import { describe, expect, test } from 'vitest';
import { stopTagOf, statusPillOf, circleLookOf, stopRefLineOf, stopAddressOf, slotPillOf, stopTitleOf } from './stop-row';
import type { DocRowVM } from './vm';
import type { PlanningOrder } from '../../../vendor/scm/lib/delivery-planning-queries';

type TagRow = Parameters<typeof stopTagOf>[0];
const tag = (row_type: PlanningOrder['row_type'], extra: Partial<TagRow> = {}) =>
  stopTagOf({ row_type, job_kind: null, dp_job_type: null, ...extra });

describe('stopTagOf — one tag and colour family per job type', () => {
  test.each([
    [tag('so'), 'DELIVERY', 'delivery'],
    [tag('assr', { job_kind: 'customer_pickup' }), 'SERVICE PICKUP', 'service'],
    [tag('assr', { job_kind: 'inspection' }), 'INSPECTION', 'service'],
    [tag('assr', { job_kind: 'delivery' }), 'SERVICE BACK', 'service'],
    [tag('project', { dp_job_type: 'SETUP' }), 'SETUP', 'setup'],
    [tag('dp', { dp_job_type: 'DISMANTLE' }), 'DISMANTLE', 'setup'],
    [tag('dp', { dp_job_type: 'SUPPLIER_PICKUP' }), 'SUPPLIER PICKUP', 'supplier'],
    [tag('dp', { dp_job_type: 'TRANSFER' }), 'TRANSFER', 'transfer'],
    [tag('dp', { dp_job_type: 'LORRY_SERVICE' }), 'LORRY SERVICE', 'lorry'],
  ])('%o', (got, label, family) => {
    expect(got).toEqual({ label, family });
  });
});

const doc = (over: Partial<DocRowVM>, o: Partial<PlanningOrder> = {}): DocRowVM => ({
  soDocNo: 'HC-SO-1', doNumber: 'HC-DO-1', ref: 'pg01', customer: 'Ada', address: '12 Jalan Besar, Kajang',
  status: 'scheduled', arrivedAt: null, deliveredAt: null,
  order: { row_type: 'so', postcode: '43000', ...o } as PlanningOrder,
  ...over,
} as DocRowVM);

describe('statusPillOf — exactly one status per stop', () => {
  test('not started / on the way / arrived / done / late', () => {
    expect(statusPillOf(doc({})).label).toBe('Not started');
    expect(statusPillOf(doc({ status: 'active' })).label).toBe('On the way');
    expect(statusPillOf(doc({ status: 'active', arrivedAt: '2026-11-01T06:41:00Z' })).label).toBe('Arrived 2:41 PM');
    expect(statusPillOf(doc({ status: 'done', deliveredAt: '2026-11-01T04:30:00Z' })).label).toBe('Done 12:30 PM');
    expect(statusPillOf(doc({ status: 'overdue' })).label).toBe('Late');
  });
});

describe('circleLookOf', () => {
  test('status first, then where the map put the stop', () => {
    expect(circleLookOf('scheduled', 'exact')).toBe('open-blue');
    expect(circleLookOf('active', 'exact')).toBe('solid-blue');
    expect(circleLookOf('arrived', 'approx')).toBe('solid-blue');
    expect(circleLookOf('done', 'none')).toBe('solid-green');
    expect(circleLookOf('overdue', 'approx')).toBe('open-red');
    expect(circleLookOf('scheduled', 'approx')).toBe('dashed-grey');
    expect(circleLookOf('scheduled', 'none')).toBe('dashed-grey');
  });
});

describe('the reference, address and slot lines', () => {
  test('a delivery shows SO · DO · Ref; a service leg its case no and what to do', () => {
    expect(stopRefLineOf(doc({}))).toBe('HC-SO-1 · HC-DO-1 · pg01');
    expect(stopRefLineOf(doc({}, { row_type: 'assr', ref: 'ASSR/1', dp_remark: 'Collect sofa leg', related_do_nos: ['HC-DO-7'] }))).toBe('ASSR/1 · Collect sofa leg · HC-DO-7');
    expect(stopRefLineOf(doc({}, { row_type: 'dp', dp_no: 'DP-9', dp_remark: 'PO-123' }))).toBe('DP-9 · PO-123');
  });
  test('the address gains its postcode when the text lacks it', () => {
    expect(stopAddressOf(doc({}))).toBe('12 Jalan Besar, Kajang, 43000');
    expect(stopAddressOf(doc({ address: '12 Jalan Besar, 43000 Kajang' }))).toBe('12 Jalan Besar, 43000 Kajang');
  });
  test('the slot pill is AM / PM / a condensed window, long text cut', () => {
    expect(slotPillOf('AM')).toBe('AM');
    expect(slotPillOf('10:30AM to 12:30PM')).toBe('10:30–12:30');
    expect(slotPillOf('Call customer before coming please')).toHaveLength(14);
  });
  test('a transfer with an origin reads From → To', () => {
    expect(stopTitleOf(doc({ customer: 'Penang Hub' }, { row_type: 'dp', dp_job_type: 'TRANSFER', dp_from_name: 'KL Warehouse' }))).toBe('KL Warehouse → Penang Hub');
    expect(stopTitleOf(doc({ customer: 'Penang Hub' }, { row_type: 'dp', dp_job_type: 'TRANSFER' }))).toBe('Penang Hub');
  });
});
