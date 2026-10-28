import { describe, expect, it } from 'vitest';
import {
  AMENDMENT_APPROVER_LABEL,
  AMENDMENT_APPROVER_TONE,
  PO_AMENDMENT_APPROVER,
  SO_AMENDMENT_LANE_APPROVE_PERM,
  soAmendmentApprover,
} from './amendment-approver';
import { STATUS_TONES } from './status-pill';

describe('who signs an amendment', () => {
  it('an SO amendment follows its lane', () => {
    expect(soAmendmentApprover('LINES')).toBe('PURCHASER');
    expect(soAmendmentApprover('DELIVERY')).toBe('LOGISTIC');
    expect(soAmendmentApprover('PRICE')).toBe('FINANCE');
    expect(soAmendmentApprover(null)).toBe('LEGACY');
    expect(soAmendmentApprover(undefined)).toBe('LEGACY');
  });

  it('a PO amendment is Purchaser', () => {
    expect(PO_AMENDMENT_APPROVER).toBe('PURCHASER');
  });

  it('says the role names the approve keys are granted to', () => {
    expect(AMENDMENT_APPROVER_LABEL).toEqual({ PURCHASER: 'Purchaser', LOGISTIC: 'Logistic', FINANCE: 'Sales Director', LEGACY: 'Legacy' });
  });

  it('maps each lane to the flat key its gate checks (mirror of the backend)', () => {
    expect(SO_AMENDMENT_LANE_APPROVE_PERM).toEqual({
      LINES: 'scm.amendment.approve_lines',
      DELIVERY: 'scm.amendment.approve_delivery',
      PRICE: 'scm.amendment.approve_price',
    });
  });

  it('Purchaser, Logistic and Finance never share a colour, and none borrows a status colour', () => {
    const { PURCHASER, LOGISTIC, FINANCE } = AMENDMENT_APPROVER_TONE;
    const fgs = [PURCHASER.fg, LOGISTIC.fg, FINANCE.fg];
    expect(new Set(fgs).size).toBe(fgs.length);
    const statusColours = Object.values(STATUS_TONES).flatMap((t) => [t.fg, t.bg]);
    for (const tone of [PURCHASER, LOGISTIC, FINANCE]) {
      expect(statusColours).not.toContain(tone.fg);
      expect(statusColours).not.toContain(tone.bg);
    }
  });
});
