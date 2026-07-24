// Pure-mapper coverage for amendment-pdf-map.ts — proves the SO and PO amendment
// detail shapes fold into the shared AmendmentPdfInput the way the owner's
// before/after change table expects: one row per changed field, ADD/REMOVE as a
// single tinted row, and the revision old -> new pair.
import { describe, it, expect } from 'vitest';
import { soAmendmentToPdfInput, poAmendmentToPdfInput } from './amendment-pdf-map';

describe('poAmendmentToPdfInput', () => {
  it('maps a QTY + PRICE line into two before/after rows and the PO reference', () => {
    const out = poAmendmentToPdfInput({
      amendment: { amendment_no: 'PO-2607-001/A1', status: 'REQUESTED', reason: 'Supplier raised cost', created_at: '2026-07-24', requested_by_name: 'Wei' },
      lines: [{
        change_type: 'QTY', new_material_code: 'BF-1', new_material_name: 'Bed One',
        new_qty: 5, new_unit_price_centi: 1200, old_snapshot: { qty: 2, unit_price_centi: 1000, material_code: 'BF-1' },
      }],
      purchaseOrder: { po_number: 'PO-2607-001', revision: 1 },
      supplierName: 'Acme Supplier',
    });
    expect(out.kind).toBe('PO');
    expect(out.partyLabel).toBe('Supplier');
    expect(out.partyName).toBe('Acme Supplier');
    expect(out.docNo).toBe('PO-2607-001');
    // Not yet applied (REQUESTED) → revision 1 -> 2.
    expect(out.revisionFrom).toBe(1);
    expect(out.revisionTo).toBe(2);
    const fields = out.changes.map((r) => r.field);
    expect(fields).toContain('Quantity');
    expect(fields).toContain('Unit cost');
    const qty = out.changes.find((r) => r.field === 'Quantity')!;
    expect(qty.before).toBe('2');
    expect(qty.after).toBe('5');
    expect(qty.kind).toBe('CHANGE');
    const cost = out.changes.find((r) => r.field === 'Unit cost')!;
    expect(cost.before).toBe('RM 10.00');
    expect(cost.after).toBe('RM 12.00');
  });

  it('maps ADD and REMOVE lines to single tinted rows', () => {
    const out = poAmendmentToPdfInput({
      amendment: { amendment_no: 'PO-1/A2', status: 'APPROVED', created_at: '2026-07-24' },
      lines: [
        { change_type: 'ADD', new_material_code: 'BF-9', new_material_name: 'Bed Nine', new_qty: 3, new_unit_price_centi: 1500 },
        { change_type: 'REMOVE', old_snapshot: { material_name: 'Bed Two', qty: 1 } },
      ],
      purchaseOrder: { po_number: 'PO-1', revision: 2 },
    });
    // APPROVED → applied → revision 1 -> 2.
    expect(out.revisionFrom).toBe(1);
    expect(out.revisionTo).toBe(2);
    const add = out.changes.find((r) => r.kind === 'ADD')!;
    expect(add.before).toBe('—');
    expect(add.after).toContain('Qty 3');
    expect(add.after).toContain('RM 15.00');
    const rem = out.changes.find((r) => r.kind === 'REMOVE')!;
    expect(rem.after).toBe('Removed');
    expect(rem.item).toContain('Bed Two');
  });
});

describe('soAmendmentToPdfInput', () => {
  it('maps an SO SPEC swap to a Spec row and marks the customer reference', () => {
    const out = soAmendmentToPdfInput({
      amendment: { amendment_no: 'SO-9/A1', status: 'SO_APPROVED', created_at: '2026-07-24', requested_by_name: 'Ali', so_approved_by_name: 'Boss', so_approved_at: '2026-07-24' },
      lines: [{ change_type: 'SPEC', new_item_code: 'SF-200', new_qty: null, new_unit_price_sen: null, old_snapshot: { item_code: 'SF-100', qty: 1 } }],
      salesOrder: { doc_no: 'SO-9', revision: 2 },
      customerName: 'Jane Customer',
    });
    expect(out.kind).toBe('SO');
    expect(out.partyLabel).toBe('Customer');
    expect(out.docNo).toBe('SO-9');
    // SO_APPROVED is applied → 1 -> 2.
    expect(out.revisionFrom).toBe(1);
    expect(out.revisionTo).toBe(2);
    const spec = out.changes.find((r) => r.field === 'Spec')!;
    expect(spec.before).toBe('SF-100');
    expect(spec.after).toBe('SF-200');
    expect(out.approvedBy).toBe('Boss');
  });
});
