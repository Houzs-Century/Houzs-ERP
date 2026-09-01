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

  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const { syncSoDeliveredFromDo } = await import("../src/scm/lib/so-delivery-sync.ts");
  const sb = pgrestShim(sql, "scm");

  /* PRE-FLIGHT, and it is the whole reason this script can be trusted.
     `syncSoDeliveredFromDo` wraps each document in its own try/catch, so a read
     that THROWS is swallowed and the document is silently left alone. Its
     coverage read uses a PostgREST embedded select
     (`delivery_orders!inner(status)`) and `pgrest-shim` does not implement those
     — it throws `pgrest-shim GAP`. Put together, the first APPLY run of this
     script offered 68 orders, moved 0, and reported SUCCESS: a verdict computed
     over nothing, which CLAUDE.md names as the shape that must never read as a
     pass. It nearly got reported as "nothing needed fixing".

     So run that exact read HERE, outside the swallow, and REFUSE if it cannot
     execute. A repair that cannot do its work must say so, not finish quietly. */
  try {
    await sb.from("delivery_order_items")
      .select("id, so_item_id, qty, delivery_orders!inner(status)")
      .in("so_item_id", []);
  } catch (e) {
    console.error(`REFUSED: the coverage read cannot execute through this client — ${(e && e.message) || e}`);
    console.error("syncSoDeliveredFromDo swallows a throw per document, so running on would");
    console.error("silently change nothing and report success. Use a real PostgREST client,");
    console.error("or teach pgrest-shim embedded selects, first.");
    await sql.end();
    process.exit(3);
  }

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
