// Clear a sales-order LINE's delivery date when its HEADER carries no date at all.
//
// WHY. MRP's visibility gate is the EFFECTIVE delivery date
// (`shared/effective-delivery.ts`): the line's own date when it is explicitly
// overridden, else the header's amended date, else the header's customer date,
// else — as a last-resort MIRROR — the line's date again. That last fallback is
// what puts an order on the MRP page when its header has no date whatsoever:
// the line date stands in for a header date that was never set.
//
// Owner, 2026-09-11, after opening several of them: 「如果你看到 order info 的
// processing date 跟 delivery date 是空的，就直接把它的 item delivery date
// 清空；清空后 MRP 就不会再 show 出来了」. In documentation both header dates are
// blank, so the line date is not a promise anybody made — it is a leftover.
//
// MEASURED BEFORE BUILDING, and it is SMALL: on production (company 1, live
// orders) this shape is 2 lines on 1 order. The other 174 lines that show on MRP
// without a processing date have a REAL header delivery date and are NOT this —
// clearing their line dates would change nothing, because the header date is
// what MRP reads for them. That distinction is the whole reason this script
// selects on the header being empty rather than on "no processing date".
//
// MODE=plan (default) is READ-ONLY. MODE=apply needs CONFIRM="CLEAR LINE DATES".
// It writes ONE column — `line_delivery_date` — and only on lines whose header
// has no `processing_date`, no `customer_delivery_date` and no
// `amended_delivery_date`. It never touches a header.
//
// RE-RUN: idempotent. A cleared line stops matching the selector (which requires
// `line_delivery_date IS NOT NULL`), so a second run reports 0.
//
// ENUM TRAP (house rule): status columns are enums — `::text` before comparing,
// never `COALESCE(col,'')`.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const MODE = (process.env.MODE ?? "plan").toLowerCase();
const CONFIRM = process.env.CONFIRM ?? "";
const COMPANY = String(process.env.COMPANY ?? "1");
const PHRASE = "CLEAR LINE DATES";

if (MODE !== "plan" && MODE !== "apply") { console.error(`MODE must be plan or apply (got "${MODE}")`); process.exit(1); }
if (MODE === "apply" && CONFIRM !== PHRASE) { console.error(`MODE=apply needs CONFIRM="${PHRASE}"`); process.exit(1); }

const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);

const targets = await sql`
  select i.id, i.doc_no, i.line_no, i.item_code,
         i.line_delivery_date::text as ldd,
         i.line_delivery_date_overridden as overridden,
         s.debtor_name, s.status::text as so_status, s.so_date::text as so_date
  from scm.mfg_sales_order_items i
  join scm.mfg_sales_orders s on s.doc_no = i.doc_no
  where i.company_id::text = ${COMPANY}
    and i.cancelled = false
    and i.line_delivery_date is not null
    and s.processing_date is null
    and s.customer_delivery_date is null
    and s.amended_delivery_date is null
    and s.status::text not in ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED','DRAFT')
  order by i.doc_no, i.line_no`;

console.log(`\n=== Lines whose header carries NO date, so the line date is the only thing putting them on MRP (${targets.length}) ===`);
console.log(`${pad("SO", 16)}${pad("LN", 4)}${pad("ITEM", 22)}${pad("LINE DATE", 12)}${pad("OVERRIDDEN", 12)}${pad("SO STATUS", 15)}CUSTOMER`);
for (const r of targets) {
  console.log(`${pad(r.doc_no, 16)}${pad(r.line_no, 4)}${pad(r.item_code, 22)}${pad(r.ldd, 12)}${pad(String(r.overridden), 12)}${pad(r.so_status, 15)}${r.debtor_name ?? ""}`);
}
notice(`plan: ${targets.length} line date(s) to clear across ${new Set(targets.map((r) => r.doc_no)).size} order(s)`);

if (MODE === "plan") {
  console.log(`\nPLAN ONLY — nothing was written. Re-run with MODE=apply CONFIRM="${PHRASE}" to write.`);
  await sql.end();
  process.exit(0);
}

let wrote = 0;
await sql.begin(async (tx) => {
  for (const r of targets) {
    /* Re-assert the precondition INSIDE the transaction: a header date set
       between the plan and the apply makes the line date meaningful again, and
       this must not clear it. */
    const res = await tx`
      update scm.mfg_sales_order_items i
      set line_delivery_date = null
      from scm.mfg_sales_orders s
      where i.id = ${r.id} and s.doc_no = i.doc_no
        and i.line_delivery_date is not null
        and s.processing_date is null
        and s.customer_delivery_date is null
        and s.amended_delivery_date is null
      returning i.id`;
    if (res.length === 1) wrote += 1;
    else console.log(`::warning::${r.doc_no} line ${r.line_no} changed since the plan — left alone`);
  }
});
notice(`APPLIED: ${wrote} line date(s) cleared`);

/* Verification on a FRESH connection. A row count is not a shape: `update …
   returning id` reports a row for a write that cleared the WRONG line, and the
   wrong line here is a real delivery promise erased. Re-open a separate
   connection and assert each target now reads NULL and its header is still
   dateless — the second half matters because a header date appearing between
   the write and the read would mean the line date should have been kept. */
await sql.end();
const verify = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const bad = [];
for (const r of targets) {
  const [row] = await verify`
    select i.line_delivery_date::text as ldd, s.processing_date::text as pd,
           s.customer_delivery_date::text as cdd, s.amended_delivery_date::text as add_
    from scm.mfg_sales_order_items i join scm.mfg_sales_orders s on s.doc_no = i.doc_no
    where i.id = ${r.id}`;
  if (!row) { bad.push(`${r.doc_no} line ${r.line_no}: row not found on re-read`); continue; }
  if (row.ldd !== null) bad.push(`${r.doc_no} line ${r.line_no}: line_delivery_date still reads ${row.ldd}`);
  else if (row.pd || row.cdd || row.add_) bad.push(`${r.doc_no} line ${r.line_no}: CLEARED, but the header now carries a date (${row.pd ?? "-"}/${row.cdd ?? "-"}/${row.add_ ?? "-"}) — re-check this one by hand`);
}
await verify.end();

if (bad.length > 0) {
  console.log("\n=== VERIFICATION FAILED ===");
  for (const b of bad) console.log(`::error::${b}`);
  process.exit(1);
}
notice(`verified on a fresh connection: all ${targets.length} line(s) read back cleared`);
console.log("\nThese orders now carry no delivery date anywhere, so MRP no longer shows them.");
console.log("That is the intended effect and it is also the warning: if one of them is a REAL order, it now needs a header date, not a line date.");
