#!/usr/bin/env node
// check-settle-charges.mjs — READ-ONLY. Follow-up to check-aeon-confirm.mjs:
// "Confirm all … across 79 reports" said "Posted 0. 52 could not be". The
// button counts, per report, the lines it could not post AND a statement charge
// it could not book, so this lists every open report whose statement charge is
// still unbooked and asks the posting gate's read-only half (validateJournal —
// the same code that posts) why it would refuse. Then Cloudflare's record of the
// button's runs: when, how many reports, what status each request returned.
// Writes nothing. Env: DATABASE_URL; CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID;
// CF_FROM / CF_TO (ISO, default the last 6 hours).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { validateJournal } from '../src/acc/engine.ts';
import { statementChargeLines } from '../src/acc/rules.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '—' : String(v).slice(0, 10));

try {
  const sb = pgrestShim(sql, 'scm');
  const open = await sql`
    SELECT b.company_id, b.acquirer_code, b.status, count(*)::int AS n,
           count(*) FILTER (WHERE coalesce(b.adjustment_sen, 0) <> 0 AND b.adjustment_je_no IS NULL)::int AS charge_unbooked
      FROM scm.acc_settlement_batches b
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
  console.log('Reports by company / merchant / status (charge_unbooked = a statement charge not yet booked):');
  for (const o of open) console.log(`  co ${o.company_id} ${o.acquirer_code} ${o.status}: ${o.n} (charge unbooked ${o.charge_unbooked})`);

  const pend = await sql`
    SELECT b.company_id, b.id, b.acquirer_code, b.file_name, b.period_to, b.status, b.adjustment_sen,
           a.transit_account_code, a.fee_account_code
      FROM scm.acc_settlement_batches b
      LEFT JOIN scm.acc_acquirers a ON a.company_id = b.company_id AND a.code = b.acquirer_code
     WHERE coalesce(b.adjustment_sen, 0) <> 0 AND b.adjustment_je_no IS NULL
     ORDER BY b.company_id, b.acquirer_code, b.period_to, b.id`;
  console.log(`\nReports whose statement charge is NOT booked: ${pend.length}`);
  const reasons = new Map();
  for (const b of pend) {
    const input = {
      companyId: Number(b.company_id),
      entryDate: day(b.period_to),
      sourceType: 'SETTLEADJ',
      sourceDocNo: `SETTLEADJ-${b.id}`,
      narration: 'dry run',
      lines: statementChargeLines(
        { transitAccountCode: b.transit_account_code, feeAccountCode: b.fee_account_code },
        { acquirerCode: b.acquirer_code, statementDate: day(b.period_to), adjustmentSen: Number(b.adjustment_sen) },
      ),
    };
    let verdict;
    try { verdict = await validateJournal(sb, input); } catch (e) { verdict = { ok: false, status: 'threw', reason: e.message }; }
    const why = verdict.ok ? 'gate would accept' : `${verdict.status}: ${verdict.reason ?? ''}`;
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
    console.log(`  co ${b.company_id} #${b.id} ${b.acquirer_code} ${b.status} ${day(b.period_to)} "${b.file_name}" charge ${rm(b.adjustment_sen)} | transit ${b.transit_account_code ?? '—'} fee ${b.fee_account_code ?? '—'} | ${why} | lines ${JSON.stringify(input.lines.map((l) => [l.accountCode, l.debitSen ?? 0, l.creditSen ?? 0]))}`);
  }
  console.log('\nWhy, counted:');
  for (const [k, v] of reasons) console.log(`  ${v}× ${k}`);
} finally {
  await sql.end();
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
if (token && acct) {
  const to = process.env.CF_TO ? new Date(process.env.CF_TO) : new Date();
  const from = process.env.CF_FROM ? new Date(process.env.CF_FROM) : new Date(to.getTime() - 6 * 3600_000);
  console.log(`\n=== Worker invocations ${from.toISOString()} → ${to.toISOString()} by minute and status (autocount-sync-api) ===`);
  const gql = `query($acct: String!, $from: Time!, $to: Time!) {
    viewer { accounts(filter: {accountTag: $acct}) {
      workersInvocationsAdaptive(limit: 2000, orderBy: [datetimeMinute_ASC], filter: {datetime_geq: $from, datetime_leq: $to, scriptName: "autocount-sync-api"}) {
        sum { requests errors }
        dimensions { datetimeMinute status }
      }
    } }
  }`;
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { acct, from: from.toISOString(), to: to.toISOString() } }),
    });
    const j = await r.json();
    if (j.errors?.length) console.log(`  GraphQL errors: ${JSON.stringify(j.errors).slice(0, 600)}`);
    const byMin = new Map();
    for (const x of j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []) {
      const m = x.dimensions.datetimeMinute.slice(11, 16);
      const e = byMin.get(m) ?? {};
      e[x.dimensions.status] = (e[x.dimensions.status] ?? 0) + x.sum.requests;
      byMin.set(m, e);
    }
    for (const [m, e] of byMin) {
      const bad = Object.entries(e).filter(([k]) => k !== 'success');
      if (bad.length) console.log(`  ${m} ${Object.entries(e).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
  } catch (e) { console.log(`  GraphQL failed: ${e.message}`); }

  console.log('\n=== The button\'s requests (confirm-matched), from the Worker\'s own log ===');
  const all = [];
  let cursorTo = to.getTime();
  for (let page = 0; page < 6; page += 1) {
    const body = {
      queryId: 'adhoc-confirm-matched-runs',
      timeframe: { from: from.getTime(), to: cursorTo },
      view: 'events', limit: 1000,
      parameters: { datasets: ['cloudflare-workers'], needle: { value: 'confirm-matched', isRegex: false, matchCase: false }, filters: [] },
    };
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/observability/telemetry/query`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.success) { console.log(`  observability: ${JSON.stringify(j.errors ?? j).slice(0, 500)}`); break; }
    const ev = j.result?.events?.events ?? [];
    all.push(...ev);
    if (ev.length < 1000) break;
    cursorTo = Math.min(...ev.map((e) => Number(e.timestamp))) - 1;
  }
  const reqs = [];
  const invs = [];
  for (const e of all) {
    const msg = String(e.source?.message ?? '');
    const t = new Date(Number(e.timestamp)).toISOString().slice(11, 19);
    const m1 = msg.match(/^\[req\] POST \S+\/batches\/(\d+)\/confirm-matched (\d+) (\d+)ms/);
    if (m1) { reqs.push({ t, id: Number(m1[1]), status: Number(m1[2]), ms: Number(m1[3]) }); continue; }
    const m2 = msg.match(/^POST \S+\/batches\/(\d+)\/confirm-matched/);
    if (m2) invs.push({ t, id: Number(m2[1]), outcome: e.$workers?.outcome ?? '-', wall: e.$workers?.wallTimeMs, cpu: e.$workers?.cpuTimeMs });
  }
  console.log(`  ${all.length} log events; ${reqs.length} answered requests ([req] lines), ${invs.length} invocations`);
  /* One run = requests no more than 60 s apart. */
  reqs.sort((a, b) => a.t.localeCompare(b.t));
  const runs = [];
  for (const r of reqs) {
    const last = runs.at(-1);
    const secs = (s) => Number(s.slice(0, 2)) * 3600 + Number(s.slice(3, 5)) * 60 + Number(s.slice(6, 8));
    if (last && secs(r.t) - secs(last.end) <= 60) { last.items.push(r); last.end = r.t; } else runs.push({ start: r.t, end: r.t, items: [r] });
  }
  for (const run of runs) {
    const st = new Map();
    for (const r of run.items) st.set(r.status, (st.get(r.status) ?? 0) + 1);
    const ids = run.items.map((r) => r.id);
    console.log(`  run ${run.start}→${run.end} UTC: ${run.items.length} requests (${[...st].map(([k, v]) => `${v}× ${k}`).join(', ')}), reports ${Math.max(...ids)}…${Math.min(...ids)}, slowest ${Math.max(...run.items.map((r) => r.ms))}ms`);
  }
  const outcomes = new Map();
  for (const i of invs) outcomes.set(i.outcome, (outcomes.get(i.outcome) ?? 0) + 1);
  console.log(`  invocation outcomes: ${[...outcomes].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const answered = new Set(reqs.map((r) => `${r.id}`));
  const noAnswer = invs.filter((i) => !answered.has(`${i.id}`));
  if (noAnswer.length) console.log(`  invocations with no [req] answer: ${noAnswer.map((i) => `${i.t} #${i.id} ${i.outcome}`).join(', ')}`);
}
