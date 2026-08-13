#!/usr/bin/env node
// Give every migrated purchase order the delivery date it always had.
//
// Owner spotted it on the screen (2026-08-10): EXPECTED DELIVERY blank on a
// migrated PO. AutoCount carries a delivery date on ALL 579 imported lines, and
// both importers wrote it — onto the LINE. The PO screen's EXPECTED DELIVERY
// reads the HEADER, which neither importer set, so a date that was never
// missing looked missing on every migrated document.
//
// The importers now derive it at insert. This gives the same value to the
// documents already in the database, using the same rule the app's own SO->PO
// convert uses: the earliest delivery date among the PO's own lines.
//
// Only fills a header that has NO date. A header someone has since set by hand
// is left exactly as it is.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. The UPDATE re-asserts expected_at IS NULL. A person who CLEARS an ETA would get it refilled - accepted, because expected_at has no clear action in the UI.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const [{ total, blank }] = await sql`SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE expected_at IS NULL)::int blank
    FROM scm.purchase_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  log(`migrated purchase orders: ${total}; header delivery date blank: ${blank}`);

  const plan = await sql`SELECT p.id, p.po_number, MIN(i.delivery_date) AS eta,
      COUNT(i.id)::int lines, COUNT(i.delivery_date)::int lines_with_date
    FROM scm.purchase_orders p JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
    WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL AND p.expected_at IS NULL
    GROUP BY p.id, p.po_number HAVING MIN(i.delivery_date) IS NOT NULL
    ORDER BY p.po_number`;
  const noLineDate = blank - plan.length;
  log(`can be filled from their own lines: ${plan.length}; still blank because no LINE carries a date either: ${noLineDate}`);
  for (const r of plan.slice(0, 10)) log(`   ${r.po_number} -> ${String(r.eta).slice(0, 10)} (${r.lines_with_date}/${r.lines} lines dated)`);
  if (plan.length > 10) log(`   ... and ${plan.length - 10} more`);
  if (!plan.length) { await sql.end(); return; }
  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write. Only a header with NO date is touched."); await sql.end(); return; }

  let n = 0;
  for (const r of plan) {
    await sql`UPDATE scm.purchase_orders SET expected_at = ${r.eta}
      WHERE id = ${r.id} AND expected_at IS NULL`;
    n += 1;
  }
  log(`DONE. purchase orders given their delivery date: ${n}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
