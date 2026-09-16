import { describe, expect, it } from 'vitest';
import { collectSoEditSaveProblems } from './so-save-problems-client';

/* The SO DETAIL editor (SalesOrderDetail) save + amendment pre-flight. It
 * delegates name / address / venue / salesperson / location to the server
 * (shown via notifySaveProblems on the PATCH), so collectSoEditSaveProblems
 * reports only the detail's own client blockers — phone, per-line variant gaps
 * (once a Processing Date is set), sofa mix, and detail extras (blank line, the
 * header date fault) — and shows them ALL at once (owner 2026-09-16). */

const codes = (ps: ReturnType<typeof collectSoEditSaveProblems>) => ps.map((p) => p.code);

describe('collectSoEditSaveProblems', () => {
  it('a complete edit reports nothing', () => {
    expect(collectSoEditSaveProblems({
      phone: '+60123456789',
      processingDate: '2099-01-10',
      variantOffenders: [],
      sofaMixConflict: false,
      sofaMixMessage: 'x',
    })).toEqual([]);
  });

  it('shows phone, every line variant gap, sofa mix and the date fault all at once', () => {
    const ps = collectSoEditSaveProblems({
      phone: '',
      processingDate: '2099-01-10',
      variantOffenders: [
        { itemCode: 'BF-5FT', missingLabels: ['Divan Height'] },
        { itemCode: 'SF-1', missingLabels: ['Seat Size'] },
      ],
      sofaMixConflict: true,
      sofaMixMessage: 'A sofa cannot share an order with a bedframe or mattress.',
      extra: [{ code: 'date_invalid', message: 'Processing Date cannot be later than the Delivery Date.', field: 'Dates' }],
    });
    expect(codes(ps)).toEqual([
      'required_field',        // phone
      'variants_incomplete',   // BF-5FT
      'variants_incomplete',   // SF-1
      'sofa_mix',
      'date_invalid',
    ]);
  });

  it('does NOT report variant gaps when no Processing Date is set (amendment / draft edit)', () => {
    const ps = collectSoEditSaveProblems({
      phone: '+60123456789',
      processingDate: '',
      variantOffenders: [{ itemCode: 'BF-5FT', missingLabels: ['Divan Height'] }],
      sofaMixConflict: false,
      sofaMixMessage: 'x',
    });
    expect(ps).toEqual([]);
  });

  it('never invents a name / address / venue block — those stay the server gate', () => {
    // Only phone + the passed extras can come back; nothing about name/address.
    const ps = collectSoEditSaveProblems({
      phone: '',
      processingDate: '2099-01-10',
      variantOffenders: [],
      sofaMixConflict: false,
      sofaMixMessage: 'x',
    });
    expect(codes(ps)).toEqual(['required_field']);
    expect(ps[0]!.message.toLowerCase()).toContain('phone');
  });
});
