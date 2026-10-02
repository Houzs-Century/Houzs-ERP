import { describe, expect, test } from 'vitest';
import {
  afterDoBlockedCols, afterDoHeaderRefusal, afterDoLineAllowed, doHeaderPatchFromSo, pickAfterDoTarget,
  type AfterDoTarget,
} from './so-after-do-edit';

const open = (id: string): AfterDoTarget => ({ id, do_number: `DO-${id}`, status: 'LOADED', locked: false });
const invoiced = (id: string): AfterDoTarget => ({ ...open(id), locked: true });

describe('which DO a new charge line goes on', () => {
  test('one open DO is picked by itself', () => {
    expect(pickAfterDoTarget([open('a'), invoiced('b')], null)).toEqual({ ok: true, target: open('a') });
  });

  test('several open DOs need a pick, and the refusal lists them', () => {
    const r = pickAfterDoTarget([open('a'), open('b')], null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal.error).toBe('after_do_pick_do');
    expect(!r.ok && r.refusal.dos).toEqual([{ id: 'a', do_number: 'DO-a' }, { id: 'b', do_number: 'DO-b' }]);
  });

  test('a picked DO with an invoice or return is refused by number', () => {
    const r = pickAfterDoTarget([open('a'), invoiced('b')], 'b');
    expect(!r.ok && r.refusal).toMatchObject({ error: 'after_do_target_locked', doNumbers: ['DO-b'] });
  });

  test('a DO that is not this order\'s is not a target', () => {
    expect(pickAfterDoTarget([open('a')], 'zzz')).toMatchObject({ ok: false, refusal: { error: 'after_do_no_do' } });
  });

  test('every DO locked: refused, naming them', () => {
    expect(pickAfterDoTarget([invoiced('a')], null)).toMatchObject({ ok: false, refusal: { error: 'after_do_target_locked' } });
  });
});

describe('the customer details', () => {
  test('State, branding and ref stay locked; the contact block does not', () => {
    expect(afterDoBlockedCols(['phone', 'address1', 'postcode', 'customer_state', 'branding', 'ref'])).toEqual(['customer_state', 'branding', 'ref']);
  });

  test('the DO patch carries only what changed, address3/4 folded into address2 like the DO create', () => {
    const so = { phone: '+60123456789', address1: '1 Jalan', address2: null, address3: 'Taman A', address4: 'Blok B', email: 'x@y.z' };
    expect(doHeaderPatchFromSo(so, ['phone', 'address3'])).toEqual({ phone: '+60123456789', address2: 'Taman A, Blok B' });
  });

  test('a column the DO has no copy of saves on the SO only', () => {
    expect(doHeaderPatchFromSo({ ship_to_address: 'x', customer_id: 'c' }, ['ship_to_address', 'customer_id'])).toEqual({});
  });

  test('copying is refused while any DO is invoiced or returned, or the order is invoiced without a DO', () => {
    expect(afterDoHeaderRefusal([open('a')], false)).toBeNull();
    expect(afterDoHeaderRefusal([open('a'), invoiced('b')], false)?.error).toBe('after_do_target_locked');
    expect(afterDoHeaderRefusal([open('a')], true)?.error).toBe('after_do_invoiced');
  });
});

test('only a charge (SERVICE) line is reopened', () => {
  expect(afterDoLineAllowed({ itemCode: 'SVC-STORAGE' })).toBe(true);
  expect(afterDoLineAllowed({ itemCode: 'MISC-01', category: 'SERVICE' })).toBe(true);
  expect(afterDoLineAllowed({ itemCode: 'BF-QUEEN', itemGroup: 'bedframe' })).toBe(false);
});
