#!/usr/bin/env node
/* REFUTATION probe #3. Read-only.
   (a) re-verify the DEPLOYED clamp myself, from pg_get_viewdef;
   (b) size the "detail page says 0, list says the truth" population — the
       diagnosis claims 2,610 orders, but only rows where local_total <> paid
       actually DISAGREE;
   (c) the owner's order's lines, with the real column names. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const DOC = process.env.DOC || 'HC-SO-2608-002';

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
  note('='.repeat(72));
  note('=== a. DEPLOYED balance rule (pg_get_viewdef), re-verified independently');
  const vd = await tryQ('viewdef', () => sql`
    SELECT pg_get_viewdef('scm.mfg_sales_orders_with_payment_totals'::regclass, true) AS def`, [{ def: null }]);
  const def = String(vd[0]?.def ?? '(missing)');
  const clampLine = def.split('\n').filter((l) => /GREATEST|balance_centi_live/.test(l)).join(' | ');
  note(`clamp line: ${clampLine || '(no GREATEST found)'}`);

  note('\n' + '='.repeat(72));
  note('=== b. how many orders do the DETAIL page and the LIST view actually DISAGREE on?');
  const b = await tryQ('disagreement', () => sql`
    WITH pay AS (SELECT so_doc_no, sum(amount_centi)::bigint AS paid
                   FROM scm.mfg_sales_order_payments GROUP BY so_doc_no),
    o AS (
      SELECT s.doc_no, s.total_revenue_centi AS trc, s.local_total_centi AS ltc,
             coalesce(p.paid,0) AS paid,
             GREATEST(coalesce(s.local_total_centi,0) - coalesce(p.paid,0), 0) AS list_balance,
             GREATEST(coalesce(s.total_revenue_centi,0) - coalesce(p.paid,0), 0) AS detail_balance
        FROM scm.mfg_sales_orders s LEFT JOIN pay p ON p.so_doc_no = s.doc_no
       WHERE s.status NOT IN ('CANCELLED','DRAFT')
    )
    SELECT count(*)::int                                                AS all_orders,
           count(*) FILTER (WHERE list_balance <> detail_balance)::int   AS disagree,
           count(*) FILTER (WHERE list_balance > 0 AND detail_balance = 0)::int AS detail_says_zero_but_owed,
           coalesce(sum(list_balance) FILTER (WHERE list_balance > 0 AND detail_balance = 0),0)::bigint AS money_hidden,
           count(*) FILTER (WHERE coalesce(trc,0) = 0 AND coalesce(ltc,0) > 0)::int AS trc_zero_pop
      FROM o`, [{}]);
  note(`non-cancelled orders                                   : ${b[0].all_orders}`);
  note(`trc = 0 while local_total > 0 (the claimed population)  : ${b[0].trc_zero_pop}`);
  note(`orders where LIST and DETAIL give DIFFERENT balances    : ${b[0].disagree}`);
  note(`  ... of which DETAIL says RM 0.00 while money IS owed  : ${b[0].detail_says_zero_but_owed}`);
  note(`  ... total money the detail page hides                 : ${rm(b[0].money_hidden)}`);

  const bex = await tryQ('disagree examples', () => sql`
    WITH pay AS (SELECT so_doc_no, sum(amount_centi)::bigint AS paid
                   FROM scm.mfg_sales_order_payments GROUP BY so_doc_no)
    SELECT s.doc_no, s.status, s.total_revenue_centi AS trc, s.local_total_centi AS ltc,
           coalesce(p.paid,0) AS paid,
           GREATEST(coalesce(s.local_total_centi,0) - coalesce(p.paid,0), 0) AS list_balance
      FROM scm.mfg_sales_orders s LEFT JOIN pay p ON p.so_doc_no = s.doc_no
     WHERE s.status NOT IN ('CANCELLED','DRAFT')
       AND GREATEST(coalesce(s.local_total_centi,0) - coalesce(p.paid,0), 0) > 0
       AND GREATEST(coalesce(s.total_revenue_centi,0) - coalesce(p.paid,0), 0) = 0
     ORDER BY GREATEST(coalesce(s.local_total_centi,0) - coalesce(p.paid,0), 0) DESC LIMIT 10`);
  for (const r of bex) {
    note(`   ${String(r.doc_no).padEnd(18)} ${String(r.status).padEnd(14)} local_total=${rm(r.ltc).padStart(13)} trc=${rm(r.trc).padStart(10)} paid=${rm(r.paid).padStart(13)}  LIST says ${rm(r.list_balance)}, DETAIL says RM 0.00`);
  }

  note('\n' + '='.repeat(72));
  note(`=== c. ${DOC} line items (real column names)`);
  const cols = await tryQ('item cols', () => sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='scm' AND table_name='mfg_sales_order_items'
       AND (column_name LIKE '%price%' OR column_name LIKE '%total%' OR column_name LIKE '%surcharge%'
            OR column_name LIKE '%special%' OR column_name IN ('item_code','qty'))
     ORDER BY column_name`);
  note(`price/total columns: ${cols.map((r) => r.column_name).join(', ')}`);
  const li = await tryQ('lines', () => sql`
    SELECT item_code, qty, unit_price_centi, special_order_price_sen,
           coalesce(custom_specials::text,'') AS custom_specials,
           updated_at::text AS updated_at
      FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC}::text ORDER BY created_at`);
  for (const r of li) {
    note(`   ${String(r.item_code).padEnd(20)} qty=${r.qty} unit=${rm(r.unit_price_centi)} special_order=${rm(r.special_order_price_sen)} updated=${r.updated_at}`);
    note(`       custom_specials=${r.custom_specials}`);
  }

  note('\n' + '='.repeat(72));
  note('=== d. would the guard have refused the owner\'s RM 2,250 before he re-priced the line?');
  note('    (from the audit log: CREATE localTotalCenti=400000; payment 1 = 200000;');
  note('     UPDATE_LINE 08:26:22 unitPriceCenti 0 -> 25000; payment 2 = 225000 at 08:27:38)');
  note('    guard test BEFORE the line edit : 200000 + 225000 = 425000 > 400000  -> over_payment 400');
  note('    guard test AFTER  the line edit : 200000 + 225000 = 425000 > 425000  -> false, ACCEPTED');

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
  process.exit(1);
});
