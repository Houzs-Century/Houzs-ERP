import { describe, expect, it } from 'vitest';
import { collectSoSaveProblems, type SoSaveProblemsInput } from './so-save-problems-client';

/* A complete, proceeding order (future dates, full address, both lines' variants
   filled). Individual tests knock out one thing at a time, or several at once. */
const complete = (): SoSaveProblemsInput => ({
  required: {
    customerName: 'Goh',
    phone: '+60123456789',
    hasNamedLine: true,
    asDraft: false,
    hasVenue: true,
    hasSalesperson: true,
    location: { companyCode: '2990', salesLocation: '', state: 'Kedah', mappingsLoaded: true, asDraft: false },
  },
  location: { companyCode: '2990', salesLocation: '', state: 'Kedah', mappingsLoaded: true, asDraft: false },
  processingDate: '2099-01-10',
  completeness: {
    customerName: 'Goh',
    fillAddressLater: false,
    address1: '268, Lorong Permata 10',
    postcode: '08000',
    deliveryDate: '2099-02-10',
  },
  dateGuard: { processingDate: '2099-01-10', deliveryDate: '2099-02-10', today: '2026-09-16', requireDatesTogether: true },
  variantOffenders: [],
  sofaMixConflict: false,
  sofaMixMessage: 'A sofa cannot share an order with a bedframe or mattress.',
  paymentGaps: [],
});

const codes = (ps: ReturnType<typeof collectSoSaveProblems>) => ps.map((p) => p.code);
const messages = (ps: ReturnType<typeof collectSoSaveProblems>) => ps.map((p) => p.message);

describe('collectSoSaveProblems', () => {
  it('returns [] when every gate passes', () => {
    expect(collectSoSaveProblems(complete())).toEqual([]);
  });

  it('the #4007 class: a missing postcode AND two lines with option/size gaps all show at once', () => {
    const input = complete();
    input.completeness.postcode = '';
    input.variantOffenders = [
      { itemCode: 'MT-QUEEN', missingLabels: ['Seat Size'] },
      { itemCode: 'BF-5FT', missingLabels: ['Divan Height'] },
    ];
    const ps = collectSoSaveProblems(input);
    // postcode completeness + two variant lines = 3, none masking the others.
    expect(ps).toHaveLength(3);
    expect(messages(ps)).toEqual([
      'Delivery postcode is required before a Processing Date can be set',
      'MT-QUEEN — Seat Size is required',
      'BF-5FT — Divan Height is required',
    ]);
  });

  it('lists EVERY missing axis on a line, not just the first', () => {
    const input = complete();
    input.variantOffenders = [{ itemCode: 'BF-5FT', missingLabels: ['Divan Height', 'Leg Height', 'Fabrics'] }];
    const ps = collectSoSaveProblems(input);
    expect(ps).toHaveLength(3);
    expect(ps.every((p) => p.line === 'BF-5FT' && p.code === 'variants_incomplete')).toBe(true);
  });

  it('folds always-required fields, completeness, variants, sofa-mix and payments into ONE list', () => {
    const input = complete();
    input.required.hasVenue = false; // always-required
    input.completeness.address1 = ''; // proceeding completeness
    input.variantOffenders = [{ itemCode: 'SF-1', missingLabels: ['Fabrics'] }];
    input.sofaMixConflict = true;
    input.paymentGaps = [{ row: 2, method: 'Merchant', missing: 'Bank' }];
    const ps = collectSoSaveProblems(input);
    expect(codes(ps)).toEqual([
      'required_field',        // Venue
      'processing_date_incomplete', // address line 1
      'variants_incomplete',   // SF-1 Fabrics
      'sofa_mix',
      'payment_method_field_required',
    ]);
  });

  it('does not double-list customer name when a Processing Date makes it a completeness failure', () => {
    const input = complete();
    input.required.customerName = '';
    input.completeness.customerName = '';
    const ps = collectSoSaveProblems(input);
    // ONE customer-name problem, the proceeding one that carries the reason.
    const custProblems = ps.filter((p) => p.message.toLowerCase().includes('customer name'));
    expect(custProblems).toHaveLength(1);
    expect(custProblems[0]!.code).toBe('processing_date_incomplete');
  });

  it('a draft with no Processing Date reports no completeness / variant gaps', () => {
    const input = complete();
    input.processingDate = '';
    input.required.asDraft = true;
    input.dateGuard = { processingDate: '', deliveryDate: '', today: '2026-09-16', requireDatesTogether: false };
    input.completeness = { customerName: '', fillAddressLater: true, address1: '', postcode: '', deliveryDate: '' };
    input.variantOffenders = [{ itemCode: 'BF-5FT', missingLabels: ['Divan Height'] }];
    expect(collectSoSaveProblems(input)).toEqual([]);
  });

  it('surfaces a past Processing Date in the same list', () => {
    const input = complete();
    input.dateGuard = { processingDate: '2020-01-01', deliveryDate: '2099-02-10', today: '2026-09-16', requireDatesTogether: true };
    const ps = collectSoSaveProblems(input);
    expect(codes(ps)).toContain('date_invalid');
  });
});
