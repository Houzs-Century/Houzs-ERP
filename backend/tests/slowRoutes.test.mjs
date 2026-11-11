// check-slow-routes.mjs reads timings nobody else reads. What can go silently
// wrong is the reading: the AE blob/double layout drifting from requestLog.ts,
// counting AE points instead of weighting by _sample_interval, a 401 reported
// as a crash, or browser buckets landing in the wrong column.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  parseDays, routeSql, slowestSql, totalsSql, writeRouteCompanySql, readAeAnswer, routeLines, slowestLines, table, pivotBrowserSlow, normalizePage,
} from '../scripts/lib/slow-routes.mjs';

describe('AE SQL', () => {
  it('matches the layout requestLog.ts writes', () => {
    const src = readFileSync(new URL('../src/middleware/requestLog.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/blobs: \["req", route, String\(status\), id, c\.req\.method/);
    expect(src).toMatch(/doubles: \[ms,/);
    const sql = routeSql(7, 40);
    expect(sql).toContain("blob1 = 'req'");
    expect(sql).toContain('blob5 AS method, blob2 AS route');
    expect(sql).toContain("INTERVAL '7' DAY");
  });

  it('reads company from blob6 and database work from double2/double3, as requestLog.ts writes them', () => {
    const src = readFileSync(new URL('../src/middleware/requestLog.ts', import.meta.url), 'utf8');
    expect(src).toContain('c.req.method, companyId == null ? "" : String(companyId)]');
    expect(src).toContain('doubles: [ms, db.ms, db.n]');
    expect(slowestSql(7, 20)).toContain('blob6 AS company, double1 AS ms, double2 AS db_ms, double3 AS db_n');
    for (const sql of [routeSql(7, 40), writeRouteCompanySql(7, 40)]) {
      // only points that recorded database work, so old zero points do not dilute the average
      expect(sql).toContain('sumIf(_sample_interval, double3 > 0) AS db_pts');
      expect(sql).toContain('sumIf(double2 * _sample_interval, double3 > 0) AS db_ms_sum');
      expect(sql).not.toContain('count()');
    }
    const byCo = writeRouteCompanySql(7, 40);
    expect(byCo).toContain('GROUP BY method, route, company');
    expect(byCo).toContain("blob6 != ''");
    expect(byCo).toContain("blob5 = 'POST'");
  });

  it('weights every aggregate by _sample_interval', () => {
    const sql = routeSql(7, 40);
    expect(sql).toContain('sum(_sample_interval) AS n');
    expect(sql).toContain('quantileExactWeighted(0.95)(double1, _sample_interval)');
    expect(sql).toContain('sumIf(_sample_interval, double1 > 3000)');
    expect(sql).not.toMatch(/count\(\)/);
    expect(totalsSql(7)).toContain('sum(_sample_interval) AS n');
    expect(slowestSql(7, 20)).toContain('ORDER BY ms DESC');
  });

  it('refuses a window that is not 1..90 whole days', () => {
    expect(parseDays(undefined)).toBe(7);
    expect(parseDays('30')).toBe(30);
    for (const bad of ['0', '91', '7; DROP', '1.5', '-1']) expect(() => parseDays(bad)).toThrow();
  });
});

describe('readAeAnswer', () => {
  it('reports a refused token as forbidden, not as a broken check', () => {
    expect(readAeAnswer(403, 'nope').kind).toBe('forbidden');
    expect(readAeAnswer(401, 'nope').kind).toBe('forbidden');
    expect(readAeAnswer(422, 'bad sql').kind).toBe('error');
    expect(readAeAnswer(200, 'not json').kind).toBe('error');
  });

  it('coerces quoted 64-bit numbers', () => {
    const a = readAeAnswer(200, JSON.stringify({ data: [{ route: '/x', n: '12', p95: 1500.5 }] }));
    expect(a).toEqual({ kind: 'ok', rows: [{ route: '/x', n: 12, p95: 1500.5 }] });
  });
});

describe('routeLines + table', () => {
  it('shows the over-3s share of that route and total seconds', () => {
    const [l] = routeLines([{ method: 'GET', route: '/a', n: 200, p50: 100, p95: 3500, p99: 5000, max_ms: 9000, over_slow: 10, total_ms: 60000 }]);
    expect(l).toMatchObject({ n: 200, p95: '3500', 'over3s%': '5.0', total_s: '60' });
    expect(table([l]).split('\n')).toHaveLength(3);
    expect(table([])).toBe('(none)');
  });

  it('averages database work over the points that recorded it, and says - when none did', () => {
    const base = { method: 'POST', route: '/api/scm/grns', n: 100, p50: 1, p95: 1, p99: 1, max_ms: 1, over_slow: 0, total_ms: 1000 };
    expect(routeLines([{ ...base, db_pts: 40, db_ms_sum: 80000, db_n_sum: 4200 }])[0]).toMatchObject({ db_ms: '2000', db_n: '105.0' });
    const none = routeLines([{ ...base, db_pts: 0, db_ms_sum: 0, db_n_sum: 0 }])[0];
    expect(none).toMatchObject({ db_ms: '-', db_n: '-' });
    expect(none).not.toHaveProperty('company');
    expect(routeLines([{ ...base, company: '1', db_pts: 0 }])[0]).toMatchObject({ company: '1' });
  });

  it('shows company and database work on the slowest requests, - on old points', () => {
    const [fresh, old] = slowestLines([
      { timestamp: 't', method: 'POST', route: '/r', status: '201', request_id: 'id1', company: '2', ms: 9100.4, db_ms: 7000, db_n: 312 },
      { timestamp: 't', method: 'POST', route: '/r', status: '201', request_id: 'id2', company: '', ms: 8000, db_ms: 0, db_n: 0 },
    ]);
    expect(fresh).toMatchObject({ company: '2', ms: '9100', db_ms: '7000', db_n: '312' });
    expect(old).toMatchObject({ company: '-', db_ms: '-', db_n: '-' });
  });
});

describe('pivotBrowserSlow', () => {
  const rows = [
    { message: '[slow 2s+] GET /api/scm/delivery-planning', route: '/scm/delivery-planning', company_id: 1, user_id: 5, count: 3 },
    { message: '[slow 800ms+] GET /api/scm/delivery-planning', route: '/scm/so/HC-SO-123', company_id: 1, user_id: 6, count: 1 },
    { message: '[timeout] GET /api/scm/delivery-planning', route: '/scm/delivery-planning', company_id: 2, user_id: 5, count: 2 },
    { message: '[slow 5s+] GET /api/scm/inventory/products', route: '/scm/inventory', company_id: 1, user_id: 7, count: 1 },
    { message: 'TypeError: x is undefined', route: '/', company_id: 1, user_id: 7, count: 99 },
  ];

  it('puts each bucket in its column and counts distinct users', () => {
    const [dp, inv] = pivotBrowserSlow(rows, (x) => x.api);
    expect(dp).toEqual({ key: 'GET /api/scm/delivery-planning', '0.8s+': 1, '2s+': 3, '5s+': 0, timeout: 2, users: 2 });
    expect(inv).toMatchObject({ key: 'GET /api/scm/inventory/products', '5s+': 1, users: 1 });
  });

  it('ignores crash rows and collapses ids in the page', () => {
    expect(pivotBrowserSlow(rows, (x) => x.api)).toHaveLength(2);
    expect(normalizePage('/scm/so/HC-SO-123')).toBe('/scm/so/:id');
    expect(pivotBrowserSlow(rows, (x) => String(x.company)).map((g) => g.key)).toEqual(['2', '1']);
  });
});
