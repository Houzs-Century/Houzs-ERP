/* Quality Overview filters (owner 2026-11-01): supplier, issue category and company narrow every read, after the visibility scope. */
import { describe, expect, test } from 'vitest';
import { overviewFilter, withOverviewFilter } from '../src/routes/lib/assr-overview-filter';

const req = (q: Record<string, string>) => ({ req: { query: (k: string) => q[k] } });

describe('assr overview filter', () => {
  test('blank means all; a company that is not a number is ignored', () => {
    expect(overviewFilter(req({ fSupplier: ' ', fCompany: '1;DROP' }))).toEqual({ supplier: null, category: null, company: null });
  });
  test('the filters follow the visibility scope, with their binds after its binds', () => {
    const scope = (p = 'c.') => ({ sql: ` AND ${p}owner = ?`, binds: ['u1'] });
    const f = overviewFilter(req({ fSupplier: 'HKI', fCategory: 'Damage', fCompany: '2' }));
    expect(withOverviewFilter(scope, f)('a.')).toEqual({
      sql: ' AND a.owner = ? AND a.creditor_code = ? AND a.issue_category = ? AND a.company_id = ?',
      binds: ['u1', 'HKI', 'Damage', '2'],
    });
  });
  test('no filter leaves the scope exactly as it was', () => {
    const scope = (p = 'c.') => ({ sql: ` AND ${p}x = ?`, binds: ['v'] });
    expect(withOverviewFilter(scope, overviewFilter(req({})))('c.')).toEqual(scope('c.'));
  });
});
