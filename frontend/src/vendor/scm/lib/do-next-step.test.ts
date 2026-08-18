import { describe, it, expect } from 'vitest';
import {
  DO_STATUSES_FOR_TEST,
  doAdvanceBlockReason,
  doAdvanceStep,
  SI_TRANSFERABLE_DO_STATUSES,
  siTransferBlockReason,
} from './do-next-step';

/* These tests pin the two properties that decide whether this module still does
   its job in six months:

   1. EVERY legal status gets an answer, and the answer is a real sentence — not
      undefined, not a shrug. The status list is the eight labels of the
      scm.do_status enum (backend/src/scm/shared/do-shipped-states.ts).
   2. The two questions never BOTH go silent. A status that cannot advance must
      say why it cannot advance; a status that cannot transfer must say why it
      cannot transfer. Silence is the defect this module exists to end, so a
      future edit that returns null from both is a regression, not a tidy-up. */

describe('siTransferBlockReason', () => {
  it('allows exactly the signed and delivered statuses', () => {
    for (const s of SI_TRANSFERABLE_DO_STATUSES) {
      expect(siTransferBlockReason(s)).toBeNull();
    }
    expect(SI_TRANSFERABLE_DO_STATUSES).toEqual(['signed', 'delivered']);
  });

  it('is case- and whitespace-insensitive, because rows carry raw DB values', () => {
    expect(siTransferBlockReason('SIGNED')).toBeNull();
    expect(siTransferBlockReason('  Delivered ')).toBeNull();
  });

  it('gives every blocking status an actionable sentence', () => {
    for (const s of ['DRAFT', 'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'CANCELLED', 'INVOICED']) {
      const r = siTransferBlockReason(s);
      expect(r, s).toBeTruthy();
      expect(r!.length, s).toBeGreaterThan(20);
      expect(r!.endsWith('.'), s).toBe(true);
    }
  });

  it('names the SIGN step from the pre-signature shipped states', () => {
    for (const s of ['LOADED', 'DISPATCHED', 'IN_TRANSIT']) {
      expect(siTransferBlockReason(s)).toMatch(/signed/i);
    }
  });

  it('does not claim an INVOICED delivery order was billed', () => {
    /* routes/unbilled-deliveries.ts:13 — nothing in the codebase ever writes
       delivery_orders.status='INVOICED', so the label means "somebody clicked
       it", never "this was billed". The sentence must state the gate instead. */
    const r = siTransferBlockReason('INVOICED')!;
    expect(r).not.toMatch(/already been invoiced|already invoiced/i);
    expect(r).toMatch(/signed or delivered/i);
  });

  it('falls back to the generic sentence for an unrecognised status', () => {
    /* Never a guess. COMPLETED is the cautionary case: it lived in these lists
       for months on a comment's authority and Postgres rejected it outright. */
    expect(siTransferBlockReason('COMPLETED')).toMatch(/signed or delivered/i);
    expect(siTransferBlockReason('')).toBeTruthy();
    expect(siTransferBlockReason(null)).toBeTruthy();
    expect(siTransferBlockReason(undefined)).toBeTruthy();
  });
});

describe('doAdvanceStep', () => {
  it('confirms a draft to DISPATCHED, matching the mobile shell', () => {
    expect(doAdvanceStep('DRAFT')).toEqual({ status: 'DISPATCHED', label: 'Confirm' });
  });

  it('marks the pre-signature shipped states signed', () => {
    for (const s of ['LOADED', 'DISPATCHED', 'IN_TRANSIT']) {
      expect(doAdvanceStep(s), s).toEqual({ status: 'DELIVERED', label: 'Mark signed' });
    }
  });

  it('offers no step from a terminal or already-complete status', () => {
    for (const s of ['SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED']) {
      expect(doAdvanceStep(s), s).toBeNull();
    }
  });

  it('never proposes a step out of CANCELLED — the server refuses every one', () => {
    /* delivery-orders-mfg.ts:5401 returns do_cancelled_final for ANY transition
       out of CANCELLED. A "Reopen" control shipped here for months and could
       not once have succeeded; this test is what stops it coming back. */
    expect(doAdvanceStep('CANCELLED')).toBeNull();
    expect(doAdvanceBlockReason('CANCELLED')).toMatch(/new delivery order/i);
  });
});

describe('the two questions are never both silent', () => {
  it('answers every legal status with at least one sentence', () => {
    for (const s of DO_STATUSES_FOR_TEST) {
      const advance = doAdvanceStep(s) ? null : doAdvanceBlockReason(s);
      const transfer = siTransferBlockReason(s);
      const canAdvance = !!doAdvanceStep(s);
      const canTransfer = transfer === null;
      // Either the operator has something to do, or he is told why not.
      expect(canAdvance || canTransfer || !!advance || !!transfer, s).toBe(true);
      if (!canAdvance) expect(advance, `advance reason for ${s}`).toBeTruthy();
      if (!canTransfer) expect(transfer, `transfer reason for ${s}`).toBeTruthy();
    }
  });

  it('covers the whole scm.do_status enum', () => {
    expect([...DO_STATUSES_FOR_TEST].sort()).toEqual(
      ['CANCELLED', 'DELIVERED', 'DISPATCHED', 'DRAFT', 'INVOICED', 'IN_TRANSIT', 'LOADED', 'SIGNED'].sort(),
    );
  });
});
