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

const DO_STATUSES: string[] = [
  ...new Set([...(DO_SHIPPED_STATES as string[]), 'DRAFT', 'LOADED', 'CANCELLED']),
];

const PRE_SIGNATURE: string[] = [...new Set(['LOADED', ...(DO_SHIPPED_STATES as string[]).filter(
  (s) => s !== 'SIGNED' && s !== 'DELIVERED' && s !== 'INVOICED',
)])];


describe('siTransferBlockReason', () => {
  it('allows every confirmed shipped status (owner 2026-08-19: no forced sign)', () => {
    for (const s of SI_TRANSFERABLE_DO_STATUSES) {
      expect(siTransferBlockReason(s)).toBeNull();
    }
    expect(SI_TRANSFERABLE_DO_STATUSES).toEqual(['loaded', 'dispatched', 'in_transit', 'signed', 'delivered']);
  });

  it('AGREES with the shared declaration — this module only lower-cases it', () => {
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
    for (const s of PRE_SIGNATURE) {
      expect(siTransferBlockReason(s), s).toBeNull();
    }
  });

  it('does not claim an INVOICED delivery order was billed', () => {
    const r = siTransferBlockReason('INVOICED')!;
    expect(r).not.toMatch(/already been invoiced|already invoiced/i);
    expect(r).toMatch(/confirmed delivery order/i);
  });

  it('falls back to the generic sentence for an unrecognised status', () => {
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
    for (const s of DO_STATUSES.filter((x) => x !== 'DRAFT')) {
      expect(doAdvanceStep(s), s).toBeNull();
    }
    for (const s of PRE_SIGNATURE) {
      expect(doAdvanceBlockReason(s), s).toMatch(/Sales Invoice/i);
    }
  });

  it('never proposes a step out of CANCELLED — the server refuses every one', () => {
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
      expect(canAdvance || canTransfer || !!advance || !!transfer, s).toBe(true);
      if (!canAdvance) expect(advance, `advance reason for ${s}`).toBeTruthy();
      if (!canTransfer) expect(transfer, `transfer reason for ${s}`).toBeTruthy();
    }
  });

  it('covers the whole scm.do_status enum', () => {
    // eslint-disable-next-line no-restricted-syntax -- assertion target: the enum this suite is the referee for, deliberately spelled out so a drift fails here.
    const ENUM_LABELS = ['CANCELLED', 'DELIVERED', 'DISPATCHED', 'DRAFT', 'INVOICED', 'IN_TRANSIT', 'LOADED', 'SIGNED'];
    expect([...DO_STATUSES].sort()).toEqual(ENUM_LABELS.sort());
  });
});
