#!/usr/bin/env node
/* Sales orders that have COLLECTED MORE THAN THEY ARE WORTH. Read-only.

   The owner reports that an over-collection never shows as a negative balance.
   Three separate things could be true and only production can say which:

     1. the balance is CLAMPED — scm.mfg_sales_orders_with_payment_totals
        computes GREATEST(local_total - paid, 0), and so-outstanding.ts does
        Math.max(0, ...). Printed here from pg_get_viewdef so the claim is
        about the DEPLOYED view, not the migration file.
     2. over-collected rows EXIST anyway — POST/PATCH /:docNo/payments refuse
        an over-payment, so any row where sum(payments) > total_revenue_centi
        got there some other way (SO-create deposit, the scan job, or the
        order total being edited DOWN after the money landed).
     3. the excess was absorbed into ITEM VALUE — if that happened, the order
        would carry a line price change (mfg_so_audit_log UPDATE_LINE with
        unitPriceCenti, or a row in mfg_so_price_overrides) dated AFTER the
        payment, and the delta would look like the excess.

   Writes nothing. Prints counts, sums and up to LIMIT worked examples.

   COMPANY=1 LIMIT=25 node scripts/probe-so-overpay.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 0);        // 0 = every company
const LIMIT = Math.min(200, Number(process.env.LIMIT || 25));

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

/* A probe that dies on one missing relation answers nothing about the other
   six questions. Each section reports its own failure and the run continues —
   the failure text IS part of the answer (which table/column is not there). */
async function tryQ(label, fn, fallback = []) {
  try { return await fn(); } catch (e) {
    note(`  !! ${label} failed: ${e.code ?? ''} ${e.message}`);
    return fallback;
  }
}

