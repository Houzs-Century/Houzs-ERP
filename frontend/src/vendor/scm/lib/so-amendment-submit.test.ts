// The rule both surfaces got wrong in opposite directions — see the module
// header. These execute the decision rather than pinning source text, so a
// future edit to the branch order fails here rather than in production.

import { describe, it, expect } from 'vitest';
import {
  planAmendmentSubmit,
  amendmentSubmittedNotice,
  AMENDMENT_MODE_BANNER,
  AMENDMENT_NOTHING_TO_SUBMIT,
  AMENDMENT_DIRECT_ONLY_SAVED_TITLE,
} from './so-amendment-submit';

const plan = (over: Partial<Parameters<typeof planAmendmentSubmit>[0]> = {}) =>
  planAmendmentSubmit({
    hasLineChanges: false,
    hasFrozenHeaderChanges: false,
    hasDirectHeaderChanges: false,
    ...over,
  });

describe('planAmendmentSubmit', () => {
  it('nothing anywhere -> NOTHING (the only genuine error)', () => {
    expect(plan()).toBe('NOTHING');
  });

  /* THE DEFECT. Desktop discarded this edit; mobile saved it and called it a
     failure. Both because the old check asked only about the amendment half. */
  it('only FREE fields moved -> DIRECT_ONLY, never an error', () => {
    expect(plan({ hasDirectHeaderChanges: true })).toBe('DIRECT_ONLY');
  });

  it('a line change -> AMENDMENT', () => {
    expect(plan({ hasLineChanges: true })).toBe('AMENDMENT');
  });

  it('a frozen header change alone -> AMENDMENT (header-only amendments are real)', () => {
    expect(plan({ hasFrozenHeaderChanges: true })).toBe('AMENDMENT');
  });

  /* The direct half rides along with an amendment; it must not downgrade the
     plan. Desktop already saved both in this case — that part was correct. */
  it('FREE + frozen together -> AMENDMENT, not DIRECT_ONLY', () => {
    expect(plan({ hasFrozenHeaderChanges: true, hasDirectHeaderChanges: true })).toBe('AMENDMENT');
  });

  it('FREE + lines together -> AMENDMENT', () => {
    expect(plan({ hasLineChanges: true, hasDirectHeaderChanges: true })).toBe('AMENDMENT');
  });

  /* Mobile stages payments in this same submit. A payment-only edit used to be
     refused "No changes to submit" and could never be booked from that screen. */
  it('a staged payment alone -> DIRECT_ONLY, not NOTHING', () => {
    expect(plan({ hasStagedPayments: true })).toBe('DIRECT_ONLY');
  });

  it('a staged payment never downgrades a real amendment', () => {
    expect(plan({ hasStagedPayments: true, hasLineChanges: true })).toBe('AMENDMENT');
  });

  it('omitting hasStagedPayments (desktop) behaves as false', () => {
    expect(planAmendmentSubmit({
      hasLineChanges: false, hasFrozenHeaderChanges: false, hasDirectHeaderChanges: false,
    })).toBe('NOTHING');
  });
});

describe('amendmentSubmittedNotice', () => {
  it('DIRECT_ONLY reports a save, never an amendment', () => {
    expect(amendmentSubmittedNotice('DIRECT_ONLY', null).title)
      .toBe(AMENDMENT_DIRECT_ONLY_SAVED_TITLE);
  });

  it('a split names both lanes and their departments', () => {
    const n = amendmentSubmittedNotice('AMENDMENT', {
      amendments: [
        { amendment_no: 'A1', lane: 'LINES' },
        { amendment_no: 'A2', lane: 'DELIVERY' },
      ],
    });
    expect(n.title).toBe('Amendment split into two approvals');
    expect(n.body).toContain('A1 → Purchasing');
    expect(n.body).toContain('A2 → Logistics');
  });

  it('one lane names who is waiting', () => {
    expect(amendmentSubmittedNotice('AMENDMENT', { amendments: [{ lane: 'DELIVERY' }] }).body)
      .toContain('Logistics');
  });

  /* A laneless row is the legacy single-gate shape; it must still say something
     true rather than "Waiting for  —". */
  it('a laneless amendment falls back to the plain message', () => {
    expect(amendmentSubmittedNotice('AMENDMENT', { amendments: [{ amendment_no: 'A1' }] }).body)
      .toBe('It now needs approval before the order is revised.');
  });

  it('survives a response shaped nothing like the contract', () => {
    expect(amendmentSubmittedNotice('AMENDMENT', undefined).title).toBe('Amendment submitted');
    expect(amendmentSubmittedNotice('AMENDMENT', { amendments: [] }).title).toBe('Amendment submitted');
  });
});

describe('operator copy', () => {
  /* 2026-07-27 moved the address block into the CONTROLLED set. Both banners
     kept saying it saved straight away. Pin the correction so a re-word cannot
     quietly reinstate the promise the server stopped honouring. */
  it('the banner does not promise that addresses save straight away', () => {
    expect(AMENDMENT_MODE_BANNER).not.toMatch(/address(es)? .{0,24}save straight away/i);
  });

  it('the banner names what DOES save straight away', () => {
    expect(AMENDMENT_MODE_BANNER).toMatch(/phone/i);
    expect(AMENDMENT_MODE_BANNER).toMatch(/save straight away/i);
  });

  it('the empty-state error asks for a line, a date or the address — the approval half', () => {
    expect(AMENDMENT_NOTHING_TO_SUBMIT).toMatch(/line/i);
    expect(AMENDMENT_NOTHING_TO_SUBMIT).toMatch(/date/i);
  });
});
