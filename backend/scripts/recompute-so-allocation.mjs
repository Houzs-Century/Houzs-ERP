// Dispatchable SO stock-allocation recompute (document-evidence round,
// 2026-08-01 — the trace check's `ready-no-open-lots` class: 19 lines whose
// stock_status says READY while their (company, warehouse, code) bucket holds
// ZERO open lots. Stale flags: the allocator only ever runs as a post-ship /
// post-GRN side effect, so nothing ever re-evaluated them after their stock
// left. There was NO dispatchable way to run it — recompute-2990-so-allocation
// needs SUPABASE_URL + SERVICE_ROLE_KEY, which the Actions environment does
// not carry (proven by the 2026-08-01 W5 live failure).
//
// REUSE, NOT REPLICATION. This runs the REAL recomputeSoStockAllocation
// (src/scm/lib/so-stock-allocation.ts) — the same function every GRN / DO /
// return triggers — over lib/pgrest-shim.mjs on DATABASE_URL alone. Stale
// READY with no stock flips back to PENDING by the allocator's OWN rules; this
// script contains NO allocation logic. Both companies: the function is global
// by design (older orders claim shared stock first).
//
// The real function has no dry-run mode, so this wraps it in ONE transaction:
//   DRY-RUN (default): BEGIN -> snapshot -> run canonical -> snapshot ->
//     ROLLBACK. Prints per-SO-line stock_status/qty old -> new, the SO header
//     flips, and the ready-no-open-lots lens before/after — the exact APPLY
//     effect, with nothing persisted.
//   APPLY=1: the same flow, COMMIT.
// Per-statement SAVEPOINTs inside the transaction restore PostgREST's
// autocommit semantics for the function's best-effort writes (an audit insert
// that fails must not poison the transaction — the round-2 id-restamp lesson,
// but with MANUAL savepoints on a plain connection, not sql.begin's
// uncaughtError bookkeeping, which is what bit twice).
//
// Env: DATABASE_URL (the only credential). APPLY=1 to commit. DOC=<doc_no>
//      optional single-SO scope (passed to the function's scopeToDocNo).
// Run under tsx (TS imports): npx tsx scripts/recompute-so-allocation.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const APPLY = process.env.APPLY === "1";
const DOC = (process.env.DOC || "").trim() || undefined;

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

function fromDevVars(field) {
  try {
    return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1];
  } catch {
    return undefined;
  }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

// The allocator's own live-SO lens (so-stock-allocation.ts step 1), IMPORTED:
// the snapshot must cover exactly the rows the function can touch, and "must"
// is only true if the two read the same constant.
const EXCLUDED = SO_TERMINAL_STATES;

async function snapshotLines() {
  const rows = await pg`
    SELECT i.id::text AS id, i.doc_no, so.company_id, i.item_code,
           i.stock_status, i.stock_qty_ready, so.status::text AS so_status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
     WHERE i.cancelled = false
       AND UPPER(so.status::text) <> ALL(${EXCLUDED})
       ${DOC ? pg`AND i.doc_no = ${DOC}` : pg``}
     ORDER BY i.doc_no, i.id`;
  return new Map(rows.map((r) => [r.id, r]));
}

async function snapshotHeaders() {
  const rows = await pg`
    SELECT doc_no, status::text AS status FROM scm.mfg_sales_orders
     WHERE UPPER(status::text) <> ALL(${EXCLUDED})
       ${DOC ? pg`AND doc_no = ${DOC}` : pg``}`;
  return new Map(rows.map((r) => [r.doc_no, r.status]));
}

// The trace check's ready-no-open-lots lens, verbatim shape: READY lines whose
// bucket holds no open lots. Printed before AND after, so the run proves the
// stale flags flipped (or says exactly which did not, and why to look).
async function readyNoOpenLots() {
  return pg`
    SELECT i.id::text AS id, i.doc_no, so.company_id, i.item_code, i.stock_status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders so ON so.doc_no = i.doc_no
     WHERE i.cancelled = false
       AND UPPER(so.status::text) <> ALL(${EXCLUDED})
       AND i.stock_status = 'READY'
       ${DOC ? pg`AND i.doc_no = ${DOC}` : pg``}
       AND NOT EXISTS (
         SELECT 1 FROM scm.inventory_lots l
          WHERE l.company_id = so.company_id
            AND l.item_code = i.item_code
            AND l.qty_remaining > 0
            AND (i.warehouse_id IS NULL OR l.warehouse_id = i.warehouse_id))
     ORDER BY i.doc_no, i.item_code`;
}

