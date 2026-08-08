import { describe, expect, it } from 'vitest';
import { arrangementDateOf, arrangementQueueCompare, type ArrangementSortRow } from './arrangement-sort';

/* The arrangement queues' default order — owner 2026-08-08 (superseding the
   08-07 three-key rule): new date → state → postcode → run time → old date →
   doc no, everything ascending, blanks/nulls LAST. */

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

  it('key 5: the OLD (customer) date breaks remaining ties — the pending-date side ordering', () => {
    const out = sorted([
      row({ so_doc_no: 'B', customer_state: 'KL', postcode: '50000', customer_delivery_date: '2026-08-03' }),
      row({ so_doc_no: 'A', customer_state: 'KL', postcode: '50000', customer_delivery_date: '2026-08-01' }),
      row({ so_doc_no: 'C', customer_state: 'KL', postcode: '50000', customer_delivery_date: null }),
    ]);
    expect(out.map((r) => r.so_doc_no)).toEqual(['A', 'B', 'C']);
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
