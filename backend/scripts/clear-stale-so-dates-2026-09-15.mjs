#!/usr/bin/env node
/* Clear the dates that keep 28 stale sales orders on MRP and the delivery board.

   OWNER, 2026-09-15, on the list MRP垃圾单清单20260911 — groups A and B named
   one by one, group C (partly delivered) by the rule and his screenshot of
   HC-SO-008586:
     「就是以下的 processing date delivery date item delivery date 都 remove 掉」
     「如果已经送货了的，你就 remain 着 … 如果还没送货的：把 delivery date /
       delivered 清掉，processing / unprocessed 清掉，让它可以重新 post。这样我
       MRP 那边就不会跑出来」

   MRP gates a line on its delivery date and the order on its Processing Date
   (no Processing Date = not proceeded, the owner's standing rule). Clearing both
   takes the order off MRP and off the delivery board, and lets it be proceeded
   again. Nothing is cancelled; quantities, prices and lines stay.

   PER ORDER (company 1):
     - header processing_date -> NULL, customer_delivery_date -> NULL, and
       `version` + 1 (the concurrency token, as clear-so-dates does) so a form
       left open in a browser cannot save the old dates back
     - every line that has NOT been delivered: line_delivery_date -> NULL,
       line_delivery_date_overridden -> false
     - a line already on a live delivery order (any DO that is not CANCELLED or
       DRAFT, qty > 0) is DELIVERED and is left exactly as it is
   Purchase orders already raised for these lines are not touched; they are
   listed.

   MODE=plan (default) runs inside a transaction and ROLLS BACK.
   MODE=apply requires CONFIRM="CLEAR STALE SO DATES".
   After an apply a FRESH connection re-reads every order: header dates NULL,
   every undelivered line's date NULL, and every delivered line's date equal to
   what it was before.

   RE-RUN: idempotent. A second run finds the dates already NULL and writes
   nothing. */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "CLEAR STALE SO DATES";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
