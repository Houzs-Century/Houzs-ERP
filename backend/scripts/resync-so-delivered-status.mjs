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
// WHAT IT CANNOT DO, said plainly: the sync also RELEASES a DELIVERED order back
// to READY_TO_SHIP when a return un-covers it. Re-offering every candidate means
// that arm can fire too. That is the same function the app runs and is correct
// by construction, but it means this is not a one-directional repair and the
// plan prints both directions before anything is written.
//
//   DATABASE_URL   required
//   COMPANY        a company id, or `all` (default all)
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
const CANDIDATE_STATUSES = ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "DELIVERED"];

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

  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const { syncSoDeliveredFromDo } = await import("../src/scm/lib/so-delivery-sync.ts");
  const sb = pgrestShim(sql, "scm");

  /* One document at a time. The function is per-document already and a batch
     would hide which one threw. */
  let called = 0;
  for (const r of cands) {
    await syncSoDeliveredFromDo(sb, [r.doc_no], null);
    called += 1;
    if (called % 200 === 0) log(`   ..${called}/${cands.length}`);
  }
  log(`offered ${called} order(s) to the auto-advance.`);

  /* VERIFY on a FRESH connection, on the VALUES: what actually moved, in which
     direction. The sync releases as well as advances, so a count of "changed"
     would hide a release behind an advance. */
  const v = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const after = await v`
    SELECT doc_no, status::text AS status FROM scm.mfg_sales_orders
     WHERE doc_no = ANY(${cands.map((r) => r.doc_no)})`;
  const advanced = [], released = [], other = [];
  for (const row of after) {
    const was = before.get(row.doc_no);
    if (!was || was === row.status) continue;
    if (row.status === "DELIVERED") advanced.push(`${row.doc_no} ${was}->DELIVERED`);
    else if (was === "DELIVERED") released.push(`${row.doc_no} DELIVERED->${row.status}`);
    else other.push(`${row.doc_no} ${was}->${row.status}`);
  }
  log("");
  log(`VERIFY (fresh connection, values not counts): ${after.length} of ${cands.length} re-read`);
  log(`   ADVANCED to DELIVERED: ${advanced.length}`);
  for (const s of advanced.slice(0, 20)) log(`      ${s}`);
  log(`   RELEASED out of DELIVERED (a return un-covered it): ${released.length}`);
  for (const s of released.slice(0, 20)) log(`      ${s}`);
  if (other.length) {
    log(`   OTHER movement — unexpected, read these: ${other.length}`);
    for (const s of other.slice(0, 20)) log(`      ${s}`);
  }
  if (after.length !== cands.length) log("VERIFY FAILED — not every order re-read.");
  await v.end();
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
