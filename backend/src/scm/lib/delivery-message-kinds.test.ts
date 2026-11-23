import { describe, expect, it } from 'vitest';
import {
  ASSR_LEG_SEND_KINDS,
  KIND_AUTOMATION,
  MESSAGE_KINDS,
  NO_STATUS_MOVE_KINDS,
  OPENER_KINDS,
  joinDeliveryAddress,
  kindAttributes,
  templateDate,
} from './delivery-message-kinds';

const row = {
  phone: '012-345 6789',
  address1: '12 Jalan Satu', address2: 'Taman Dua', address3: '', address4: null,
  postcode: '47100', city: 'Puchong', customer_state: 'Selangor',
};

describe('message kinds → Connect automation names', () => {
  it('every kind names exactly one automation, by the name seeded in Connect', () => {
    for (const k of MESSAGE_KINDS) expect(KIND_AUTOMATION[k]).toBeTruthy();
    expect(KIND_AUTOMATION.delivery).toBe('New Delivery Follow-up');
    expect(KIND_AUTOMATION.amend).toBe('New Amend');
    expect(KIND_AUTOMATION.driver_info).toBe('Driver Info');
    expect(KIND_AUTOMATION.postage).toBe('Postage Confirm');
    // Must equal the Connect automation name byte-for-byte (houzs-connect #157).
    expect(KIND_AUTOMATION.overdue_order).toBe('Overdue Order');
    // East Malaysia touchpoints — byte-for-byte the seeded Connect automation names.
    expect(KIND_AUTOMATION.eastmy_prep).toBe('East Malaysia Prep Notice');
    expect(KIND_AUTOMATION.eastmy_shipped).toBe('East Malaysia Shipped');
    expect(KIND_AUTOMATION.eastmy_arrived).toBe('East Malaysia Arrived');
    expect(new Set(Object.values(KIND_AUTOMATION)).size).toBe(MESSAGE_KINDS.length);
  });

  it('only the conversation openers reset the contact (Delivery Lock must survive a reminder)', () => {
    // eastmy_prep opens the details conversation (its callback is eastmy_ack), so
    // it resets; Shipped / Arrived are one-way and must not.
    expect([...OPENER_KINDS].sort()).toEqual(['amend', 'assr_arrangement', 'delivery', 'eastmy_prep', 'postpone']);
    expect(OPENER_KINDS.has('driver_info')).toBe(false);
    expect(OPENER_KINDS.has('balance_reminder')).toBe(false);
    expect(OPENER_KINDS.has('eastmy_shipped')).toBe(false);
    expect(OPENER_KINDS.has('eastmy_arrived')).toBe(false);
  });

  it('a one-way heads-up and the East Malaysia touchpoints move no Delivery Message Status', () => {
    expect([...NO_STATUS_MOVE_KINDS].sort()).toEqual(['eastmy_arrived', 'eastmy_prep', 'eastmy_shipped', 'overdue_order']);
    // The delivery-date conversation's statuses still move for the normal sends.
    expect(NO_STATUS_MOVE_KINDS.has('delivery')).toBe(false);
    expect(NO_STATUS_MOVE_KINDS.has('balance_reminder')).toBe(false);
  });

  it('a Service Case leg can be sent Postpone, the Reminders and Driver Info; SO-only sends are excluded', () => {
    expect([...ASSR_LEG_SEND_KINDS].sort()).toEqual(['driver_info', 'postpone', 'reminder_1', 'reminder_2', 'reminder_3']);
    // The date confirms (delivery/amend) become Service Arrangement, handled on
    // their own path, and the money / address sends read a Sales Order, so none
    // of these split out to the ASSR sender.
    for (const k of ['delivery', 'amend', 'balance_reminder', 'postage', 'delivery_completed', 'overdue_order', 'assr_arrangement'] as const) {
      expect(ASSR_LEG_SEND_KINDS.has(k)).toBe(false);
    }
  });
});

describe('joinDeliveryAddress', () => {
  it('prefers the delivery address over the customer address and drops blanks', () => {
    expect(joinDeliveryAddress(row)).toBe('12 Jalan Satu, Taman Dua, 47100 Puchong, Selangor');
    expect(joinDeliveryAddress({ ...row, delivery_address1: 'Site office, Lot 5' }))
      .toBe('Site office, Lot 5, 47100 Puchong, Selangor');
  });

  it('is empty when nothing is known, so the caller can skip rather than send blanks', () => {
    expect(joinDeliveryAddress({})).toBe('');
  });
});

