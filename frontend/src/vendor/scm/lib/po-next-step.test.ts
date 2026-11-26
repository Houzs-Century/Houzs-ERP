import { describe, it, expect } from 'vitest';
import {
  GRN_RECEIVABLE_PO_STATUSES,
  grnTransferBlockReason,
  poConfirmBlockReason,
} from './po-next-step';

const PO_STATUSES = [
  'DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED',
] as const;

describe('poConfirmBlockReason', () => {
  it('allows exactly DRAFT — the only status /confirm writes from', () => {
    expect(poConfirmBlockReason('DRAFT')).toBeNull();
    for (const s of ['SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']) {
      expect(poConfirmBlockReason(s), s).toBeTruthy();
    }
  });

  it('sends a cancelled PO to Reopen, not back to Confirm', () => {
    expect(poConfirmBlockReason('CANCELLED')).toMatch(/reopen/i);
  });

  it('gives every status a sentence, in every casing', () => {
    for (const s of PO_STATUSES) {
      const r = poConfirmBlockReason(s);
      if (s === 'DRAFT') { expect(r).toBeNull(); continue; }
      expect(r!.endsWith('.'), s).toBe(true);
    }
    expect(poConfirmBlockReason('draft')).toBeNull();
    expect(poConfirmBlockReason('  Draft ')).toBeNull();
  });

  it('falls back to the generic sentence rather than guessing', () => {
    expect(poConfirmBlockReason('SOMETHING_NEW')).toMatch(/only a draft/i);
    expect(poConfirmBlockReason(null)).toBeTruthy();
    expect(poConfirmBlockReason(undefined)).toBeTruthy();
    expect(poConfirmBlockReason('')).toBeTruthy();
  });
});

describe('grnTransferBlockReason', () => {
  it('mirrors the server RECEIVABLE_PO_STATUSES exactly', () => {
    expect([...GRN_RECEIVABLE_PO_STATUSES]).toEqual(['submitted', 'partially_received']);
    expect(grnTransferBlockReason('SUBMITTED')).toBeNull();
    expect(grnTransferBlockReason('PARTIALLY_RECEIVED')).toBeNull();
  });

  it('tells a draft to confirm first, which is the step that unblocks it', () => {
    expect(grnTransferBlockReason('DRAFT')).toMatch(/confirm/i);
  });

  it('gives every blocking status an actionable sentence', () => {
    for (const s of ['DRAFT', 'RECEIVED', 'CANCELLED']) {
      const r = grnTransferBlockReason(s);
      expect(r, s).toBeTruthy();
      expect(r!.length, s).toBeGreaterThan(20);
      expect(r!.endsWith('.'), s).toBe(true);
    }
  });

  it('never leaves a legal status silent', () => {
    for (const s of PO_STATUSES) {
      const blocked = grnTransferBlockReason(s);
      const receivable = (GRN_RECEIVABLE_PO_STATUSES as readonly string[]).includes(s.toLowerCase());
      expect(receivable ? blocked === null : !!blocked, s).toBe(true);
    }
  });
});
