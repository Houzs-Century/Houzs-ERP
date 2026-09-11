// Clear the delivery dates of an ABANDONED sales order so it leaves the MRP page.
//
// THE OWNER'S RULE, 2026-09-11, in his words: an expired order that has shipped
// NOTHING is rubbish — clear its dates and it drops off MRP. An order that has
// shipped SOMETHING keeps its date, deliberately: 「那些已经送过货的呢，你就
// remain 着它的 delivery date… 我就会看到『哇，这个 delivery date 已经有了』，
// 然后我再去看它的 DO，我就懂它是 partial delivery 了」. The surviving date is
// the signal that sends him to the delivery order.
//
// So the split is SHIPPED-ANYTHING, not overdue-ness:
//   shipped 0 units  -> clear (header customer/amended date + every line date)
//   shipped > 0      -> touch nothing, ever
//
// AND AN AGE FLOOR, which the owner did not ask for and which this script
// imposes anyway — with the reason, because it is a judgement and he can
// override it with one input. Measured on production 2026-09-11: of the 21
// never-shipped expired orders, SIX are from 2026-08/09 and one (`HC-SO-013505`,
// ROY) was four days overdue. Those are not rubbish, they are live orders
// running late, and erasing a live order's delivery date hides it from the
// delivery board as well as from MRP. `BEFORE` defaults to 2026-01-01 so the
// 2024-2025 backlog clears and the recent ones are listed for a human instead.
// Pass BEFORE=2027-01-01 to include them once he says so.
//
// MODE=plan (default) is READ-ONLY and prints EVERY date it would erase — that
// printout is the restore record, because these columns carry no history. Keep
// the run log.
//
// MODE=apply needs CONFIRM="CLEAR ABANDONED DATES". It writes
// `customer_delivery_date`, `amended_delivery_date` and the lines'
// `line_delivery_date`. It never cancels an order and never touches a line's
// quantity — the order stays exactly as real as it was, it just stops claiming
// a date nobody is working to.
//
// RE-RUN: idempotent. A cleared order no longer matches the selector (which
// needs a non-null effective date), so a second run reports 0.
//
// ENUM TRAP: status columns are enums — `::text` before comparing.
// DATE TRAP: dates are returned `::text`, never as Date objects — `String(d)`
// on a pg date gives "Sun May 12 ..." and slicing it yields nonsense.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const MODE = (process.env.MODE ?? "plan").toLowerCase();
const CONFIRM = process.env.CONFIRM ?? "";
const COMPANY = String(process.env.COMPANY ?? "1");
const BEFORE = process.env.BEFORE ?? "2026-01-01";
const PHRASE = "CLEAR ABANDONED DATES";

if (MODE !== "plan" && MODE !== "apply") { console.error(`MODE must be plan or apply (got "${MODE}")`); process.exit(1); }
if (MODE === "apply" && CONFIRM !== PHRASE) { console.error(`MODE=apply needs CONFIRM="${PHRASE}"`); process.exit(1); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(BEFORE)) { console.error(`BEFORE must be YYYY-MM-DD (got "${BEFORE}")`); process.exit(1); }

const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

const rows = await sql`
  with candidate as (
    select s.doc_no, s.debtor_name, s.status::text as so_status,
           s.customer_delivery_date::text as cdd,
           s.amended_delivery_date::text as amended,
           s.processing_date::text as pd,
           coalesce(s.amended_delivery_date, s.customer_delivery_date) as eff
    from scm.mfg_sales_orders s
    join scm.mfg_sales_order_items i on i.doc_no = s.doc_no
    where i.company_id::text = ${COMPANY} and i.cancelled = false and i.qty > 0
      and s.processing_date is null
      and coalesce(s.amended_delivery_date, s.customer_delivery_date) < current_date
      and s.status::text not in ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED','DRAFT')
    group by 1,2,3,4,5,6,7
  )
  select c.*,
    (current_date - c.eff)::int as days_late,
    (select coalesce(sum(di.qty),0)::int
       from scm.delivery_order_items di
       join scm.delivery_orders d on d.id = di.delivery_order_id
      where d.so_doc_no = c.doc_no and d.status::text not in ('CANCELLED','DRAFT')) as shipped_units,
    (select count(*)::int from scm.mfg_sales_order_items i
      where i.doc_no = c.doc_no and i.cancelled = false and i.line_delivery_date is not null) as dated_lines
  from candidate c
  order by c.eff`;

const shipped = rows.filter((r) => r.shipped_units > 0);
const never = rows.filter((r) => r.shipped_units === 0);
const clear = never.filter((r) => r.cdd < BEFORE || (r.amended && r.amended < BEFORE));
const recent = never.filter((r) => !clear.includes(r));

console.log(`\n=== WOULD CLEAR — never shipped a unit, and older than ${BEFORE} (${clear.length}) ===`);
console.log("THIS TABLE IS THE RESTORE RECORD. These columns keep no history; keep this log.");
console.log(`${pad("SO", 16)}${pad("CUSTOMER", 22)}${pad("customer_dd", 13)}${pad("amended_dd", 13)}${pad("LATE", 8)}dated lines`);
for (const r of clear) {
  console.log(`${pad(r.doc_no, 16)}${pad(r.debtor_name, 22)}${pad(r.cdd ?? "-", 13)}${pad(r.amended ?? "-", 13)}${pad(r.days_late + "d", 8)}${r.dated_lines}`);
}

