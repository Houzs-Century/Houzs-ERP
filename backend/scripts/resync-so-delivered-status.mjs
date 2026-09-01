#!/usr/bin/env node
// ----------------------------------------------------------------------------
// resync-so-delivered-status — re-offer every candidate sales order to the
// EXISTING auto-advance, so orders whose goods are all out stop sitting in In
// Production.
//
// Run under tsx (it imports the real TS rule): npx tsx scripts/resync-so-delivered-status.mjs
//
// WHY THIS AND NOT A STATUS WRITE. The rule already exists —
// `scm/lib/so-delivery-sync.ts` advances a fully covered SO to DELIVERED — and
// it fires when a DELIVERY ORDER changes status. Orders whose DO last changed
// BEFORE the 2026-08-22 ruling were evaluated under the old set, where LOADED
// did not count as delivered, so they came out "not fully covered" and nothing
// has re-asked since. This re-asks, under today's rule.
//
// IT CALLS THE REAL FUNCTION, it does not restate it. That matters here more
// than usual: an earlier draft of this repair was going to flip the DELIVERY
// ORDERS to DELIVERED instead, which would have FAKED A DRIVER SCAN — the
// owner's own three-rung ladder (shared/do-scan-ladder.ts, 2026-08-25/26) has
// the driver write IN_TRANSIT and DELIVERED, and a script must not write a scan
// that never happened. Owner, 2026-09-01, on why the SO should advance anyway:
//   「我 load 了之后，基本上也是算出货了（delivered）不是吗？只是它是在
//    delivered 的一个状态而已」
// which is the system's own position: DO_NOT_DELIVERED_STATES is {DRAFT,
// CANCELLED}, so a Confirmed delivery already counts as delivered everywhere the
// coverage engines look (shared/do-shipped-states.ts). The DO keeps its real
// stage; only the SO catches up.
//
// EVERY COMPANY by default — a per-company default is what left company 2 at
// IN PRODUCTION 0 for a week (docs/bugs/0597-*).
//
// ADVANCE ONLY BY DEFAULT, and this is the guard that matters. The sync is
// two-directional: it also RELEASES a DELIVERED order back to READY_TO_SHIP when
// a return has un-covered it. Offering every candidate would re-judge the orders
// that are ALREADY delivered — measured 2026-09-02: 43 of the 111 candidates.
// Fixing 7 stuck orders is not a licence to re-open 43 finished ones, however
// correct the rule is. So an order already sitting in DELIVERED is SKIPPED and
// COUNTED, and the release question stays visible instead of riding in on a
// repair nobody asked to be two-directional. RELEASE=1 opts into it deliberately.
//
//   DATABASE_URL   required
//   COMPANY        a company id, or `all` (default all)
//   RELEASE        1 to ALSO re-judge orders already DELIVERED (default off)
//   MODE           plan (default) | apply
//   CONFIRM        on apply, exactly: LOADED MEANS THE GOODS ARE OUT
//
// RE-RUN: convergent. A second run finds the orders already advanced and the
// sync leaves them alone — it only ever moves a status that disagrees with the
// coverage it re-derives live.
// ----------------------------------------------------------------------------
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const RAW = String(process.env.COMPANY ?? "all").trim().toLowerCase();
const ALL = RAW === "all" || RAW === "";
const MODE = (process.env.MODE ?? "plan").trim().toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "LOADED MEANS THE GOODS ARE OUT";
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && (process.env.CONFIRM ?? "").trim() !== CONFIRM_PHRASE) {
  console.error(`REFUSED: apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* The statuses the sync itself may move an order out of, restated here ONLY to
   pick candidates cheaply — the sync re-checks it, so a drift between the two
   costs a wasted call, never a wrong write. */
const RELEASE = process.env.RELEASE === "1";
const CANDIDATE_STATUSES = RELEASE
  ? ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "DELIVERED"]
  : ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP"];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} scope=${ALL ? "ALL COMPANIES" : `company ${RAW}`}`);

  const companies = ALL
    ? (await sql`SELECT DISTINCT company_id AS id FROM scm.mfg_sales_orders
                  WHERE company_id IS NOT NULL ORDER BY 1`).map((r) => Number(r.id))
    : [Number(RAW)];
  log(`companies: ${companies.join(", ")}`);

  /* Only orders that HAVE a delivery order are worth re-offering — the sync
     answers "not covered" for everything else and the call is pure cost. */
  const cands = await sql`
    SELECT DISTINCT h.doc_no, h.company_id, h.status::text AS status
      FROM scm.mfg_sales_orders h
      JOIN scm.delivery_orders dh ON dh.so_doc_no = h.doc_no
     WHERE h.company_id = ANY(${companies})
       AND upper(h.status::text) = ANY(${CANDIDATE_STATUSES})
       AND upper(COALESCE(dh.status::text, '')) NOT IN ('DRAFT', 'CANCELLED')
     ORDER BY h.doc_no`;
  log(`orders with a non-draft delivery order, in a status the sync may move: ${cands.length}`);
  /* The half deliberately NOT offered, named rather than omitted. */
  if (!RELEASE) {
    const [held] = await sql`
      SELECT COUNT(DISTINCT h.doc_no)::int AS n
        FROM scm.mfg_sales_orders h
        JOIN scm.delivery_orders dh ON dh.so_doc_no = h.doc_no
       WHERE h.company_id = ANY(${companies}) AND upper(h.status::text) = 'DELIVERED'
         AND upper(COALESCE(dh.status::text, '')) NOT IN ('DRAFT', 'CANCELLED')`;
    log(`ADVANCE ONLY — ${held.n} order(s) already DELIVERED are NOT offered, so this run`
      + ' cannot release a finished order. RELEASE=1 includes them.');
  }

  const before = new Map(cands.map((r) => [r.doc_no, r.status]));

  if (!APPLY) {
    const byStatus = new Map();
    for (const r of cands) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    log(`   by status: ${[...byStatus].map(([s, n]) => `${s} ${n}`).join(", ")}`);
    log("");
    log(`PLAN ONLY — MODE=apply CONFIRM="${CONFIRM_PHRASE}" writes.`);
    log("The sync decides per order; this plan cannot predict its verdict without");
    log("running it, so the count above is the POPULATION offered, not the moves.");
    await sql.end();
    return;
  }

  /* THE RULE, IMPORTED — not restated. `isSoFullyCovered` is the pure predicate
     `syncSoDeliveredFromDo` itself decides with, so this repair cannot disagree
     with the app about what "delivered" means. Only the PLUMBING is local.

     Why the plumbing is local at all: the sync's own reads use PostgREST
     embedded selects, `pgrest-shim` does not implement those, and the sync
     swallows the throw per document — so calling it from here silently changed
     nothing and reported success (docs/bugs/0599-*). The SQL below reads exactly
     what it reads: delivery lines EXCLUDING {DRAFT, CANCELLED} orders, netted of
     non-cancelled returns. That equivalence was checked against the probe before
     this was written, and returns accounted for 0 of the shortfall. */
  const { isSoFullyCovered } = await import("../src/scm/lib/so-delivery-sync.ts");

  const docs = cands.map((r) => r.doc_no);
  const soLines = await sql`
    SELECT i.id, i.doc_no, i.qty::numeric AS qty
      FROM scm.mfg_sales_order_items i
     WHERE i.doc_no = ANY(${docs}) AND COALESCE(i.cancelled, false) = false`;
  const doLines = await sql`
    SELECT di.id, di.so_item_id, di.qty::numeric AS qty, i.doc_no
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders dh ON dh.id = di.delivery_order_id
      JOIN scm.mfg_sales_order_items i ON i.id = di.so_item_id
     WHERE i.doc_no = ANY(${docs})
       AND upper(COALESCE(dh.status::text, '')) NOT IN ('DRAFT', 'CANCELLED')`;
  const retLines = await sql`
    SELECT di.so_item_id, dri.qty_returned::numeric AS qty, i.doc_no
      FROM scm.delivery_return_items dri
      JOIN scm.delivery_returns dr ON dr.id = dri.delivery_return_id
      JOIN scm.delivery_order_items di ON di.id = dri.do_item_id
      JOIN scm.mfg_sales_order_items i ON i.id = di.so_item_id
     WHERE i.doc_no = ANY(${docs})
       AND upper(COALESCE(dr.status::text, '')) <> 'CANCELLED'`;

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.doc_no)) m.set(r.doc_no, []);
      m.get(r.doc_no).push(r);
    }
    return m;
  };
  const soBy = group(soLines), doBy = group(doLines), retBy = group(retLines);

  const toAdvance = [];
  for (const r of cands) {
    const lines = (soBy.get(r.doc_no) ?? []).map((l) => ({ id: l.id, qty: Number(l.qty) }));
    if (lines.length === 0) continue;
    const dls = (doBy.get(r.doc_no) ?? []).map((d) => ({ soItemId: d.so_item_id, qty: Number(d.qty) }));
    const rls = (retBy.get(r.doc_no) ?? []).map((d) => ({ soItemId: d.so_item_id, qty: Number(d.qty) }));
    if (isSoFullyCovered(lines, dls, rls)) toAdvance.push(r.doc_no);
  }

  log(`fully covered and therefore to advance: ${toAdvance.length} of ${cands.length}`);
  for (const d of toAdvance.slice(0, 25)) log(`   ${d} (${before.get(d)} -> DELIVERED)`);
  if (toAdvance.length === 0) { log("nothing to advance."); await sql.end(); return; }

  const moved = await sql`
    UPDATE scm.mfg_sales_orders SET status = 'DELIVERED', updated_at = now()
     WHERE doc_no = ANY(${toAdvance})
       AND upper(status::text) = ANY(${CANDIDATE_STATUSES})
   RETURNING doc_no, company_id`;
  log(`APPLIED — ${moved.length} order(s) advanced to DELIVERED.`);

  /* VERIFY on a FRESH connection, on the VALUES. */
  const v = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const after = await v`
    SELECT doc_no, company_id, status::text AS status FROM scm.mfg_sales_orders
     WHERE doc_no = ANY(${moved.map((m) => m.doc_no)})`;
  const wrong = after.filter((r) => String(r.status).toUpperCase() !== "DELIVERED");
  log(`VERIFY (fresh connection, values not counts): ${after.length} of ${moved.length} re-read;`
    + ` DELIVERED on ${after.length - wrong.length}`);
  for (const r of wrong.slice(0, 5)) log(`   UNEXPECTED ${r.doc_no} (company ${r.company_id}): '${r.status}'`);
  if (wrong.length || after.length !== moved.length) log("VERIFY FAILED — investigate before re-running.");
  await v.end();
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
