/* Gap review G16: list money tiles counted cancelled documents.

   The SO, Consignment Order and Consignment Note lists sum their Revenue (and
   Outstanding / Paid / Cost / Margin) over every row matching the tab. With no
   tab ("All") that included every cancelled document, which keeps its
   local_total. They now leave cancelled out, except on the Cancelled tab. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { moneySkipsCancelled, NOT_CANCELLED_OR } from '../src/scm/lib/list-money-cancelled';

const src = (f: string) => readFileSync(new URL(`../src/scm/routes/${f}`, import.meta.url), 'utf8');

/** Rows a PostgREST `or=(status.is.null,status.neq.CANCELLED)` keeps. */
const keeps = (status: string | null) =>
  NOT_CANCELLED_OR.split(',').some((part) => (part === 'status.is.null' ? status === null : part === 'status.neq.CANCELLED' && status !== null && status !== 'CANCELLED'));

describe('moneySkipsCancelled', () => {
  it('skips cancelled on All and on every status tab but Cancelled', () => {
    expect(moneySkipsCancelled(undefined)).toBe(true);
    expect(moneySkipsCancelled(null)).toBe(true);
    expect(moneySkipsCancelled('')).toBe(true);
    expect(moneySkipsCancelled('CONFIRMED')).toBe(true);
    expect(moneySkipsCancelled('CANCELLED')).toBe(false);
    expect(moneySkipsCancelled(' cancelled ')).toBe(false);
  });

  it('the predicate drops CANCELLED and keeps a document with no status', () => {
    expect(keeps('CANCELLED')).toBe(false);
    expect(keeps('CONFIRMED')).toBe(true);
    expect(keeps(null)).toBe(true);
  });
});

describe('the three list money reads apply it', () => {
  it('Sales Orders: the money filter closure', () => {
    expect(src('mfg-sales-orders.ts')).toContain('soListMoneyKpis(sb, moneySkipCancelled ? (q: any) => applyMoneyFilters(q).or(NOT_CANCELLED_OR) : applyMoneyFilters)');
  });
  it('Consignment Orders and Notes: the full-set money read', () => {
    for (const f of ['consignment-orders.ts', 'consignment-notes.ts']) {
      expect(src(f)).toContain('if (moneySkipsCancelled(status)) mq = mq.or(NOT_CANCELLED_OR);');
    }
  });
});
