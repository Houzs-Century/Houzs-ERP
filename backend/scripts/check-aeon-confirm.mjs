#!/usr/bin/env node
// check-aeon-confirm.mjs — READ-ONLY. Owner 2026-10-21, screenshot of Merchant
// Recon (AEON): "Confirm all 1 matched, across 79 reports" ended "Posted 0. 52
// could not be — Network error", and nearly every line reads "2 possible / you
// choose". 「这个是什么意思？」
//
// Answers, without writing anything:
//   1. the AEON reports: how many, their lines by bucket, the statement charge
//      each carries and whether it was booked (the button books it too);
//   2. what the Worker saw when the button ran — Cloudflare's own invocation
//      record of every confirm-matched request (status, outcome, CPU / wall time);
//   3. why the lines are "2 possible": the payments of the same amount inside
//      AEON's date window, the same pool the screen offers;
//   4. whether the AEON reference is keyed on any Sales Order payment at all.
// Env: DATABASE_URL; CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (optional);
// HOURS (default 36) for the Cloudflare window.
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '—' : String(v).slice(0, 10));
const ts = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v == null ? '—' : String(v).slice(0, 19));
const dayGap = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const HOURS = Math.min(Math.max(parseInt(process.env.HOURS || '36', 10) || 36, 1), 168);

async function cloudflare() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !acct) { console.log('\n(Cloudflare token/account not available — skipped the Worker side)'); return; }
  const to = new Date();
  const from = new Date(to.getTime() - HOURS * 3600_000);

  console.log(`\n=== Worker invocations that did not succeed, last ${HOURS}h (GraphQL) ===`);
  const gql = `query($acct: String!, $from: Time!, $to: Time!) {
    viewer { accounts(filter: {accountTag: $acct}) {
      workersInvocationsAdaptive(limit: 500, orderBy: [datetimeMinute_ASC], filter: {datetime_geq: $from, datetime_leq: $to, status_neq: "success"}) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP99 wallTimeP99 }
        dimensions { datetimeMinute status scriptName }
      }
    } }
  }`;
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { acct, from: from.toISOString(), to: to.toISOString() } }),
    });
    const j = await r.json();
    if (j.errors?.length) console.log(`  GraphQL errors: ${JSON.stringify(j.errors).slice(0, 800)}`);
    const rows = j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    for (const x of rows) {
      console.log(`  ${x.dimensions.datetimeMinute} ${x.dimensions.scriptName} ${x.dimensions.status} requests ${x.sum.requests} errors ${x.sum.errors} cpuP99 ${Math.round((x.quantiles?.cpuTimeP99 ?? 0) / 1000)}ms wallP99 ${Math.round((x.quantiles?.wallTimeP99 ?? 0) / 1000)}ms`);
    }
    if (rows.length === 0 && !j.errors?.length) console.log('  none');
  } catch (e) { console.log(`  GraphQL failed: ${e.message}`); }

  console.log(`\n=== confirm-matched requests the Worker logged, last ${HOURS}h (Observability) ===`);
  try {
    const body = {
      queryId: 'adhoc-aeon-confirm-matched',
      timeframe: { from: from.getTime(), to: to.getTime() },
      view: 'events',
      limit: 300,
      parameters: {
        datasets: ['cloudflare-workers'],
        needle: { value: 'confirm-matched', isRegex: false, matchCase: false },
        filters: [],
      },
    };
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/observability/telemetry/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { console.log(`  HTTP ${r.status}: ${text.slice(0, 600)}`); return; }
    if (!j.success) { console.log(`  HTTP ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 800)}`); return; }
    const events = j.result?.events?.events ?? [];
    console.log(`  ${events.length} event(s)`);
    if (events[0]) console.log(`  shape of one: ${JSON.stringify(events[0]).slice(0, 1500)}`);
    const lines = events.map((e) => {
      const w = e.$workers ?? {};
      const m = e.$metadata ?? {};
      const msg = String(m.message ?? e.source?.message ?? (typeof e.source === 'string' ? e.source : '') ?? '').replace(/\s+/g, ' ').slice(0, 160);
      return `${new Date(Number(e.timestamp ?? m.timestamp ?? 0)).toISOString().slice(11, 19)} ${w.outcome ?? '-'} ${w.eventType ?? ''} cpu ${w.cpuTimeMs ?? '-'}ms wall ${w.wallTimeMs ?? '-'}ms ${m.statusCode ?? ''} ${m.error ? `ERR ${String(m.error).slice(0, 120)}` : ''} | ${msg}`;
    }).sort();
    for (const l of lines) console.log(`  ${l}`);
  } catch (e) { console.log(`  Observability failed: ${e.message}`); }
}

