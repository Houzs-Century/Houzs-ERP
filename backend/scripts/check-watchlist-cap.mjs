#!/usr/bin/env node
// check-watchlist-cap.mjs — READ-ONLY. Owner 2026-10-21 「为什么看没有10月的
// payment」: Merchant Recon's "Card payments no merchant report has reported
// yet" stops at 21/09. The list reads every Sales Order payment in a 90-day
// window (+ the merchant's drift days) in ONE PostgREST call, and PostgREST
// hands back at most 1000 rows without saying so. This counts what the window
// holds, replays the call through PostgREST itself (the same REST endpoint the
// Worker uses) to see where it stops, and counts the October card payments the
// list should be showing. Writes nothing. Env: DATABASE_URL, SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY (optional, for the replay), COMPANY_ID (default 1).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '—' : String(v).slice(0, 10));

const to = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const from = new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
const lo = new Date(Date.parse(`${from}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
const hi = `${new Date(Date.parse(`${to}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)}T23:59:59.999`;

try {
  console.log(`Watchlist window today: ${from} → ${to}; payments read ${lo} → ${hi} (7 drift days)`);
  const [all] = await sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE method IN ('merchant', 'installment', 'imported'))::int AS card,
           min(paid_at) AS first, max(paid_at) AS last
      FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND paid_at >= ${lo} AND paid_at <= ${hi}`;
  console.log(`  Sales Order payments in that read (every method): ${all.n} — card/instalment/imported ${all.card}; ${day(all.first)} → ${day(all.last)}`);

  const plain = await sql`
    SELECT paid_at FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND paid_at >= ${lo} AND paid_at <= ${hi} LIMIT 1000`;
  const days = plain.map((p) => day(p.paid_at)).sort();
  console.log(`  The same read cut at 1000 rows (no order, as PostgREST does): ${plain.length} rows, ${days[0]} → ${days.at(-1)}`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const q = new URL(`${url.replace(/\/$/, '')}/rest/v1/mfg_sales_order_payments`);
    q.searchParams.set('select', 'id,paid_at');
    q.searchParams.append('company_id', `eq.${CO}`);
    q.searchParams.append('paid_at', `gte.${lo}`);
    q.searchParams.append('paid_at', `lte.${hi}`);
    const r = await fetch(q, { headers: { apikey: key, authorization: `Bearer ${key}`, 'accept-profile': 'scm', prefer: 'count=exact' } });
    const body = await r.json();
    const got = Array.isArray(body) ? body.map((p) => String(p.paid_at).slice(0, 10)).sort() : [];
    console.log(`  PostgREST itself answered: HTTP ${r.status}, ${got.length} rows (${got[0] ?? '—'} → ${got.at(-1) ?? '—'}), content-range ${r.headers.get('content-range')}`);
  } else {
    console.log('  (no REST credentials here — replay skipped)');
  }

  const oct = await sql`
    SELECT coalesce(nullif(trim(merchant_provider), ''), '(none)') AS tag, count(*)::int AS n, sum(amount_sen)::bigint AS sen
      FROM scm.mfg_sales_order_payments p
     WHERE company_id = ${CO} AND paid_at >= '2026-10-01' AND method IN ('merchant', 'installment')
       AND NOT EXISTS (SELECT 1 FROM scm.acc_settlement_matches m WHERE m.company_id = p.company_id AND m.payment_source = 'SOPAY' AND m.payment_id::text = p.id::text)
     GROUP BY 1 ORDER BY 2 DESC`;
  console.log('\nOctober card payments not on any merchant report yet, by merchant keyed:');
  for (const o of oct) console.log(`  ${o.tag}: ${o.n} RM ${rm(o.sen)}`);
  const late = await sql`
    SELECT count(*)::int AS n, sum(amount_sen)::bigint AS sen FROM scm.mfg_sales_order_payments p
     WHERE company_id = ${CO} AND paid_at >= '2026-09-22' AND paid_at < '2026-10-01' AND method IN ('merchant', 'installment')
       AND NOT EXISTS (SELECT 1 FROM scm.acc_settlement_matches m WHERE m.company_id = p.company_id AND m.payment_source = 'SOPAY' AND m.payment_id::text = p.id::text)`;
  console.log(`  and 22/09–30/09: ${late[0].n} RM ${rm(late[0].sen)}`);

  /* Does the same cap reach the matching itself? A daily statement reads its day ± 7. */
  const busiest = await sql`
    WITH d AS (SELECT generate_series('2026-09-01'::date, current_date, '1 day')::date AS day)
    SELECT d.day, (SELECT count(*) FROM scm.mfg_sales_order_payments p
                    WHERE p.company_id = ${CO} AND p.paid_at >= d.day - 7 AND p.paid_at < d.day + 8)::int AS n
      FROM d ORDER BY 2 DESC LIMIT 3`;
  console.log(`\nBusiest 15-day read a daily statement makes (day ± 7): ${busiest.map((b) => `${day(b.day)} ${b.n}`).join(', ')}`);
} finally {
  await sql.end();
}