describe('kindAttributes', () => {
  it('openers and simple reminders add nothing beyond the shared bundle', () => {
    // eastmy_prep is a plain opener too: the shared bundle carries ref_1 /
    // callback_url / refs_all (+ amount / bank_block when owed).
    for (const k of ['delivery', 'amend', 'reminder_1', 'reminder_2', 'reminder_3', 'delivery_completed', 'eastmy_prep'] as const) {
      expect(kindAttributes(k, row, '2026-10-08', 0, undefined)).toEqual({ attributes: {} });
    }
  });

  it('East Malaysia shipped reads consignment + ETA off the row; skips when either is missing', () => {
    // No Consignment No. / ETA on the row -> skipped, never sent with a blank.
    expect(kindAttributes('eastmy_shipped', row, null, 0, undefined).skip).toBe('eastmy_shipment_fields_required');
    expect(kindAttributes('eastmy_shipped', { ...row, consignment_no: 'MSCU1234567' }, null, 0, undefined).skip)
      .toBe('eastmy_shipment_fields_required');
    const r = kindAttributes(
      'eastmy_shipped',
      { ...row, consignment_no: 'MSCU1234567', eta_arriving_port: '2026-12-15' },
      null,
      0,
      undefined,
    );
    expect(r.skip).toBeUndefined();
    expect(r.attributes).toEqual({ consignment_no: 'MSCU1234567', eta_em_port: '2026/12/15' });
  });

  it('East Malaysia arrived is an operator-judgment send: never gated, adds nothing', () => {
    // No system date gate (owner 2026-11-20): Sya Sya decides it has arrived and
    // sends by hand, so it fires regardless of any arrival date on the row.
    const r = kindAttributes('eastmy_arrived', row, null, 0, undefined);
    expect(r.skip).toBeUndefined();
    expect(r.attributes).toEqual({});
  });

  it('balance reminder skips a group that owes nothing', () => {
    expect(kindAttributes('balance_reminder', row, null, 0, undefined).skip).toBe('no_balance');
    expect(kindAttributes('balance_reminder', row, null, 2550, undefined).skip).toBeUndefined();
  });

  it('driver info needs the operator input and maps it onto the template variables', () => {
    expect(kindAttributes('driver_info', row, '2026-10-08', 0, undefined).skip).toBe('driver_info_required');
    const r = kindAttributes('driver_info', row, '2026-10-08', 0, {
      driverInfo: { driverName: ' Ali ', driverContact: '019-1111111', driverIc: '900101-14-5555', carPlate: 'WXY 1234', deliveryTime: '10am – 1pm' },
    });
    expect(r.attributes).toEqual({
      client_delivery_date: '2026/10/08',
      delivery_time: '10am – 1pm',
      drivers_name: 'Ali',
      drivers_contact: '019-1111111',
      drivers_ic: '900101-14-5555',
      car_plate: 'WXY 1234',
    });
  });

  it('postpone reads the reason and new date off the board row; skips when either is missing', () => {
    // No Amend Reason / no new Delivery Date on the row -> skipped, not sent blank.
    expect(kindAttributes('postpone', row, '2026-10-08', 0, undefined).skip).toBe('postpone_needs_reason_date');
    expect(kindAttributes('postpone', { ...row, amend_reason: 'Our strict quality control checks' }, '2026-10-08', 0, undefined).skip)
      .toBe('postpone_needs_reason_date');
    const r = kindAttributes(
      'postpone',
      { ...row, amend_reason: 'Our strict quality control checks', amended_delivery_date: '2026-10-12', customer_delivery_date: '2026-10-08' },
      '2026-10-08',
      0,
      undefined,
    );
    expect(r.attributes).toEqual({
      client_delivery_date: '2026/10/08',
      amend_date_reason_2: 'Our strict quality control checks',
      new_delivery_date: '2026/10/12',
    });
  });

  it('overdue order sends the board Amend Reason as amend_date_reason; skips when blank', () => {
    // No Amend Reason on the row -> skipped, never sent as the literal "{amend_date_reason}".
    expect(kindAttributes('overdue_order', row, '2026-10-08', 0, undefined).skip).toBe('overdue_order_needs_reason');
    const r = kindAttributes('overdue_order', { ...row, amend_reason: 'Our strict quality control checks' }, '2026-10-08', 0, undefined);
    expect(r.attributes).toEqual({ amend_date_reason: 'Our strict quality control checks' });
    expect(r.skip).toBeUndefined();
  });

  it('postage sends the phone and the joined address, and skips an order with no address', () => {
    const r = kindAttributes('postage', row, null, 0, undefined);
    expect(r.attributes).toEqual({ customer_phone: '+0123456789', delivery_address: '12 Jalan Satu, Taman Dua, 47100 Puchong, Selangor' });
    expect(kindAttributes('postage', { phone: '0123' }, null, 0, undefined).skip).toBe('no_address');
  });

  it('templateDate turns ISO into the templates’ yyyy/mm/dd', () => {
    expect(templateDate('2026-10-08')).toBe('2026/10/08');
    expect(templateDate(null)).toBe('');
  });
});
