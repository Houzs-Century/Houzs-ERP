import { describe, it, expect } from 'vitest';
import {
  doAdvanceBlockReason,
  doAdvanceStep,
  SI_TRANSFERABLE_DO_STATUSES,
  siTransferBlockReason,
} from './do-next-step';
// @ts-expect-error — .mjs constants module, no types, deliberately not vendored.
import { DO_SHIPPED_STATES } from '../../../../../backend/scripts/lib/do-shipped-states.mjs';

/* The status vocabulary is DERIVED, not hand-typed. DO_SHIPPED_STATES is the
   canonical shipped list (backend/src/scm/shared/do-shipped-states.ts, mirrored
   into .mjs and pinned by backend/tests/doShippedStatesMirror.test.ts), and the
   three remaining labels of the scm.do_status enum are its complement. Written
   this way so that a status ADDED to the shipped set arrives here on its own and
   this suite fails until the module has a sentence for it — a hand-copied list
   would simply not notice, which is the whole reason the lint rule forbids one. */
const DO_STATUSES: string[] = [...(DO_SHIPPED_STATES as string[]), 'DRAFT', 'LOADED', 'CANCELLED'];

/** The shipped states from which the document is not yet signed off. */
const PRE_SIGNATURE: string[] = ['LOADED', ...(DO_SHIPPED_STATES as string[]).filter(
  (s) => s !== 'SIGNED' && s !== 'DELIVERED' && s !== 'INVOICED',
)];

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
  it('allows exactly the four shipped statuses the owner ruled on', () => {
    /* OWNER RULING 2026-08-18: "DISPATCHED, IN_TRANSIT, SIGNED, DELIVERED —
       这些 status 都可以转 SI". This test asserted ['signed','delivered'] until
       then, which was the narrowest of three live spellings and — because 2990's
       source system has no "delivered" step — silently told one whole
       organisation the transfer did not exist. */
    for (const s of SI_TRANSFERABLE_DO_STATUSES) {
      expect(siTransferBlockReason(s)).toBeNull();
    }
    expect(SI_TRANSFERABLE_DO_STATUSES).toEqual(['dispatched', 'in_transit', 'signed', 'delivered']);
  });

  it('is case- and whitespace-insensitive, because rows carry raw DB values', () => {
    expect(siTransferBlockReason('SIGNED')).toBeNull();
    expect(siTransferBlockReason('  Delivered ')).toBeNull();
  });

  it('gives every blocking status an actionable sentence', () => {
    for (const s of DO_STATUSES.filter((x) => !['DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED'].includes(x))) {
      const r = siTransferBlockReason(s);
      expect(r, s).toBeTruthy();
      expect(r!.length, s).toBeGreaterThan(20);
      expect(r!.endsWith('.'), s).toBe(true);
    }
  });

  it('names the DISPATCH step from the states that have not shipped', () => {
    /* Was "names the SIGN step from the pre-signature shipped states". Under the
       owner's ruling the pre-signature SHIPPED states (DISPATCHED, IN_TRANSIT)
       are transferable, so the only blockers left are the pre-SHIP ones, and the
       action to name is dispatch, not signing. */
    for (const s of ['DRAFT', 'LOADED']) {
      expect(siTransferBlockReason(s), s).toMatch(/dispatch/i);
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
    for (const s of PRE_SIGNATURE) {
      expect(doAdvanceStep(s), s).toEqual({ status: 'DELIVERED', label: 'Mark signed' });
    }
  });

  it('offers no step from a terminal or already-complete status', () => {
    for (const s of DO_STATUSES.filter((x) => !PRE_SIGNATURE.includes(x) && x !== 'DRAFT')) {
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
    for (const s of DO_STATUSES) {
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
    /* This is the ONE place the eight labels are written out, and it is the
       EXPECTED VALUE of an equality assertion, not a list anything reads to
       decide behaviour. Its entire job is to fail when the derived list above
       and the enum stop agreeing — the referee, which is the opposite of the
       silent copy the rule forbids. Nothing imports it; deleting it would
       remove a check, not a duplicate. */
    // eslint-disable-next-line no-restricted-syntax -- assertion target: the enum this suite is the referee for, deliberately spelled out so a drift fails here.
    const ENUM_LABELS = ['CANCELLED', 'DELIVERED', 'DISPATCHED', 'DRAFT', 'INVOICED', 'IN_TRANSIT', 'LOADED', 'SIGNED'];
    expect([...DO_STATUSES].sort()).toEqual(ENUM_LABELS.sort());
  });
});
