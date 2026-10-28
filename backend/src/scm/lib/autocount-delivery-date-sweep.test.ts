// The delivery-date sweep's whole decision is `planDeliveryDateSweep`, which is
// pure — so every rule its header claims is asserted here without a database or
// the AutoCount host. What it protects is narrow and specific: this sweep runs
// on a cron, unattended, and writes to documents the floor reads, so each
// "leave it alone" case below is a way it could have widened its own blast
// radius. docs/bugs/0810.
import { describe, expect, it } from 'vitest';

import {
  planDeliveryDateSweep, sweepSince,
  type BookDeliveryDate,
} from './autocount-delivery-date-sweep';

const book = (rows: Array<[string, number, string]>): BookDeliveryDate[] =>
  rows.map(([DocNo, DtlKey, DeliveryDate]) => ({ DocNo, DtlKey, DeliveryDate }));

interface Line {
  id: string;
  linked_ac_dtlkey: number | string | null;
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean | null;
  parent: string | null;
}
const line = (o: Partial<Line> & { id: string }): Line => ({
  linked_ac_dtlkey: 1, line_delivery_date: '2026-09-05',
  line_delivery_date_overridden: false, parent: 'HC-SO-1', ...o,
});
const headers = (o: Record<string, { date: string | null; amended: string | null }>) =>
  new Map(Object.entries(o));

describe('planDeliveryDateSweep — lines', () => {
  it('moves a line whose date the book has changed', () => {
    const { lines } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]), [line({ id: 'a' })], headers({}),
    );
    expect(lines).toEqual([{ id: 'a', from: '2026-09-05', to: '2026-09-19', parent: 'HC-SO-1' }]);
  });

  it('leaves a line the operator overrode', () => {
    const { lines } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]),
      [line({ id: 'a', line_delivery_date_overridden: true })], headers({}),
    );
    expect(lines).toEqual([]);
  });

  it('leaves a BLANK line — a blank is not a change, and MRP gates on this field', () => {
    const { lines } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]),
      [line({ id: 'a', line_delivery_date: null })], headers({}),
    );
    expect(lines).toEqual([]);
  });

  it('leaves a line the window does not cover', () => {
    const { lines } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]),
      [line({ id: 'a', linked_ac_dtlkey: 999 })], headers({}),
    );
    expect(lines).toEqual([]);
  });

  it('leaves a line already in step', () => {
    const { lines } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]),
      [line({ id: 'a', line_delivery_date: '2026-09-19' })], headers({}),
    );
    expect(lines).toEqual([]);
  });

  it('matches on the book DtlKey whether it arrives as a number or a string', () => {
    const { lines } = planDeliveryDateSweep(
      book([['HC-SO-1', 779361, '2026-09-19']]),
      [line({ id: 'a', linked_ac_dtlkey: '779361' })], headers({}),
    );
    expect(lines.map((l) => l.id)).toEqual(['a']);
  });
});

describe('planDeliveryDateSweep — headers', () => {
  it('follows the book when every line of the document agrees', () => {
    const { headers: h } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19'], ['HC-SO-1', 2, '2026-09-19']]),
      [line({ id: 'a', linked_ac_dtlkey: 1 }), line({ id: 'b', linked_ac_dtlkey: 2 })],
      headers({ 'HC-SO-1': { date: '2026-09-05', amended: null } }),
    );
    expect(h).toEqual([{ key: 'HC-SO-1', from: '2026-09-05', to: '2026-09-19' }]);
  });

  it('leaves the header when the book lines disagree — only the lines move', () => {
    const { lines, headers: h } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19'], ['HC-SO-1', 2, '2026-09-22']]),
      [line({ id: 'a', linked_ac_dtlkey: 1 }), line({ id: 'b', linked_ac_dtlkey: 2 })],
      headers({ 'HC-SO-1': { date: '2026-09-05', amended: null } }),
    );
    expect(h).toEqual([]);
    expect(lines.map((l) => l.id).sort()).toEqual(['a', 'b']);
  });

  it('leaves a header carrying an amendment — that disagreement is the write-back’s fault, not the pull’s', () => {
    const { headers: h } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]), [line({ id: 'a' })],
      headers({ 'HC-SO-1': { date: '2026-09-05', amended: '2026-09-30' } }),
    );
    expect(h).toEqual([]);
  });

  it('leaves a BLANK header', () => {
    const { headers: h } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]), [line({ id: 'a' })],
      headers({ 'HC-SO-1': { date: null, amended: null } }),
    );
    expect(h).toEqual([]);
  });

  it('leaves a header it was given no current value for', () => {
    const { headers: h } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]), [line({ id: 'a' })], headers({}),
    );
    expect(h).toEqual([]);
  });

  it('counts a document by its BOOK dates, so an overridden line still lets the header follow', () => {
    /* The override protects that LINE, not the document: the book still says one
       date for the whole document, and the header is a different field. */
    const { lines, headers: h } = planDeliveryDateSweep(
      book([['HC-SO-1', 1, '2026-09-19']]),
      [line({ id: 'a', line_delivery_date_overridden: true })],
      headers({ 'HC-SO-1': { date: '2026-09-05', amended: null } }),
    );
    expect(lines).toEqual([]);
    expect(h).toEqual([{ key: 'HC-SO-1', from: '2026-09-05', to: '2026-09-19' }]);
  });
});

describe('sweepSince', () => {
  it('reaches back the window and returns a plain ISO date', () => {
    expect(sweepSince(new Date('2026-09-11T05:00:00Z'), 120)).toBe('2026-05-14');
  });

  it('crosses a year boundary', () => {
    expect(sweepSince(new Date('2026-01-10T00:00:00Z'), 30)).toBe('2025-12-11');
  });
});
