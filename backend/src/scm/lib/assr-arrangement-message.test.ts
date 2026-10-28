import { describe, expect, it } from 'vitest';
import { assrChatStateFromLog, assrLegDate, isAssrLeg, parseAssrRowKey } from './assr-arrangement-message';
import { KIND_AUTOMATION, OPENER_KINDS, kindAttributes } from './delivery-message-kinds';

describe('parseAssrRowKey', () => {
  it('splits a board row key into case number and leg', () => {
    expect(parseAssrRowKey('ASSR/2610-038#inspection')).toEqual({ assrNo: 'ASSR/2610-038', leg: 'inspection' });
    expect(parseAssrRowKey('ASSR/2608-042#customer_pickup')).toEqual({ assrNo: 'ASSR/2608-042', leg: 'customer_pickup' });
  });
  it('is null for an SO doc or an unknown leg', () => {
    expect(parseAssrRowKey('HC-SO-2610-045')).toBeNull();
    expect(parseAssrRowKey('ASSR/2610-038#repair')).toBeNull();
  });
  it('isAssrLeg accepts only the three board legs', () => {
    expect(isAssrLeg('delivery')).toBe(true);
    expect(isAssrLeg('{assr_leg}')).toBe(false);
    expect(isAssrLeg(undefined)).toBe(false);
  });
});

describe('assrLegDate', () => {
  it("prefers the date Logistics confirmed over Service's request", () => {
    const row = { inspection_visit_at: '2026-11-01', sched_inspection_date: '2026-11-03T00:00:00Z' };
    expect(assrLegDate(row, 'inspection')).toBe('2026-11-03');
  });
  it('falls back to the requested date, then null', () => {
    expect(assrLegDate({ do_date: '2026-11-05' }, 'delivery')).toBe('2026-11-05');
    expect(assrLegDate({}, 'customer_pickup')).toBeNull();
  });
});

describe('assrChatStateFromLog', () => {
  const send = { doc_no: 'A#inspection', source: 'delivery-planning', success: true, payload: '{}', created_at: '2026-10-28T08:00:00Z' };
  const amend = {
    doc_no: 'A#inspection', source: 'chat-callback', success: true, created_at: '2026-10-28T09:00:00Z',
    payload: JSON.stringify({ event: 'amend', requested_delivery_date: '05/11/2026', reason: 'Date Unavailable' }),
  };
  it('a send alone reads Done Send', () => {
    expect(assrChatStateFromLog([send]).get('A#inspection')).toEqual({
      delivery_message_status: 'Done Send', amend_date_from_customer: null, amend_reason_from_customer: null,
    });
  });
  it("an amend carries the customer's date and reason", () => {
    expect(assrChatStateFromLog([amend, send]).get('A#inspection')).toEqual({
      delivery_message_status: 'Pending Reschedule (D)', amend_date_from_customer: '2026-11-05', amend_reason_from_customer: 'Date Unavailable',
    });
  });
  it('a newer send clears the old request; a failed send changes nothing', () => {
    const resend = { ...send, created_at: '2026-10-29T08:00:00Z' };
    expect(assrChatStateFromLog([amend, send, resend]).get('A#inspection')?.amend_date_from_customer).toBeNull();
    const failed = { ...resend, success: false };
    expect(assrChatStateFromLog([amend, send, failed]).get('A#inspection')?.delivery_message_status).toBe('Pending Reschedule (D)');
  });
  it('a confirm reads Done Scheduling', () => {
    const confirm = { ...amend, created_at: '2026-10-28T10:00:00Z', payload: JSON.stringify({ event: 'confirm' }) };
    expect(assrChatStateFromLog([send, amend, confirm]).get('A#inspection')?.delivery_message_status).toBe('Done Scheduling');
  });
});

describe('assr_arrangement kind', () => {
  it('fires the Service Arrangement automation and opens a Confirm / Amend conversation', () => {
    expect(KIND_AUTOMATION.assr_arrangement).toBe('Service Arrangement');
    expect(OPENER_KINDS.has('assr_arrangement')).toBe(true);
  });
  it('skips a Sales Order sent with it', () => {
    expect(kindAttributes('assr_arrangement', {}, '2026-11-03', 0, undefined).skip).toBe('assr_only');
  });
});