const COMPANY = 1;
const DOCS = String(process.env.DOCS || [
  "HC-SO-008460", "HC-SO-007958", "HC-SO-004716", "HC-SO-003189", "HC-SO-002366", "HC-SO-002315", "HC-SO-000015",
  "HC-SO-001526", "HC-SO-001640", "HC-SO-001473", "HC-SO-001472", "HC-SO-001255", "HC-SO-001112", "HC-SO-001180",
  "HC-SO-013505", "HC-SO-013394", "HC-SO-013361", "HC-SO-013339", "HC-SO-013319", "HC-SO-012435",
  // group C, partly delivered — the owner's screenshot was HC-SO-008586
  "HC-SO-010504", "HC-SO-008586", "HC-SO-004391", "HC-SO-007435", "HC-SO-001920", "HC-SO-006438", "HC-SO-004197", "HC-SO-002281",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const d = (v) => (v == null ? "-" : String(v).slice(0, 10));

async function plan(tx) {
  notice(`=== clear stale SO dates — ${APPLY ? "APPLY" : "PLAN (rolled back)"} · ${DOCS.length} orders ===`);
  const expect = [];
  let headers = 0, lineWrites = 0, keptDelivered = 0;
  for (const doc of DOCS) {
    const [h] = await tx`SELECT doc_no, status::text AS st, processing_date::text AS proc, customer_delivery_date::text AS cdd, debtor_name
      FROM scm.mfg_sales_orders WHERE doc_no = ${doc} AND company_id = ${COMPANY}`;
    if (!h) { notice(`${doc}: NOT FOUND in company ${COMPANY} — skipped`); continue; }
    const lines = await tx`SELECT i.id::text AS id, i.line_no, i.item_code, i.qty, i.cancelled, i.line_delivery_date::text AS ldd,
        coalesce((SELECT sum(di.qty) FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
                  WHERE di.so_item_id = i.id AND o.status::text NOT IN ('CANCELLED','DRAFT')), 0)::numeric AS delivered,
        (SELECT string_agg(DISTINCT o.do_number || ' ' || o.status::text, ', ') FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
          WHERE di.so_item_id = i.id) AS dos,
        (SELECT string_agg(DISTINCT p.po_number || ' ' || p.status::text, ', ') FROM scm.purchase_order_items pi JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
          WHERE pi.so_item_id = i.id) AS pos
      FROM scm.mfg_sales_order_items i WHERE i.doc_no = ${doc} ORDER BY i.line_no NULLS LAST, i.created_at`;
    say(`\n${doc} · ${h.debtor_name} · ${h.st} · processing ${d(h.proc)} · delivery ${d(h.cdd)}`);
    if (h.proc || h.cdd) {
      await tx`UPDATE scm.mfg_sales_orders SET processing_date = NULL, customer_delivery_date = NULL, version = version + 1 WHERE doc_no = ${doc} AND company_id = ${COMPANY}`;
      headers++;
    }
    const kept = [];
    for (const l of lines) {
      const delivered = Number(l.delivered) > 0;
      const tag = delivered ? `DELIVERED ${l.delivered} — kept` : (l.ldd ? "date cleared" : "no date");
      say(`   ln${l.line_no ?? "-"} ${l.item_code} qty ${l.qty}${l.cancelled ? " CANCELLED" : ""} · line date ${d(l.ldd)} · ${tag}${l.dos ? ` · DO ${l.dos}` : ""}${l.pos ? ` · PO ${l.pos}` : ""}`);
      if (delivered) { keptDelivered++; kept.push({ id: l.id, ldd: l.ldd }); continue; }
      if (l.ldd) {
        await tx`UPDATE scm.mfg_sales_order_items SET line_delivery_date = NULL, line_delivery_date_overridden = false WHERE id = ${l.id} AND company_id = ${COMPANY}`;
        lineWrites++;
      }
    }
    expect.push({ doc, kept, undelivered: lines.filter((l) => Number(l.delivered) <= 0).map((l) => l.id) });
  }
  notice(`headers cleared ${headers} · line dates cleared ${lineWrites} · delivered lines kept ${keptDelivered}`);
  return expect;
}

async function verify(expect) {
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const fails = [];
  try {
    for (const e of expect) {
      const [h] = await check`SELECT processing_date, customer_delivery_date FROM scm.mfg_sales_orders WHERE doc_no = ${e.doc}`;
      if (h.processing_date !== null || h.customer_delivery_date !== null) fails.push(`${e.doc} header dates not NULL`);
      if (e.undelivered.length) {
        const [r] = await check`SELECT count(*)::int AS n FROM scm.mfg_sales_order_items WHERE id::text = ANY(${e.undelivered}) AND line_delivery_date IS NOT NULL`;
        if (r.n) fails.push(`${e.doc}: ${r.n} undelivered lines still dated`);
      }
      for (const k of e.kept) {
        const [r] = await check`SELECT line_delivery_date::text AS ldd FROM scm.mfg_sales_order_items WHERE id::text = ${k.id}`;
        if ((r?.ldd ?? null) !== (k.ldd ?? null)) fails.push(`${e.doc}: delivered line ${k.id} date moved ${k.ldd} -> ${r?.ldd}`);
      }
    }
  } finally { await check.end(); }
  if (fails.length) { notice(`VERIFY FAILED: ${fails.join(" | ")}`); process.exit(1); }
  notice(`VERIFY OK (fresh connection): ${expect.length} orders — header dates NULL, undelivered line dates NULL, delivered lines unchanged`);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
let expect;
try {
  await sql.begin(async (tx) => {
    expect = await plan(tx);
    if (!APPLY) throw new Error("PLAN_ROLLBACK");
  }).catch((e) => { if (e.message !== "PLAN_ROLLBACK") throw e; });
} catch (e) { console.error(e); await sql.end(); process.exit(1); }
await sql.end();
if (!APPLY) { notice("PLAN — rolled back, nothing written."); process.exit(0); }
await verify(expect);
