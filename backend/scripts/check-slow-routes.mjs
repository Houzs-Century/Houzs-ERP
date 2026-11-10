// Read-only report: which API routes are slow, and which are slow AND busy.
//
// WHY THIS EXISTS. "Many parts of the system feel slow" cannot be fixed one
// screen at a time by feel. Two records already exist and nobody reads them:
//
//   1. Cloudflare Analytics Engine, dataset houzs_erp_metrics. Every request
//      writes one point from middleware/requestLog.ts: matched route, method,
//      status, request id, duration of the whole Worker chain. This is the
//      ground truth. There is no reader in the app (System Health's "perf"
//      panel was never built), so this script reads it over the AE SQL API.
//   2. client_errors (Postgres). The browser reports a request it waited
//      >= 0.8 s for, bucketed 0.8s+/2s+/5s+, plus timeouts, with the page and
//      the company. Capped at 10 per signature per session, so it counts how
//      often people waited, not requests. It is the only source with company.
//
// WHAT IT PRINTS (window = DAYS, default 7):
//   A. per route + method: count, p50, p95, p99, max ms, share over 3 s, total
//      Worker seconds — ordered by total time (slow x used)
//   B. the same routes ordered by p95, among routes with >= MIN_COUNT requests
//   C. the slowest individual requests: time, route, status, ms, request id
//      (company is not in the AE point; a request id finds the log line)
//   D. browser waits by API path, by page and by company
//
// Strictly reads: SELECTs inside a READ ONLY transaction, and AE SQL (which is
// read-only by construction). Exits 0 for every real answer, including "the
// Cloudflare token cannot read Analytics" (the answer is then a permission to
// add, printed as a notice). Only an unreachable database, or an AE query that
// the API rejects for any other reason, exits non-zero.
//
// Run: Actions -> "Run a backend script on production", script
// check-slow-routes.mjs, mode plan. Optional env: DAYS=7;LIMIT=40;MIN_COUNT=20
// Needs CLOUDFLARE_API_TOKEN (Account Analytics: Read) + CLOUDFLARE_ACCOUNT_ID
// for parts A-C, DATABASE_URL for part D; the runner passes all three.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

import {
  parseDays, routeSql, slowestSql, totalsSql, readAeAnswer, routeLines, table, pivotBrowserSlow, SLOW_MS,
} from './lib/slow-routes.mjs';

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const intEnv = (name, dflt, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be 1..${max}, got '${raw}'`);
  return n;
};

const DAYS = parseDays(process.env.DAYS);
const LIMIT = intEnv('LIMIT', 40, 200);
const MIN_COUNT = intEnv('MIN_COUNT', 20, 1_000_000);
let broke = false;

// ── A-C: Analytics Engine ──────────────────────────────────────────────────
async function ae(sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, body: sql },
  );
  return readAeAnswer(res.status, await res.text());
}

async function analyticsEngine() {
  console.log(`\n=== Worker request timings, last ${DAYS} days (Analytics Engine) ===`);
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    notice('AE NOT READ: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is empty in this environment.');
    return;
  }
  const totals = await ae(totalsSql(DAYS));
  if (totals.kind === 'forbidden') {
    notice(
      'AE NOT READ: the Cloudflare token was refused (401/403). It needs the permission ' +
        '"Account Analytics: Read" on this account. Nothing else is wrong with the data.',
    );
    console.log(totals.message);
    return;
  }
  if (totals.kind === 'error') {
    console.error(`AE query failed: ${totals.message}`);
    broke = true;
    return;
  }
  const t = totals.rows[0] ?? {};
  if (!t.points) {
    notice(
      `AE HAS NO REQUEST POINTS in the last ${DAYS} days. Either Analytics Engine is not ` +
        'enabled on the account or the ERP_METRICS binding is not deployed.',
    );
    return;
  }
  notice(`requests ${Math.round(t.n)} (AE points ${t.points}, sampled), ${t.first_at} .. ${t.last_at}`);

  const routes = await ae(routeSql(DAYS, 1000));
  if (routes.kind !== 'ok') {
    console.error(`AE route query failed: ${routes.message}`);
    broke = true;
    return;
  }
  console.log(`\n-- A. Top ${LIMIT} routes by total Worker time (slow x used). ms; over3s% = share of that route's requests over ${SLOW_MS} ms --`);
  console.log(table(routeLines(routes.rows.slice(0, LIMIT))));

  const busy = routes.rows.filter((r) => r.n >= MIN_COUNT).sort((a, b) => b.p95 - a.p95);
  console.log(`\n-- B. Top ${LIMIT} routes by p95 (at least ${MIN_COUNT} requests) --`);
  console.log(table(routeLines(busy.slice(0, LIMIT))));

  const slowest = await ae(slowestSql(DAYS, 20));
  if (slowest.kind !== 'ok') {
    console.error(`AE slowest query failed: ${slowest.message}`);
    broke = true;
    return;
  }
  console.log('\n-- C. Slowest 20 requests (company is not recorded in AE; request_id finds the Workers log line) --');
  console.log(table(slowest.rows.map((r) => ({ at: r.timestamp, method: r.method, route: r.route, status: r.status, ms: Math.round(r.ms), request_id: r.request_id }))));

  const all = routes.rows.reduce((a, r) => ({ n: a.n + r.n, slow: a.slow + r.over_slow }), { n: 0, slow: 0 });
  if (all.n > 0) notice(`requests over ${SLOW_MS} ms: ${Math.round(all.slow)} / ${Math.round(all.n)} (${((100 * all.slow) / all.n).toFixed(2)}%)`);
}

// ── D: client_errors ───────────────────────────────────────────────────────
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

async function browserWaits() {
  console.log(`\n=== Browser waits, last ${DAYS} days (client_errors; capped 10 per signature per session) ===`);
  const url = resolveUrl();
  if (!url) {
    notice('client_errors NOT READ: DATABASE_URL is not set.');
    return;
  }
  const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  try {
    const rows = await pg.begin('read only', (sql) => sql`
      SELECT message, route, company_id, user_id, count
      FROM client_errors
      WHERE last_seen_at >= to_char(timezone('UTC', now() - make_interval(days => ${DAYS})), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        AND (message LIKE '[slow %' OR message LIKE '[timeout]%')`);
    notice(`browser slow/timeout rows: ${rows.length}`);
    const view = (keyOf, label) => {
      const lines = pivotBrowserSlow(rows, keyOf).slice(0, LIMIT).map(({ key, ...rest }) => ({ [label]: key, ...rest }));
      console.log(table(lines));
    };
    console.log(`\n-- D1. By API path (top ${LIMIT}) --`);
    view((x) => x.api, 'api');
    console.log(`\n-- D2. By page the user was on (top ${LIMIT}) --`);
    view((x) => x.page, 'page');
    console.log('\n-- D3. By company --');
    view((x) => String(x.company), 'company_id');
  } finally {
    await pg.end({ timeout: 5 });
  }
}

await analyticsEngine();
await browserWaits();
if (broke) process.exit(1);
