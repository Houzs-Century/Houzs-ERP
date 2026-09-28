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

  it('draws from POSTED receipts only, company-scoped, through the shared pool', () => {
    const start = BE.indexOf("purchaseReturns.get('/returnable-grn-lines'");
    const seg = BE.slice(start, BE.indexOf("purchaseReturns.get('/:id'", start));
    expect(seg).toContain(".eq('status', 'POSTED')");
    expect(seg).toContain('scopeToCompany(');
    /* The remaining > 0 rule moved into lib/returnable-grn-lines.ts on
       2026-09-28, where returnable-grn-lines.test.ts asserts it against real
       rows rather than against this file's characters. What is pinned HERE is
       that the route still asks that one pool instead of growing a second. */
    expect(seg).toContain('buildReturnablePool(');
    expect(seg).not.toMatch(/\.filter\(\(l\) => l\.remaining/);
    // Every read binds its error — no fail-open on this pool.
    for (const bound of ['error: poErr', 'error: piErr', 'error: hgErr', 'error: gErr']) {
      expect(seg, `unbound read: ${bound}`).toContain(bound);
    }
  });

  /* THE DEFECT, 2026-09-28 (owner, HC-PO-010114: 「系统找不到 GRN - 但是现实已经
     received stock」). The pool matched `grns.purchase_order_id` only, so every
     unit received on a receipt HEADED at another purchase order was invisible
     and a fully received PO offered nothing to return. One receipt carrying
     several suppliers' orders is deliberate here, so the LINE link is the truth. */
  it("finds receipts by the LINE link, and answers the PO's own supplier", () => {
    const start = BE.indexOf("purchaseReturns.get('/returnable-grn-lines'");
    const seg = BE.slice(start, BE.indexOf("purchaseReturns.get('/:id'", start));
    expect(seg).toContain(".in('purchase_order_item_id', batch)");
    // The legacy carve-out: an UNLINKED line on this PO's own receipt.
    expect(seg).toContain(".is('purchase_order_item_id', null)");
    // The supplier is the ORDER's, never the receipt's — a shared receipt
    // belongs to a different counterparty.
    expect(seg).toContain("const supplierId = (poRow as { supplier_id: string | null }).supplier_id ?? null;");
    expect(seg).not.toContain('grnList[0]?.supplier_id');
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
