/* The invoice scanner's PO anchor must see EVERY PO a goods receipt took goods
 * from, not only the one on its header.
 *
 * A receipt can take lines from several POs (the add-PO picker,
 * `/from-po-items`); grns.purchase_order_id names only the first. The PO
 * fallback compared the scanned PO No against that header alone, so an invoice
 * for a later PO of the receipt was never anchored to it and the scan ended at
 * "could not tell which Goods Receipt". Same class as the Bill-a-GRN picker
 * (#5496): HC-GRN-2611-052's lines come from 12 POs, its header names one.
 *
 * Drives the real findAnchorGrns over lib/fake-postgrest.ts. */
import { describe, expect, it } from 'vitest';

import { fakeSb, type Row } from './fake-postgrest';
import { findAnchorGrns, matchAnchoredLines, reviewOfPiRead } from './pi-scan-run';
import type { PiScanExtract } from './pi-scan-extract';

const scan = (poNo: string | null, doNo: string | null = null) =>
  ({ poNo, doNo, supplierCode: null, supplierName: null, invoiceNumber: 'INV-1', invoiceDate: null, lines: [] }) as unknown as PiScanExtract;

function tables(extra: { grns?: Row[]; grn_items?: Row[]; purchase_order_items?: Row[]; purchase_orders?: Row[] } = {}) {
  return {
    grns: [
      { id: 'grn-52', grn_number: 'HC-GRN-2611-052', delivery_note_ref: 'DO-9', status: 'POSTED', on_hold: false,
        received_at: '2026-11-01', company_id: 1, supplier_id: 's1',
        purchase_order_id: 'po-125', purchase_order: { po_number: 'HC-PO-2610-125' } },
      { id: 'grn-other', grn_number: 'HC-GRN-2611-053', delivery_note_ref: 'DO-10', status: 'POSTED', on_hold: false,
        received_at: '2026-11-02', company_id: 1, supplier_id: 's1',
        purchase_order_id: 'po-300', purchase_order: { po_number: 'HC-PO-2610-300' } },
      ...(extra.grns ?? []),
    ],
    grn_items: [
      { id: 'gi-1', grn_id: 'grn-52', purchase_order_item_id: 'poi-125', company_id: 1 },
      { id: 'gi-2', grn_id: 'grn-52', purchase_order_item_id: 'poi-202', company_id: 1 },
      { id: 'gi-3', grn_id: 'grn-52', purchase_order_item_id: null, company_id: 1 },
      { id: 'gi-4', grn_id: 'grn-other', purchase_order_item_id: 'poi-300', company_id: 1 },
      ...(extra.grn_items ?? []),
    ],
    purchase_order_items: [
      { id: 'poi-125', purchase_order_id: 'po-125', company_id: 1 },
      { id: 'poi-202', purchase_order_id: 'po-202', company_id: 1 },
      { id: 'poi-300', purchase_order_id: 'po-300', company_id: 1 },
      ...(extra.purchase_order_items ?? []),
    ],
    purchase_orders: [
      { id: 'po-125', po_number: 'HC-PO-2610-125', company_id: 1 },
      { id: 'po-202', po_number: 'HC-PO-2610-202', company_id: 1 },
      { id: 'po-300', po_number: 'HC-PO-2610-300', company_id: 1 },
      ...(extra.purchase_orders ?? []),
    ],
  };
}

const anchorNumbers = async (sb: ReturnType<typeof fakeSb>, poNo: string | null, doNo: string | null = null, company = 1) =>
  (await findAnchorGrns(sb as never, scan(poNo, doNo), company)).map((g) => g.grn_number);

