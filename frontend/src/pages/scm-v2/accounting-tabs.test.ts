import { describe, expect, it } from 'vitest';
import { ACCOUNTING_TABS, accountingTabFromSearch } from './accounting-tabs';

/* The sidebar's deep links land on a tab by name (docs/bugs/0824); a name the
   page does not know must fall back, never render an empty page. */
describe('the Accounting tab named in the URL', () => {
  it('is accepted when the page knows it', () => {
    for (const t of ACCOUNTING_TABS) expect(accountingTabFromSearch(t)).toBe(t);
  });

  it('falls back on a name the page does not know, or none', () => {
    expect(accountingTabFromSearch('nope')).toBeNull();
    expect(accountingTabFromSearch('')).toBeNull();
    expect(accountingTabFromSearch(null)).toBeNull();
    expect(accountingTabFromSearch(undefined)).toBeNull();
    expect(accountingTabFromSearch('PNL')).toBeNull();
  });
});
