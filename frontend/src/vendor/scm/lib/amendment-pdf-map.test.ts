// Pure-mapper coverage for amendment-pdf-map.ts — proves the SO and PO amendment
// detail shapes fold into the shared AmendmentPdfInput the way the owner's
// before/after change table expects: one row per changed field, ADD/REMOVE as a
// single tinted row, and the revision old -> new pair.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import { soAmendmentToPdfInput, poAmendmentToPdfInput } from './amendment-pdf-map';

describe('poAmendmentToPdfInput', () => {
  it('maps a QTY + PRICE line into two before/after rows and the PO reference', () => {
    const out = poAmendmentToPdfInput({
      amendment: { amendment_no: 'PO-2607-001/A1', status: 'REQUESTED', reason: 'Supplier raised cost', created_at: '2026-07-24', requested_by_name: 'Wei' },
      lines: [{
        change_type: 'QTY', new_item_code: 'BF-1', new_material_name: 'Bed One',
        new_qty: 5, new_unit_price_sen: 1200, old_snapshot: { qty: 2, unit_price_sen: 1000, item_code: 'BF-1' },
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
    // Routing: qty -> Production / Design (processing); cost -> Finance (delivery/commercial).
    expect(qty.department).toContain('Production');
    expect(cost.department).toBe('Finance');
    expect(out.routing?.isMixed).toBe(true);
    expect(out.routing?.typeLabels).toContain('Processing');
    expect(out.routing?.typeLabels).toContain('Delivery / Commercial');
  });

  it('routes a delivery-date change to Logistics and marks it delivery/commercial', () => {
    const out = poAmendmentToPdfInput({
      amendment: { amendment_no: 'PO-2/A1', status: 'REQUESTED', created_at: '2026-07-24' },
      lines: [{
        change_type: 'DELIVERY', new_item_code: 'BF-3', new_delivery_date: '2026-08-10',
        old_snapshot: { item_code: 'BF-3', qty: 1, delivery_date: '2026-08-01' },
      }],
      purchaseOrder: { po_number: 'PO-2', revision: 1 },
    });
    const del = out.changes.find((r) => r.field === 'Delivery date')!;
    expect(del.department).toBe('Logistics');
    expect(out.routing?.isMixed).toBe(false);
    expect(out.routing?.typeLabels).toEqual(['Delivery / Commercial']);
    expect(out.routing?.departments).toEqual([{ department: 'Logistics', fields: ['Delivery date'] }]);
  });

  it('maps ADD and REMOVE lines to single tinted rows', () => {
    const out = poAmendmentToPdfInput({
      amendment: { amendment_no: 'PO-1/A2', status: 'APPROVED', created_at: '2026-07-24' },
      lines: [
        { change_type: 'ADD', new_item_code: 'BF-9', new_material_name: 'Bed Nine', new_qty: 3, new_unit_price_sen: 1500 },
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
    // A SKU/spec swap is a processing change owned by Production / Design.
    expect(spec.department).toBe('Production / Design');
    expect(out.routing?.typeLabels).toEqual(['Processing']);
    expect(out.routing?.isMixed).toBe(false);
  });
});

/* mig 0317 — the delivery-fee reduction. The discount is the request (the unit
   stays derived), so the printed document must carry it as its own row: a page
   showing only "Qty 1 · RM 250.00" on both sides reads as no change at all. */
describe('soAmendmentToPdfInput — the discount row (mig 0317)', () => {
  const base = {
    amendment: { amendment_no: '2990-SO-2608-020/A2', status: 'REQUESTED', reason: null, created_at: '2026-08-21', requested_by_name: 'YH' },
    salesOrder: { doc_no: '2990-SO-2608-020', revision: 1 },
    customerName: 'Hee Wai loon',
  };

  it('a discount-only fee edit prints as a Discount before/after row', () => {
    const out = soAmendmentToPdfInput({
      ...base,
      lines: [{
        change_type: 'SPEC', new_item_code: 'SVC-DELIVERY', new_qty: 1,
        new_unit_price_sen: 25000, new_discount_sen: 12500,
        old_snapshot: { item_code: 'SVC-DELIVERY', qty: 1, unit_price_sen: 25000, discountSen: 0 },
      }],
    });
    const disc = out.changes.find((r) => r.field === 'Discount')!;
    expect(disc).toBeTruthy();
    expect(disc.before).toBe('RM 0.00');
    expect(disc.after).toBe('RM 125.00');
    expect(disc.kind).toBe('CHANGE');
  });

  it('an untouched discount prints no Discount row', () => {
    const out = soAmendmentToPdfInput({
      ...base,
      lines: [{
        change_type: 'QTY', new_item_code: 'SVC-DELIVERY', new_qty: 2,
        new_unit_price_sen: 25000,
        old_snapshot: { item_code: 'SVC-DELIVERY', qty: 1, unit_price_sen: 25000, discountSen: 1500 },
      }],
    });
    expect(out.changes.map((r) => r.field)).not.toContain('Discount');
  });

  it('a zeroed discount prints as a clear, not as a blank cell', () => {
    const out = soAmendmentToPdfInput({
      ...base,
      lines: [{
        change_type: 'SPEC', new_item_code: 'SVC-DELIVERY', new_qty: 1,
        new_unit_price_sen: 25000, new_discount_sen: 0,
        old_snapshot: { item_code: 'SVC-DELIVERY', qty: 1, unit_price_sen: 25000, discountSen: 1500 },
      }],
    });
    const disc = out.changes.find((r) => r.field === 'Discount')!;
    expect(disc.before).toBe('RM 15.00');
    expect(disc.after).toBe('RM 0.00');
  });
});

/* THE PRINTED STATUS. `amendment-pdf.ts` draws `input.status` verbatim into the
   header's Status row, so what the mapper puts here is exactly what lands on
   paper. Until 2026-08-26 the four callers each hand-wrote
   `applied ? "Approved" : "Requested"` and a REJECTED amendment therefore
   printed **Requested** — the word that says nobody has decided yet — on a
   document handed to a supplier or filed as the decision record. */
describe('the amendment document prints the status the amendment lists show', () => {
  const so = (status: string) => soAmendmentToPdfInput({
    amendment: { amendment_no: 'SO-1/A1', status, created_at: '2026-08-20' },
    lines: [], salesOrder: { doc_no: 'SO-1', revision: 1 },
  }).status;
  const po = (status: string) => poAmendmentToPdfInput({
    amendment: { amendment_no: 'PO-1/A1', status, created_at: '2026-08-20' },
    lines: [], purchaseOrder: { po_number: 'PO-1', revision: 1 },
  }).status;

  it('a REJECTED amendment prints Rejected, on both kinds', () => {
    expect(so('REJECTED')).toBe('Rejected');
    expect(po('REJECTED')).toBe('Rejected');
  });

  it('every other state keeps the collapse the amendment lists use', () => {
    for (const [stored, word] of [
      ['REQUESTED', 'Requested'],
      ['SUPPLIER_PENDING', 'Requested'],
      ['SO_APPROVED', 'Approved'],
      ['PO_APPROVED', 'Approved'],
      ['SENT', 'Approved'],
    ] as Array<[string, string]>) {
      expect(so(stored), stored).toBe(word);
    }
    expect(po('REQUESTED')).toBe('Requested');
    expect(po('APPROVED')).toBe('Approved');
  });

  /* No caller may hand the document its own word again: the input shape no
     longer carries one, so this is the compiler's job, and the assertion here
     is that the mapper does NOT read one off the detail object. */
  it('ignores a status word supplied by the caller', () => {
    const withLegacyWord = {
      amendment: { amendment_no: 'SO-1/A1', status: 'REJECTED', created_at: '2026-08-20' },
      lines: [], salesOrder: { doc_no: 'SO-1', revision: 1 },
      statusLabel: 'Approved',
    };
    expect(soAmendmentToPdfInput(withLegacyWord).status).toBe('Rejected');
  });
});

/* THE PREVIEW AND THE DOCUMENT MUST NOT DISAGREE. `PrintPreviewModal` shows a
   Status row on the screen the operator presses Print from, and all four
   amendment surfaces hand-wrote the SAME `applied ? "Approved" : "Requested"`
   there too — so fixing only the PDF would have made the preview say Requested
   over a document saying Rejected, which is this whole class again one screen
   later. Both now call amendmentPrintedStatus.

   A source scan, because the four surfaces are page components in the suite
   that cannot render on this machine, and because it covers a FIFTH surface
   nobody has written yet. */
describe('no amendment surface hand-writes the printed status', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const SURFACES = [
    'pages/scm-v2/AmendmentDetailV2.tsx',
    'pages/scm-v2/PoAmendmentDetailV2.tsx',
    'mobile/MobileSODetail.tsx',
    'mobile/MobilePoAmendmentDetail.tsx',
  ];
  /* `? "Approved" : "Requested"`, however the ternary is spaced or wrapped. */
  const HAND_WRITTEN = /\?\s*"Approved"\s*:\s*"Requested"/s;

  it('the matcher fires on the expression this change removed', () => {
    for (const line of [
      '      statusLabel: soApplied ? "Approved" : "Requested",',
      '          { label: "Status", value: applied ? "Approved" : "Requested" },',
      '{ label: "Status", value: status === "APPROVED"\n ? "Approved"\n : "Requested" },',
    ]) {
      expect(HAND_WRITTEN.test(line), line).toBe(true);
    }
    expect(HAND_WRITTEN.test('value: amendmentPrintedStatus(status)')).toBe(false);
  });

  it('every amendment surface is clean', () => {
    for (const f of SURFACES) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src.length).toBeGreaterThan(1000);
      expect(HAND_WRITTEN.test(src), `${f} hand-writes the amendment status — use amendmentPrintedStatus`).toBe(false);
    }
  });
});
