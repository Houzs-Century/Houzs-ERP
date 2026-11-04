/* Owner follow-up 2026-10-23: the Delivery Planning board defaults to EFFECTIVE
 * delivery date (amended ?? original customer date), earliest first, and the All
 * tab buckets rows by that date's month with a trailing "No date" group. These
 * tests pin the shared key/comparator/label so the sort and the month buckets
 * can never disagree.
 */
import { describe, expect, test } from 'vitest';
import {
  effectiveDeliveryDay,
  compareByDeliveryDate,
  compareByDeliverySlot,
  compareDoPrintOrder,
  deliveryMonthKey,
  deliveryMonthLabel,
  type DeliveryDateRow,
  type DeliverySlotRow,
} from './delivery-date-group';

const row = (amended: string | null, customer: string | null): DeliveryDateRow => ({
  amended_delivery_date: amended,
  customer_delivery_date: customer,
});

describe('effectiveDeliveryDay', () => {
  test('prefers the amended date, falls back to the customer date, truncates to the day', () => {
    expect(effectiveDeliveryDay(row('2026-10-15', '2026-09-01'))).toBe('2026-10-15');
    expect(effectiveDeliveryDay(row(null, '2026-09-01'))).toBe('2026-09-01');
    expect(effectiveDeliveryDay(row('2026-10-15T08:30:00Z', null))).toBe('2026-10-15');
    expect(effectiveDeliveryDay(row(null, null))).toBeNull();
  });
});

describe('compareByDeliveryDate — default ordering', () => {
  test('earliest effective date first, no-date rows last', () => {
    const noDate = row(null, null);
    const oct = row('2026-10-20', null);
    const sep = row(null, '2026-09-05'); // customer-date fallback
    const aug = row('2026-08-01', '2026-12-31');
    const sorted = [noDate, oct, sep, aug].slice().sort(compareByDeliveryDate);
    expect(sorted.map(effectiveDeliveryDay)).toEqual(['2026-08-01', '2026-09-05', '2026-10-20', null]);
  });

  test('two no-date rows tie (stable)', () => {
    expect(compareByDeliveryDate(row(null, null), row(null, null))).toBe(0);
  });
});

describe('deliveryMonthKey / deliveryMonthLabel — month buckets', () => {
  test('key is YYYY-MM off the effective date; no date -> empty key', () => {
    expect(deliveryMonthKey(row('2026-10-15', null))).toBe('2026-10');
    expect(deliveryMonthKey(row(null, '2026-09-30'))).toBe('2026-09');
    expect(deliveryMonthKey(row(null, null))).toBe('');
  });

  test('label is YYYY/MM (app date order, no month name); empty key -> "No date"', () => {
    expect(deliveryMonthLabel('2026-10')).toBe('2026/10');
    expect(deliveryMonthLabel('2026-01')).toBe('2026/01');
    expect(deliveryMonthLabel('')).toBe('No date');
  });
});

describe("compareByDeliverySlot — each lorry's day, earliest Time Slot first", () => {
  const stop = (so: string, day: string | null, lorry: string | null, slot: string | null, extra: Partial<DeliverySlotRow> = {}): DeliverySlotRow => ({
    ...row(day, null), so_doc_no: so, time_range: slot, crew: { lorry_plate: lorry }, ...extra,
  });
  const order = (rows: DeliverySlotRow[]) => rows.slice().sort(compareByDeliverySlot).map((r) => r.so_doc_no);

  test("the reporter's VQE9058 run reads 9AM to 5PM", () => {
    const d = '2026-11-04';
    expect(order([
      stop('HC-SO-2609-314', d, 'VQE9058', '3:30PM TO 5:30PM'),
      stop('HC-SO-012317', d, 'VQE9058', '12PM TO 2PM'),
      stop('HC-SO-012987', d, 'VQE9058', '10:30AM TO 12:30PM'),
      stop('HC-SO-2610-020', d, 'VQE9058', '9AM TO 11AM'),
      stop('HC-SO-2610-164', d, 'VQE9058', '5PM TO 7PM'),
      stop('HC-SO-2609-281', d, 'VQE9058', '2PM TO 4PM'),
    ])).toEqual(['HC-SO-2610-020', 'HC-SO-012987', 'HC-SO-012317', 'HC-SO-2609-281', 'HC-SO-2609-314', 'HC-SO-2610-164']);
  });

  test('the date outranks the slot, and a row with no slot sinks to the end of its lorry', () => {
    expect(order([
      stop('NEXT-DAY-9AM', '2026-11-05', 'A', '9AM TO 11AM'),
      stop('NO-SLOT', '2026-11-04', 'A', null),
      stop('TODAY-5PM', '2026-11-04', 'A', '5PM TO 7PM'),
    ])).toEqual(['TODAY-5PM', 'NO-SLOT', 'NEXT-DAY-9AM']);
  });

  test('two lorries never interleave; a row with no lorry sinks to the end of its day', () => {
    const d = '2026-11-04';
    expect(order([
      stop('NO-LORRY', d, null, '8AM TO 9AM'),
      stop('B-9AM', d, 'B', '9AM TO 11AM'),
      stop('A-2PM', d, 'A', '2PM TO 4PM'),
      stop('A-10AM', d, 'A', '10AM TO 12PM'),
    ])).toEqual(['A-10AM', 'A-2PM', 'B-9AM', 'NO-LORRY']);
  });

  test("a stop sequence set on the trip outranks the slot, like the driver's phone", () => {
    const d = '2026-11-04';
    expect(order([
      stop('EARLY-BUT-SECOND', d, 'A', '9AM TO 11AM', { trip_stop_no: 2 }),
      stop('LATE-BUT-FIRST', d, 'A', '6PM TO 8PM', { trip_stop_no: 1 }),
    ])).toEqual(['LATE-BUT-FIRST', 'EARLY-BUT-SECOND']);
  });
});

describe('compareDoPrintOrder — a printed DO stack reads like the board', () => {
  const d = '2026-11-04';
  const order = (rows: Array<Parameters<typeof compareDoPrintOrder>[0]>) =>
    rows.slice().sort(compareDoPrintOrder).map((r) => r.so_doc_no);

  test('earliest Time Slot first inside one lorry', () => {
    expect(order([
      { so_doc_no: '3PM', expected_delivery_at: d, time_range: '3:30PM TO 5:30PM', crew: { lorry_plate: 'VQE9058' } },
      { so_doc_no: '9AM', expected_delivery_at: d, time_range: '9AM TO 11AM', crew: { lorry_plate: 'VQE9058' } },
    ])).toEqual(['9AM', '3PM']);
  });

  test('the crew lorry wins, and Vehicle stands in when no crew is set', () => {
    expect(order([
      { so_doc_no: 'B', expected_delivery_at: d, time_range: '8AM TO 9AM', vehicle: 'B', crew: null },
      { so_doc_no: 'A', expected_delivery_at: d, time_range: '2PM TO 4PM', vehicle: 'Z', crew: { lorry_plate: 'A' } },
    ])).toEqual(['A', 'B']);
  });
});