async function main() {
  notice("=== RECOMPUTE SO STOCK ALLOCATION — the canonical function, dispatchable (DATABASE_URL only) ===");
  notice(`mode: ${APPLY ? "APPLY (one transaction, COMMITTED)" : "DRY-RUN (the canonical function runs inside a transaction and is ROLLED BACK — nothing persisted)"}`);
  notice(`scope: ${DOC ? `single SO ${DOC}` : "GLOBAL (both companies — the allocator is global by design; older orders claim shared stock first)"}`);
  notice("");

  const staleBefore = await readyNoOpenLots();
  notice(`ready-no-open-lots lens BEFORE (the stale-READY class the trace check found): ${staleBefore.length} line(s)`);
  for (const r of staleBefore) notice(`  ${r.doc_no} (co=${r.company_id}) ${r.item_code} — READY with zero open lots in its bucket`);
  notice("");

  const { recomputeSoStockAllocation } = await import("../src/scm/lib/so-stock-allocation.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");

  // Per-statement savepoints restore PostgREST's autocommit semantics inside
  // the wrapping transaction: the allocator's best-effort writes (audit rows)
  // may fail without poisoning everything after them. Manual savepoints on the
  // plain connection — NOT sql.begin, whose uncaughtError bookkeeping rethrows
  // recovered errors at commit (BUG-HISTORY 2026-08-01, twice).
  /* SERIALIZED (2026-08-29, docs/bugs/0562). The canonical function fans its
     reads out six-wide (paginate-all's CHUNK_CONCURRENCY), and Postgres
     releases a savepoint TOGETHER WITH every savepoint created after it — so
     interleaved triads (SAVEPOINT 5, SAVEPOINT 6, RELEASE 5...) destroyed
     pgrest_sp_6 before its own RELEASE and the sweep died with "savepoint does
     not exist". One statement's triad at a time; the semantics per statement
     are unchanged, and a diagnostic driver has no business being concurrent
     on a single transaction anyway. */
  let spN = 0;
  let spChain = Promise.resolve();
  const spSql = {
    unsafe: (text, params) => {
      const run = async () => {
        spN += 1;
        const sp = `pgrest_sp_${spN}`;
        await pg.unsafe(`SAVEPOINT ${sp}`);
        try {
          const rows = await pg.unsafe(text, params);
          await pg.unsafe(`RELEASE SAVEPOINT ${sp}`);
          return rows;
        } catch (e) {
          await pg.unsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw e;
        }
      };
      const next = spChain.then(run, run);
      spChain = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  const sb = pgrestShim(spSql, "scm");

  let result;
  let before, after, headersBefore, headersAfter, staleAfter;
  await pg.unsafe("BEGIN");
  try {
    before = await snapshotLines();
    headersBefore = await snapshotHeaders();
    result = await recomputeSoStockAllocation(sb, DOC);
    after = await snapshotLines();
    headersAfter = await snapshotHeaders();
    staleAfter = await readyNoOpenLots();
    if (APPLY && result?.ok !== false) {
      await pg.unsafe("COMMIT");
    } else {
      await pg.unsafe("ROLLBACK");
    }
  } catch (e) {
    try { await pg.unsafe("ROLLBACK"); } catch { /* connection-level failure */ }
    throw e;
  }

  notice(`canonical result: ok=${result?.ok} linesFlipped=${result?.linesFlipped} ordersAdvanced=${result?.ordersAdvanced} ordersRegressed=${result?.ordersRegressed}${result?.reason ? ` reason=${result.reason}` : ""}${result?.deferredDocNos ? ` deferred=[${result.deferredDocNos.join(", ")}]` : ""}`);
  if (result?.ok === false) {
    warn(`the canonical function refused (${result?.reason ?? "no reason"}) — ${APPLY ? "transaction ROLLED BACK, nothing committed" : "dry-run rolled back as always"}.`);
  }
  notice("");
  notice("================ PER-LINE stock_status old -> new ================");
  let flips = 0;
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) continue;
    if (a.stock_status !== b.stock_status || Number(a.stock_qty_ready ?? 0) !== Number(b.stock_qty_ready ?? 0)) {
      flips += 1;
      notice(`  ${b.doc_no} (co=${b.company_id}) ${b.item_code}: ${b.stock_status}(${b.stock_qty_ready ?? 0}) -> ${a.stock_status}(${a.stock_qty_ready ?? 0})`);
    }
  }
  if (flips === 0) notice("  (no line changed — the projection already matches the allocator's own answer; idempotent re-run lands here)");
  notice("");
  notice("================ SO HEADER flips ================");
  let hFlips = 0;
  for (const [doc, b] of headersBefore) {
    const a = headersAfter.get(doc);
    if (a != null && a !== b) {
      hFlips += 1;
      notice(`  ${doc}: ${b} -> ${a}`);
    }
  }
  if (hFlips === 0) notice("  (no header changed)");
  notice("");
  notice(`ready-no-open-lots lens AFTER: ${staleAfter.length} line(s)${staleAfter.length ? " — still stale, listed:" : " — the stale flags flipped."}`);
  for (const r of staleAfter) notice(`  ${r.doc_no} (co=${r.company_id}) ${r.item_code} — investigate: the allocator's own rules kept it READY`);
  notice("");

  if (sb.__gaps.length > 0) {
    console.error("SHIM GAP during the recompute — the canonical function called a method the shim does not implement; aborting non-zero so a silent skip can never read as success:");
    for (const g of sb.__gaps) console.error(`  ${g}`);
    process.exit(1);
  }
  notice(APPLY
    ? (result?.ok === false ? "NOT COMMITTED — the canonical function refused; see its reason above." : "APPLIED — committed. Re-run in DRY-RUN (expect zero flips) and re-run the SO source-trace check: ready-no-open-lots must shrink to zero.")
    : "DRY-RUN — the canonical function ran and every write above was rolled back. Review, then APPLY=1.");
  notice("=== END ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("RECOMPUTE_SO_ALLOCATION_FAIL", e?.message ?? e);
    try { await pg.end({ timeout: 5 }); } catch { /* already gone */ }
    process.exit(1);
  });