try {
  const acqs = await sql`SELECT company_id, code, display_name, date_tolerance_days, has_unique_ref, column_map FROM scm.acc_acquirers WHERE code = 'AEON' ORDER BY company_id`;
  for (const a of acqs) console.log(`AEON co ${a.company_id}: name "${a.display_name}" tolerance ${a.date_tolerance_days}d unique ref ${a.has_unique_ref} columns ${JSON.stringify(a.column_map)}`);

  console.log('\n=== AEON reports (batches) ===');
  const batches = await sql`
    SELECT b.company_id, b.id, b.file_name, b.period_from, b.period_to, b.row_count, b.status, b.created_at,
           b.adjustment_sen, b.adjustment_je_no, b.adjustment_posted_at,
           count(r.id) FILTER (WHERE r.bucket = 'MATCHED')::int AS matched,
           count(r.id) FILTER (WHERE r.bucket = 'MATCHED' AND r.confirmed_at IS NULL)::int AS matched_open,
           count(r.id) FILTER (WHERE r.bucket = 'NEEDS_CONFIRM')::int AS needs,
           count(r.id) FILTER (WHERE r.bucket = 'UNMATCHED')::int AS unmatched,
           count(r.id) FILTER (WHERE r.bucket = 'IGNORED')::int AS ignored,
           count(r.id) FILTER (WHERE r.confirmed_at IS NOT NULL)::int AS confirmed,
           coalesce(sum(r.gross_sen), 0)::bigint AS gross
      FROM scm.acc_settlement_batches b
      LEFT JOIN scm.acc_settlement_rows r ON r.batch_id = b.id AND r.company_id = b.company_id
     WHERE b.acquirer_code = 'AEON'
     GROUP BY b.company_id, b.id
     ORDER BY b.company_id, b.period_from, b.id`;
  const byCo = new Map();
  for (const b of batches) {
    const s = byCo.get(b.company_id) ?? { n: 0, lines: 0, matched: 0, matchedOpen: 0, needs: 0, unmatched: 0, ignored: 0, confirmed: 0, gross: 0, adj: 0, adjN: 0, adjBooked: 0, today: 0, files: new Set() };
    s.n += 1; s.lines += b.matched + b.needs + b.unmatched + b.ignored; s.matched += b.matched; s.matchedOpen += b.matched_open;
    s.needs += b.needs; s.unmatched += b.unmatched; s.ignored += b.ignored; s.confirmed += b.confirmed; s.gross += Number(b.gross);
    if (Number(b.adjustment_sen ?? 0) !== 0) { s.adj += Number(b.adjustment_sen); s.adjN += 1; if (b.adjustment_je_no) s.adjBooked += 1; }
    if (day(b.created_at) >= '2026-10-20') s.today += 1;
    byCo.set(b.company_id, s);
  }
  for (const [co, s] of byCo) {
    console.log(`co ${co}: ${s.n} reports (${s.today} uploaded since 10-20), ${s.lines} lines gross RM ${rm(s.gross)} — MATCHED ${s.matched} (open ${s.matchedOpen}), NEEDS_CONFIRM ${s.needs}, UNMATCHED ${s.unmatched}, IGNORED ${s.ignored}, confirmed ${s.confirmed}; statement charges on ${s.adjN} reports RM ${rm(s.adj)} (booked ${s.adjBooked})`);
  }
  for (const b of batches) {
    console.log(`  co ${b.company_id} #${b.id} "${b.file_name}" ${day(b.period_from)}→${day(b.period_to)} up ${ts(b.created_at)} ${b.status} | M ${b.matched}/${b.matched_open} N ${b.needs} U ${b.unmatched} I ${b.ignored} C ${b.confirmed} | adj ${rm(b.adjustment_sen)} ${b.adjustment_je_no ?? ''} ${b.adjustment_posted_at ? ts(b.adjustment_posted_at) : ''}`);
  }

  console.log('\n=== Statement-charge entries (SETTLEADJ) made since 2026-10-20 ===');
  const adj = await sql`
    SELECT company_id, je_no, entry_date, source_doc_no, narration, created_at, posted, reversed
      FROM scm.journal_entries WHERE source_type = 'SETTLEADJ' AND created_at >= '2026-10-20' ORDER BY created_at`;
  for (const a of adj) console.log(`  co ${a.company_id} ${a.je_no} ${day(a.entry_date)} ${a.source_doc_no} made ${ts(a.created_at)} posted ${a.posted} reversed ${a.reversed} — ${String(a.narration ?? '').slice(0, 90)}`);
  if (adj.length === 0) console.log('  none');

  const matchCount = await sql`SELECT company_id, count(*)::int AS n FROM scm.acc_settlement_matches GROUP BY 1 ORDER BY 1`;
  console.log(`\nSettlement links per company (the button reads them all, once per report): ${matchCount.map((m) => `co ${m.company_id} ${m.n}`).join(', ')}`);

  console.log('\n=== Why "2 possible" — same amount inside the window, per line ===');
  for (const a of acqs) {
    const co = a.company_id;
    const tol = Math.max(0, Number(a.date_tolerance_days ?? 0));
    const name = String(a.display_name ?? '').trim();
    const rows = await sql`
      SELECT r.id, r.batch_id, r.line_no, r.txn_date, r.ref, r.gross_sen, r.bucket
        FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
       WHERE b.acquirer_code = 'AEON' AND r.company_id = ${co} AND r.confirmed_at IS NULL AND r.bucket IN ('NEEDS_CONFIRM', 'MATCHED', 'UNMATCHED')
       ORDER BY r.txn_date, r.id`;
    if (rows.length === 0) continue;
    const lo = new Date(Date.parse(`${day(rows[0].txn_date)}T00:00:00Z`) - (tol + 1) * 86_400_000).toISOString().slice(0, 10);
    const hi = new Date(Date.parse(`${day(rows.at(-1).txn_date)}T00:00:00Z`) + (tol + 1) * 86_400_000).toISOString().slice(0, 10);
    const so = await sql`
      SELECT p.id::text AS id, 'SO' AS src, p.so_doc_no AS doc, p.paid_at, p.amount_sen, p.approval_code, p.method, p.merchant_provider, o.status, o.debtor_name
        FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no AND o.company_id = p.company_id
       WHERE p.company_id = ${co} AND p.paid_at >= ${lo} AND p.paid_at < ${hi}`;
    const si = await sql`
      SELECT p.id::text AS id, 'SI' AS src, i.invoice_number AS doc, p.paid_at, p.amount_sen, p.approval_code, p.method, p.merchant_provider, NULL AS status, i.debtor_name
        FROM scm.sales_invoice_payments p LEFT JOIN scm.sales_invoices i ON i.id = p.sales_invoice_id
       WHERE p.company_id = ${co} AND p.paid_at >= ${lo} AND p.paid_at < ${hi}`;
    const settled = new Set((await sql`SELECT payment_source, payment_id::text AS payment_id FROM scm.acc_settlement_matches WHERE company_id = ${co}`).map((m) => `${m.payment_source === 'SIPAY' ? 'SI' : 'SO'}:${m.payment_id}`));
    const could = (p) => {
      const prov = p.merchant_provider == null ? '' : String(p.merchant_provider).trim();
      if (prov !== '' && prov !== name) return false;
      return p.method === 'merchant' || p.method === 'installment' || p.method === 'imported';
    };
    const pool = [...so, ...si].filter((p) => could(p) && String(p.status ?? '').toUpperCase() !== 'CANCELLED' && !settled.has(`${p.src}:${p.id}`));
    const tagged = pool.filter((p) => String(p.merchant_provider ?? '').trim() !== '').length;
    console.log(`co ${co}: ${rows.length} open lines ${day(rows[0].txn_date)}→${day(rows.at(-1).txn_date)}; payments that could be AEON in the window: ${pool.length} (tagged AEON ${tagged}, untagged ${pool.length - tagged})`);
    const hist = new Map();
    const samples = [];
    const docsSeen = new Map();
    for (const r of rows) {
      const d = day(r.txn_date);
      const same = pool.filter((p) => Number(p.amount_sen) === Number(r.gross_sen) && dayGap(day(p.paid_at), d) <= tol);
      const k = same.length >= 3 ? '3+' : String(same.length);
      hist.set(k, (hist.get(k) ?? 0) + 1);
      for (const p of same) docsSeen.set(`${p.src}:${p.id}`, (docsSeen.get(`${p.src}:${p.id}`) ?? 0) + 1);
      if (same.length >= 2 && samples.length < 6) samples.push({ r, same });
    }
    console.log(`  lines by number of same-amount payments: ${[...hist].map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    const reused = [...docsSeen.values()].filter((n) => n > 1).length;
    console.log(`  payments offered to more than one line: ${reused} of ${docsSeen.size}`);
    for (const { r, same } of samples) {
      console.log(`  line #${r.batch_id}/${r.line_no} ${day(r.txn_date)} ref ${r.ref ?? '—'} RM ${rm(r.gross_sen)} ${r.bucket}:`);
      for (const p of same) console.log(`      ${p.src} ${p.doc} ${day(p.paid_at)} RM ${rm(p.amount_sen)} ${p.method} tag ${p.merchant_provider ?? '—'} code ${p.approval_code ?? '—'} ${String(p.debtor_name ?? '').slice(0, 30)}`);
    }

    const refs = [...new Set(rows.map((r) => String(r.ref ?? '').trim()).filter(Boolean))];
    const keyed = refs.length === 0 ? [] : await sql`
      SELECT approval_code, so_doc_no, merchant_provider, amount_sen, paid_at FROM scm.mfg_sales_order_payments
       WHERE company_id = ${co} AND approval_code IN ${sql(refs)}`;
    console.log(`  AEON references on the open lines: ${refs.length}; found as an approval code on a Sales Order payment: ${new Set(keyed.map((k) => k.approval_code)).size}`);
    for (const k of keyed.slice(0, 8)) console.log(`      ${k.approval_code} → ${k.so_doc_no} tag ${k.merchant_provider ?? '—'} RM ${rm(k.amount_sen)} ${day(k.paid_at)}`);
    const sampleRefs = rows.slice(0, 5).map((r) => `${day(r.txn_date)} ${r.ref ?? '—'} RM ${rm(r.gross_sen)}`);
    console.log(`  first lines' references: ${sampleRefs.join(' | ')}`);
    const aeonTagged = await sql`
      SELECT so_doc_no, paid_at, amount_sen, approval_code, method FROM scm.mfg_sales_order_payments
       WHERE company_id = ${co} AND upper(coalesce(merchant_provider, '')) LIKE '%AEON%' AND paid_at >= ${lo} ORDER BY paid_at LIMIT 8`;
    for (const t of aeonTagged) console.log(`  AEON-tagged SO payment: ${t.so_doc_no} ${day(t.paid_at)} RM ${rm(t.amount_sen)} ${t.method} code ${t.approval_code ?? '—'}`);
  }

  const ce = await sql`
    SELECT MAX(message) AS message, MAX(route) AS route, SUM(count)::int AS n, MAX(last_seen_at) AS last_seen_at
      FROM client_errors WHERE last_seen_at >= '2026-10-20' AND (message ILIKE '%network%' OR message ILIKE '%settlement%' OR route ILIKE '%merchant%' OR route ILIKE '%settlement%')
     GROUP BY dedup_hash ORDER BY 3 DESC LIMIT 10`.catch((e) => { console.log(`client_errors read failed: ${e.message}`); return []; });
  console.log(`\nBrowser error reports since 10-20 (network / settlement / merchant): ${ce.length}`);
  for (const e of ce) console.log(`  ${e.n}× ${String(e.message).slice(0, 140)} @ ${e.route} last ${e.last_seen_at}`);
} finally {
  await sql.end();
}

await cloudflare();
