#!/usr/bin/env node
/* REFUTATION probe #2. Read-only. The first pass found a unitPriceCenti rise of
   exactly RM 250.00 (RM 0.00 -> RM 250.00) on HC-SO-2608-002 at 2026-08-16
   08:26:22, seventy-six seconds before the newest SO payment row in the whole
   database. That is the owner's report. Dump that order completely. */
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
  note(`=== 1. header of ${DOC}`);
  const h = await tryQ('header', () => sql`
    SELECT s.doc_no, s.company_id, s.status, s.so_date::text AS so_date,
           s.created_at::text AS created_at, s.updated_at::text AS updated_at,
           s.total_revenue_centi, s.local_total_centi, s.balance_centi,
           s.deposit_centi, s.line_count, s.revision, s.debtor_name,
           v.balance_centi_live, v.paid_total_centi
      FROM scm.mfg_sales_orders s
      LEFT JOIN scm.mfg_sales_orders_with_payment_totals v ON v.doc_no = s.doc_no
     WHERE s.doc_no = ${DOC}::text`);
  for (const r of h) {
    note(`  ${r.doc_no} co=${r.company_id} ${r.status} rev=${r.revision} so_date=${r.so_date}`);
    note(`  created=${r.created_at}  updated=${r.updated_at}  lines=${r.line_count}  debtor=${r.debtor_name}`);
    note(`  local_total=${rm(r.local_total_centi)}  total_revenue=${rm(r.total_revenue_centi)}  header balance_centi=${rm(r.balance_centi)}  deposit=${rm(r.deposit_centi)}`);
    note(`  VIEW paid_total=${rm(r.paid_total_centi)}  VIEW balance_centi_live=${rm(r.balance_centi_live)}`);
  }

  note('\n=== 2. line items now');
  const li = await tryQ('lines', () => sql`
    SELECT item_code, description, qty, unit_price_centi, line_total_centi,
           coalesce(cancelled,false) AS cancelled, created_at::text AS created_at,
           updated_at::text AS updated_at
      FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC}::text
     ORDER BY created_at`);
  for (const r of li) {
    note(`  ${String(r.item_code).padEnd(24)} qty=${r.qty}  unit=${rm(r.unit_price_centi)}  line=${rm(r.line_total_centi)}  ${r.cancelled ? 'CANCELLED' : ''}  ${String(r.description ?? '').slice(0, 40)}`);
    note(`      created=${r.created_at} updated=${r.updated_at}`);
  }

  note('\n=== 3. payments ledger');
  const pays = await tryQ('pays', () => sql`
    SELECT id::text AS id, paid_at::text AS at, method, merchant_provider, amount_centi,
           coalesce(is_deposit,false) AS is_deposit, created_at::text AS created_at,
           coalesce(note,'') AS note, coalesce(account_sheet,'') AS sheet
      FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${DOC}::text ORDER BY created_at`);
  for (const p of pays) {
    note(`  ${p.created_at}  paid_at=${p.at}  ${String(p.method).padEnd(11)} ${rm(p.amount_centi).padStart(12)}  ${p.is_deposit ? 'DEPOSIT' : 'balance'}  ${p.sheet}  ${p.note.slice(0, 60)}`);
  }

  note('\n=== 4. FULL audit trail, in order, with complete field_changes');
  const au = await tryQ('audit', () => sql`
    SELECT created_at::text AS at, action, actor_name_snapshot AS who,
           coalesce(source,'') AS source, coalesce(note,'') AS note,
           coalesce(field_changes::text,'') AS changes
      FROM scm.mfg_so_audit_log WHERE so_doc_no = ${DOC}::text ORDER BY created_at`);
  for (const x of au) {
    note(`  ${x.at}  ${String(x.action).padEnd(22)} ${String(x.who ?? '?').padEnd(14)} ${x.source} ${x.note.slice(0, 40)}`);
    note(`      ${String(x.changes).slice(0, 700)}`);
  }

  note('\n' + '='.repeat(72));
  note('=== 5. EVERY SO touched today (2026-08-16), audit + payments');
  const today = await tryQ('today', () => sql`
    SELECT a.so_doc_no, a.created_at::text AS at, a.action, a.actor_name_snapshot AS who,
           coalesce(a.field_changes::text,'') AS changes
      FROM scm.mfg_so_audit_log a
     WHERE a.created_at >= '2026-08-16'::date
     ORDER BY a.created_at`);
  for (const x of today) {
    note(`  ${x.at} ${String(x.so_doc_no).padEnd(18)} ${String(x.action).padEnd(20)} ${String(x.who ?? '?').padEnd(12)} ${String(x.changes).slice(0, 260)}`);
  }

  note('\n=== 6. every SO payment row created today');
  const pt = await tryQ('pays today', () => sql`
    SELECT so_doc_no, created_at::text AS created_at, paid_at::text AS at, method,
           amount_centi, coalesce(is_deposit,false) AS is_deposit, coalesce(note,'') AS note
      FROM scm.mfg_sales_order_payments WHERE created_at >= '2026-08-16'::date
     ORDER BY created_at`);
  for (const p of pt) {
    note(`  ${p.created_at} ${String(p.so_doc_no).padEnd(18)} ${String(p.method).padEnd(11)} ${rm(p.amount_centi).padStart(12)} ${p.is_deposit ? 'DEPOSIT' : 'balance'} ${p.note.slice(0, 50)}`);
  }

  note('\n=== 7. the other 9 unitPriceCenti rises: full audit rows');
  const rises = await tryQ('rises', () => sql`
    SELECT a.so_doc_no, a.created_at::text AS at, a.action, a.actor_name_snapshot AS who,
           coalesce(a.field_changes::text,'') AS changes
      FROM scm.mfg_so_audit_log a
      CROSS JOIN LATERAL jsonb_array_elements(a.field_changes) fc
     WHERE a.action = 'UPDATE_LINE'
       AND fc->>'field' = 'unitPriceCenti'
       AND jsonb_typeof(fc->'from') = 'number' AND jsonb_typeof(fc->'to') = 'number'
       AND (fc->>'to')::bigint > (fc->>'from')::bigint
     ORDER BY a.created_at DESC`);
  for (const x of rises) {
    note(`  ${x.at} ${String(x.so_doc_no).padEnd(18)} ${String(x.who ?? '?').padEnd(14)} ${String(x.changes).slice(0, 400)}`);
  }

  note('\n=== 8. for each of those orders: total vs paid at the time');
  const ctx = await tryQ('ctx', () => sql`
    WITH docs AS (
      SELECT DISTINCT a.so_doc_no AS doc
        FROM scm.mfg_so_audit_log a
        CROSS JOIN LATERAL jsonb_array_elements(a.field_changes) fc
       WHERE a.action = 'UPDATE_LINE' AND fc->>'field' = 'unitPriceCenti'
         AND jsonb_typeof(fc->'from') = 'number' AND jsonb_typeof(fc->'to') = 'number'
         AND (fc->>'to')::bigint > (fc->>'from')::bigint
    )
    SELECT d.doc, s.status, s.local_total_centi, s.total_revenue_centi, s.balance_centi,
           coalesce((SELECT sum(amount_centi) FROM scm.mfg_sales_order_payments WHERE so_doc_no = d.doc),0)::bigint AS paid,
           coalesce((SELECT string_agg(rm.method || ' ' || rm.amount_centi::text || ' @' || rm.created_at::text, ' | ' ORDER BY rm.created_at)
                       FROM scm.mfg_sales_order_payments rm WHERE rm.so_doc_no = d.doc),'') AS paylist
      FROM docs d JOIN scm.mfg_sales_orders s ON s.doc_no = d.doc
     ORDER BY d.doc`);
  for (const r of ctx) {
    note(`  ${String(r.doc).padEnd(18)} ${String(r.status).padEnd(14)} local_total=${rm(r.local_total_centi).padStart(13)} trc=${rm(r.total_revenue_centi).padStart(13)} hdr_balance=${rm(r.balance_centi).padStart(13)} paid=${rm(r.paid).padStart(13)}`);
    note(`      pays: ${r.paylist}`);
  }

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
  process.exit(1);
});
