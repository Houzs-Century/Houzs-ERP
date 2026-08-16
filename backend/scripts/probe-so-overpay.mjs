#!/usr/bin/env node
/* REFUTATION probe. Read-only. Re-tests the claims made about SO over-collection.

   The earlier probe reported "price rises whose delta EQUALS a payment amount: 0"
   with NO DENOMINATOR — a zero is worthless if the audit log records no price
   rises at all. It also examined only the 25 worst rows of the population
   measured against total_revenue_centi (the imported-order artefact), and never
   looked at the 8 genuine over-collections measured against local_total_centi.

   Writes nothing. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 0);
const LIMIT = Math.min(200, Number(process.env.LIMIT || 25));

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

async function tryQ(label, fn, fallback = []) {
  try { return await fn(); } catch (e) {
    note(`  !! ${label} failed: ${e.code ?? ''} ${e.message}`);
    return fallback;
  }
}

async function main() {
  // ── A. NULL vs 0: does the AutoCount reader refuse, or assert zero? ───────
  note('='.repeat(72));
  note('=== A. total_revenue_centi on non-cancelled SOs: NULL vs 0 vs positive');
  const a = await tryQ('trc shape', () => sql`
    SELECT
      count(*) FILTER (WHERE s.total_revenue_centi IS NULL)::int          AS trc_null,
      count(*) FILTER (WHERE s.total_revenue_centi = 0)::int              AS trc_zero,
      count(*) FILTER (WHERE s.total_revenue_centi > 0)::int              AS trc_pos,
      count(*) FILTER (WHERE coalesce(s.total_revenue_centi,0) = 0
                         AND coalesce(s.local_total_centi,0) > 0)::int    AS zero_trc_real_money,
      count(*)::int                                                       AS total
      FROM scm.mfg_sales_orders s
     WHERE s.status NOT IN ('CANCELLED','DRAFT')
       AND (${CO}::bigint = 0 OR s.company_id = ${CO}::bigint)`, [{}]);
  note(`total_revenue_centi IS NULL          : ${a[0].trc_null}`);
  note(`total_revenue_centi = 0              : ${a[0].trc_zero}`);
  note(`total_revenue_centi > 0              : ${a[0].trc_pos}`);
  note(`trc<=0 BUT local_total>0 (screen=0)  : ${a[0].zero_trc_real_money}`);
  note(`non-cancelled SOs total              : ${a[0].total}`);

  // ── B. THE DENOMINATOR the earlier probe never printed ───────────────────
  note('\n' + '='.repeat(72));
  note('=== B. does the audit log record line price changes AT ALL?');
  const b = await tryQ('audit denominator', () => sql`
    SELECT
      (SELECT count(*)::int FROM scm.mfg_so_audit_log)                              AS audit_rows_total,
      (SELECT count(*)::int FROM scm.mfg_so_audit_log WHERE action = 'UPDATE_LINE') AS update_line_rows,
      (SELECT count(*)::int FROM scm.mfg_so_audit_log
        WHERE action = 'UPDATE_LINE' AND field_changes::text LIKE '%unitPriceCenti%') AS update_line_price_rows`, [{}]);
  note(`mfg_so_audit_log rows (all)                       : ${b[0].audit_rows_total}`);
  note(`  action = UPDATE_LINE                            : ${b[0].update_line_rows}`);
  note(`  ... whose field_changes mention unitPriceCenti  : ${b[0].update_line_price_rows}`);

  const bshape = await tryQ('field_changes shape', () => sql`
    SELECT jsonb_typeof(field_changes) AS t, count(*)::int AS n
      FROM scm.mfg_so_audit_log WHERE field_changes IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC`);
  note(`field_changes jsonb_typeof: ${bshape.map((r) => `${r.t}=${r.n}`).join(', ') || '(none)'}`);

  const brise = await tryQ('price rises', () => sql`
    SELECT count(*)::int AS n_rises,
           coalesce(min((fc->>'to')::bigint - (fc->>'from')::bigint),0)::bigint AS min_delta,
           coalesce(max((fc->>'to')::bigint - (fc->>'from')::bigint),0)::bigint AS max_delta
      FROM scm.mfg_so_audit_log a
      CROSS JOIN LATERAL jsonb_array_elements(a.field_changes) fc
     WHERE a.action = 'UPDATE_LINE'
       AND fc->>'field' = 'unitPriceCenti'
       AND jsonb_typeof(fc->'from') = 'number' AND jsonb_typeof(fc->'to') = 'number'
       AND (fc->>'to')::bigint > (fc->>'from')::bigint`, [{}]);
  note(`unitPriceCenti RISES recorded anywhere            : ${brise[0].n_rises}  (delta ${rm(brise[0].min_delta)} .. ${rm(brise[0].max_delta)})`);

  const bsample = await tryQ('price rise sample', () => sql`
    SELECT a.so_doc_no, a.created_at::text AS at, a.actor_name_snapshot AS who,
           (fc->>'from')::bigint AS from_sen, (fc->>'to')::bigint AS to_sen
      FROM scm.mfg_so_audit_log a
      CROSS JOIN LATERAL jsonb_array_elements(a.field_changes) fc
     WHERE a.action = 'UPDATE_LINE'
       AND fc->>'field' = 'unitPriceCenti'
       AND jsonb_typeof(fc->'from') = 'number' AND jsonb_typeof(fc->'to') = 'number'
       AND (fc->>'to')::bigint > (fc->>'from')::bigint
     ORDER BY a.created_at DESC LIMIT 12`);
  for (const r of bsample) {
    note(`   ${r.so_doc_no} ${r.at} ${r.who ?? '?'}  ${rm(r.from_sen)} -> ${rm(r.to_sen)}  (+${rm(Number(r.to_sen) - Number(r.from_sen))})`);
  }

  const bov = await tryQ('override denominator', () => sql`
    SELECT count(*)::int AS n FROM scm.mfg_so_price_overrides`, [{ n: -1 }]);
  note(`mfg_so_price_overrides rows (whole table)         : ${bov[0].n}`);

  // ── C. THE GENUINE over-collections: paid > local_total_centi ────────────
  note('\n' + '='.repeat(72));
  note('=== C. genuine over-collections (sum(payments) > local_total_centi) — every one');
  const cRows = await tryQ('genuine over', () => sql`
    WITH pay AS (
      SELECT so_doc_no, sum(amount_centi)::bigint AS paid, count(*)::int AS n_rows
        FROM scm.mfg_sales_order_payments GROUP BY so_doc_no
    )
    SELECT s.doc_no, s.company_id, s.status, s.so_date::text AS so_date,
           s.total_revenue_centi, s.local_total_centi, s.balance_centi, s.deposit_centi,
           p.paid, p.n_rows, v.balance_centi_live
      FROM scm.mfg_sales_orders s
      JOIN pay p ON p.so_doc_no = s.doc_no
      LEFT JOIN scm.mfg_sales_orders_with_payment_totals v ON v.doc_no = s.doc_no
     WHERE s.status NOT IN ('CANCELLED','DRAFT')
       AND (${CO}::bigint = 0 OR s.company_id = ${CO}::bigint)
       AND p.paid > s.local_total_centi
     ORDER BY (p.paid - s.local_total_centi) DESC
     LIMIT ${LIMIT}::int`);
  note(`genuine over-collected orders listed: ${cRows.length}`);
  for (const r of cRows) {
    const excess = Number(r.paid) - Number(r.local_total_centi);
    note(`\n  ${r.doc_no}  co=${r.company_id}  ${r.status}  so_date=${r.so_date}`);
    note(`    local_total=${rm(r.local_total_centi)}  total_revenue=${rm(r.total_revenue_centi)}  paid=${rm(r.paid)} (${r.n_rows} rows)  OVER BY ${rm(excess)}`);
    note(`    view balance_centi_live=${rm(r.balance_centi_live)}   header balance_centi=${rm(r.balance_centi)}   header deposit=${rm(r.deposit_centi)}`);
    const pays = await tryQ('pays', () => sql`
      SELECT paid_at::text AS at, method, amount_centi, coalesce(is_deposit,false) AS is_deposit,
             created_at::text AS created_at, coalesce(note,'') AS note, coalesce(created_by::text,'') AS by
        FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${r.doc_no}::text ORDER BY created_at`);
    for (const p of pays) {
      note(`      pay ${p.at}  ${String(p.method).padEnd(11)} ${rm(p.amount_centi).padStart(13)}  ${p.is_deposit ? 'DEPOSIT' : 'balance'}  created=${p.created_at}  ${p.note.slice(0, 50)}`);
    }
    const au = await tryQ('audit', () => sql`
      SELECT created_at::text AS at, action, actor_name_snapshot AS who,
             coalesce(field_changes::text,'') AS changes, coalesce(source,'') AS source
        FROM scm.mfg_so_audit_log WHERE so_doc_no = ${r.doc_no}::text
       ORDER BY created_at`);
    const priceish = au.filter((x) => /unitPriceCenti|totalCenti|qty|Total/i.test(x.changes));
    note(`    audit rows: ${au.length}  (price/qty bearing: ${priceish.length})`);
    for (const x of priceish.slice(-8)) note(`      ${x.at} ${x.action} ${x.who ?? '?'} ${x.source} ${String(x.changes).slice(0, 200)}`);
    const ov = await tryQ('ov', () => sql`
      SELECT created_at::text AS at, item_code, original_price_sen, override_price_sen, coalesce(reason,'') AS reason
        FROM scm.mfg_so_price_overrides WHERE doc_no = ${r.doc_no}::text ORDER BY created_at`);
    note(`    admin price overrides: ${ov.length}`);
    for (const o of ov) note(`      ${o.at} ${o.item_code} ${rm(o.original_price_sen)} -> ${rm(o.override_price_sen)} ${o.reason}`);
  }

  // ── D. Did the acc hook (shipped 2026-08-16) ever run in prod? ───────────
  note('\n' + '='.repeat(72));
  note('=== D. accounting hook: any bookable payment created SINCE the hook shipped?');
  const d = await tryQ('acc window', () => sql`
    SELECT
      (SELECT count(*)::int FROM scm.mfg_sales_order_payments
        WHERE method <> 'imported' AND created_at >= '2026-08-16'::date)  AS bookable_since_ship,
      (SELECT max(created_at)::text FROM scm.mfg_sales_order_payments
        WHERE method <> 'imported')                                        AS newest_bookable,
      (SELECT count(*)::int FROM scm.journal_entries)                      AS je_total,
      (SELECT count(DISTINCT source_type)::int FROM scm.journal_entries)   AS je_source_types`, [{}]);
  note(`bookable SO payments created on/after 2026-08-16 : ${d[0].bookable_since_ship}`);
  note(`newest bookable SO payment created_at            : ${d[0].newest_bookable}`);
  note(`journal_entries rows (any source_type)           : ${d[0].je_total}`);
  note(`distinct source_type values                      : ${d[0].je_source_types}`);
  const dst = await tryQ('je source types', () => sql`
    SELECT source_type, count(*)::int AS n FROM scm.journal_entries GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
  note(`source_type histogram: ${dst.map((r) => `${r.source_type}=${r.n}`).join(', ') || '(empty table)'}`);

  // ── E. The catalogue, again, and what the code would have to select ──────
  note('\n' + '='.repeat(72));
  note('=== E. mfg_sales_orders customer-identity columns (acc/payments.ts:84)');
  const e = await tryQ('cols', () => sql`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders'
       AND column_name IN ('customer_name','customer_phone','debtor_name','debtor_code','phone','company_id')
     ORDER BY column_name`);
  note(`present: ${e.map((r) => r.column_name).join(', ') || '(none)'}`);

  // ── F. Would an over-payment through the ROUTE even be possible today? ───
  note('\n' + '='.repeat(72));
  note('=== F. non-imported payments on orders whose total_revenue_centi <= 0 (guard is a no-op there)');
  const f = await tryQ('guard noop', () => sql`
    SELECT count(*)::int AS n_orders, coalesce(sum(p.paid),0)::bigint AS paid_sen
      FROM scm.mfg_sales_orders s
      JOIN LATERAL (SELECT sum(amount_centi)::bigint AS paid, count(*)::int AS n
                      FROM scm.mfg_sales_order_payments
                     WHERE so_doc_no = s.doc_no AND method <> 'imported') p ON p.n > 0
     WHERE s.status NOT IN ('CANCELLED','DRAFT')
       AND coalesce(s.total_revenue_centi,0) <= 0`, [{}]);
  note(`orders with trc<=0 carrying NON-imported money: ${f[0].n_orders}, ${rm(f[0].paid_sen)}`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
  process.exit(1);
});