describe('findAnchorGrns — PO fallback reads the PO of each receipt line', () => {
  it('anchors a two-PO receipt by its header PO', async () => {
    expect(await anchorNumbers(fakeSb(tables()), 'HC-PO-2610-125')).toEqual(['HC-GRN-2611-052']);
  });

  it('anchors the same receipt by the PO of a later line, which its header does not name', async () => {
    expect(await anchorNumbers(fakeSb(tables()), 'HC-PO-2610-202')).toEqual(['HC-GRN-2611-052']);
  });

  it('keeps the supplier\'s bare-number spelling working on a line PO', async () => {
    expect(await anchorNumbers(fakeSb(tables()), '2610-202')).toEqual(['HC-GRN-2611-052']);
  });

  it('does not anchor a receipt by a PO none of its lines or its header carry', async () => {
    expect(await anchorNumbers(fakeSb(tables()), 'HC-PO-2610-999')).toEqual([]);
  });

  it('a DO No match still wins and the PO lines are not consulted', async () => {
    expect(await anchorNumbers(fakeSb(tables()), 'HC-PO-2610-202', 'DO-10')).toEqual(['HC-GRN-2611-053']);
  });

  it('does not read another company\'s PO as a line PO', async () => {
    const sb = fakeSb(tables({
      grn_items: [{ id: 'gi-5', grn_id: 'grn-52', purchase_order_item_id: 'poi-x', company_id: 1 }],
      purchase_order_items: [{ id: 'poi-x', purchase_order_id: 'po-x', company_id: 2 }],
      purchase_orders: [{ id: 'po-x', po_number: 'HC-PO-2610-777', company_id: 2 }],
    }));
    expect(await anchorNumbers(sb, 'HC-PO-2610-777')).toEqual([]);
  });

  it('a failed line-PO read anchors nothing rather than a header-only subset', async () => {
    const sb = fakeSb(tables(), { purchase_order_items: ['purchase_order_id'] });
    expect(await anchorNumbers(sb, 'HC-PO-2610-125')).toEqual([]);
  });
});

/* Owner 2026-11-10: once a multi-PO receipt is matched, the lines of the PO
 * printed on the invoice are offered to the item-code matcher first; only when
 * none of them matches does it fall back to every unbilled line of the receipt.
 * Same item code on two POs of one receipt must bill the printed PO's line. */
describe('matchAnchoredLines — the printed PO\'s lines first, then the whole receipt', () => {
  const line = (id: string, poi: string | null, item_code: string) => ({
    id, grn_id: 'grn-52', purchase_order_item_id: poi, company_id: 1, item_code,
    qty_accepted: 2, invoiced_qty: 0, returned_qty: 0, unit_price_sen: 10000,
  });
  const receipt = () => {
    const t = tables();
    t.grn_items = [line('gi-125', 'poi-125', 'MAT-Q'), line('gi-202', 'poi-202', 'MAT-Q'), line('gi-bed', 'poi-125', 'BED-K')];
    return fakeSb(t);
  };
  const invoice = (poNo: string | null, doNo: string | null, itemCode: string) =>
    ({ ...scan(poNo, doNo), lines: [{ itemCode, description: itemCode, qty: 2, unitPrice: 100, lineTotal: 200 }] }) as unknown as PiScanExtract;
  const run = async (parsed: PiScanExtract) => {
    const sb = receipt();
    const anchors = await findAnchorGrns(sb as never, parsed, 1);
    const { match, tier } = await matchAnchoredLines(sb as never, parsed, anchors, 1, new Map());
    return { billed: match.picks.map((p) => p.grnItemId), tier };
  };

  it('bills the printed PO\'s line when the same item code sits on two POs of one receipt', async () => {
    expect(await run(invoice('HC-PO-2610-202', null, 'MAT-Q'))).toEqual({ billed: ['gi-202'], tier: 'invoice_po' });
  });

  it('prefers the printed PO\'s line on a receipt anchored by its D.O. too', async () => {
    expect(await run(invoice('HC-PO-2610-202', 'DO-9', 'MAT-Q'))).toEqual({ billed: ['gi-202'], tier: 'invoice_po' });
  });

  it('falls back to the whole receipt when no line of the printed PO matches', async () => {
    expect(await run(invoice('HC-PO-2610-202', null, 'BED-K'))).toEqual({ billed: ['gi-bed'], tier: 'whole_receipt' });
  });

  it('an invoice with no PO matches exactly as before, over every unbilled line', async () => {
    expect(await run(invoice(null, 'DO-9', 'MAT-Q'))).toEqual({ billed: ['gi-125'], tier: null });
  });

  it('records the tier on the check-first copy for review staff', async () => {
    const { review } = await reviewOfPiRead(receipt() as never, 1, invoice('HC-PO-2610-202', null, 'MAT-Q'), null);
    expect(review.lineTier).toBe('invoice_po');
    expect(review.lines.map((l) => l.grnItemId)).toEqual(['gi-202']);
  });
});
