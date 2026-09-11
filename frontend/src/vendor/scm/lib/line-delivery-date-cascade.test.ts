// The cascade the owner found MISSING on the delivery order while it worked on
// the sales order. Each case below is one of the two halves a hand-written copy
// gets wrong: moving the lines that follow, and NOT moving the one somebody
// typed.
import { describe, expect, it } from 'vitest';

import { cascadeLineDeliveryDate } from './line-delivery-date-cascade';

const follower = (d: string | null) => ({ lineDeliveryDate: d, lineDeliveryDateOverridden: false });
const typed = (d: string | null) => ({ lineDeliveryDate: d, lineDeliveryDateOverridden: true });

describe('cascadeLineDeliveryDate', () => {
  it('moves every following line onto the header date', () => {
    const out = cascadeLineDeliveryDate([follower('2026-09-19'), follower('2026-09-19')], '2026-09-24');
    expect(out?.map((l) => l.lineDeliveryDate)).toEqual(['2026-09-24', '2026-09-24']);
  });

  it('never moves a line the operator typed', () => {
    const out = cascadeLineDeliveryDate([follower('2026-09-19'), typed('2026-10-02')], '2026-09-24');
    expect(out?.map((l) => l.lineDeliveryDate)).toEqual(['2026-09-24', '2026-10-02']);
    expect(out?.[1]?.lineDeliveryDateOverridden).toBe(true);
  });

  it('returns null when nothing moves, so the caller keeps its array', () => {
    const lines = [follower('2026-09-24'), typed('2026-10-02')];
    expect(cascadeLineDeliveryDate(lines, '2026-09-24')).toBeNull();
  });

  it('returns null when every line is overridden, however far the header moves', () => {
    expect(cascadeLineDeliveryDate([typed('2026-01-01'), typed(null)], '2026-09-24')).toBeNull();
  });

  it('fills a BLANK following line — a new line added after the header was set', () => {
    const out = cascadeLineDeliveryDate([follower(null)], '2026-09-24');
    expect(out?.[0]?.lineDeliveryDate).toBe('2026-09-24');
  });

  it('CLEARS the followers when the header is cleared, and treats "" as no date', () => {
    for (const empty of ['', null, undefined]) {
      const out = cascadeLineDeliveryDate([follower('2026-09-24')], empty);
      expect(out?.[0]?.lineDeliveryDate).toBeNull();
    }
    // ...and clearing an already-blank follower is not a change
    expect(cascadeLineDeliveryDate([follower(null)], '')).toBeNull();
  });

  it('does not mutate the array it was given', () => {
    const lines = [follower('2026-09-19')];
    const out = cascadeLineDeliveryDate(lines, '2026-09-24');
    expect(lines[0]?.lineDeliveryDate).toBe('2026-09-19');
    expect(out?.[0]).not.toBe(lines[0]);
  });

  it('keeps every other field on the line', () => {
    const out = cascadeLineDeliveryDate(
      [{ ...follower('2026-09-19'), itemCode: 'CODY-(Q)', qty: 3 }],
      '2026-09-24',
    );
    expect(out?.[0]).toMatchObject({ itemCode: 'CODY-(Q)', qty: 3, lineDeliveryDate: '2026-09-24' });
  });

  it('is a no-op on an empty list', () => {
    expect(cascadeLineDeliveryDate([], '2026-09-24')).toBeNull();
  });

  /* An UNDEFINED flag is the shape a line loaded from the API has before
     anything touches it (`lineDeliveryDateOverridden` is optional). It must
     read as "following", not as "typed" - the stricter reading here would
     freeze every imported line. */
  it('treats a missing override flag as following', () => {
    const out = cascadeLineDeliveryDate([{ lineDeliveryDate: '2026-09-19' }], '2026-09-24');
    expect(out?.[0]?.lineDeliveryDate).toBe('2026-09-24');
  });
});