console.log(`\n=== HELD BACK — never shipped, but recent (on or after ${BEFORE}) (${recent.length}) ===`);
console.log("These read as LIVE orders running late, not rubbish. Erasing their dates would hide them");
console.log("from the delivery board too. Pass BEFORE=<later date> to include them once that is the call.");
for (const r of recent) {
  console.log(`  ${pad(r.doc_no, 16)}${pad(r.debtor_name, 22)}${pad(r.cdd ?? "-", 13)}${pad(r.days_late + "d late", 12)}${r.so_status}`);
}

console.log(`\n=== UNTOUCHED — shipped something, so the date STAYS as the partial-delivery signal (${shipped.length}) ===`);
for (const r of shipped) {
  console.log(`  ${pad(r.doc_no, 16)}${pad(r.debtor_name, 22)}${pad(r.cdd ?? "-", 13)}shipped ${r.shipped_units} unit(s)`);
}

notice(`plan: clear ${clear.length}, hold back ${recent.length} as recent, leave ${shipped.length} partial-delivery orders alone`);

if (MODE === "plan") {
  console.log(`\nPLAN ONLY — nothing was written. Re-run with MODE=apply CONFIRM="${PHRASE}" to write.`);
  await sql.end();
  process.exit(0);
}

let heads = 0; let lines = 0;
await sql.begin(async (tx) => {
  for (const r of clear) {
    /* Re-assert INSIDE the transaction that nothing shipped since the plan. A
       delivery order raised in between makes this order partial, and a partial
       order must keep its date — that is the whole signal the owner asked for. */
    const [still] = await tx`
      select coalesce(sum(di.qty),0)::int as shipped
      from scm.delivery_order_items di
      join scm.delivery_orders d on d.id = di.delivery_order_id
      where d.so_doc_no = ${r.doc_no} and d.status::text not in ('CANCELLED','DRAFT')`;
    if (Number(still.shipped) > 0) { console.log(`::warning::${r.doc_no} has shipped since the plan — left alone`); continue; }
    const h = await tx`
      update scm.mfg_sales_orders
      set customer_delivery_date = null, amended_delivery_date = null
      where doc_no = ${r.doc_no} and processing_date is null
      returning doc_no`;
    if (h.length !== 1) { console.log(`::warning::${r.doc_no} changed since the plan — left alone`); continue; }
    heads += 1;
    const l = await tx`
      update scm.mfg_sales_order_items
      set line_delivery_date = null
      where doc_no = ${r.doc_no} and cancelled = false and line_delivery_date is not null
      returning id`;
    lines += l.length;
  }
});
notice(`APPLIED: ${heads} order header(s) and ${lines} line date(s) cleared`);

/* Verification on a FRESH connection. A row count is not a shape: the failure
   that matters is clearing an order that has since shipped, and a count cannot
   see that. Re-read each one and assert BOTH that the dates are gone AND that
   it still has no shipment — if it shipped, this cleared the wrong order and a
   human must put the date back from the table above. */
await sql.end();
const verify = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const bad = [];
for (const r of clear) {
  const [row] = await verify`
    select s.customer_delivery_date::text as cdd, s.amended_delivery_date::text as amended,
      (select count(*)::int from scm.mfg_sales_order_items i
        where i.doc_no = s.doc_no and i.cancelled = false and i.line_delivery_date is not null) as dated_lines,
      (select coalesce(sum(di.qty),0)::int from scm.delivery_order_items di
        join scm.delivery_orders d on d.id = di.delivery_order_id
       where d.so_doc_no = s.doc_no and d.status::text not in ('CANCELLED','DRAFT')) as shipped
    from scm.mfg_sales_orders s where s.doc_no = ${r.doc_no}`;
  if (!row) { bad.push(`${r.doc_no}: not found on re-read`); continue; }
  if (Number(row.shipped) > 0) bad.push(`${r.doc_no}: CLEARED but it HAS shipped ${row.shipped} unit(s) — put the date back: customer_delivery_date was ${r.cdd}`);
  else if (row.cdd || row.amended || Number(row.dated_lines) > 0) bad.push(`${r.doc_no}: still carries a date (header ${row.cdd ?? "-"}/${row.amended ?? "-"}, ${row.dated_lines} dated line(s))`);
}
await verify.end();

if (bad.length > 0) {
  console.log("\n=== VERIFICATION FAILED ===");
  for (const b of bad) console.log(`::error::${b}`);
  process.exit(1);
}
notice(`verified on a fresh connection: all ${clear.length} order(s) read back with no date and no shipment`);
console.log("\nThese orders now carry no delivery date, so MRP and the delivery board no longer show them.");
console.log("They are NOT cancelled — the lines and quantities are untouched. Cancelling is a separate decision.");
