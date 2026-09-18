import { describe, it, expect } from 'vitest';
import { planInvoiceSnapshotRepair } from '../scripts/lib/invoice-snapshot-repair.mjs';

/* The four live rows, read off probe-invoice-link-facts run 34178911176
   (2026-09-08 10:08 local). Every one is a migrated invoice whose parent
   document holds exactly ONE line, and every one is the same sofa model with
   the invoice still on the pre-correction `-1S` placeholder. */
const live = (over = {}) => ({
  id: 'row-1', chain: 'PI', invoiceNo: 'HC-PI-007551', invoiceMigrated: true,
  lineCode: '9058-1S', parentCode: '9058-1A(LHF)',
  parentDocNo: 'HC-GR-005068', parentLineCount: 1,
  ...over,
});

describe('planInvoiceSnapshotRepair', () => {
  it('repairs the invoice side, never the parent — the parent is what the book and the correction agree on', () => {
    const { repair, refused } = planInvoiceSnapshotRepair([live()]);
    expect(refused).toEqual([]);
    expect(repair).toHaveLength(1);
    expect(repair[0]).toMatchObject({ id: 'row-1', from: '9058-1S', to: '9058-1A(LHF)', model: '9058' });
  });

  it('repairs all four of the live rows', () => {
    const rows = [
      live(),
      live({ id: 'r2', invoiceNo: 'HC-PI-007920', lineCode: '8030-1S', parentCode: '8030-1A(LHF)', parentDocNo: 'HC-GR-005277' }),
      live({ id: 'r3', chain: 'SI', invoiceNo: 'HC-I-000745', lineCode: '5526-1S', parentCode: '5526-L(LHF)', parentDocNo: 'HC-DO-000542' }),
      live({ id: 'r4', chain: 'SI', invoiceNo: 'HC-I-2412-0065', lineCode: '2379-1S', parentCode: '2379-2S', parentDocNo: 'HC-DO-002158' }),
    ];
    const { repair, refused } = planInvoiceSnapshotRepair(rows);
    expect(refused).toEqual([]);
    expect(repair.map((r) => r.to)).toEqual(['9058-1A(LHF)', '8030-1A(LHF)', '5526-L(LHF)', '2379-2S']);
  });

  /* THE ONE THAT MATTERS. A different MODEL is not a stale compartment — it is
     a link naming a product the document does not order, and rewriting the code
     would erase the evidence instead of repairing it. */
  it('REFUSES a different model, because that is a wrong LINK and not a stale compartment', () => {
    const { repair, refused } = planInvoiceSnapshotRepair([live({ parentCode: '9028-1A(LHF)' })]);
    expect(repair).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0].why).toMatch(/model/i);
  });

  it('REFUSES when the parent document has more than one line, because then the LINK could be the error', () => {
    const { repair, refused } = planInvoiceSnapshotRepair([live({ parentLineCount: 3 })]);
    expect(repair).toEqual([]);
    expect(refused[0].why).toMatch(/LINK itself could be the error/);
  });

  it('REFUSES an invoice that was typed rather than snapshotted', () => {
    const { repair, refused } = planInvoiceSnapshotRepair([live({ invoiceMigrated: false })]);
    expect(repair).toEqual([]);
    expect(refused[0].why).toMatch(/not created as a snapshot/);
  });

  it('REFUSES a code that is not a sofa compartment at all', () => {
    const { repair, refused } = planInvoiceSnapshotRepair([
      live({ lineCode: 'RC-COM', parentCode: 'RC-XYZ' }),
    ]);
    expect(repair).toEqual([]);
    expect(refused[0].why).toMatch(/not one sofa's two compartments/);
  });

  it('REFUSES a blank code on either side rather than writing over it', () => {
    expect(planInvoiceSnapshotRepair([live({ lineCode: '' })]).refused[0].why).toMatch(/no item code/);
    expect(planInvoiceSnapshotRepair([live({ parentCode: null })]).refused[0].why).toMatch(/no item code/);
  });

  it('treats a case-and-space difference as agreement, not as a repair', () => {
    const { repair, refused } = planInvoiceSnapshotRepair([
      live({ lineCode: ' 9058-1a(lhf) ', parentCode: '9058-1A(LHF)' }),
    ]);
    expect(repair).toEqual([]);
    expect(refused[0].why).toMatch(/already agree/);
  });

  it('never proposes a change to the parent, and never touches money or the link', () => {
    const { repair } = planInvoiceSnapshotRepair([live()]);
    const keys = Object.keys(repair[0]).sort();
    expect(keys).toEqual(['chain', 'from', 'id', 'invoiceNo', 'model', 'parentDocNo', 'to']);
  });
});
