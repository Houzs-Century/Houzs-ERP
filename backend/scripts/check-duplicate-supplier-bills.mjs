// READ-ONLY. How many supplier bill numbers are booked more than once on live
// purchase invoices / AP invoices, per company?
//
// WHY THIS EXISTS. Until fix/sister-g2 nothing refused a second live invoice
// carrying the same supplier's bill number: the scan queue only flagged it and
// the New forms did not look. The route refusal ships regardless; a UNIQUE
// index would be the durable guard, and it can only be built if production
// holds no duplicates. This answers that without anyone opening a SQL console.
//
// THE KEY is the one the route uses (lib/duplicate-supplier-bill.ts billRefKey):
// whitespace removed, upper case, per company + supplier, CANCELLED rows left
// out, AP invoices compared within their own doc_kind (NULL read as INV).
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 for every
// answer, including zero; only an unreachable database or a query error exits
// non-zero.
// RE-RUN: read-only, a second run reports the same counts plus anything new.
import "./lib/public-log-guard.mjs";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });

async function main() {
  const rows = await sql`
    WITH live AS (
      SELECT 'purchase_invoices' AS tbl, company_id, supplier_id::text AS supplier_id, 'INV' AS kind,
             upper(regexp_replace(supplier_invoice_ref, '\\s+', '', 'g')) AS k, status
        FROM scm.purchase_invoices
       WHERE status <> 'CANCELLED' AND supplier_invoice_ref IS NOT NULL
      UNION ALL
      SELECT 'ap_invoices', company_id, supplier_id::text, upper(COALESCE(doc_kind, 'INV')),
             upper(regexp_replace(supplier_invoice_ref, '\\s+', '', 'g')), status
        FROM scm.ap_invoices
       WHERE status <> 'CANCELLED' AND supplier_invoice_ref IS NOT NULL
    ), groups AS (
      SELECT tbl, company_id, supplier_id, kind, k, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE status = 'DRAFT')::int AS drafts
        FROM live WHERE k <> ''
       GROUP BY tbl, company_id, supplier_id, kind, k
      HAVING COUNT(*) > 1
    )
    SELECT tbl, company_id, COUNT(*)::int AS dup_numbers, SUM(n)::int AS rows_involved,
           SUM(drafts)::int AS drafts_involved, MAX(n)::int AS worst
      FROM groups GROUP BY tbl, company_id ORDER BY tbl, company_id`;

  if (rows.length === 0) {
    notice("ZERO duplicates: no supplier bill number is booked twice on a live purchase invoice or AP invoice. A unique index is buildable.");
    return;
  }
  for (const r of rows) {
    notice(`${r.tbl} company ${r.company_id}: ${r.dup_numbers} bill number(s) booked more than once, ${r.rows_involved} invoices involved (${r.drafts_involved} still DRAFT), worst ${r.worst} copies`);
  }
  notice("Duplicates exist: a unique index would fail to build until these are cancelled or corrected.");
}

try {
  await main();
} catch (e) {
  console.error("check failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