async function main() {
  // ── 1. The DEPLOYED balance rule ─────────────────────────────────────────
  note('='.repeat(72));
  note('=== 1. deployed view definition: mfg_sales_orders_with_payment_totals');
  const vd = await tryQ('viewdef', () => sql`
    SELECT pg_get_viewdef('scm.mfg_sales_orders_with_payment_totals'::regclass, true) AS def`, [{ def: null }]);
  note(String(vd[0]?.def ?? '(view missing)'));

  // ── 2. How many orders have collected more than they are worth ───────────
  note('\n' + '='.repeat(72));
  note('=== 2. over-collected sales orders (sum(payments) > total_revenue_centi)');
  const agg = await sql`
    WITH pay AS (
      SELECT so_doc_no, sum(amount_centi)::bigint AS paid, count(*)::int AS n_rows,
             bool_or(coalesce(is_deposit,false)) AS has_deposit_row,
             min(paid_at)::text AS first_paid, max(paid_at)::text AS last_paid
        FROM scm.mfg_sales_order_payments
       GROUP BY so_doc_no
    )
    SELECT count(*)::int                                   AS n_orders,
           coalesce(sum(p.paid - s.total_revenue_centi),0)::bigint AS excess_sen,
           coalesce(max(p.paid - s.total_revenue_centi),0)::bigint AS worst_sen
      FROM scm.mfg_sales_orders s
      JOIN pay p ON p.so_doc_no = s.doc_no
     WHERE s.status NOT IN ('CANCELLED','DRAFT')
       AND (${CO}::bigint = 0 OR s.company_id = ${CO}::bigint)
       AND p.paid > s.total_revenue_centi`;
  note(`orders over-collected : ${agg[0].n_orders}`);
  note(`total excess          : ${rm(agg[0].excess_sen)}`);
  note(`worst single order    : ${rm(agg[0].worst_sen)}`);

  // Same question against local_total_centi (what the LIST view subtracts).
  const agg2 = await sql`
    WITH pay AS (SELECT so_doc_no, sum(amount_centi)::bigint AS paid
                   FROM scm.mfg_sales_order_payments GROUP BY so_doc_no)
    SELECT count(*)::int AS n_orders,
           coalesce(sum(p.paid - s.local_total_centi),0)::bigint AS excess_sen
      FROM scm.mfg_sales_orders s JOIN pay p ON p.so_doc_no = s.doc_no
     WHERE s.status NOT IN ('CANCELLED','DRAFT')
       AND (${CO}::bigint = 0 OR s.company_id = ${CO}::bigint)
       AND p.paid > s.local_total_centi`;
  note(`\nsame vs local_total_centi (the LIST view's minuend): ${agg2[0].n_orders} orders, ${rm(agg2[0].excess_sen)}`);

  // The soPaidCenti rule the DETAIL page uses: header deposit counts too when
  // no is_deposit ledger row exists. A DIFFERENT over-collection population.
  const agg3 = await sql`
    WITH pay AS (
      SELECT so_doc_no, sum(amount_centi)::bigint AS paid,
             bool_or(coalesce(is_deposit,false)) AS has_deposit_row
        FROM scm.mfg_sales_order_payments GROUP BY so_doc_no
    )
    SELECT count(*)::int AS n_orders,
           coalesce(sum(
             (CASE WHEN coalesce(p.has_deposit_row,false) THEN 0 ELSE coalesce(s.deposit_centi,0) END)
             + coalesce(p.paid,0) - s.total_revenue_centi),0)::bigint AS excess_sen
      FROM scm.mfg_sales_orders s LEFT JOIN pay p ON p.so_doc_no = s.doc_no
     WHERE s.status NOT IN ('CANCELLED','DRAFT')
       AND (${CO}::bigint = 0 OR s.company_id = ${CO}::bigint)
       AND (CASE WHEN coalesce(p.has_deposit_row,false) THEN 0 ELSE coalesce(s.deposit_centi,0) END)
           + coalesce(p.paid,0) > s.total_revenue_centi`;
  note(`detail-page rule (soPaidCenti, header deposit folded in): ${agg3[0].n_orders} orders, ${rm(agg3[0].excess_sen)}`);

  // ── 3. Worked examples, with what each SCREEN would show ─────────────────
  note('\n' + '='.repeat(72));
  note(`=== 3. worst ${LIMIT} over-collected orders — and what the screens show`);
  const rows = await sql`
    WITH pay AS (
      SELECT so_doc_no, sum(amount_centi)::bigint AS paid, count(*)::int AS n_rows,
             min(paid_at)::text AS first_paid, max(paid_at)::text AS last_paid
        FROM scm.mfg_sales_order_payments GROUP BY so_doc_no
    )
    SELECT s.doc_no, s.company_id, s.status, s.so_date::text AS so_date,
           s.created_at::text AS created_at,
           s.total_revenue_centi, s.local_total_centi, s.balance_centi,
           s.deposit_centi, s.line_count,
           p.paid, p.n_rows, p.first_paid, p.last_paid,
           v.balance_centi_live, v.paid_total_centi
      FROM scm.mfg_sales_orders s
      JOIN pay p ON p.so_doc_no = s.doc_no
      LEFT JOIN scm.mfg_sales_orders_with_payment_totals v ON v.doc_no = s.doc_no
     WHERE s.status NOT IN ('CANCELLED','DRAFT')
       AND (${CO}::bigint = 0 OR s.company_id = ${CO}::bigint)
       AND p.paid > s.total_revenue_centi
     ORDER BY (p.paid - s.total_revenue_centi) DESC
     LIMIT ${LIMIT}::int`;

  for (const r of rows) {
    const excess = Number(r.paid) - Number(r.total_revenue_centi);
    note(`\n  ${r.doc_no}  co=${r.company_id}  ${r.status}  so_date=${r.so_date}`);
    note(`    total_revenue=${rm(r.total_revenue_centi)}  local_total=${rm(r.local_total_centi)}  lines=${r.line_count}`);
    note(`    paid(ledger)=${rm(r.paid)} over ${r.n_rows} row(s)  ${r.first_paid} .. ${r.last_paid}   header deposit=${rm(r.deposit_centi)}`);
    note(`    OVER-COLLECTED BY ${rm(excess)}`);
    note(`    view balance_centi_live = ${rm(r.balance_centi_live)}   (would be ${rm(excess * -1)} if unclamped)`);
    note(`    header balance_centi    = ${rm(r.balance_centi)}`);

    // 3a. Did a LINE price move on this order, and when relative to the money?
    const lineAudit = await tryQ('audit-log', () => sql`
      SELECT a.created_at::text AS at, a.action, a.actor_name_snapshot AS who,
             a.field_changes::text AS changes, a.source, a.note
        FROM scm.mfg_so_audit_log a
       WHERE a.so_doc_no = ${r.doc_no}::text
         AND a.action IN ('UPDATE_LINE','ADD_LINE','DELETE_LINE')
       ORDER BY a.created_at`);
    const priceMoves = lineAudit.filter((a) => /unitPriceCenti|totalCenti|qty/.test(a.changes ?? ''));
    note(`    line-change audit rows: ${lineAudit.length} (of which price/qty bearing: ${priceMoves.length})`);
    for (const a of priceMoves.slice(-6)) {
      note(`      ${a.at}  ${a.action}  ${a.who ?? '?'}  ${String(a.changes).slice(0, 220)}`);
    }

    // 3b. Admin price overrides on this order.
    const ov = await tryQ('price-overrides', () => sql`
      SELECT created_at::text AS at, item_code, original_price_sen, override_price_sen, reason
        FROM scm.mfg_so_price_overrides WHERE doc_no = ${r.doc_no}::text ORDER BY created_at`);
    note(`    admin price overrides: ${ov.length}`);
    for (const o of ov) {
      note(`      ${o.at}  ${o.item_code}  ${rm(o.original_price_sen)} -> ${rm(o.override_price_sen)}  (delta ${rm(Number(o.override_price_sen) - Number(o.original_price_sen))})  ${o.reason ?? ''}`);
    }

    // 3c. The payment rows themselves.
    const pays = await tryQ('payments', () => sql`
      SELECT paid_at::text AS at, method, amount_centi, coalesce(is_deposit,false) AS is_deposit,
             created_at::text AS created_at, coalesce(note,'') AS note
        FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${r.doc_no}::text ORDER BY created_at`);
    for (const p of pays) {
      note(`      pay ${p.at}  ${String(p.method).padEnd(11)} ${rm(p.amount_centi).padStart(13)}  ${p.is_deposit ? 'DEPOSIT' : 'balance'}  ${p.note.slice(0, 60)}`);
    }
  }

  // ── 4. HOW they got there: created over-collected, or edited down later ──
  note('\n' + '='.repeat(72));
  note('=== 4. how the over-collection arose (audit-based, best effort)');
  const how = await tryQ('how-arose', () => sql`
    WITH pay AS (SELECT so_doc_no, sum(amount_centi)::bigint AS paid
                   FROM scm.mfg_sales_order_payments GROUP BY so_doc_no),
    over AS (
      SELECT s.doc_no
        FROM scm.mfg_sales_orders s JOIN pay p ON p.so_doc_no = s.doc_no
       WHERE s.status NOT IN ('CANCELLED','DRAFT')
         AND (${CO}::bigint = 0 OR s.company_id = ${CO}::bigint)
         AND p.paid > s.total_revenue_centi
    )
    SELECT
      count(*) FILTER (WHERE le.n IS NULL OR le.n = 0)::int AS never_line_edited,
      count(*) FILTER (WHERE le.n > 0)::int                 AS line_edited_after_create,
      count(*)::int                                         AS total
      FROM over o
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n FROM scm.mfg_so_audit_log a
         WHERE a.so_doc_no = o.doc_no AND a.action IN ('UPDATE_LINE','ADD_LINE','DELETE_LINE')
      ) le ON true`, [{ never_line_edited: -1, line_edited_after_create: -1, total: -1 }]);
  note(`over-collected orders with NO line edit at all : ${how[0].never_line_edited}`);
  note(`over-collected orders that WERE line-edited    : ${how[0].line_edited_after_create}`);
  note(`total                                          : ${how[0].total}`);

  // ── 5. The inverse test: did any order's line value grow by exactly the
  //      amount of a payment that would otherwise have over-collected it?
  note('\n' + '='.repeat(72));
  note('=== 5. line price rises that exactly match a payment amount (the "it added 250 to the item" claim)');
  const match = await tryQ('price-vs-payment match', () => sql`
    WITH price_moves AS (
      SELECT a.so_doc_no, a.created_at,
             (fc->>'from')::bigint AS from_sen, (fc->>'to')::bigint AS to_sen
        FROM scm.mfg_so_audit_log a
        CROSS JOIN LATERAL jsonb_array_elements(a.field_changes) fc
       WHERE a.action IN ('UPDATE_LINE')
         AND fc->>'field' = 'unitPriceCenti'
         AND jsonb_typeof(fc->'from') = 'number' AND jsonb_typeof(fc->'to') = 'number'
         AND (fc->>'to')::bigint > (fc->>'from')::bigint
    )
    SELECT m.so_doc_no, m.created_at::text AS at,
           m.from_sen, m.to_sen, (m.to_sen - m.from_sen) AS delta_sen,
           p.amount_centi, p.paid_at::text AS paid_at
      FROM price_moves m
      JOIN scm.mfg_sales_order_payments p
        ON p.so_doc_no = m.so_doc_no
       AND p.amount_centi = (m.to_sen - m.from_sen)
     ORDER BY m.created_at DESC
     LIMIT 40`);
  note(`price rises whose delta EQUALS a payment amount on the same order: ${match.length}`);
  for (const m of match) {
    note(`  ${m.so_doc_no}  ${m.at}  line ${rm(m.from_sen)} -> ${rm(m.to_sen)} (delta ${rm(m.delta_sen)})  payment ${rm(m.amount_centi)} on ${m.paid_at}`);
  }

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
  process.exit(1);
});
