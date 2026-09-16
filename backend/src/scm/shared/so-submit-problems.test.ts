import { describe, expect, it } from 'vitest';
import {
  collectSoSubmitProblems,
  soPaymentSubFieldGap,
  type SoSubmitFacts,
} from './so-submit-problems';
import { SOFA_MIX_REASON } from '../lib/main-mix';

/** A fully-complete confirmed create — every gate passes. Tests override slices. */
const OK: SoSubmitFacts = {
  customerName: 'Ada Lovelace',
  phone: '0123456789',
  hasNamedLine: true,
  asDraft: false,
  hasVenue: true,
  hasSalesperson: true,
  gateLocation: true,
  companyCode: 'HOUZS',
  salesLocation: 'HQ-WH',
  customerState: 'Selangor',
  gate: { procDate: null, delivDate: null, todayMY: '2026-09-16', variantOffenders: [] },
  sofaMixConflict: false,
  paymentGaps: [],
};

const codes = (fs: SoSubmitFacts) => collectSoSubmitProblems(fs).map((p) => p.code);
const messages = (fs: SoSubmitFacts) => collectSoSubmitProblems(fs).map((p) => p.message);

describe('collectSoSubmitProblems', () => {
  it('returns [] when every gate passes', () => {
    expect(collectSoSubmitProblems(OK)).toEqual([]);
  });

  it('names every missing always-required identity field at once', () => {
    const ps = collectSoSubmitProblems({
      ...OK,
      customerName: '   ',
      phone: '',
      hasNamedLine: false,
      hasVenue: false,
      hasSalesperson: false,
    });
    expect(ps.map((p) => p.message)).toEqual([
      'Customer name is required.',
      'Phone number is required.',
      'At least one line item with a product is required.',
      'Venue is required.',
      'Salesperson is required.',
    ]);
    expect(ps.every((p) => p.code === 'required_field')).toBe(true);
  });

  it('a draft does not need the confirm-only fields (venue, salesperson, location)', () => {
    const ps = collectSoSubmitProblems({
      ...OK,
      asDraft: true,
      hasVenue: false,
      hasSalesperson: false,
      gateLocation: false,
      salesLocation: '',
      customerState: '',
    });
    expect(ps).toEqual([]);
  });

  it('drops the bare "Customer name is required." when a Processing Date restates it', () => {
    // Proceeding with no customer name: the tier-1 completeness restates it with
    // the reason, so the bare required duplicate must not also appear.
    const ps = collectSoSubmitProblems({
      ...OK,
      customerName: '',
      gate: {
        procDate: '2099-01-10',
        delivDate: '2099-02-10',
        todayMY: '2026-09-16',
        variantOffenders: [],
        completeness: { hasCustomerName: false, hasAddress: true, hasPostcode: true },
      },
    });
    const customerMsgs = ps.filter((p) => p.field === 'Customer' || p.field === 'Customer name');
    // Exactly one customer-name problem, and it is the gate's (with the reason).
    expect(ps.filter((p) => p.message.startsWith('Customer name is required')).length).toBe(1);
    expect(customerMsgs[0]!.code).toBe('processing_date_incomplete');
  });

  it('keeps the bare "Customer name is required." when NOT proceeding', () => {
    const ps = collectSoSubmitProblems({ ...OK, customerName: '' });
    expect(ps.map((p) => p.message)).toContain('Customer name is required.');
    expect(codes({ ...OK, customerName: '' })).toContain('required_field');
  });

  it('delegates tier-1 (variants + dates) verbatim to collectProcessingGateProblems', () => {
    const ps = collectSoSubmitProblems({
      ...OK,
      gate: {
        procDate: '2020-05-10',
        delivDate: '2020-05-01', // proc > deliv, both past
        todayMY: '2026-09-16',
        variantOffenders: [{ itemCode: 'TELLUC-2S', group: 'sofa', missing: ['fabricCode'] }],
        completeness: { hasCustomerName: true, hasAddress: true, hasPostcode: true },
      },
    });
    expect(ps.map((p) => p.code)).toEqual([
      'variants_incomplete',
      'processing_date_past',
      'delivery_date_past',
      'processing_after_delivery',
    ]);
  });

  it('reports the stock-location "no State" cause when the company needs one', () => {
    const ps = collectSoSubmitProblems({ ...OK, salesLocation: '', customerState: '' });
    expect(ps.map((p) => p.code)).toEqual(['so_state_required']);
  });

  it('reports the stock-location "State unmapped" cause', () => {
    const ps = collectSoSubmitProblems({ ...OK, salesLocation: '', customerState: 'Perlis' });
    expect(ps.map((p) => p.code)).toEqual(['so_state_unmapped']);
    expect(ps[0]!.message).toContain('Perlis');
  });

  it('does not gate the location when gateLocation is false (edit / draft / mappings loading)', () => {
    const ps = collectSoSubmitProblems({ ...OK, gateLocation: false, salesLocation: '', customerState: '' });
    expect(ps).toEqual([]);
  });

  it('emits the shared sofa-mix sentence', () => {
    const ps = collectSoSubmitProblems({ ...OK, sofaMixConflict: true });
    expect(ps).toEqual([{ code: 'sofa_mix', message: SOFA_MIX_REASON, field: 'Line items' }]);
  });

  it('names every incomplete payment row, not just the first', () => {
    const ps = collectSoSubmitProblems({
      ...OK,
      paymentGaps: [
        { row: 1, method: 'Merchant', missing: 'Bank' },
        { row: 3, method: 'Online', missing: 'Sub-Type' },
      ],
    });
    expect(ps.map((p) => p.message)).toEqual([
      'Payment 1 (Merchant) needs a Bank.',
      'Payment 3 (Online) needs a Sub-Type.',
    ]);
    expect(ps.every((p) => p.code === 'payment_method_field_required')).toBe(true);
  });

  it('appends surface extras verbatim, last', () => {
    const extra = { code: 'scanned_line_unpicked', message: 'Pick a product.', field: 'Line items' };
    const ps = collectSoSubmitProblems({ ...OK, extra: [extra] });
    expect(ps[ps.length - 1]).toEqual(extra);
  });

  it('collects blockers from every tier in ONE list (the whole point)', () => {
    const ps = collectSoSubmitProblems({
      ...OK,
      phone: '',
      hasVenue: false,
      salesLocation: '',
      customerState: '',
      sofaMixConflict: true,
      paymentGaps: [{ row: 1, method: 'Merchant', missing: 'Bank' }],
    });
    // phone + venue + stock-location + sofa + payment = 5, all at once.
    expect(ps).toHaveLength(5);
    expect(messages({
      ...OK, phone: '', hasVenue: false, salesLocation: '', customerState: '',
      sofaMixConflict: true, paymentGaps: [{ row: 1, method: 'Merchant', missing: 'Bank' }],
    })).toEqual([
      'Phone number is required.',
      'Venue is required.',
      'Pick the delivery State — it decides which warehouse this order ships from, and an order with no warehouse cannot be created.',
      SOFA_MIX_REASON,
      'Payment 1 (Merchant) needs a Bank.',
    ]);
  });
});

