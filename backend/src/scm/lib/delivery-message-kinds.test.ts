import { describe, expect, it } from 'vitest';
import {
  KIND_AUTOMATION,
  MESSAGE_KINDS,
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
    expect(new Set(Object.values(KIND_AUTOMATION)).size).toBe(MESSAGE_KINDS.length);
  });

  it('only the conversation openers reset the contact (Delivery Lock must survive a reminder)', () => {
    expect([...OPENER_KINDS].sort()).toEqual(['amend', 'delivery', 'postpone']);
    expect(OPENER_KINDS.has('driver_info')).toBe(false);
    expect(OPENER_KINDS.has('balance_reminder')).toBe(false);
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
    for (const k of ['delivery', 'amend', 'reminder_1', 'reminder_2', 'reminder_3', 'delivery_completed'] as const) {
      expect(kindAttributes(k, row, '2026-10-08', 0, undefined)).toEqual({ attributes: {} });
    }
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

  it('postpone prints the current date, the reason and the proposed date', () => {
    expect(kindAttributes('postpone', row, '2026-10-08', 0, undefined).skip).toBe('postpone_required');
    const r = kindAttributes('postpone', row, '2026-10-08', 0, { postpone: { reason: 'lorry breakdown', newDate: '2026-10-12' } });
    expect(r.attributes).toEqual({
      client_delivery_date: '2026/10/08',
      amend_date_reason_2: 'lorry breakdown',
      new_delivery_date: '2026/10/12',
    });
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
