/* The zero-cost receipt refusal, read once and understood by every surface.

   ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
   `backend/src/scm/lib/zero-cost-receipt-guard.ts` answers 409 with the OFFENDING
   LINES and a `remedy` array naming the two ways out: enter the unit price from
   the supplier's goods-received document, or tick "Received free" on that line.
   `authed-fetch` turned that body into a sentence and threw the parse away, so a
   caller could show the refusal and nothing else — which is what left the mobile
   receipt screen with a correct, readable refusal naming two fixes and NEITHER
   of them on the screen in the receiver's hand ("Post" and "Cancel" only). The
   parse now lives here, shared, so the sentence and the remedy UI read the same
   body. */

import { describe, expect, test } from 'vitest';
import {
  ZERO_COST_RECEIPT_ERROR,
  parseZeroCostRefusal,
  zeroCostRefusalFrom,
  zeroCostRefusalText,
} from './zero-cost-refusal';

const BODY = JSON.stringify({
  error: ZERO_COST_RECEIPT_ERROR,
  message: 'These lines would receive stock at zero cost, but the item has been purchased at a real price before.',
  remedy: ['Enter the unit price; or', 'tick "Received free" and say why.'],
  ackField: 'zeroCostAck',
  lines: [
    { id: 'gi-1', itemCode: 'AKEMI-QD', qtyAccepted: 2, knownUnitCostSen: 45000 },
    { id: 'gi-2', itemCode: 'TRION-KD', qtyAccepted: 1, knownUnitCostSen: 120050 },
  ],
});

describe('parseZeroCostRefusal', () => {
  test('reads the lines the receiver has to act on', () => {
    const r = parseZeroCostRefusal(BODY);
    expect(r).not.toBeNull();
    expect(r!.lines.map((l) => l.id)).toEqual(['gi-1', 'gi-2']);
    expect(r!.lines[0]).toEqual({
      id: 'gi-1', itemCode: 'AKEMI-QD', qtyAccepted: 2, knownUnitCostSen: 45000,
    });
    expect(r!.remedy).toHaveLength(2);
  });

  test('another refusal is not this one', () => {
    expect(parseZeroCostRefusal(JSON.stringify({ error: 'qty_exceeds_remaining' }))).toBeNull();
    expect(parseZeroCostRefusal('')).toBeNull();
    expect(parseZeroCostRefusal(undefined)).toBeNull();
    expect(parseZeroCostRefusal('not json at all')).toBeNull();
  });

  test('a body with a preamble before the JSON still parses (authed-fetch tolerance)', () => {
    expect(parseZeroCostRefusal(`409 \n${BODY}`)?.lines).toHaveLength(2);
  });

  test('a refusal naming no lines is still the refusal, with an empty list', () => {
    const r = parseZeroCostRefusal(JSON.stringify({ error: ZERO_COST_RECEIPT_ERROR }));
    expect(r).not.toBeNull();
    expect(r!.lines).toEqual([]);
  });
});

describe('zeroCostRefusalText — the sentence every surface already showed', () => {
  test('names WHICH lines, what each normally costs, and both ways out', () => {
    const text = zeroCostRefusalText(parseZeroCostRefusal(BODY));
    expect(text).toContain('purchased at a real price before');
    expect(text).toContain('• AKEMI-QD x2');
    expect(text).toContain('normally about RM450.00 each');
    expect(text).toContain('normally about RM1200.50 each');
    expect(text).toContain('— Enter the unit price; or');
  });

  test('an unparseable refusal still says the true thing', () => {
    expect(zeroCostRefusalText(null))
      .toBe('These lines would receive stock at zero cost, but the item has been bought at a real price before.');
  });
});

describe('zeroCostRefusalFrom — recovering the body off a thrown error', () => {
  test('an authed-fetch error carrying the raw body yields the refusal', () => {
    const err = Object.assign(new Error('…'), { status: 409, body: BODY });
    expect(zeroCostRefusalFrom(err)?.lines).toHaveLength(2);
  });

  test('any other error yields null', () => {
    expect(zeroCostRefusalFrom(new Error('boom'))).toBeNull();
    expect(zeroCostRefusalFrom(Object.assign(new Error('x'), { status: 500, body: '{}' }))).toBeNull();
    expect(zeroCostRefusalFrom(null)).toBeNull();
    expect(zeroCostRefusalFrom('a string')).toBeNull();
  });
});
