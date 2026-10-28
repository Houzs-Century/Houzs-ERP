#!/usr/bin/env node
/* Stamp the customer's party CODE onto AR lines that carry only a name.

   Why (owner 2026-09-08, 做,第 3 点也做): the AR control keeps one customer
   apart from the next by the PARTY on each journal line. 2990's orders carry
   no debtor code, so the 171 customer payments booked on 2026-09-08 (and any
   refund posted before this) stamped party_name alone — two customers who
   share a name merge in every party view, and one customer whose name was
   typed two ways splits. Every 2990 order does carry a customer_id, so the
   rule (customerPartyCode, acc/payments.ts) is: the debtor code when the
   business keeps one, else the order's customer_id. New postings stamp it
   themselves; this script gives the lines booked before the rule the same
   code, resolved from the document behind each entry.

   WHICH rows, exactly — never "every customer line":
     • journal_entry_lines with party_type CUSTOMER and party_code NULL, whose
       entry is a SOPAY (source_doc_no = the SO payment row id → its order), or
       a PV of purpose CUSTOMER_REFUND (source_doc_no = the voucher number →
       the voucher's own customer);
     • only where the document yields a code (debtor code or customer_id). A
       line whose document yields nothing is listed and left alone.
   Nothing else on the line moves: amounts, accounts, names all stay.

   MODE=plan (default) reports; MODE=apply needs CONFIRM="STAMP CUSTOMER PARTY CODES".
   RE-RUN: convergent — a stamped line no longer matches and reports nothing.
   Verification re-reads on a FRESH connection and asserts the shape: zero
   resolvable lines still without a code. */
import postgres from "postgres";

const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = "STAMP CUSTOMER PARTY CODES";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
if (APPLY && process.env.CONFIRM !== CONFIRM) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM}"`); process.exit(2);
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The same precedence as customerPartyCode in acc/payments.ts: the debtor code
   when kept (blank = not kept), else the customer's id. */
const CANDIDATES = (sql) => sql`
  WITH so AS (
    SELECT l.id AS line_id, e.je_no, e.company_id, e.source_type, e.source_doc_no, l.party_name,
           COALESCE(NULLIF(BTRIM(o.debtor_code), ''), o.customer_id::text) AS code
    FROM scm.journal_entry_lines l
    JOIN scm.journal_entries e ON e.id = l.journal_entry_id
    JOIN scm.mfg_sales_order_payments p ON p.id::text = e.source_doc_no
    JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
    WHERE l.party_type = 'CUSTOMER' AND l.party_code IS NULL
      AND e.source_type = 'SOPAY'
      AND (e.company_id IS NULL OR o.company_id = e.company_id)
  ), pv AS (
    SELECT l.id AS line_id, e.je_no, e.company_id, e.source_type, e.source_doc_no, l.party_name,
           COALESCE(NULLIF(BTRIM(v.debtor_code), ''), v.customer_id::text) AS code
    FROM scm.journal_entry_lines l
    JOIN scm.journal_entries e ON e.id = l.journal_entry_id
    JOIN scm.payment_vouchers v ON v.pv_number = e.source_doc_no
    WHERE l.party_type = 'CUSTOMER' AND l.party_code IS NULL
      AND e.source_type = 'PV' AND v.purpose = 'CUSTOMER_REFUND'
      AND (e.company_id IS NULL OR v.company_id = e.company_id)
  )
  SELECT * FROM so UNION ALL SELECT * FROM pv
  ORDER BY company_id, je_no`;

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  note(`mode=${APPLY ? "APPLY" : "PLAN (read-only)"}`);
  const rows = await CANDIDATES(sql);
  const todo = rows.filter((r) => r.code != null && String(r.code).trim() !== "");
  const stuck = rows.filter((r) => !(r.code != null && String(r.code).trim() !== ""));
  const perCompany = new Map();
  for (const r of todo) perCompany.set(r.company_id, (perCompany.get(r.company_id) ?? 0) + 1);
  for (const [co, n] of perCompany) note(`co${co}: ${n} line(s) to stamp`);
  for (const r of todo.slice(0, 20)) note(`  co${r.company_id} ${r.je_no} (${r.source_type} ${r.source_doc_no}) ${r.party_name ?? "(no name)"} -> ${r.code}`);
  if (todo.length > 20) note(`  … and ${todo.length - 20} more`);
  for (const r of stuck) note(`LEFT ALONE (no code on the document): co${r.company_id} ${r.je_no} ${r.party_name ?? "(no name)"}`);
  if (!APPLY) { note(`PLAN complete — ${todo.length} line(s) would be stamped, ${stuck.length} left alone.`); }
  else {
    let stamped = 0;
    for (const r of todo) {
      const res = await sql`UPDATE scm.journal_entry_lines
        SET party_code = ${String(r.code)}
        WHERE id = ${r.line_id} AND party_type = 'CUSTOMER' AND party_code IS NULL`;
      stamped += res.count;
    }
    note(`stamped ${stamped} of ${todo.length}`);
    // fresh-connection SHAPE verification
    await sql.end({ timeout: 5 });
    const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
    const left = (await CANDIDATES(check)).filter((r) => r.code != null && String(r.code).trim() !== "");
    await check.end({ timeout: 5 });
    note(`verify: ${left.length} resolvable line(s) still without a code`);
    if (left.length > 0 || stamped !== todo.length) { console.error("VERIFICATION FAILED"); process.exit(1); }
    note("APPLIED and verified on a fresh connection.");
    process.exit(0);
  }
} finally {
  try { await sql.end({ timeout: 5 }); } catch { /* closed above on apply */ }
}
