import { describe, expect, it } from 'vitest';
import { partCountFor, partLabel, splitPackingList, splitPackingRegion } from './packing-list-split';
import type { PackingListRow, PackingRegionDo, PackingRegionRow, PackingStop } from './packing-list-queries';

const stop = (n: number, doId: string | null): PackingStop => ({
  stop_no: n, stop_type: null, customer_name: `C${n}`, address: null, do_id: doId, do_number: doId, do_status: 'LOADED',
  do_missing: false, so_doc_no: null, phone: null, time_range: null, units: 2, items: [],
});

const list = (dos: number, source: PackingListRow['source'] = 'crew'): PackingListRow => ({
  trip_id: 'crew:VJK8821', trip_no: null, trip_date: '2026-11-28', trip_status: null, lorry_plate: 'VJK 8821',
  driver_name: null, driver_phone: null, helper_1_name: null, helper_2_name: null, warehouse_name: null,
  stop_count: dos, do_count: dos, units: dos * 2, m3_milli: 5000,
  stops: Array.from({ length: dos }, (_, i) => stop(dos - i, `do-${dos - i}`)),
  source,
});

const rdo = (i: number, plate: string | null): PackingRegionDo => ({
  do_id: `do-${i}`, do_number: `DO-${i}`, do_status: 'LOADED', so_doc_no: null, customer_name: `C${i % 7}`, address: null,
  phone: null, time_range: null, debtor_code: null, m3_milli: null, lorry_plate: plate, driver_name: null, driver_phone: null,
  helper_1_name: null, helper_2_name: null, trip_no: null, trip_stop_no: null, state: null, country: null, units: 1, items: [],
});

const region = (n: number): PackingRegionRow => {
  const dos = Array.from({ length: n }, (_, i) => rdo(i + 1, i % 2 ? 'VJK 8821' : null));
  return { region: 'KL', label: 'KL', do_count: n, customer_count: 7, units: n, lorry_plates: ['VJK 8821'], not_arranged: 0, dos };
};

describe('splitting a packing list over 60 DOs (owner 2026-11-28)', () => {
  it('60 DOs or fewer stays one sheet with no part', () => {
    expect(splitPackingList(list(60))).toEqual([{ sheet: list(60), part: null }]);
    expect(partCountFor(60)).toBe(1);
    expect(partLabel(null)).toBe('');
  });

  it('65 DOs prints as two even parts in delivery order, every DO exactly once', () => {
    const pieces = splitPackingList(list(65));
    expect(pieces.map((p) => p.part)).toEqual([{ no: 1, count: 2 }, { no: 2, count: 2 }]);
    expect(pieces.map((p) => p.sheet.do_count)).toEqual([33, 32]);
    expect(pieces[0]!.sheet.stops[0]!.stop_no).toBe(1);
    expect(pieces[1]!.sheet.stops[0]!.stop_no).toBe(34);
    const all = pieces.flatMap((p) => p.sheet.stops.map((s) => s.do_id));
    expect(new Set(all).size).toBe(65);
    expect(pieces[0]!.sheet.units).toBe(66);
    expect(pieces[0]!.sheet.m3_milli).toBeNull();
    expect(partLabel(pieces[1]!.part)).toBe('Part 2 of 2');
  });

  it('no part ever holds more than 60 DOs', () => {
    for (const n of [61, 120, 121, 179, 181, 300]) {
      const pieces = splitPackingList(list(n));
      expect(pieces.length).toBe(partCountFor(n));
      expect(Math.max(...pieces.map((p) => p.sheet.do_count))).toBeLessThanOrEqual(60);
      expect(pieces.reduce((t, p) => t + p.sheet.do_count, 0)).toBe(n);
    }
  });

  it('a trip list is never split: its QR is the trip, not a DO set', () => {
    expect(splitPackingList(list(80, 'trip'))).toHaveLength(1);
  });

  it('a region over 60 splits too, each part with its own totals', () => {
    const pieces = splitPackingRegion(region(70));
    expect(pieces.map((p) => p.sheet.do_count)).toEqual([35, 35]);
    expect(pieces[0]!.sheet.dos[0]!.do_id).toBe('do-1');
    expect(pieces[1]!.sheet.dos[0]!.do_id).toBe('do-36');
    expect(pieces[0]!.sheet.not_arranged).toBe(18);
    expect(pieces[0]!.sheet.lorry_plates).toEqual(['VJK 8821']);
    expect(splitPackingRegion(region(10))).toHaveLength(1);
  });
});