describe('soPaymentSubFieldGap', () => {
  it('Merchant needs a Bank then a Plan', () => {
    expect(soPaymentSubFieldGap({ methodLabel: 'Merchant' })).toBe('Bank');
    expect(soPaymentSubFieldGap({ methodLabel: 'Merchant', merchantProvider: 'Maybank' })).toBe('Plan');
    expect(soPaymentSubFieldGap({ methodLabel: 'Merchant', merchantProvider: 'Maybank', installmentMonthsLabel: '6 months' })).toBeNull();
  });
  it('Online needs a Sub-Type', () => {
    expect(soPaymentSubFieldGap({ methodLabel: 'Online' })).toBe('Sub-Type');
    expect(soPaymentSubFieldGap({ methodLabel: 'Online', onlineType: 'FPX' })).toBeNull();
  });
  it('Convert needs the source order', () => {
    expect(soPaymentSubFieldGap({ methodLabel: 'Convert' })).toBe('order the money comes from');
    expect(soPaymentSubFieldGap({ methodLabel: 'Convert', convertedFromDocNo: 'SO-2609-001' })).toBeNull();
  });
  it('Cash / unknown need no sub-field', () => {
    expect(soPaymentSubFieldGap({ methodLabel: 'Cash' })).toBeNull();
    expect(soPaymentSubFieldGap({ methodLabel: 'whatever' })).toBeNull();
  });
});
