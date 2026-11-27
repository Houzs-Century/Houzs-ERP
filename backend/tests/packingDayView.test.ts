/* The packing day: DOs by date + board crew (production puts DOs on a lorry through
 * scm.delivery_order_crew, not trips), grouped by lorry and by region. */
import { describe, expect, test } from 'vitest';
import {
  assemblePackingDay, assemblePackingRegions, mergeLorryLists, sequenceLorryDos, timeSlotStart,
  type DayCrewRow, type DayDoRow,
} from '../src/scm/lib/packing-day-view';
import { regionConfigFromRows } from '../src/scm/lib/delivery-board-regions';
import type { PackingList } from '../src/scm/lib/packing-list-view';

const DATE = '2026-11-28';

const cfg = regionConfigFromRows(
  [{ id: 'r1', code: 'KL', name: 'KL/SEL' }, { id: 'r2', code: 'SOUTHERN', name: 'Southern' }, { id: 'r3', code: 'NORTHERN', name: 'Northern' }],
  [
    { state_key: 'Selangor', region_id: 'r1' }, { state_key: 'Johor', region_id: 'r2' },
    { state_key: 'Pahang', region_id: 'r3' }, { state_key: 'Pahang', region_id: 'r2' },
  ],
);

const dO = (id: string, over: Partial<DayDoRow> = {}): DayDoRow => ({
  id, do_number: `DO-${id}`, status: 'DRAFT', so_doc_no: null, debtor_code: `C-${id}`, debtor_name: `Customer ${id}`,
  address1: '1 Jalan', address2: null, city: 'PJ', postcode: '47300', state: 'Selangor',
  customer_state: 'Selangor', customer_country: 'Malaysia', phone: '0123', time_range: null,
  m3_total_milli: 1000, vehicle: null, driver_name: null, ...over,
});

const crew = (doId: string, plate: string | null, over: Partial<DayCrewRow> = {}): DayCrewRow => ({
  do_id: doId, lorry_plate: plate, driver_1_name: 'Ah Meng', driver_1_contact: '0123884410',
  helper_1_name: 'Raju', helper_2_name: null, ...over,
});

const line = (doId: string, code: string, qty: number, group: string | null = 'Mattress') => ({
  delivery_order_id: doId, line_no: 1, item_code: code, description: code, qty, rack_id: null,
  shipped_from: null, item_group: group, variants: null, description2: null, so_item_id: null, committed_po_batch_no: null,
});

const day = (dos: DayDoRow[], crews: DayCrewRow[], tripStops: Parameters<typeof assemblePackingDay>[0]['tripStops'] = []) =>
  assemblePackingDay({
    deliveryOrders: dos, crew: crews, tripStops,
    items: dos.flatMap((d) => [line(d.id, `M-${d.id}`, 1), line(d.id, `SVC-DELIVERY`, 1, 'Service')]),
    racks: [], soItems: [],
  });

describe('timeSlotStart — the slot is free text', () => {
  test.each([
    ['9am - 11am', 540], ['9:30am-11am', 570], ['14:00-16:00', 840], ['2 - 4pm', 840],
    ['12pm - 2pm', 720], ['12am', 0], ['2pm - 4pm (call 30 min before)', 840], ['', null], [null, null], ['anytime', null],
  ])('%s -> %s', (text, minutes) => expect(timeSlotStart(text)).toBe(minutes));
});

describe('assemblePackingDay — the lorry of each DO', () => {
  test('trip lorry, else crew plate, else the DO vehicle; crew names; service lines and cancelled DOs dropped', () => {
    const out = day(
      [dO('a'), dO('b', { vehicle: 'OLD 1' }), dO('c', { vehicle: 'VAN 7', driver_name: 'Hdr' }), dO('d'), dO('x', { status: 'CANCELLED' })],
      [crew('a', 'VJK 8821'), crew('b', 'WXY 1234')],
      [{ do_id: 'b', trip_no: 'T1', stop_no: 2, lorry_plate: 'BNM 5520' }],
    );
    expect(out.map((d) => [d.do_id, d.lorry_plate, d.trip_stop_no])).toEqual([
      ['a', 'VJK 8821', null], ['b', 'BNM 5520', 2], ['c', 'VAN 7', null], ['d', null, null],
    ]);
    expect(out[0]).toMatchObject({ driver_name: 'Ah Meng', driver_phone: '0123884410', helper_1_name: 'Raju', units: 1 });
    expect(out[2]!.driver_name).toBe('Hdr');
    expect(out[0]!.items.map((i) => i.item_code)).toEqual(['M-a']);
  });
});

