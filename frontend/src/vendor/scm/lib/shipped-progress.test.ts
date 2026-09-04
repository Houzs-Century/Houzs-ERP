// ----------------------------------------------------------------------------
// Splitting ARRIVAL from SHIPPING (owner 2026-09-02, option B).
//
// Most of these are refusals, deliberately. The happy path — 2 of 5 is partial
// — is not where this goes wrong; it goes wrong on the three shapes that look
// like an answer and are not: a missing field, an order with nothing to ship,
// and an over-delivery.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { shippedProgressOf, shippedProgressOfLine, shippedProgressLabel } from './shipped-progress';

describe('how much has left', () => {
  test('nothing shipped yet', () => {
    expect(shippedProgressOf({ shipped_qty: 0, deliverable_qty: 5 }).state).toBe('none');
  });

  test('2 of 5 is partial, and says so in the label', () => {
    const p = shippedProgressOf({ shipped_qty: 2, deliverable_qty: 5 });
    expect(p.state).toBe('partial');
    expect(shippedProgressLabel(p)).toBe('2 / 5');
  });

  test('5 of 5 is full', () => {
    expect(shippedProgressOf({ shipped_qty: 5, deliverable_qty: 5 }).state).toBe('full');
  });

  /* THE ONE THAT MATTERS. A payload that predates these fields must not read as
     "nothing has shipped" — that is a claim, and this order may be fully out. */
  test('a MISSING figure is unknown, never zero', () => {
    expect(shippedProgressOf({}).state).toBe('unknown');
    expect(shippedProgressOf({ shipped_qty: 2 }).state).toBe('unknown');
    expect(shippedProgressOf({ deliverable_qty: 5 }).state).toBe('unknown');
    expect(shippedProgressOf({ shipped_qty: null, deliverable_qty: null }).state).toBe('unknown');
    expect(shippedProgressLabel(shippedProgressOf({}))).toBeNull();
  });

  /* Every line cancelled, or a service-only order: there is nothing to ship.
     Calling that 'full' would put a DELIVERED badge on an order nobody shipped. */
  test('nothing TO ship is none, never full', () => {
    expect(shippedProgressOf({ shipped_qty: 0, deliverable_qty: 0 }).state).toBe('none');
  });

  /* An over-delivery is a real state (a replacement shipped against a reduced
     line). It reads full, and the label keeps both numbers so the oddity is
     visible rather than clamped away. */
  test('shipped MORE than committed reads full and shows both numbers', () => {
    const p = shippedProgressOf({ shipped_qty: 6, deliverable_qty: 5 });
    expect(p.state).toBe('full');
    expect(shippedProgressLabel(p)).toBe('6 / 5');
  });
});

describe('a LINE and a ROW cannot disagree — one rule, two field names', () => {
  test('delivered 2 / remaining 3 is the same answer as shipped 2 of 5', () => {
    expect(shippedProgressOfLine({ delivered_qty: 2, remaining_qty: 3 }))
      .toEqual(shippedProgressOf({ shipped_qty: 2, deliverable_qty: 5 }));
  });

  test('a line missing either figure is unknown too', () => {
    expect(shippedProgressOfLine({}).state).toBe('unknown');
    expect(shippedProgressOfLine({ delivered_qty: 2 }).state).toBe('unknown');
  });
});
