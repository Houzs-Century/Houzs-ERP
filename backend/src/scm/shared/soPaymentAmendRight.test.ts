/* Who may correct a recorded customer payment, and until when.
 *
 * OWNER + MANAGEMENT, 2026-09-10: "已经和management 确定了，让权限在finance 这里
 * 更改" — Finance holds the right to correct a mis-keyed sales payment. This is
 * step 3 of the three that decision was built in; steps 1 (see the divergence,
 * bug 0774) and 2 (the edit re-posts, bug 0778) shipped first, deliberately,
 * because until an edit moved the ledger, granting this right would have let
 * payments and books drift apart in volume.
 *
 * It is also the condition `paymentRowMutable` has reserved a place for since
 * 2026-07-19, in the owner's own words: 「如果他已经做完 bank record 并且 knock
 * off 掉了，就不行了」. So the right is NOT "Finance may change anything". It
 * stops dead at a payment that has already been RECONCILED — and that stop
 * beats the permission, because by then the figure is evidence somebody has
 * signed off, printed and possibly sent to an auditor.
 *
 * The order of the rules is the whole design and each line below defends one:
 *   DRAFT        → still fluid (unchanged since 2026-07-13)
 *   RECONCILED   → closed to EVERYONE, Finance included
 *   same day     → still fluid for whoever keyed it (unchanged)
 *   may amend    → Finance's new door
 *   otherwise    → the window that has always closed
 */
import { describe, expect, it } from 'vitest';
import {
  paymentRowMutable,
  PAYMENT_WINDOW_CLOSED_MESSAGE,
  type PaymentReconciledBy,
} from './so-field-policy';

const TODAY = '2026-09-10';
const OLD = '2026-08-02';

const merchant: PaymentReconciledBy = { kind: 'merchant', on: '2026-08-05' };
const bank: PaymentReconciledBy = { kind: 'bank', jeNo: 'JE-2608-0031' };
const month: PaymentReconciledBy = { kind: 'month', accountCode: '310-0010', month: '2026-08' };

describe('the same-day window, unchanged', () => {
  it('still lets today be corrected by anyone', () => {
    expect(paymentRowMutable(TODAY, TODAY, false)).toEqual({ mutable: true, problem: null, via: 'same_day' });
  });

  it('still locks an older payment for somebody without the right', () => {
    const r = paymentRowMutable(OLD, TODAY, false);
    expect(r.mutable).toBe(false);
    expect(r.problem).toBe(PAYMENT_WINDOW_CLOSED_MESSAGE);
  });

  it('still exempts a DRAFT sales order', () => {
    expect(paymentRowMutable('2020-01-01', TODAY, true).mutable).toBe(true);
  });
});

describe("Finance's amend right", () => {
  it('opens an old payment for a holder of the right', () => {
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: true }))
      .toEqual({ mutable: true, problem: null, via: 'amend' });
  });

  it('changes nothing for somebody who does not hold it', () => {
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: false }).mutable).toBe(false);
    expect(paymentRowMutable(OLD, TODAY, false, {}).mutable).toBe(false);
  });

  it('is not needed on the day the payment was keyed', () => {
    expect(paymentRowMutable(TODAY, TODAY, false, { mayAmend: false }).mutable).toBe(true);
  });
});

describe('a RECONCILED payment is closed to everyone', () => {
  it('refuses the holder of the amend right', () => {
    const r = paymentRowMutable(OLD, TODAY, false, { mayAmend: true, reconciled: merchant });
    expect(r.mutable).toBe(false);
    expect(r.problem).not.toBe(PAYMENT_WINDOW_CLOSED_MESSAGE);
  });

  /* The strongest case: a payment keyed TODAY that has already been matched.
     The same-day window would say yes; reconciliation says no, and it is the
     one that has to win — the match is already booked against it. */
  it('refuses even on the day it was keyed', () => {
    expect(paymentRowMutable(TODAY, TODAY, false, { reconciled: merchant }).mutable).toBe(false);
  });

  it('names WHICH reconciliation closed it, so the operator can go and look', () => {
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: true, reconciled: merchant }).problem)
      .toMatch(/merchant settlement report/i);
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: true, reconciled: bank }).problem)
      .toMatch(/JE-2608-0031/);
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: true, reconciled: month }).problem)
      .toMatch(/310-0010/);
  });

  it('says what to do instead, rather than only that the door is shut', () => {
    const msg = paymentRowMutable(OLD, TODAY, false, { mayAmend: true, reconciled: bank }).problem;
    expect(msg).toMatch(/record a new payment|credit note/i);
  });

  /* Every refusal travels through humanApiError's sentence filter, which drops
     anything that looks like machinery. A reason nobody can read is a reason
     nobody acts on. */
  it('every refusal stays plain language, short, and free of jargon', () => {
    for (const reconciled of [merchant, bank, month]) {
      const msg = paymentRowMutable(OLD, TODAY, false, { mayAmend: true, reconciled }).problem;
      expect(msg).not.toBeNull();
      expect(msg as string).not.toMatch(/[{}]|\bnull\b|\bundefined\b|payment_edit_locked/);
      expect((msg as string).length).toBeLessThan(240);
    }
  });

  /* A DRAFT order is exempted BEFORE this check, and that is deliberate: it is
     the 2026-07-13 exemption for an OCR-scanned draft whose payment was
     mis-read, and this change was not asked to touch it. Pinned so the choice
     is a decision on the record rather than an accident of line order. */
  it('leaves the DRAFT exemption alone, on purpose', () => {
    expect(paymentRowMutable(OLD, TODAY, true, { reconciled: merchant }).mutable).toBe(true);
  });
});

/* WHY the door is open matters as much as that it is. A correction made on the
   strength of the amend right owes a reason and lands on the Finance
   corrections report; a same-day fix by whoever keyed it does not (owner
   2026-09-10: 靠权限改的来决定). The predicate is the only thing that knows
   which of the two it just allowed, so it has to say. */
describe('the predicate says WHY a row may change', () => {
  it('names the draft exemption', () => {
    expect(paymentRowMutable(OLD, TODAY, true).via).toBe('draft');
  });

  it('names the same-day window', () => {
    expect(paymentRowMutable(TODAY, TODAY, false).via).toBe('same_day');
    expect(paymentRowMutable(TODAY, TODAY, false, { mayAmend: true }).via).toBe('same_day');
  });

  it('names the amend right, and only when it was what opened the door', () => {
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: true }).via).toBe('amend');
  });

  it('names nothing when the row may not change', () => {
    expect(paymentRowMutable(OLD, TODAY, false).via).toBeNull();
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: true, reconciled: merchant }).via).toBeNull();
  });
});
