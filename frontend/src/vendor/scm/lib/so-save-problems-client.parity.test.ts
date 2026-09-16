import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSoSaveProblems, type SoSaveProblemsInput } from './so-save-problems-client';

/* PARITY WITH THE BACKEND REFUSAL.
 *
 * The three gates the backend's collectProcessingGateProblems also owns —
 * per-line variant completeness, the customer/address/postcode/delivery-date
 * completeness a Processing Date demands, and the date rules — must read the
 * SAME on the client pre-flight as in the server's validation_failed refusal,
 * so the operator sees identical wording whether the block is caught before the
 * round-trip or by the server (owner 2026-09-16, after #4007).
 *
 * The frontend test project CANNOT import backend/src at runtime (see
 * po-line-import.canonical.test.ts), so this pins parity by TEXT: it reads the
 * backend source and asserts the exact message templates this client emits are
 * present there verbatim. Reword one side and this test fails, forcing the
 * other to match — the same drift guard the canonical tests use. cwd is the
 * frontend package root, so `../backend` is the sibling backend in this
 * worktree. */
const backendSrc = (): string =>
  readFileSync(resolve(process.cwd(), '../backend/src/scm/shared/so-save-problems.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('so-save-problems client/backend parity', () => {
  it('the backend source is real and carries the gate collector', () => {
    const t = backendSrc();
    expect(t.length).toBeGreaterThan(1000);
    expect(t).toContain('collectProcessingGateProblems');
  });

  it('the Processing-Date completeness subjects + clause are byte-identical to the backend', () => {
    const t = backendSrc();
    // ACT_CLAUSE.processing_date
    expect(t).toContain('before a Processing Date can be set');
    // CONDITION_SUBJECT subjects
    expect(t).toContain('Customer name is required');
    expect(t).toContain('Delivery address line 1 is required');
    expect(t).toContain('Delivery postcode is required');
    expect(t).toContain('A delivery date is required');
  });

  it('the variant-gap message template is byte-identical to the backend', () => {
    // backend: message: `${off.itemCode} — ${label} is required`
    expect(backendSrc()).toContain('${off.itemCode} — ${label} is required');
  });

  it('this client emits those exact strings for the same facts', () => {
    const input: SoSaveProblemsInput = {
      required: {
        customerName: '', phone: '+60123456789', hasNamedLine: true, asDraft: false,
        hasVenue: true, hasSalesperson: true,
        location: { companyCode: '2990', salesLocation: '', state: 'Kedah', mappingsLoaded: true, asDraft: false },
      },
      location: { companyCode: '2990', salesLocation: '', state: 'Kedah', mappingsLoaded: true, asDraft: false },
      processingDate: '2099-01-10',
      completeness: { customerName: '', fillAddressLater: false, address1: '', postcode: '', deliveryDate: '' },
      dateGuard: { processingDate: '2099-01-10', deliveryDate: '2099-02-10', today: '2026-09-16', requireDatesTogether: true },
      variantOffenders: [{ itemCode: 'BF-5FT', missingLabels: ['Divan Height'] }],
      sofaMixConflict: false,
      sofaMixMessage: 'x',
      paymentGaps: [],
    };
    const msgs = collectSoSaveProblems(input).map((p) => p.message);
    // Completeness wording matches the backend CONDITION_SUBJECT + ACT_CLAUSE.
    expect(msgs).toContain('Customer name is required before a Processing Date can be set');
    expect(msgs).toContain('Delivery address line 1 is required before a Processing Date can be set');
    expect(msgs).toContain('Delivery postcode is required before a Processing Date can be set');
    expect(msgs).toContain('A delivery date is required before a Processing Date can be set');
    // Variant wording matches the backend template with itemCode + label filled.
    expect(msgs).toContain('BF-5FT — Divan Height is required');
  });
});
