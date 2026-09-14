import { describe, expect, it } from 'vitest';
import {
  AMENDMENT_APPROVER_LABEL,
  AMENDMENT_APPROVER_TONE,
  PO_AMENDMENT_APPROVER,
  soAmendmentApprover,
} from './amendment-approver';
import { STATUS_TONES } from './status-pill';

describe('who signs an amendment', () => {
  it('an SO amendment follows its lane', () => {
    expect(soAmendmentApprover('LINES')).toBe('PURCHASER');
    expect(soAmendmentApprover('DELIVERY')).toBe('LOGISTIC');
    expect(soAmendmentApprover(null)).toBe('LEGACY');
    expect(soAmendmentApprover(undefined)).toBe('LEGACY');
  });

  it('a PO amendment is Purchaser', () => {
    expect(PO_AMENDMENT_APPROVER).toBe('PURCHASER');
  });

  it('says the role names the approve keys are granted to', () => {
    expect(AMENDMENT_APPROVER_LABEL).toEqual({ PURCHASER: 'Purchaser', LOGISTIC: 'Logistic', LEGACY: 'Legacy' });
  });

  it('Purchaser and Logistic never share a colour, and neither borrows a status colour', () => {
    const { PURCHASER, LOGISTIC } = AMENDMENT_APPROVER_TONE;
    expect(PURCHASER.fg).not.toBe(LOGISTIC.fg);
    const statusColours = Object.values(STATUS_TONES).flatMap((t) => [t.fg, t.bg]);
    for (const tone of [PURCHASER, LOGISTIC]) {
      expect(statusColours).not.toContain(tone.fg);
      expect(statusColours).not.toContain(tone.bg);
    }
  });
});
