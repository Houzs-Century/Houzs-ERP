import { describe, expect, it } from 'vitest';
import { collectSoSaveProblems, type SoSaveProblemsInput } from './so-save-problems-client';

/* The lean create flows — SalesOrderNewGuided (sofa wizard) and
 * SalesOrderNewFromProducts (product cart) — now pre-validate through the same
 * collectSoSaveProblems as the Full form and the phone (owner 2026-09-16). They
 * collect no dates and no payments and gate customer + at least one line before
 * submit, so the only client blocker either can raise is the sofa-mix rule
 * (FromProducts carts can mix categories; the wizard is sofa-only). These pin
 * that: a mixed cart shows the blocker, a clean one shows none. Venue /
 * salesperson are marked satisfied by both flows (they manage neither; the
 * server gates a CONFIRMED create) so no client block is invented. */

const leanFlow = (over: Partial<SoSaveProblemsInput> = {}): SoSaveProblemsInput => ({
  required: {
    customerName: 'Goh',
    phone: '+60123456789',
    hasNamedLine: true,
    asDraft: true,
    hasVenue: true,
    hasSalesperson: true,
    location: { companyCode: '2990', salesLocation: '', state: '', asDraft: true },
  },
  location: { companyCode: '2990', salesLocation: '', state: '', asDraft: true },
  processingDate: '',
  completeness: { customerName: 'Goh', fillAddressLater: false, address1: '', postcode: '', deliveryDate: '' },
  dateGuard: { processingDate: '', deliveryDate: '', today: '2026-09-16' },
  variantOffenders: [],
  sofaMixConflict: false,
  sofaMixMessage: 'A sofa cannot share an order with a bedframe or mattress.',
  paymentGaps: [],
  ...over,
});

describe('create flows via collectSoSaveProblems', () => {
  it('a clean sofa-only wizard build (draft, no dates) reports nothing', () => {
    expect(collectSoSaveProblems(leanFlow())).toEqual([]);
  });

  it('a clean product cart reports nothing', () => {
    expect(collectSoSaveProblems(leanFlow({ required: { ...leanFlow().required, asDraft: false } }))).toEqual([]);
  });

  it('a cart that mixes a sofa with a bedframe surfaces the sofa-mix blocker', () => {
    const ps = collectSoSaveProblems(leanFlow({ sofaMixConflict: true }));
    expect(ps).toHaveLength(1);
    expect(ps[0]!.code).toBe('sofa_mix');
  });

  it('a draft flow never raises completeness or variant gaps even with none filled', () => {
    // asDraft + no processing date: the address / variant / date gates stay off,
    // exactly as these flows rely on (enrichment happens on the SO detail).
    const ps = collectSoSaveProblems(leanFlow({
      completeness: { customerName: '', fillAddressLater: true, address1: '', postcode: '', deliveryDate: '' },
      variantOffenders: [{ itemCode: 'SF-1', missingLabels: ['Seat Size'] }],
    }));
    expect(ps).toEqual([]);
  });
});
