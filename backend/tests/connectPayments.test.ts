import { describe, expect, test } from "vitest";
import {
  mapConnectMethod,
  rmToSen,
  isSupportedCurrency,
  classifySoMatch,
} from "../src/scm/lib/connect-payment-map";

/* POST /api/connect/payments — HOUZS CONNECT → ERP confirmed-payment push.
 *
 * Two kinds of test, for the same reason as tests/chatCallback.test.ts:
 *   · the PURE decision helpers (connect-payment-map) have no Supabase / env /
 *     I/O, so every branch is asserted directly here;
 *   · the HANDLER talks to the scm Postgres schema (getSupabaseService), which
 *     this isolated env does not bind, so its invariants are pinned against the
 *     SOURCE — each would read as reasonable code if quietly reverted (book the
 *     payment directly; drop the service-tier gate; bypass the slip window), so
 *     each needs a red test, not a comment.
 */

// ── Pure helpers ────────────────────────────────────────────────────────────
describe("mapConnectMethod", () => {
  test("Connect's 3 tokens map to the ERP ledger codes", () => {
    expect(mapConnectMethod("Card")).toBe("merchant");
    expect(mapConnectMethod("Online")).toBe("transfer");
    expect(mapConnectMethod("Cash")).toBe("cash");
  });
  test("ERP spellings and casing also resolve", () => {
    expect(mapConnectMethod("merchant")).toBe("merchant");
    expect(mapConnectMethod("  TRANSFER ")).toBe("transfer");
    expect(mapConnectMethod("cASh")).toBe("cash");
  });
  test("anything else is null (never a guessed method)", () => {
    expect(mapConnectMethod("Installment")).toBeNull();
    expect(mapConnectMethod("")).toBeNull();
    expect(mapConnectMethod(null)).toBeNull();
    expect(mapConnectMethod("cheque")).toBeNull();
  });
});

describe("rmToSen", () => {
  test("RM → integer sen, rounded", () => {
    expect(rmToSen(4600)).toBe(460000);
    expect(rmToSen(550.5)).toBe(55050);
    expect(rmToSen(0.1 + 0.2)).toBe(30); // float cents never reach the DB
  });
  test("non-positive / non-finite is null", () => {
    expect(rmToSen(0)).toBeNull();
    expect(rmToSen(-5)).toBeNull();
    expect(rmToSen(Number.NaN)).toBeNull();
    expect(rmToSen(null)).toBeNull();
  });
});

describe("isSupportedCurrency", () => {
  test("RM / MYR / empty pass; anything else is refused", () => {
    expect(isSupportedCurrency("MYR")).toBe(true);
    expect(isSupportedCurrency("rm")).toBe(true);
    expect(isSupportedCurrency("")).toBe(true);
    expect(isSupportedCurrency(null)).toBe(true);
    expect(isSupportedCurrency("USD")).toBe(false);
    expect(isSupportedCurrency("SGD")).toBe(false);
  });
});

describe("classifySoMatch", () => {
  const doc = (doc_no: string, linked_ac_docno: string | null = null) => ({ doc_no, linked_ac_docno });

  test("a single exact doc_no hit is confident", () => {
    const r = classifySoMatch([doc("HC-SO-002608-002")], "HC-SO-002608-002");
    expect(r).toEqual({ ok: true, docNo: "HC-SO-002608-002" });
  });
  test("resolves by the AutoCount number the customer was shown", () => {
    const r = classifySoMatch([doc("HC-SO-002608-002", "IV-0001")], "IV-0001");
    expect(r).toEqual({ ok: true, docNo: "HC-SO-002608-002" });
  });
  test("an exact doc_no hit wins over a linked-number hit", () => {
    const hits = [doc("REALDOC", "SHARED"), doc("SHARED", "OTHER")];
    expect(classifySoMatch(hits, "SHARED")).toEqual({ ok: true, docNo: "SHARED" });
  });
  test("no hit is NOT booked (needs manual)", () => {
    const r = classifySoMatch([], "NOPE");
    expect(r.ok).toBe(false);
  });
  test("two doc_no hits is ambiguous — never booked blind", () => {
    const r = classifySoMatch([doc("X"), doc("X")], "X");
    expect(r.ok).toBe(false);
  });
  test("a blank ref is refused", () => {
    expect(classifySoMatch([doc("X")], "   ").ok).toBe(false);
  });
});

