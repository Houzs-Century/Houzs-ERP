import { describe, expect, it } from 'vitest';
import { ACCOUNTING_TABS, ACCOUNTING_TAB_TITLES, accountingTabFromSearch, logisticsMovedTo } from './accounting-tabs';

/* The sidebar's deep links land on a tab by name (docs/bugs/0824); a name the
   page does not know must fall back, never render an empty page. */
describe('the Accounting tab named in the URL', () => {
  it('is accepted when the page knows it', () => {
    for (const t of ACCOUNTING_TABS) expect(accountingTabFromSearch(t)).toBe(t);
    /* Every tab has the title the page header shows once the strip is gone (docs/bugs/0841). */
    for (const t of ACCOUNTING_TABS) expect(ACCOUNTING_TAB_TITLES[t].length).toBeGreaterThan(0);
  });

  it('falls back on a name the page does not know, or none', () => {
    expect(accountingTabFromSearch('nope')).toBeNull();
    expect(accountingTabFromSearch('')).toBeNull();
    expect(accountingTabFromSearch(null)).toBeNull();
    expect(accountingTabFromSearch(undefined)).toBeNull();
    expect(accountingTabFromSearch('PNL')).toBeNull();
  });
});

/* The Logistics cost tab is the Department P&L's Logistics now (owner 2026-11-25). */
describe('an old Logistics cost address', () => {
  it('lands on the Department P&L\'s Logistics, its dates and view kept, its switches under the Department P&L\'s names', () => {
    expect(accountingTabFromSearch('logistics')).toBeNull();
    expect(logisticsMovedTo(new URLSearchParams('tab=logistics'))).toBe('/scm/accounting?tab=departments&dv=logistics');
    expect(logisticsMovedTo(new URLSearchParams('tab=logistics&from=2026-09-01&to=2026-10-31&lv=region&lm=months&lsplit=1&lpct=0')))
      .toBe('/scm/accounting?tab=departments&dv=logistics&from=2026-09-01&to=2026-10-31&lv=region&dm=months&dsplit=1&dpct=0');
  });
});
