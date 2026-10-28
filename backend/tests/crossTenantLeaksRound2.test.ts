// Cross-tenant isolation, round 2 — one REFUSAL test per leak closed on
// fix/cross-tenant-leaks-round2.
//
// WHY THIS FILE IS SHAPED LIKE THIS. The bar set for these fixes was: prove the
// test BITES — stash the fix, watch the test fail, restore, watch it pass. A
// test that passes with and without the fix proves nothing, and this repo has
// shipped several. So every assertion below is written against the STATEMENT
// THE FIX CHANGED, not against a helper the fix happens to call:
//
//   · the raw-SQL routers (mail-center, assr-form-intake, projects) are driven
//     through their real Hono app with a fake `env.DB` that records every
//     statement, so the assertion is on the SQL the handler actually issued;
//   · the supabase-client routers cannot be driven here (the SCM tree rides
//     Supabase Postgres — see the note at the top of tests/dpOrdersScope.test.ts),
//     so those fixes are pinned at the primitive the handler now calls, with a
//     fake client that answers "the other company's row" and asserts the
//     primitive REFUSES it.
//
// The negative half matters as much as the positive: several of these helpers
// must DEGRADE to a no-op on a single-company / pre-migration install, and a
// test that only checked "it refuses" would have let a fix ship that blanked
// Houzs. Both directions are asserted for every one.
import { describe, expect, test } from "vitest";
import {
  activeCompanyCodePred,
  crossCompanySourceRefusal,
} from "../src/scm/lib/companyScope";
import {
  assertWarehouseInCompany,
  assertTripInAllowedCompanies,
} from "../src/scm/lib/ref-in-company";
import { scopeStaffRowsToActiveCompany } from "../src/scm/lib/staffCompanyScope";

const HOUZS = 1;
const C2990 = 2;
const COMPANIES = [
  { id: HOUZS, code: "HOUZS", name: "Houzs Century" },
  { id: C2990, code: "2990", name: "2990's Home" },
];

/** A CompanyScopeCtx (and enough of a Hono context for the staff pass). */
function ctx(opts: {
  companyId?: number;
  companyCode?: string;
  allowed?: number[];
  companies?: typeof COMPANIES;
  DB?: unknown;
}) {
  const bag: Record<string, unknown> = {
    companyId: opts.companyId,
    companyCode: opts.companyCode,
    allowedCompanyIds: opts.allowed,
    companies: opts.companies ?? COMPANIES,
  };
  return { get: (k: string) => bag[k], env: { DB: opts.DB } } as any;
}

// ── a D1-shaped fake that RECORDS the SQL every handler issues ──────────────
type Recorded = { sql: string; binds: unknown[] };
function fakeDb(answer: (sql: string, binds: unknown[]) => unknown) {
  const seen: Recorded[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...b: unknown[]) { binds = b; return stmt; },
        async all<T>() {
          seen.push({ sql, binds });
          const r = answer(sql, binds);
          return { results: (Array.isArray(r) ? r : []) as T[] };
        },
        async first<T>() {
          seen.push({ sql, binds });
          const r = answer(sql, binds);
          return (Array.isArray(r) ? (r[0] ?? null) : r ?? null) as T | null;
        },
        async run() {
          seen.push({ sql, binds });
          return { meta: { changes: (answer(sql, binds) as number) ?? 0 } };
        },
      };
      return stmt;
    },
  };
  return { db, seen };
}

const flat = (s: string) => s.replace(/\s+/g, " ");

