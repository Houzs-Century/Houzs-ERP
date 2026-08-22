import { describe, it, expect } from 'vitest';
import {
  doAdvanceBlockReason,
  doAdvanceStep,
  SI_TRANSFERABLE_DO_STATUSES,
  siTransferBlockReason,
} from './do-next-step';
// @ts-expect-error — .mjs constants module, no types, deliberately not vendored.
import { DO_SHIPPED_STATES } from '../../../../../backend/scripts/lib/do-shipped-states.mjs';
import { SI_TRANSFERABLE_DO_STATES } from '../../shared/do-shipped-states';

/* The status vocabulary is DERIVED, not hand-typed. DO_SHIPPED_STATES is the
   canonical shipped list (backend/src/scm/shared/do-shipped-states.ts, mirrored
   into .mjs and pinned by backend/tests/doShippedStatesMirror.test.ts), and the
   three remaining labels of the scm.do_status enum are its complement. Written
   this way so that a status ADDED to the shipped set arrives here on its own and
   this suite fails until the module has a sentence for it — a hand-copied list
   would simply not notice, which is the whole reason the lint rule forbids one.

   THE DERIVATION EARNED ITS KEEP ON 2026-08-22 and then showed its one flaw.
   LOADED moved INTO the shipped set (the owner put the stock-out on the confirm
   step), the complement below still added it by hand, and the vocabulary came
   out with LOADED twice — caught here, which is the point. De-duplicated so the
   complement is a complement whichever side a label sits on. */
const DO_STATUSES: string[] = [
  ...new Set([...(DO_SHIPPED_STATES as string[]), 'DRAFT', 'LOADED', 'CANCELLED']),
];

/** The shipped states from which the document is not yet signed off. */
const PRE_SIGNATURE: string[] = [...new Set(['LOADED', ...(DO_SHIPPED_STATES as string[]).filter(
  (s) => s !== 'SIGNED' && s !== 'DELIVERED' && s !== 'INVOICED',
)])];

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
  it('allows every confirmed shipped status (owner 2026-08-19: no forced sign)', () => {
    for (const s of SI_TRANSFERABLE_DO_STATUSES) {
      expect(siTransferBlockReason(s)).toBeNull();
    }
    // Every status past DRAFT that is not CANCELLED — the set the server has
    // always permitted an SI to be raised from (only CANCELLED is refused there).
    expect(SI_TRANSFERABLE_DO_STATUSES).toEqual(['loaded', 'dispatched', 'in_transit', 'signed', 'delivered']);
  });

  it('AGREES with the shared declaration — this module only lower-cases it', () => {
    /* A REFEREE, and it is worth being exact about what it can and cannot see.

       WHAT IT CATCHES: the shared declaration and this module's view of it
       drifting apart in VALUE — someone edits SI_TRANSFERABLE_DO_STATES and
       this module keeps answering the old set, or vice versa.

       WHAT IT CANNOT CATCH, measured rather than assumed: re-typing the list
       here with the same five strings. That was tried while resolving this
       merge and all 13 tests stayed green, so an assertion of the SHAPE would
       have been a claim this file cannot support. The structural pin — that
       do-next-step.ts imports the declaration and does not re-type the status
       list — is a SOURCE check and it lives in
       backend/tests/oneSystemTwoOrganisations.test.ts, which reads this file.
       Re-typed there, that suite goes red (proven, not assumed). It is not
       repeated here, because a rule with two homes is the defect this whole
       change is about. */
    expect([...SI_TRANSFERABLE_DO_STATUSES])
      .toEqual(SI_TRANSFERABLE_DO_STATES.map((x) => x.toLowerCase()));
  });

  it('is case- and whitespace-insensitive, because rows carry raw DB values', () => {
    expect(siTransferBlockReason('SIGNED')).toBeNull();
    expect(siTransferBlockReason('  Delivered ')).toBeNull();
    expect(siTransferBlockReason('DISPATCHED')).toBeNull();
  });

  it('gives every blocking status an actionable sentence', () => {
    const transferable = SI_TRANSFERABLE_DO_STATUSES as readonly string[];
    for (const s of DO_STATUSES.filter((x) => !transferable.includes(x.toLowerCase()))) {
      const r = siTransferBlockReason(s);
      expect(r, s).toBeTruthy();
      expect(r!.length, s).toBeGreaterThan(20);
      expect(r!.endsWith('.'), s).toBe(true);
    }
  });

  it('now ALLOWS the pre-signature shipped states — Mark signed is no longer required', () => {
    /* The gate this reverses: LOADED / DISPATCHED / IN_TRANSIT used to be blocked
       with "Mark this delivery order signed first". They are confirmed shipments,
       so their Sales Invoice may now be raised directly. */
    for (const s of PRE_SIGNATURE) {
      expect(siTransferBlockReason(s), s).toBeNull();
    }
  });

  it('does not claim an INVOICED delivery order was billed', () => {
    /* routes/unbilled-deliveries.ts:13 — nothing in the codebase ever writes
       delivery_orders.status='INVOICED', so the label means "somebody clicked
       it", never "this was billed". The sentence must state the gate instead. */
    const r = siTransferBlockReason('INVOICED')!;
    expect(r).not.toMatch(/already been invoiced|already invoiced/i);
    expect(r).toMatch(/confirmed delivery order/i);
  });

  it('falls back to the generic sentence for an unrecognised status', () => {
    /* Never a guess. COMPLETED is the cautionary case: it lived in these lists
       for months on a comment's authority and Postgres rejected it outright. */
    expect(siTransferBlockReason('COMPLETED')).toMatch(/confirmed delivery order/i);
    expect(siTransferBlockReason('')).toBeTruthy();
    expect(siTransferBlockReason(null)).toBeTruthy();
    expect(siTransferBlockReason(undefined)).toBeTruthy();
  });
});

describe('doAdvanceStep', () => {
  it('confirms a draft to LOADED — the status the stock leaves on', () => {
    /* The target changed on 2026-08-22 and the LABEL did not, which is the whole
       correction: this control said "Confirm" while writing DISPATCHED, a status
       every screen renders as "Shipped". The owner settled where the stock
       leaves — 「once confirmed就代表出货了 就是直接扣库存」 — so Confirm writes
       LOADED, and LOADED is where the inventory OUT fires. */
    expect(doAdvanceStep('DRAFT')).toEqual({ status: 'LOADED', label: 'Confirm' });
  });

  it('offers no step from any state but DRAFT — "Mark signed" was removed (owner 2026-08-21)', () => {
    /* LOADED / DISPATCHED / IN_TRANSIT used to advance to DELIVERED as
       "Mark signed". That step is gone: a shipped delivery is closed by the
       driver's Proof-of-Delivery screen, and the office's next action is the
       Sales Invoice — which doAdvanceBlockReason names in its place, so the
       "two questions never both silent" contract still holds. */
    for (const s of DO_STATUSES.filter((x) => x !== 'DRAFT')) {
      expect(doAdvanceStep(s), s).toBeNull();
    }
    for (const s of PRE_SIGNATURE) {
      expect(doAdvanceBlockReason(s), s).toMatch(/Sales Invoice/i);
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
