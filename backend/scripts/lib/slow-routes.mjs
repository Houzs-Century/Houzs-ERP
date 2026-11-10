// The pure half of check-slow-routes.mjs: the Analytics Engine SQL it sends,
// how it reads the answer, and how it lays the numbers out. No network, no
// database, so the shape is pinned by tests/slowRoutes.test.mjs.
//
// AE LAYOUT (fixed by middleware/requestLog.ts; a reader must match it):
//   blob1='req', blob2=route (matched Hono pattern), blob3=status,
//   blob4=request id, blob5=method; double1=duration ms (whole Worker chain).
// scan-timing.ts shares the dataset with blob1='scan', hence the filter.
// AE samples under load: every aggregate weights by _sample_interval, so a
// count is sum(_sample_interval), never count().

export const DATASET = 'houzs_erp_metrics';
export const SLOW_MS = 3000;

const DAYS_RE = /^[1-9][0-9]?$/;

/** Window in days, 1..90 (AE keeps three months). Anything else is refused. */
export function parseDays(raw) {
  if (raw === undefined || raw === '') return 7;
  if (!DAYS_RE.test(String(raw)) || Number(raw) > 90) {
    throw new Error(`DAYS must be a whole number 1..90, got '${raw}'`);
  }
  return Number(raw);
}

function where(days) {
  return `blob1 = 'req' AND timestamp > NOW() - INTERVAL '${days}' DAY`;
}

const q = (level) => `quantileExactWeighted(${level})(double1, _sample_interval)`;

/** Per route + method. Ordered by total Worker time, which ranks "slow AND used". */
export function routeSql(days, limit) {
  return `SELECT blob5 AS method, blob2 AS route,
  sum(_sample_interval) AS n,
  ${q(0.5)} AS p50, ${q(0.95)} AS p95, ${q(0.99)} AS p99,
  max(double1) AS max_ms,
  sumIf(_sample_interval, double1 > ${SLOW_MS}) AS over_slow,
  sum(double1 * _sample_interval) AS total_ms
FROM ${DATASET}
WHERE ${where(days)}
GROUP BY method, route
ORDER BY total_ms DESC
LIMIT ${limit}
FORMAT JSON`;
}

/** The slowest individual requests. Company is NOT in the AE point. */
export function slowestSql(days, limit) {
  return `SELECT timestamp, blob5 AS method, blob2 AS route, blob3 AS status, blob4 AS request_id, double1 AS ms
FROM ${DATASET}
WHERE ${where(days)}
ORDER BY ms DESC
LIMIT ${limit}
FORMAT JSON`;
}

/** Whole-window totals, so "no rows" can be told apart from "a quiet week". */
export function totalsSql(days) {
  return `SELECT sum(_sample_interval) AS n, count() AS points, min(timestamp) AS first_at, max(timestamp) AS last_at
FROM ${DATASET}
WHERE ${where(days)}
FORMAT JSON`;
}

/**
 * Classify one AE SQL API answer.
 *   ok          -> rows (numbers coerced; AE quotes 64-bit integers)
 *   forbidden   -> the token cannot read Analytics (401/403): an ANSWER, the
 *                  fix is a token permission, not this script
 *   error       -> anything else: the check itself broke
 */
export function readAeAnswer(status, bodyText) {
  if (status === 401 || status === 403) return { kind: 'forbidden', message: bodyText.slice(0, 300) };
  if (status < 200 || status >= 300) return { kind: 'error', message: `HTTP ${status}: ${bodyText.slice(0, 500)}` };
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { kind: 'error', message: `not JSON: ${bodyText.slice(0, 300)}` };
  }
  if (!Array.isArray(body?.data)) return { kind: 'error', message: `no data array: ${bodyText.slice(0, 300)}` };
  const numeric = new Set(['n', 'points', 'p50', 'p95', 'p99', 'max_ms', 'over_slow', 'total_ms', 'ms']);
  const rows = body.data.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) out[k] = numeric.has(k) ? Number(v) : v;
    return out;
  });
  return { kind: 'ok', rows };
}

const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)}` : '-');

/** Route rows -> display rows (share over 3 s as a percent of that route's requests). */
export function routeLines(rows) {
  return rows.map((r) => ({
    method: r.method,
    route: r.route,
    n: Math.round(r.n),
    p50: ms(r.p50),
    p95: ms(r.p95),
    p99: ms(r.p99),
    max: ms(r.max_ms),
    'over3s%': r.n > 0 ? ((100 * r.over_slow) / r.n).toFixed(1) : '-',
    'total_s': (r.total_ms / 1000).toFixed(0),
  }));
}

/** Fixed-width text table; plain text so it reads the same in the Actions log. */
export function table(rows) {
  if (rows.length === 0) return '(none)';
  const cols = Object.keys(rows[0]);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(width[i])).join('  ').trimEnd();
  return [line(cols), line(width.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

const SLOW_MSG = /^\[(slow (?:800ms\+|2s\+|5s\+)|timeout)\]\s+(\S+)\s+(\S+)$/;

/** A SPA pathname with its id-like segments collapsed, so one screen is one line. */
export function normalizePage(route) {
  return String(route ?? '')
    .split('/')
    .map((seg) => (/\d/.test(seg) && seg.length > 0 ? ':id' : seg))
    .join('/') || '/';
}

const weight = (x) => x['0.8s+'] + 2 * x['2s+'] + 4 * x['5s+'] + 6 * x.timeout;

/**
 * Browser-side signal from client_errors (frontend/src/lib/errorReporter.ts):
 * messages "[slow 2s+] GET /api/x" and "[timeout] GET /api/x", stored one row
 * per (message, page, build, user, day) with a count. Counts are capped at 10
 * per signature per browser session, so read them as "how often people
 * waited", not as request counts. Groups the raw rows by `keyOf`.
 */
export function pivotBrowserSlow(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const m = SLOW_MSG.exec(String(r.message ?? '').trim());
    if (!m) continue;
    const key = keyOf({ api: `${m[2]} ${m[3]}`, page: normalizePage(r.route), company: r.company_id ?? 'none' });
    const cur = groups.get(key) ?? { key, '0.8s+': 0, '2s+': 0, '5s+': 0, timeout: 0, users: new Set() };
    const bucket = m[1] === 'timeout' ? 'timeout' : m[1].replace('slow ', '').replace('800ms+', '0.8s+');
    cur[bucket] += Number(r.count) || 0;
    cur.users.add(r.user_id);
    groups.set(key, cur);
  }
  return [...groups.values()]
    .sort((a, b) => weight(b) - weight(a))
    .map((g) => ({ ...g, users: g.users.size }));
}