// ── Source invariants ─────────────────────────────────────────────────────────
const sources = import.meta.glob(
  ["../src/routes/connect-payments.ts", "../src/index.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function source(suffix: string): string {
  const hit = Object.entries(sources).find(([p]) => p.endsWith(suffix));
  expect(hit, `source not found: ${suffix} — did the file move?`).toBeTruthy();
  const text = hit![1] ?? "";
  expect(text.length, `source empty: ${suffix}`).toBeGreaterThan(200);
  return text;
}

function stripComments(s: string): string {
  // Line comments FIRST, then block comments. The route's header has
  // `app.use("/api/*", auth)` inside a `//` line — its `/*` would otherwise open
  // a phantom block comment that swallows real code down to the next `*/` (the
  // exact trap chatCallback.test documents on index.ts). Dropping `//` lines
  // first removes that `/*` before the block-comment pass runs.
  return s
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

// Line of the first UNCOMMENTED occurrence of `needle`, or -1. (index.ts is full
// of app.use("/api/*", …) patterns whose star would break a block-comment strip,
// so compare line positions and skip // lines instead — same as chatCallback's.)
function uncommentedLine(src: string, needle: string): number {
  return src.split("\n").findIndex((l) => l.includes(needle) && !l.trimStart().startsWith("//"));
}

describe("the push is mounted and reachable", () => {
  test("mounted BELOW the /api/* auth gate (reuses the service user)", () => {
    const src = source("src/index.ts");
    const mount = uncommentedLine(src, 'app.route("/api/connect/payments"');
    const gate = uncommentedLine(src, 'app.use("/api/*", auth)');
    expect(mount, "route is not mounted in index.ts").toBeGreaterThan(-1);
    expect(gate, "the /api/* auth gate moved — this test needs updating").toBeGreaterThan(-1);
    // Above the gate it would never see the Bearer <CONNECT_SERVICE_TOKEN> user
    // the auth middleware mints; the whole point is to reuse that service user.
    expect(mount).toBeGreaterThan(gate);
  });

  test("gated to the service tier", () => {
    const src = stripComments(source("routes/connect-payments.ts"));
    expect(src).toMatch(/requirePermission\(\s*['"]\*['"]\s*\)/);
  });
});

describe("it books through the one writer, and only on a confident match", () => {
  const route = () => stripComments(source("routes/connect-payments.ts"));

  test("books via recordSoPaymentRow", () => {
    expect(route()).toMatch(/recordSoPaymentRow\s*\(/);
  });

  test("never writes mfg_sales_order_payments directly", () => {
    // The one-writer rule (so-payment-row owns the insert + the whole fan-out:
    // posting, receipt, deposit invoice, AutoCount). A raw insert here would
    // record money with none of that.
    expect(route()).not.toMatch(/from\(\s*['"]mfg_sales_order_payments['"]\s*\)/);
  });

  test("an unresolved order_ref is queued, not booked blind", () => {
    const src = route();
    expect(src).toMatch(/classifySoMatch\s*\(/);
    // The no-match guard returns 'needs_manual' before anything is booked.
    expect(src).toMatch(/!match\.ok[\s\S]{0,120}needs_manual/);
  });
});

describe("it does not weaken the owner's controls", () => {
  const route = () => stripComments(source("routes/connect-payments.ts"));

  test("the 14-day slip-date window is enforced, never bypassed", () => {
    const src = route();
    expect(src).toMatch(/checkPaymentSlipDate\s*\(/);
    // allowOutOfWindowSlipDate would silently book an out-of-window slip the
    // owner's rule routes to a human with the backdate right.
    expect(src).not.toContain("allowOutOfWindowSlipDate");
  });

  test("idempotency is keyed on connect_payment_id via the push ledger", () => {
    const src = route();
    expect(src).toContain("connect_payment_pushes");
    expect(src).toContain("connect_payment_id");
  });

  test("off-list bank / online sub-type is snapped or queued, never invented", () => {
    const src = route();
    expect(src).toMatch(/snapPaymentOption\s*\(/);
  });
});
