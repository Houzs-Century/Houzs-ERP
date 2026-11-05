/* Owner 2026-11-05 (8 月的要 … all up to August): before September the fairs' orders
   were opened in AutoCount and only one or two reached the ERP, so Project Overview
   showed Johor [AKEMI] REX 8–10/08 at 6,150 against the team's typed 150,618. An event
   that ended before 2026-09-01 and has typed figures reads them; from September, and
   for an event with nothing typed, the ERP orders stay the record. */
import { describe, expect, test } from 'vitest';
import { ORDERS_RECORD_FROM, readsTypedFirst } from '../src/routes/projectOverview';

const ev = (start: string | null, end: string | null, income: number) => ({ start_date: start, end_date: end, income });

describe('which figures Project Overview reads for an event', () => {
  test('ended by 31 August with typed sales: the typed figures', () => {
    expect(ORDERS_RECORD_FROM).toBe('2026-09-01');
    expect(readsTypedFirst(ev('2026-08-08', '2026-08-10', 150618))).toBe(true);
    expect(readsTypedFirst(ev('2026-08-29', '2026-08-31', 157717))).toBe(true);
    expect(readsTypedFirst(ev('2025-11-21', '2025-11-23', 350851))).toBe(true);
  });

  test('ending in September or later: the ERP orders', () => {
    expect(readsTypedFirst(ev('2026-08-29', '2026-09-01', 100000))).toBe(false);
    expect(readsTypedFirst(ev('2026-10-09', '2026-10-12', 386400))).toBe(false);
  });

  test('nothing typed: the orders, whatever the date; no end date falls back to the start', () => {
    expect(readsTypedFirst(ev('2026-08-14', '2026-08-16', 0))).toBe(false);
    expect(readsTypedFirst(ev('2026-07-01', null, 5000))).toBe(true);
    expect(readsTypedFirst(ev(null, null, 5000))).toBe(false);
  });
});
