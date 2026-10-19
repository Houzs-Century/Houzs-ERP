/* Fair Links to Settle — which orders the page lists, and the badge that counts
   them (owner 2026-10-19: 「总之没有 assign 到 fair 的就列出来就对了」).
   Pinned here:
     • the three reconcile verdicts AND an explicit No fair are listed;
     • an order with no verdict is listed from 1 September 2026 only;
     • a cancelled order, and an order that has a link, never are;
     • the company predicate is applied to every read;
     • the badge counts exactly the rows the page would show. */

import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from './fake-postgrest';
import { countFairPending, loadFairPending, NO_VERDICT_LISTED_FROM } from './fair-pending';

const so = (doc: string, over: Row): Row => ({
  doc_no: doc, company_id: 1, so_date: '2026-10-06', venue: 'MID VALLEY', branding: 'AKEMI',
  project_id: null, fair_match: null, status: 'CONFIRMED', local_total_sen: 100000, salesperson_id: 's1', ...over,
});

/* Shapes taken from production on 2026-10-16/19 (check-so-fair-links.mjs). */
const ROWS = (): Row[] => [
  so('HC-SO-2610-060', { fair_match: 'AMBIGUOUS', so_date: '2026-10-05' }),
  so('HC-SO-2609-331', { fair_match: 'UNMATCHED', so_date: '2026-09-29', branding: 'BEDFRAME' }),
  so('HC-SO-2610-166', { fair_match: 'PENDING', so_date: '2026-10-12', venue: 'IOI MALL KULAI' }),
  so('HC-SO-2609-222', { fair_match: 'NO_FAIR', so_date: '2026-09-27', venue: 'SUNWAY CARNIVAL' }),
  so('HC-SO-2609-009', { fair_match: null, so_date: '2026-09-09' }),
  so('HC-SO-013404', { fair_match: null, so_date: '2026-09-01' }),
  /* Not listed: */
  so('HC-SO-2608-120', { fair_match: null, so_date: '2026-08-31' }),            // before Houzs opened its books
  so('HC-SO-2610-001', { fair_match: 'PICKED', project_id: 363 }),             // linked
  so('HC-SO-2609-500', { fair_match: 'AMBIGUOUS', project_id: 340 }),          // a link beats a stale verdict
  so('HC-SO-2610-099', { fair_match: 'PENDING', status: 'CANCELLED' }),        // not a sale
  so('2990-SO-2610-001', { company_id: 2, fair_match: 'PENDING' }),            // the other company
];

const scope1 = <Q,>(q: Q): Q => (q as unknown as { eq(c: string, v: unknown): Q }).eq('company_id', 1);

describe('loadFairPending', () => {
  it('lists every order with no fair a person should look at, newest first', async () => {
    const sb = fakeSb({ mfg_sales_orders: ROWS() });
    const res = await loadFairPending(sb, scope1, 500);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => r.doc_no)).toEqual([
      'HC-SO-2610-166', 'HC-SO-2610-060', 'HC-SO-2609-331', 'HC-SO-2609-222', 'HC-SO-2609-009', 'HC-SO-013404',
    ]);
  });

  it('starts the no-verdict half on the day Houzs opened its books', () => {
    expect(NO_VERDICT_LISTED_FROM).toBe('2026-09-01');
  });

  it('keeps to the limit after merging both halves', async () => {
    const sb = fakeSb({ mfg_sales_orders: ROWS() });
    const res = await loadFairPending(sb, scope1, 2);
    expect(res.ok && res.rows.map((r) => r.doc_no)).toEqual(['HC-SO-2610-166', 'HC-SO-2610-060']);
  });
});

describe('countFairPending', () => {
  it('counts exactly the rows the page lists', async () => {
    const sb = fakeSb({ mfg_sales_orders: ROWS() });
    const [list, count] = await Promise.all([loadFairPending(sb, scope1, 500), countFairPending(sb, scope1)]);
    expect(count).toEqual({ ok: true, count: 6 });
    expect(list.ok && list.rows.length).toBe(6);
  });

  it('a failed read is a failure, not zero — and not an empty list either', async () => {
    /* The column-missing answer PostgREST gives (42703), the fake's way to fail a read. */
    const sb = fakeSb({ mfg_sales_orders: ROWS() }, { mfg_sales_orders: ['doc_no'] });
    expect((await countFairPending(sb, scope1)).ok).toBe(false);
    expect((await loadFairPending(sb, scope1, 500)).ok).toBe(false);
  });
});