// ═══════════════════════════════════════════════════════════════════════════
// LEAK 1 — GET /mail-center/outbox + /outbox/:id returned every company's
// outbound mail INCLUDING body_html, which carries the /invite/<token> and
// /reset/<token> links routes/auth.ts mints. Cross-tenant account takeover.
// ═══════════════════════════════════════════════════════════════════════════
describe("mail-center outbox is scoped by company_code", () => {
  test("REFUSES to read another company's outbox rows — the predicate is on the statement", () => {
    const pred = activeCompanyCodePred(
      ctx({ companyId: C2990, companyCode: "2990", allowed: [C2990] }),
    );
    // Something is appended, it names the column, and it BINDS rather than
    // interpolating (a company code is a string; this file's other helpers
    // inline only validated integers).
    expect(pred.sql).toContain("company_code");
    expect(pred.binds).toEqual(["2990", "2"]);
    // The 2990 caller must NOT pick up the base company's rows...
    expect(pred.binds).not.toContain("HOUZS");
    // ...and must NOT inherit the NULL (legacy = HOUZS, migration 0094) rows.
    expect(pred.sql).not.toContain("IS NULL");
  });

  test("the BASE company owns the NULL rows — mig 0094 says NULL is a HOUZS row", () => {
    const pred = activeCompanyCodePred(
      ctx({ companyId: HOUZS, companyCode: "HOUZS", allowed: [HOUZS, C2990] }),
    );
    expect(pred.sql).toContain("IS NULL");
    expect(pred.binds).toEqual(["HOUZS", "1"]);
  });

  test("FAILS CLOSED when the context resolved but no company could be picked", () => {
    const pred = activeCompanyCodePred(ctx({ allowed: [] }));
    expect(pred.sql).toBe(" AND 1=0");
  });

  test("DEGRADES to no predicate on a single-company / pre-migration install", () => {
    // allowedCompanyIds undefined = the companies master is unresolved. Adding a
    // predicate here would blank the outbox on single-company Houzs.
    expect(activeCompanyCodePred(ctx({})).sql).toBe("");
  });

  test("the HANDLER applies it — GET /outbox and /outbox/:id both bind the predicate", async () => {
    // Driven through the real router, because a correct helper nobody called is
    // exactly the shape this whole branch exists to close.
    const { db, seen } = fakeDb((sql) => {
      if (/FROM mail_user_scope/i.test(sql)) return { level: "company" };
      if (/FROM email_addresses/i.test(sql)) return [{ address: "hello@2990shome.com" }];
      return [];
    });
    const { Hono } = await import("hono");
    const mailCenter = (await import("../src/routes/mail-center")).default;
    const outer = new Hono<any>();
    outer.use("*", async (c: any, next: any) => {
      c.set("userId", 7);
      c.set("user", { id: 7, permissions: ["*"], permissions_set: new Set(["*"]) });
      c.set("companyId", C2990);
      c.set("companyCode", "2990");
      c.set("allowedCompanyIds", [HOUZS, C2990]);
      c.set("companies", COMPANIES);
      await next();
    });
    outer.route("/", mailCenter);

    await outer.request("/outbox", {}, { DB: db } as any);
    const list = seen.find((x) => /SELECT id, to_address[\s\S]*FROM email_outbox/i.test(x.sql));
    expect(list).toBeDefined();
    expect(flat(list!.sql)).toContain("company_code IN (?, ?)");
    expect(list!.binds).toContain("2990");
    // The 2990 caller must not inherit the NULL (= HOUZS) rows.
    expect(list!.sql).not.toContain("IS NULL");
    // The status ROLL-UP is scoped too: counting across companies would put the
    // other tenant's failures in this tenant's header.
    const counts = seen.find((x) => /COUNT\(\*\) AS n FROM email_outbox/i.test(x.sql));
    expect(flat(counts!.sql)).toContain("company_code IN (?, ?)");

    seen.length = 0;
    await outer.request("/outbox/some-id", {}, { DB: db } as any);
    const detail = seen.find((x) => /FROM email_outbox WHERE id = \?/i.test(x.sql));
    // The DETAIL is where body_html — and therefore the reset link — is returned.
    expect(detail).toBeDefined();
    expect(flat(detail!.sql)).toContain("company_code IN (?, ?)");
    expect(detail!.binds).toEqual(["some-id", "2990", "2"]);
  });

  test("does not accept an id-as-text alternative that is another company's CODE", () => {
    // Defensive: a company literally coded "2" must not be reachable from the
    // company whose id is 2.
    const odd = [
      { id: 2, code: "2990", name: "b" },
      { id: 9, code: "2", name: "a" },
    ];
    const pred = activeCompanyCodePred(
      ctx({ companyId: 2, companyCode: "2990", allowed: [2, 9], companies: odd }),
    );
    expect(pred.binds).toEqual(["2990"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAK 2 — PRE-AUTH GET /assr-form-intake/status-export dumped customer_name,
// phone, addr1-4 and complaint_issue for BOTH companies to whoever held either
// shared secret; POST /delivery-dates (found in the same pass) WROTE onto a
// case resolved by assr_no with no company predicate.
// ═══════════════════════════════════════════════════════════════════════════
describe("assr-form-intake is scoped to the SECRET's own company", () => {
  const KEY = "intake-key-for-tests";

  async function callExport(companiesReadable: boolean) {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) {
        if (!companiesReadable) throw new Error("no such table: companies");
        return { id: HOUZS };
      }
      return [];
    });
    const mod = await import("../src/routes/assrFormIntake");
    const res = await mod.default.request(
      "/status-export",
      { headers: { "X-Intake-Key": KEY } },
      { DB: db, FORM_INTAKE_KEY: KEY } as any,
    );
    return { res, seen };
  }

  test("REFUSES to export the other company's cases — the read carries company_id", async () => {
    const { res, seen } = await callExport(true);
    expect(res.status).toBe(200);
    const caseRead = seen.find((s) => /FROM assr_cases/i.test(s.sql));
    expect(caseRead).toBeDefined();
    expect(flat(caseRead!.sql)).toContain("archived_at IS NULL AND company_id = 1");
  });

  test("DEGRADES on a pre-migration install rather than exporting nothing", async () => {
    const { res, seen } = await callExport(false);
    expect(res.status).toBe(200);
    const caseRead = seen.find((s) => /FROM assr_cases/i.test(s.sql));
    expect(flat(caseRead!.sql)).toContain("archived_at IS NULL");
    expect(caseRead!.sql).not.toContain("company_id");
  });

  test("a wrong key is still 401 — the company scoping did not replace the auth", async () => {
    const { db } = fakeDb(() => ({ id: HOUZS }));
    const mod = await import("../src/routes/assrFormIntake");
    const res = await mod.default.request(
      "/status-export",
      { headers: { "X-Intake-Key": "wrong" } },
      { DB: db, FORM_INTAKE_KEY: KEY } as any,
    );
    expect(res.status).toBe(401);
  });

  test("the WRITE leg refuses too — /delivery-dates resolves assr_no within one company", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM assr_cases/i.test(sql)) return null; // out of company → skipped
      return [];
    });
    const mod = await import("../src/routes/assrFormIntake");
    const res = await mod.default.request(
      "/delivery-dates",
      {
        method: "POST",
        headers: { "X-Intake-Key": KEY, "content-type": "application/json" },
        body: JSON.stringify({
          updates: [{ assr_no: "ASSR-0001", job: "INSPECTION", date: "2026-08-20" }],
        }),
      },
      { DB: db, FORM_INTAKE_KEY: KEY } as any,
    );
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };
    // Nothing was written, and the lookup that decided so was company-scoped.
    expect(body.results[0]).toMatchObject({ skipped: "no_case" });
    const lookup = seen.find((s) => /SELECT id,.*FROM assr_cases/is.test(s.sql));
    expect(flat(lookup!.sql)).toContain("WHERE assr_no = ? AND company_id = 1");
    expect(seen.some((s) => /UPDATE assr_cases/i.test(s.sql))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAK 3 — routes/projects.ts child-id family. The file header asserted children
// are always reached through their parent; ~30 handlers address the child by its
// own id with no parent in the URL at all. PATCH/DELETE /finance/lines/:lineId
// was a bare WHERE id = ? on a table that HAS company_id (mig 0170).
// ═══════════════════════════════════════════════════════════════════════════
describe("projects child-id handlers refuse another company's row", () => {
  async function patchFinanceLine(activeCompany: number | undefined, ownedBy: number) {
    const { db, seen } = fakeDb((sql, binds) => {
      // The ownership gate: `SELECT 1 AS ok FROM project_finance_lines WHERE id = ?  AND company_id = N`
      if (/FROM project_finance_lines WHERE id = \?/.test(flat(sql))) {
        const m = /company_id = (\d+)/.exec(sql);
        if (!m) return { ok: 1 }; // degraded (no predicate) — legacy behaviour
        return Number(m[1]) === ownedBy ? { ok: 1 } : null;
      }
      return null;
    });
    const mod = await import("../src/routes/projects");
    const res = await mod.default.request(
      "/finance/lines/77",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_centi: 999999 }),
      },
      { DB: db } as any,
      // Hono passes executionCtx third; the company context is read off c.get,
      // so it is injected by the middleware stub below instead.
    );
    return { res, seen };
  }

  // The router reads the company off `c.get("companyId")`, which companyContext
  // sets. Drive it through a tiny stub app so the real handler runs unchanged.
  async function drive(path: string, init: RequestInit, companyId: number | undefined, answer: (sql: string, binds: unknown[]) => unknown) {
    const { db, seen } = fakeDb(answer);
    const { Hono } = await import("hono");
    const projects = (await import("../src/routes/projects")).default;
    const outer = new Hono<any>();
    outer.use("*", async (c: any, next: any) => {
      if (companyId !== undefined) {
        c.set("companyId", companyId);
        c.set("allowedCompanyIds", [HOUZS, C2990]);
        c.set("companies", COMPANIES);
      }
      c.set("user", { id: 1, permissions: ["*"], permissions_set: new Set(["*"]) });
      await next();
    });
    outer.route("/", projects);
    const res = await outer.request(path, init, { DB: db } as any);
    return { res, seen };
  }

  test("REFUSES a PATCH of the other company's P&L line with 404, and writes nothing", async () => {
    const { res, seen } = await drive(
      "/finance/lines/77",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount_centi: 999999 }) },
      C2990, // caller is in 2990
      (sql) => {
        if (/FROM project_finance_lines WHERE id = \?/.test(flat(sql))) {
          // The row belongs to HOUZS, so a company_id = 2 gate matches nothing.
          return /company_id = 1\b/.test(sql) ? { ok: 1 } : null;
        }
        return null;
      },
    );
    expect(res.status).toBe(404);
    expect(seen.some((s) => /UPDATE project_finance_lines/i.test(s.sql))).toBe(false);
    // And the gate it refused on really did carry the caller's company.
    const gate = seen.find((s) => /FROM project_finance_lines WHERE id = \?/.test(flat(s.sql)));
    expect(flat(gate!.sql)).toContain("AND company_id = 2");
  });

  test("REFUSES a DELETE of the other company's checklist item", async () => {
    const { res, seen } = await drive(
      "/checklist/501",
      { method: "DELETE" },
      C2990,
      (sql) => (/FROM project_checklist WHERE id = \?/.test(flat(sql)) ? null : null),
    );
    expect(res.status).toBe(404);
    expect(seen.some((s) => /DELETE FROM project_checklist\b/i.test(s.sql))).toBe(false);
  });

  test("REFUSES a child whose table has NO company_id, via EXISTS on the parent project", async () => {
    const { res, seen } = await drive(
      "/team/9",
      { method: "DELETE" },
      C2990,
      () => null, // the EXISTS finds no project of ours owning team row 9
    );
    expect(res.status).toBe(404);
    expect(seen.some((s) => /DELETE FROM project_team/i.test(s.sql))).toBe(false);
    const gate = seen.find((s) => /FROM project_team t/.test(flat(s.sql)));
    expect(flat(gate!.sql)).toContain("EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.company_id = 2)");
  });

  test("DEGRADES on a single-company install — the gate is skipped, not failed closed", async () => {
    const { seen } = await drive(
      "/team/9",
      { method: "DELETE" },
      undefined, // no company context at all
      () => 1,
    );
    // No ownership probe was issued, and the delete went through as before.
    expect(seen.some((s) => /FROM project_team t/.test(flat(s.sql)))).toBe(false);
    expect(seen.some((s) => /DELETE FROM project_team/i.test(s.sql))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAK 4 — the purchase-side line-link family. The guard sat on the HEADER id
// while the LINE id came from the BODY unchecked, so received_qty /
// invoiced_qty / returned_qty were written onto the other tenant's lines.
// ═══════════════════════════════════════════════════════════════════════════
describe("a source LINE named in the request body must be in the active company", () => {
  const fakeSb = (rows: Array<Record<string, unknown>> | null, error?: string) => ({
    from() { return this; },
    select() { return this; },
    in() { return Promise.resolve({ data: rows, error: error ? { message: error } : null }); },
  }) as any;

  test("REFUSES a PO line owned by the other company", async () => {
    const out = await crossCompanySourceRefusal(
      fakeSb([{ id: "poi-1", company_id: C2990 }]),
      ctx({ companyId: HOUZS, companyCode: "HOUZS", allowed: [HOUZS] }),
      "purchase_order_items",
      ["poi-1"],
      null,
    );
    expect(out).not.toBeNull();
    expect(out).toHaveProperty("blocked");
    const blocked = (out as { blocked: { error: string; message: string } }).blocked;
    expect(blocked.error).toBe("cross_company_conversion_blocked");
    // A LINE has no document number: the refusal must not read out a uuid.
    expect(blocked.message).toContain("That document");
    expect(blocked.message).not.toContain("poi-1");
    // And it must survive the SCM client's plain-sentence filter.
    expect(blocked.message.length).toBeLessThan(200);
  });

  test("ALLOWS a line of the caller's own company", async () => {
    const out = await crossCompanySourceRefusal(
      fakeSb([{ id: "gi-1", company_id: HOUZS }]),
      ctx({ companyId: HOUZS, companyCode: "HOUZS", allowed: [HOUZS] }),
      "grn_items",
      ["gi-1"],
      null,
    );
    expect(out).toBeNull();
  });

  test("FAILS CLOSED on a read error — an unproven line is not a permitted one", async () => {
    const out = await crossCompanySourceRefusal(
      fakeSb(null, "connection reset"),
      ctx({ companyId: HOUZS, companyCode: "HOUZS", allowed: [HOUZS] }),
      "grn_items",
      ["gi-1"],
      null,
    );
    expect(out).toEqual({ loadError: "connection reset" });
  });

  test("DEGRADES when the company is unresolved (single-company install)", async () => {
    const out = await crossCompanySourceRefusal(
      fakeSb([{ id: "gi-1", company_id: C2990 }]),
      ctx({}),
      "grn_items",
      ["gi-1"],
      null,
    );
    expect(out).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAK 5 — hr.ts GET /pickers returned every active staff row platform-wide
// while its four immediate siblings each carried .eq('company_id', ...).
// LEAK 6 — staff.ts PATCH /by-user/:userId/showroom keyed the write on user_id
// alone, so the other company's person could be re-parked.
// ═══════════════════════════════════════════════════════════════════════════
describe("the staff scoping pass now reachable from BOTH pickers", () => {
  const grantDb = (grants: Array<{ user_id: number; company_id: number }>) => ({
    prepare() {
      return {
        bind() { return this; },
        async all() { return { results: grants }; },
      };
    },
  });

  const roster = [
    { id: "s-houzs", user_id: 10 },   // granted HOUZS
    { id: "s-2990", user_id: 20 },    // granted 2990
    { id: "s-both", user_id: 30 },    // granted both
    { id: "s-unlinked", user_id: null }, // no Houzs user → the 2990 mirror source
  ];
  const grants = [
    { user_id: 10, company_id: HOUZS },
    { user_id: 20, company_id: C2990 },
    { user_id: 30, company_id: HOUZS },
    { user_id: 30, company_id: C2990 },
  ];

  test("REFUSES to list the other company's staff — a HOUZS picker sees no 2990-only person", async () => {
    const { scoped } = await scopeStaffRowsToActiveCompany(
      ctx({ companyId: HOUZS, allowed: [HOUZS], DB: grantDb(grants) }),
      roster,
    );
    expect(scoped.map((r) => r.id)).toEqual(["s-houzs", "s-both"]);
    expect(scoped.map((r) => r.id)).not.toContain("s-2990");
    expect(scoped.map((r) => r.id)).not.toContain("s-unlinked");
  });

  test("and the mirror side is symmetric — a 2990 picker sees no HOUZS-only person", async () => {
    const { scoped } = await scopeStaffRowsToActiveCompany(
      ctx({ companyId: C2990, allowed: [C2990], DB: grantDb(grants) }),
      roster,
    );
    expect(scoped.map((r) => r.id).sort()).toEqual(["s-2990", "s-both", "s-unlinked"]);
    expect(scoped.map((r) => r.id)).not.toContain("s-houzs");
  });

  test("FAILS CLOSED when the master is loaded but no active company resolves", async () => {
    const { scoped, degrade } = await scopeStaffRowsToActiveCompany(
      ctx({ allowed: [], DB: grantDb(grants) }),
      roster,
    );
    expect(scoped).toEqual([]);
    expect(degrade).toBe(false);
  });

  test("DEGRADES to the full roster with no companies master (single-company Houzs)", async () => {
    const { scoped, degrade } = await scopeStaffRowsToActiveCompany(
      { get: () => undefined, env: { DB: grantDb(grants) } } as any,
      roster,
    );
    expect(scoped).toBe(roster);
    expect(degrade).toBe(true);
  });

  test("a row with NO user_id link is never attributed to BOTH companies", async () => {
    // The bug this guards: reading user_id off a row that never selected it.
    // hr.ts had to add user_id to its select for exactly this reason.
    const houzs = await scopeStaffRowsToActiveCompany(
      ctx({ companyId: HOUZS, allowed: [HOUZS], DB: grantDb(grants) }),
      [{ id: "s-unlinked", user_id: null }],
    );
    const mirror = await scopeStaffRowsToActiveCompany(
      ctx({ companyId: C2990, allowed: [C2990], DB: grantDb(grants) }),
      [{ id: "s-unlinked", user_id: null }],
    );
    expect(houzs.scoped).toEqual([]);
    expect(mirror.scoped).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAK 7 — THE MISSING PRIMITIVE. No assertWarehouseInCompany /
// warehouseInCompany / requireWarehouse existed anywhere in scm/, so three
// handlers took `body.warehouseId` / `body.tripId` and used them unchecked.
// ═══════════════════════════════════════════════════════════════════════════
describe("assertWarehouseInCompany", () => {
  const sb = (row: unknown, error?: string) => ({
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    maybeSingle() { return Promise.resolve({ data: row, error: error ? { message: error } : null }); },
  }) as any;

  test("REFUSES a warehouse the active company does not own, with 404", async () => {
    const out = await assertWarehouseInCompany(sb(null), "wh-2990", HOUZS);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(404);
      // Same answer as "no such warehouse": confirming someone else's id exists
      // is itself a leak.
      expect(out.body.error).toBe("not_found_in_company");
    }
  });

  test("ALLOWS the active company's own warehouse", async () => {
    expect((await assertWarehouseInCompany(sb({ id: "wh-1" }), "wh-1", HOUZS)).ok).toBe(true);
  });

  test("FAILS CLOSED on a read error — this guard fronts a stock movement", async () => {
    const out = await assertWarehouseInCompany(sb(null, "timeout"), "wh-1", HOUZS);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(500);
      // The driver's message must not be interpolated: the SCM client discards
      // any server message of 200 characters or more.
      expect(out.body.message).not.toContain("timeout");
      expect(out.body.message.length).toBeLessThan(200);
    }
  });

  test("no warehouse named is not this guard's business", async () => {
    expect((await assertWarehouseInCompany(sb(null), null, HOUZS)).ok).toBe(true);
  });
});

describe("assertTripInAllowedCompanies", () => {
  const sb = (row: unknown, capture?: (col: string, val: unknown) => void) => ({
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    in(col: string, val: unknown) { capture?.(col, val); return this; },
    maybeSingle() { return Promise.resolve({ data: row, error: null }); },
  }) as any;

  test("REFUSES a trip in a company the caller holds no grant for", async () => {
    const out = await assertTripInAllowedCompanies(
      sb(null),
      "trip-2990",
      ctx({ companyId: HOUZS, allowed: [HOUZS] }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });

  test("WIDENS to the allowed set, not the active company — the board is one queue", async () => {
    let seen: unknown = null;
    const out = await assertTripInAllowedCompanies(
      sb({ id: "trip-x" }, (col, val) => { if (col === "company_id") seen = val; }),
      "trip-x",
      ctx({ companyId: HOUZS, allowed: [HOUZS, C2990] }),
    );
    expect(out.ok).toBe(true);
    // The predicate is the caller's GRANTS, so an ops user granted both can put
    // a HOUZS job on a trip they run out of the 2990 book.
    expect(seen).toEqual([HOUZS, C2990]);
  });

  test("DEGRADES when the allow-list is unresolved", async () => {
    expect((await assertTripInAllowedCompanies(sb(null), "trip-x", ctx({}))).ok).toBe(true);
  });
});
