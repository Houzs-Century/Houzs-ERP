// A PO-sourced Purchase Return draws from RECEIPTS, not from the PO's own lines.
//
// 2026-08-21 full-flow audit, item B6: the PO detail's "Raise Return" prefilled
// the PO's OWN lines with grn_item_id null — every line "manual": uncapped
// (unlimited return qty), consuming no returned_qty (the PO stayed fully
// received while its goods left), and deducting the company DEFAULT warehouse
// instead of the receiving one. The pool is now the PO's POSTED GRN lines with
// remaining > 0, served by GET /purchase-returns/returnable-grn-lines and
// consumed by the page's PO prefill with full grnItemId linkage.
//
// Structural: the endpoint needs a live DB; these pin the SOURCE shapes.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BE = readFileSync(resolve(__dirname, '../src/scm/routes/purchase-returns.ts'), 'utf8');
const FE = readFileSync(
  resolve(__dirname, '../../frontend/src/pages/scm-v2/PurchaseReturnNew.tsx'),
  'utf8',
);

describe('GET /purchase-returns/returnable-grn-lines', () => {
  it('is registered BEFORE the /:id route, which would otherwise swallow it', () => {
    const literal = BE.indexOf("purchaseReturns.get('/returnable-grn-lines'");
    const param = BE.indexOf("purchaseReturns.get('/:id'");
    expect(literal, 'endpoint missing').toBeGreaterThan(-1);
    expect(param, '/:id route missing').toBeGreaterThan(-1);
    expect(literal, 'literal path must precede /:id').toBeLessThan(param);
  });

  it('draws from POSTED receipts only, company-scoped, with a positive remaining', () => {
    const start = BE.indexOf("purchaseReturns.get('/returnable-grn-lines'");
    const seg = BE.slice(start, BE.indexOf("purchaseReturns.get('/:id'", start));
    expect(seg).toContain(".eq('status', 'POSTED')");
    expect(seg).toContain('scopeToCompany(');
    expect(seg).toContain('.filter((l) => l.remaining > 0)');
    // Both reads bind their errors — no fail-open on this pool.
    expect(seg).toContain('error: gErr');
    expect(seg).toContain('error: iErr');
  });
});

describe('PurchaseReturnNew — the PO prefill carries the receipt linkage', () => {
  it('builds PO-mode lines from useReturnableGrnLines, each with its grnItemId', () => {
    expect(FE).toContain('useReturnableGrnLines(poId)');
    const prefill = FE.slice(FE.indexOf('Pre-fill from PO'), FE.indexOf('const setLine'));
    expect(prefill, 'PO prefill must link each line').toContain('grnItemId:      l.grnItemId');
    expect(prefill, 'the null-linkage shape must be gone').not.toContain('grnItemId:      null');
  });

  it('an empty pool is named as the SCOPED fact, not rendered as a blank form', () => {
    expect(FE).toContain('poPoolEmpty');
    expect(FE).toContain('Nothing returnable on');
  });
});
