// Pins the arrangement queues' default ordering (owner 2026-08-07: "跟着
// delivery date、state、postcode 去排"): delivery date ascending with missing
// dates LAST, then customer state, then postcode. See arrangement-sort.ts for
// why the date key is the effective date and how the default interacts with a
// clicked column sort.
import { describe, expect, test } from 'vitest';
import {
  arrangementDateOf,
  arrangementQueueCompare,
  type ArrangementSortRow,
} from './arrangement-sort';

const row = (over: Partial<ArrangementSortRow>): ArrangementSortRow => ({
  effective_delivery_date: null,
  amended_delivery_date: null,
  customer_delivery_date: null,
  customer_state: null,
  postcode: null,
  ...over,
});

describe('arrangementDateOf — the date key', () => {
  test('prefers the server-derived effective date', () => {
    expect(
      arrangementDateOf(row({
        effective_delivery_date: '2026-08-01',
        amended_delivery_date: '2026-08-02',
        customer_delivery_date: '2026-08-03',
      })),
    ).toBe('2026-08-01');
  });

  test('falls through amended → customer when effective is missing (old cached payloads)', () => {
    expect(
      arrangementDateOf(row({ amended_delivery_date: '2026-08-02', customer_delivery_date: '2026-08-03' })),
    ).toBe('2026-08-02');
    expect(arrangementDateOf(row({ customer_delivery_date: '2026-08-03' }))).toBe('2026-08-03');
    expect(arrangementDateOf(row({}))).toBeNull();
  });

  test('truncates a timestamp to its calendar day so same-day rows tie', () => {
    expect(arrangementDateOf(row({ effective_delivery_date: '2026-08-07T10:30:00Z' }))).toBe('2026-08-07');
  });
});

describe('arrangementQueueCompare — date asc → state → postcode', () => {
  test('oldest delivery date first (ascending)', () => {
    const older = row({ effective_delivery_date: '2026-07-01' });
    const newer = row({ effective_delivery_date: '2026-08-05' });
    expect(arrangementQueueCompare(older, newer)).toBeLessThan(0);
    expect(arrangementQueueCompare(newer, older)).toBeGreaterThan(0);
  });

  test('rows with NO date sink to the bottom, never the top', () => {
    const dated = row({ effective_delivery_date: '2026-12-31' });
    const dateless = row({ customer_state: 'Aaa' }); // an early state must not rescue it
    expect(arrangementQueueCompare(dated, dateless)).toBeLessThan(0);
    expect(arrangementQueueCompare(dateless, dated)).toBeGreaterThan(0);
  });

  test('same date → state breaks the tie, A→Z, case-insensitively', () => {
    const johor = row({ effective_delivery_date: '2026-08-01', customer_state: 'johor' });
    const selangor = row({ effective_delivery_date: '2026-08-01', customer_state: 'Selangor' });
    expect(arrangementQueueCompare(johor, selangor)).toBeLessThan(0);
    expect(arrangementQueueCompare(selangor, johor)).toBeGreaterThan(0);
  });

  test('same date + state → postcode breaks the tie ascending', () => {
    const near = row({ effective_delivery_date: '2026-08-01', customer_state: 'Selangor', postcode: '40000' });
    const far = row({ effective_delivery_date: '2026-08-01', customer_state: 'Selangor', postcode: '47810' });
    expect(arrangementQueueCompare(near, far)).toBeLessThan(0);
  });

  test('blank state / postcode sort after real values on a tied date', () => {
    const withState = row({ effective_delivery_date: '2026-08-01', customer_state: 'Johor' });
    const noState = row({ effective_delivery_date: '2026-08-01', customer_state: '  ' });
    expect(arrangementQueueCompare(withState, noState)).toBeLessThan(0);

    const withPost = row({ effective_delivery_date: '2026-08-01', customer_state: 'Johor', postcode: '80000' });
    const noPost = row({ effective_delivery_date: '2026-08-01', customer_state: 'Johor', postcode: null });
    expect(arrangementQueueCompare(withPost, noPost)).toBeLessThan(0);
  });

  test('full tie returns 0 (stable sort keeps the server order)', () => {
    const a = row({ effective_delivery_date: '2026-08-01', customer_state: 'Johor', postcode: '80000' });
    const b = row({ effective_delivery_date: '2026-08-01', customer_state: 'Johor', postcode: '80000' });
    expect(arrangementQueueCompare(a, b)).toBe(0);
  });

  test('a whole queue sorts date → state → postcode with dateless rows last', () => {
    const rows = [
      row({ effective_delivery_date: '2026-08-05', customer_state: 'Johor', postcode: '80000' }),
      row({ customer_state: 'Aaa' }),
      row({ effective_delivery_date: '2026-08-01', customer_state: 'Selangor', postcode: '47810' }),
      row({ effective_delivery_date: '2026-08-01', customer_state: 'Johor', postcode: '80000' }),
      row({ effective_delivery_date: '2026-08-01', customer_state: 'Selangor', postcode: '40000' }),
    ];
    const sorted = [...rows].sort(arrangementQueueCompare);
    expect(sorted.map((r) => [arrangementDateOf(r), r.customer_state, r.postcode])).toEqual([
      ['2026-08-01', 'Johor', '80000'],
      ['2026-08-01', 'Selangor', '40000'],
      ['2026-08-01', 'Selangor', '47810'],
      ['2026-08-05', 'Johor', '80000'],
      [null, 'Aaa', null],
    ]);
  });
});
