// ----------------------------------------------------------------------------
// A locked payment's refusal reaches the operator as the SERVER'S sentence.
//
// PRODUCTION, 2026-09-11 (docs/bugs/0821). Finance corrected a mis-keyed card
// payment on 2990-SO-2607-012 (bank 3,052.00, keyed 3,053.00) and was shown
// "That clashes with something already in the system. Please refresh and
// check." The route had answered `{ error: 'payment_edit_locked', reason:
// 'This payment can no longer be changed because it was matched on a merchant
// settlement report on 2026-09-11. …' }` — 212 characters, over the sentence
// filter's 200 — so the explanation was held and dropped, and the operator was
// sent to refresh a page that would refuse again.
//
// Two things pin that here: the server's sentence wins when it is sayable
// (the code is in SERVER_SENTENCE_WINS), and when it is not, the floor is a
// sentence about a LOCKED PAYMENT rather than the status-code catch-all.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { humanApiError } from './authed-fetch';
import { paymentReconciledMessage } from './so-field-policy';

const body = (o: unknown) => JSON.stringify(o);
const GENERIC_409 = 'That clashes with something already in the system. Please refresh and check.';

describe('payment_edit_locked reaches the operator', () => {
  test("the server's sentence, naming the reconciliation, is what is shown", () => {
    const reason = paymentReconciledMessage({ kind: 'merchant', on: '2026-09-11' });
    expect(reason.length).toBeLessThan(200);
    expect(humanApiError(409, body({ error: 'payment_edit_locked', reason }))).toBe(reason);
  });

  test('the same-day window sentence is shown as written', () => {
    const reason = 'This payment can only be changed or removed on the day it was keyed in. That day has passed, '
      + 'so it is now locked. Record a new payment instead, or ask Finance to adjust it.';
    expect(humanApiError(409, body({ error: 'payment_edit_locked', reason }))).toBe(reason);
  });

  test('a sentence the filter drops falls to a line about a locked payment, never the generic 409', () => {
    const tooLong = 'This payment can no longer be changed because '.padEnd(260, 'x');
    const shown = humanApiError(409, body({ error: 'payment_edit_locked', reason: tooLong }));
    expect(shown).not.toBe(GENERIC_409);
    expect(shown).toMatch(/locked/i);
    expect(shown).toMatch(/not changed/i);
  });
});