describe('mergeLorryLists — one sheet per lorry, crew-first', () => {
  test('DOs with crew and no trip become one list per plate, DOs with no plate are not a lorry', () => {
    const dos = day(
      [dO('a', { time_range: '2pm - 4pm' }), dO('b', { time_range: '9am - 11am' }), dO('c'), dO('d'), dO('e', { time_range: '11am - 1pm' })],
      [crew('a', 'VJK 8821'), crew('b', 'vjk  8821'), crew('c', 'WXY 1234', { driver_1_name: 'Faiz' }), crew('e', 'VJK 8821')],
    );
    const lists = mergeLorryLists(DATE, [], dos);
    expect(lists.map((l) => [l.lorry_plate, l.source, l.stops.map((s) => `${s.stop_no}:${s.do_id}`)])).toEqual([
      ['VJK 8821', 'crew', ['1:b', '2:e', '3:a']],
      ['WXY 1234', 'crew', ['1:c']],
    ]);
    expect(lists[0]).toMatchObject({ trip_id: 'crew:VJK 8821', trip_no: null, driver_name: 'Ah Meng', do_count: 3, units: 3, m3_milli: 3000 });
    expect(lists[1]!.driver_name).toBe('Faiz');
    expect(lists.flatMap((l) => l.stops.map((s) => s.do_id))).not.toContain('d');
  });

  test('no time slot sorts last, then by DO number', () => {
    const dos = day([dO('z1'), dO('a1'), dO('m1', { time_range: '5pm' })], []);
    expect(sequenceLorryDos(dos).map((d) => d.do_id)).toEqual(['m1', 'a1', 'z1']);
  });

  test('trip stop numbers win when every DO of the lorry has one', () => {
    const dos = day([dO('a', { time_range: '9am' }), dO('b', { time_range: '5pm' })], [], [
      { do_id: 'a', trip_no: 'T', stop_no: 2, lorry_plate: 'X' }, { do_id: 'b', trip_no: 'T', stop_no: 1, lorry_plate: 'X' },
    ]);
    expect(sequenceLorryDos(dos).map((d) => d.do_id)).toEqual(['b', 'a']);
  });

  const tripList = (over: Partial<PackingList>): PackingList => ({
    trip_id: 't1', trip_no: 'TRIP-1', trip_date: DATE, trip_status: 'PLANNED', lorry_plate: 'BNM 5520',
    driver_name: 'Kelvin', driver_phone: null, helper_1_name: null, helper_2_name: null, warehouse_name: 'HQ',
    stop_count: 1, do_count: 1, units: 1, m3_milli: null, source: 'trip',
    stops: [{ stop_no: 1, stop_type: 'DELIVERY', customer_name: 'T', address: null, do_id: 't-do', do_number: 'DO-T', do_status: 'DRAFT', do_missing: false, so_doc_no: null, phone: null, time_range: null, units: 1, items: [] }],
    ...over,
  });

  test('a trip with DO stops stays, de-duplicated against crew; a transfer-only trip is dropped', () => {
    const dos = day([dO('t-do'), dO('a')], [crew('t-do', 'VJK 8821'), crew('a', 'VJK 8821')]);
    const transfer = tripList({ trip_id: 't2', lorry_plate: 'TRF 1', stops: [{ ...tripList({}).stops[0]!, stop_type: 'TRANSFER', do_id: null }] });
    const lists = mergeLorryLists(DATE, [tripList({}), transfer], dos);
    expect(lists.map((l) => [l.trip_id, l.stops.map((s) => s.do_id)])).toEqual([
      ['t1', ['t-do']],
      ['crew:VJK 8821', ['a']],
    ]);
  });

  test('crew DOs whose plate matches a trip join that trip after its stops', () => {
    const dos = day([dO('t-do'), dO('a')], [crew('a', 'bnm 5520')]);
    const [only] = mergeLorryLists(DATE, [tripList({})], dos);
    expect(only!.stops.map((s) => `${s.stop_no}:${s.do_id}`)).toEqual(['1:t-do', '2:a']);
    expect(only!.do_count).toBe(2);
  });
});

describe('assemblePackingRegions — the board buckets', () => {
  const dos = day(
    [dO('a', { customer_state: 'Johor' }), dO('b', { debtor_name: 'Zed' }), dO('c', { debtor_name: 'Amy', debtor_code: 'C-b' }), dO('p', { customer_state: 'Pahang' }), dO('s', { customer_state: null, state: 'Johor' })],
    [crew('b', 'WXY 1234')],
  );

  test('state -> region in config order, a multi-mapped state goes to its first region, DO state falls back to state', () => {
    const out = assemblePackingRegions(cfg, dos, false);
    expect(out.map((r) => [r.region, r.dos.map((d) => d.do_id)])).toEqual([
      ['KL', ['b', 'c']], ['SOUTHERN', ['a', 's']], ['NORTHERN', ['p']],
    ]);
    expect(out[0]).toMatchObject({ label: 'KL/SEL', do_count: 2, customer_count: 1, lorry_plates: ['WXY 1234'], not_arranged: 1 });
  });

  test('unassignedOnly keeps only DOs with no lorry', () => {
    const out = assemblePackingRegions(cfg, dos, true);
    expect(out.flatMap((r) => r.dos.map((d) => d.do_id))).toEqual(['c', 'a', 's', 'p']);
    expect(out.every((r) => r.lorry_plates.length === 0)).toBe(true);
  });
});
