import { describe, expect, it } from 'vitest';
import { arrangementDateOf, arrangementQueueCompare, type ArrangementSortRow } from './arrangement-sort';

/* The arrangement queues' default order — owner 2026-08-08 v3: new date →
   [both new-dateless: old date first] → state → postcode → run time → old
   date → doc no, everything ascending, blanks/nulls LAST. On the pending-date
   side (no arranged date) the customer's ORIGINAL date outranks geography. */

const row = (over: Partial<ArrangementSortRow>): ArrangementSortRow => ({
  amended_delivery_date: null,
  customer_delivery_date: null,
  customer_state: null,
  postcode: null,
  so_doc_no: null,
  ...over,
});

const sorted = (rows: ArrangementSortRow[]) => [...rows].sort(arrangementQueueCompare);

describe('arrangementDateOf — the ARRANGED (new) date only', () => {
  it('reads amended_delivery_date, day-truncated; customer date never leaks in', () => {
    expect(arrangementDateOf(row({ amended_delivery_date: '2026-08-12T08:00:00Z' }))).toBe('2026-08-12');
    expect(arrangementDateOf(row({ customer_delivery_date: '2026-08-01' }))).toBeNull();
  });
});

describe('arrangementQueueCompare — new date → state → postcode → time → old date → doc no', () => {
  it('key 1: oldest NEW date first, dateless rows below every dated row', () => {
    const out = sorted([
      row({ so_doc_no: 'C', amended_delivery_date: null }),
      row({ so_doc_no: 'B', amended_delivery_date: '2026-08-20' }),
      row({ so_doc_no: 'A', amended_delivery_date: '2026-08-12' }),
    ]);
    expect(out.map((r) => r.so_doc_no)).toEqual(['A', 'B', 'C']);
  });

  it('key 2/3: same new date groups by state then postcode, blanks last', () => {
    const out = sorted([
      row({ so_doc_no: 'D', amended_delivery_date: '2026-08-12', customer_state: 'Selangor', postcode: '47100' }),
      row({ so_doc_no: 'C', amended_delivery_date: '2026-08-12', customer_state: 'Selangor', postcode: '40000' }),
      row({ so_doc_no: 'B', amended_delivery_date: '2026-08-12', customer_state: 'Kuala Lumpur', postcode: '59200' }),
      row({ so_doc_no: 'E', amended_delivery_date: '2026-08-12', customer_state: null, postcode: '10000' }),
    ]);
    expect(out.map((r) => r.so_doc_no)).toEqual(['B', 'C', 'D', 'E']);
  });

  it('key 4: within the same group, run time orders (eta offset, then stop no); off-trip rows tie through below', () => {
    const g = { amended_delivery_date: '2026-08-12', customer_state: 'KL', postcode: '50000' };
    const out = sorted([
      row({ ...g, so_doc_no: 'C' }),
      row({ ...g, so_doc_no: 'B', trip_eta_offset_s: 5400 }),
      row({ ...g, so_doc_no: 'A', trip_eta_offset_s: 1800 }),
      row({ ...g, so_doc_no: 'B2', trip_eta_offset_s: 5400, trip_stop_no: 2 }),
    ]);
    expect(out.map((r) => r.so_doc_no)).toEqual(['A', 'B2', 'B', 'C']);
  });

  it('key 5: the OLD (customer) date breaks remaining ties within one old-date-and-geo group', () => {
    const out = sorted([
      row({ so_doc_no: 'B', customer_state: 'KL', postcode: '50000', customer_delivery_date: '2026-08-03' }),
      row({ so_doc_no: 'A', customer_state: 'KL', postcode: '50000', customer_delivery_date: '2026-08-01' }),
      row({ so_doc_no: 'C', customer_state: 'KL', postcode: '50000', customer_delivery_date: null }),
    ]);
    expect(out.map((r) => r.so_doc_no)).toEqual(['A', 'B', 'C']);
  });

  /* ── The pending-date side (owner 2026-08-08 v3): no arranged date on either
     row → the customer's ORIGINAL date OUTRANKS geography. ─────────────────── */
  describe('pending side — old date outranks state/postcode when no new date exists', () => {
    it('orders by oldest promised customer date FIRST, then state, then postcode', () => {
      const out = sorted([
        row({ so_doc_no: 'C', customer_state: 'Johor', postcode: '80000', customer_delivery_date: '2026-08-05' }),
        row({ so_doc_no: 'A', customer_state: 'Selangor', postcode: '47100', customer_delivery_date: '2026-08-01' }),
        row({ so_doc_no: 'B', customer_state: 'Kuala Lumpur', postcode: '50000', customer_delivery_date: '2026-08-03' }),
      ]);
      // Oldest promise wins even though its state sorts LAST alphabetically.
      expect(out.map((r) => r.so_doc_no)).toEqual(['A', 'B', 'C']);
    });

    it('same old date groups by state then postcode; old-dateless rows sink last', () => {
      const out = sorted([
        row({ so_doc_no: 'D', customer_state: 'Johor', postcode: '80000', customer_delivery_date: null }),
        row({ so_doc_no: 'B', customer_state: 'Selangor', postcode: '40000', customer_delivery_date: '2026-08-01' }),
        row({ so_doc_no: 'A', customer_state: 'Kuala Lumpur', postcode: '59200', customer_delivery_date: '2026-08-01' }),
        row({ so_doc_no: 'C', customer_state: 'Selangor', postcode: '47100', customer_delivery_date: '2026-08-01' }),
      ]);
      expect(out.map((r) => r.so_doc_no)).toEqual(['A', 'B', 'C', 'D']);
    });

    it('when either row HAS a new date, the established order stands (state before old date)', () => {
      const out = sorted([
        // Same non-null NEW date: state decides, NOT the old date.
        row({ so_doc_no: 'B', amended_delivery_date: '2026-08-12', customer_state: 'Selangor', customer_delivery_date: '2026-08-01' }),
        row({ so_doc_no: 'A', amended_delivery_date: '2026-08-12', customer_state: 'Kuala Lumpur', customer_delivery_date: '2026-08-05' }),
      ]);
      expect(out.map((r) => r.so_doc_no)).toEqual(['A', 'B']);
    });
  });

  it('key 6: document number is the final tiebreak (dp_no stands in when no SO)', () => {
    const g = { customer_state: 'KL', postcode: '50000', customer_delivery_date: '2026-08-01' };
    const out = sorted([
      row({ ...g, so_doc_no: 'SO-2' }),
      row({ ...g, so_doc_no: null, dp_no: 'DP-1' }),
      row({ ...g, so_doc_no: 'SO-1' }),
    ]);
    expect(out.map((r) => r.so_doc_no ?? r.dp_no)).toEqual(['DP-1', 'SO-1', 'SO-2']);
  });
});
