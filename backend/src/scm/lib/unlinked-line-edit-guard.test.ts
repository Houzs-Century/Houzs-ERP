
import { describe, it, expect } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { unlinkedEditRefusal, doPendingItemCodesOf } from './unlinked-line-edit-guard';
import grnsSrc from '../routes/grns.ts?raw';
import purchaseReturnsSrc from '../routes/purchase-returns.ts?raw';
import deliveryReturnsSrc from '../routes/delivery-returns.ts?raw';
import salesInvoicesSrc from '../routes/sales-invoices.ts?raw';
import consignmentReturnsSrc from '../routes/consignment-returns.ts?raw';
import purchaseConsignmentReturnsSrc from '../routes/purchase-consignment-returns.ts?raw';

const PO_ID = 'po-1';
const GRN_ID = 'grn-1';
const DO_ID = 'do-1';
const CN_ID = 'cn-1';
const PCR_ID = 'pcr-1';

const poWith = (materials: string[]) =>
  fakeSb({
    purchase_order_items: materials.map((m, i) => ({
      id: `poi-${i}`, purchase_order_id: PO_ID, item_code: m,
    })),
  });

const grnWith = (materials: string[]) =>
  fakeSb({
    grn_items: materials.map((m, i) => ({
      id: `gi-${i}`, grn_id: GRN_ID, item_code: m,
    })),
  });

const doWith = (items: string[]) =>
  fakeSb({
    delivery_order_items: items.map((m, i) => ({
      id: `doi-${i}`, delivery_order_id: DO_ID, item_code: m,
    })),
  });

const cnWith = (items: string[]) =>
  fakeSb({
    consignment_delivery_order_items: items.map((m, i) => ({
      id: `cdoi-${i}`, consignment_delivery_order_id: CN_ID, item_code: m,
    })),
  });

const pcrWith = (materials: string[]) =>
  fakeSb({
    purchase_consignment_receive_items: materials.map((m, i) => ({
      id: `pcri-${i}`, pc_receive_id: PCR_ID, item_code: m,
    })),
  });

const doPendingWith = (items: Array<{ code: string; qty: number; invoiced?: number }>) =>
  fakeSb({
    delivery_orders: [{ id: DO_ID, do_number: 'DO-1', status: 'DISPATCHED', debtor_code: 'C1', debtor_name: 'C' }],
    delivery_order_items: items.map((m, i) => ({
      id: `doi-${i}`, delivery_order_id: DO_ID, item_code: m.code, qty: m.qty,
    })),
    sales_invoices: items.map((_, i) => ({ id: `si-${i}`, status: 'DRAFT' })),
    sales_invoice_items: items.flatMap((m, i) => (m.invoiced
      ? [{ id: `sii-${i}`, sales_invoice_id: `si-${i}`, do_item_id: `doi-${i}`, qty: m.invoiced }]
      : [])),
    delivery_returns: [],
    delivery_return_items: [],
  });


describe('unlinkedEditRefusal — the re-point exploit', () => {
  it('REFUSES re-pointing an unlinked GRN line at one of the PO\'s own materials', async () => {
    const out = await unlinkedEditRefusal(poWith(['FOAM-40D']), 'grn', {
      parentId: PO_ID,
      storedLink: null,
      storedCode: 'SAMPLE-SWATCH',
      patchCode: 'FOAM-40D',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
    expect(out?.message).toContain('FOAM-40D');
    expect(out?.message).toContain('Purchase Order');
  });

  it('REFUSES re-pointing an unlinked purchase-return line at the GRN\'s own material', async () => {
    const out = await unlinkedEditRefusal(grnWith(['FOAM-40D']), 'purchase-return', {
      parentId: GRN_ID,
      storedLink: null,
      storedCode: 'GOODWILL-ITEM',
      patchCode: 'FOAM-40D',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
    expect(out?.message).toContain('Goods Receipt');
  });

  it('REFUSES re-pointing an unlinked delivery-return line at the DO\'s own item', async () => {
    const out = await unlinkedEditRefusal(doWith(['NTYR-PILLOW']), 'delivery-return', {
      parentId: DO_ID,
      storedLink: null,
      storedCode: 'SPARE-LEG',
      patchCode: 'NTYR-PILLOW',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
    expect(out?.message).toContain('Delivery Order');
  });

  it('REFUSES re-pointing an unlinked SI line at a STILL-PENDING DO item', async () => {
    const out = await unlinkedEditRefusal(
      doPendingWith([{ code: 'NTYR-PILLOW', qty: 10 }]), 'sales-invoice',
      { parentId: DO_ID, storedLink: null, storedCode: 'CONSULT-FEE', patchCode: 'NTYR-PILLOW' },
    );
    expect(out?.error).toBe('unlinked_line_repoint');
  });

  it('REFUSES re-pointing an unlinked consignment-return line at the Note\'s own item', async () => {
    const out = await unlinkedEditRefusal(cnWith(['NTYR-PILLOW']), 'consignment-return', {
      parentId: CN_ID,
      storedLink: null,
      storedCode: 'SPARE-LEG',
      patchCode: 'NTYR-PILLOW',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
    expect(out?.message).toContain('Consignment Note');
  });

  it('REFUSES re-pointing an unlinked purchase-consignment-return line at the PC Receive\'s own material', async () => {
    const out = await unlinkedEditRefusal(pcrWith(['FOAM-40D']), 'purchase-consignment-return', {
      parentId: PCR_ID,
      storedLink: null,
      storedCode: 'GOODWILL-ITEM',
      patchCode: 'FOAM-40D',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
    expect(out?.message).toContain('PC Receive');
  });

  it('resolves the parent Note from the return header, not a passed parentId', async () => {
    const withHeader = fakeSb({
      consignment_delivery_returns: [{ id: 'cr-1', consignment_do_id: CN_ID, company_id: 7 }],
      consignment_delivery_order_items: [{ id: 'cdoi-0', consignment_delivery_order_id: CN_ID, item_code: 'NTYR-PILLOW' }],
    });
    const out = await unlinkedEditRefusal(withHeader, 'consignment-return', {
      parent: { table: 'consignment_delivery_returns', column: 'consignment_do_id', id: 'cr-1', companyId: 7 },
      storedLink: null, storedCode: 'SPARE-LEG', patchCode: 'NTYR-PILLOW',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
  });

  it('resolves the parent PC Receive from the return header', async () => {
    const sb = fakeSb({
      purchase_consignment_returns: [{ id: 'pr-1', pc_receive_id: PCR_ID, company_id: 7 }],
      purchase_consignment_receive_items: [{ id: 'pcri-0', pc_receive_id: PCR_ID, item_code: 'FOAM-40D' }],
    });
    const out = await unlinkedEditRefusal(sb, 'purchase-consignment-return', {
      parent: { table: 'purchase_consignment_returns', column: 'pc_receive_id', id: 'pr-1', companyId: 7 },
      storedLink: null, storedCode: 'GOODWILL-ITEM', patchCode: 'FOAM-40D',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
  });

  it('matches across case and whitespace on EITHER side', async () => {
    const out = await unlinkedEditRefusal(poWith([' foam-40d ']), 'grn', {
      parentId: PO_ID, storedLink: null, storedCode: 'SAMPLE', patchCode: '  FOAM-40D ',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
  });
});


describe('unlinkedEditRefusal — what must still pass', () => {
  it('ALLOWS a service / freight / ad-hoc line whose code is on NO parent', async () => {
    for (const chain of ['grn', 'purchase-return'] as const) {
      const sb = chain === 'grn' ? poWith(['FOAM-40D']) : grnWith(['FOAM-40D']);
      const out = await unlinkedEditRefusal(sb, chain, {
        parentId: chain === 'grn' ? PO_ID : GRN_ID,
        storedLink: null, storedCode: 'FREIGHT', patchCode: 'INSTALL-FEE',
      });
      expect(out).toBeNull();
    }
  });

  it('ALLOWS a line whose stored link is NOT NULL — its cap and recount govern it', async () => {
    const out = await unlinkedEditRefusal(poWith(['FOAM-40D']), 'grn', {
      parentId: PO_ID, storedLink: 'poi-0', storedCode: 'FOAM-40D', patchCode: 'FOAM-40D',
    });
    expect(out).toBeNull();
  });

  it('ALLOWS a genuinely ad-hoc code on the two consignment-return chains', async () => {
    const cn = await unlinkedEditRefusal(cnWith(['NTYR-PILLOW']), 'consignment-return', {
      parentId: CN_ID, storedLink: null, storedCode: 'SPARE-LEG', patchCode: 'GOODWILL-CUSHION',
    });
    expect(cn).toBeNull();
    const pcr = await unlinkedEditRefusal(pcrWith(['FOAM-40D']), 'purchase-consignment-return', {
      parentId: PCR_ID, storedLink: null, storedCode: 'FREIGHT', patchCode: 'INSTALL-FEE',
    });
    expect(pcr).toBeNull();
  });

  it('ALLOWS a LINKED consignment-return line editing its own qty (code echoed back)', async () => {
    const cn = await unlinkedEditRefusal(cnWith(['NTYR-PILLOW']), 'consignment-return', {
      parentId: CN_ID, storedLink: 'cdoi-0', storedCode: 'NTYR-PILLOW', patchCode: 'NTYR-PILLOW',
    });
    expect(cn).toBeNull();
    const pcr = await unlinkedEditRefusal(pcrWith(['FOAM-40D']), 'purchase-consignment-return', {
      parentId: PCR_ID, storedLink: 'pcri-0', storedCode: 'FOAM-40D', patchCode: 'FOAM-40D',
    });
    expect(pcr).toBeNull();
  });

  it('ALLOWS a patch that does not touch the code — the effective-value trap', async () => {
    const out = await unlinkedEditRefusal(poWith(['FOAM-40D']), 'grn', {
      parentId: PO_ID, storedLink: null, storedCode: 'FOAM-40D', patchCode: undefined,
    });
    expect(out).toBeNull();
  });

  it('ALLOWS a client that echoes the SAME code back unchanged', async () => {
    const out = await unlinkedEditRefusal(poWith(['FOAM-40D']), 'grn', {
      parentId: PO_ID, storedLink: null, storedCode: 'FOAM-40D', patchCode: 'FOAM-40D',
    });
    expect(out).toBeNull();
  });

  it('ALLOWS an edit to a line that was ALREADY on the parent — blame the actor', async () => {
    const out = await unlinkedEditRefusal(poWith(['FOAM-40D', 'FABRIC-A']), 'grn', {
      parentId: PO_ID, storedLink: null, storedCode: 'FOAM-40D', patchCode: 'FABRIC-A',
    });
    expect(out).toBeNull();
  });

  it('ALLOWS everything when the document names no parent', async () => {
    for (const id of [null, undefined, '', '   ']) {
      const out = await unlinkedEditRefusal(poWith(['FOAM-40D']), 'grn', {
        parentId: id, storedLink: null, storedCode: 'SAMPLE', patchCode: 'FOAM-40D',
      });
      expect(out).toBeNull();
    }
  });

  it('ALLOWS an SI line shadowing a DO item that is ALREADY FULLY INVOICED', async () => {
    const out = await unlinkedEditRefusal(
      doPendingWith([{ code: 'NTYR-PILLOW', qty: 10, invoiced: 10 }]), 'sales-invoice',
      { parentId: DO_ID, storedLink: null, storedCode: 'CONSULT-FEE', patchCode: 'NTYR-PILLOW' },
    );
    expect(out).toBeNull();
  });

  it('does NOT behave like a boolean already-converted flag (owner ruling 1)', async () => {
    const sb = fakeSb({
      purchase_order_items: [{ id: 'poi-0', purchase_order_id: PO_ID, item_code: 'FOAM-40D', qty: 100, received_qty: 60 }],
    });
    const out = await unlinkedEditRefusal(sb, 'grn', {
      parentId: PO_ID, storedLink: 'poi-0', storedCode: 'FOAM-40D', patchCode: 'FOAM-40D',
    });
    expect(out).toBeNull();
  });
});


describe('unlinkedEditRefusal — a guard that cannot read the parent must refuse', () => {
  it('REFUSES when the parent read fails, rather than reading it as "nothing on the parent"', async () => {
    const sb = fakeSb(
      { purchase_order_items: [{ id: 'poi-0', purchase_order_id: PO_ID, item_code: 'FOAM-40D' }] },
      { purchase_order_items: ['item_code'] },
    );
    const out = await unlinkedEditRefusal(sb, 'grn', {
      parentId: PO_ID, storedLink: null, storedCode: 'SAMPLE', patchCode: 'FOAM-40D',
    });
    expect(out?.error).toBe('unlinked_check_failed');
    expect(out?.message).toContain('not');
  });

  it('reports the failure on the SI chain too', async () => {
    const sb = fakeSb(
      { delivery_order_items: [{ id: 'doi-0', delivery_order_id: DO_ID, item_code: 'X', qty: 1 }] },
      { delivery_order_items: ['item_code'] },
    );
    const out = await unlinkedEditRefusal(sb, 'sales-invoice', {
      parentId: DO_ID, storedLink: null, storedCode: 'SAMPLE', patchCode: 'X',
    });
    expect(out?.error).toBe('unlinked_check_failed');
  });

  it('REFUSES when the Consignment Note read fails (fail closed)', async () => {
    const sb = fakeSb(
      { consignment_delivery_order_items: [{ id: 'cdoi-0', consignment_delivery_order_id: CN_ID, item_code: 'NTYR-PILLOW' }] },
      { consignment_delivery_order_items: ['item_code'] },
    );
    const out = await unlinkedEditRefusal(sb, 'consignment-return', {
      parentId: CN_ID, storedLink: null, storedCode: 'SPARE-LEG', patchCode: 'NTYR-PILLOW',
    });
    expect(out?.error).toBe('unlinked_check_failed');
  });

  it('REFUSES when the PC Receive read fails (fail closed)', async () => {
    const sb = fakeSb(
      { purchase_consignment_receive_items: [{ id: 'pcri-0', pc_receive_id: PCR_ID, item_code: 'FOAM-40D' }] },
      { purchase_consignment_receive_items: ['item_code'] },
    );
    const out = await unlinkedEditRefusal(sb, 'purchase-consignment-return', {
      parentId: PCR_ID, storedLink: null, storedCode: 'GOODWILL-ITEM', patchCode: 'FOAM-40D',
    });
    expect(out?.error).toBe('unlinked_check_failed');
  });

  it('doPendingItemCodesOf reports a failed DO read instead of answering "none pending"', async () => {
    const sb = fakeSb(
      { delivery_order_items: [{ id: 'doi-0', delivery_order_id: DO_ID, item_code: 'X', qty: 1 }] },
      { delivery_order_items: ['item_code'] },
    );
    const out = await doPendingItemCodesOf(sb, DO_ID);
    expect(out.ok).toBe(false);
  });
});


function handlerSlice(src: string, label: string, startMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `handler start marker not found in ${label}: ${startMarker}`).toBeGreaterThan(-1);
  const rest = src.slice(start + startMarker.length);
  /* `\r?` is not decoration: this repo is developed on Windows, where the
     checkout is CRLF, so the LF-only form matched nothing and every
     assertion below died on "handler end not found". It failed LOUDLY
     rather than passing empty — but only on Windows, so CI stayed green
     while the local suite was unusable. Same family as #2062. */
  const end = rest.search(/\r?\n\}\)?;\r?\n/);
  expect(end, `handler end not found in ${label} for: ${startMarker}`).toBeGreaterThan(-1);
  const slice = rest.slice(0, end);
  expect(slice.trim().length, `empty handler slice in ${label}`).toBeGreaterThan(0);
  return slice;
}

describe('every line-edit handler in the family calls the guard', () => {
  const HANDLERS: Array<[string, string, string]> = [
    ['GRN line PATCH', 'grns.ts', "grns.patch('/:id/items/:itemId'"],
    ['purchase-return line PATCH', 'purchase-returns.ts', 'export const patchPurchaseReturnItemHandler'],
    ['delivery-return line PATCH', 'delivery-returns.ts', "deliveryReturns.patch('/:id/items/:itemId'"],
    ['sales-invoice line PATCH', 'sales-invoices.ts', "salesInvoices.patch('/:id/items/:itemId'"],
    ['consignment-return line PATCH', 'consignment-returns.ts', "consignmentReturns.patch('/:id/items/:itemId'"],
    ['purchase-consignment-return line PATCH', 'purchase-consignment-returns.ts', "purchaseConsignmentReturns.patch('/:id/items/:itemId'"],
  ];
  const SRC: Record<string, string> = {
    'grns.ts': grnsSrc,
    'purchase-returns.ts': purchaseReturnsSrc,
    'delivery-returns.ts': deliveryReturnsSrc,
    'sales-invoices.ts': salesInvoicesSrc,
    'consignment-returns.ts': consignmentReturnsSrc,
    'purchase-consignment-returns.ts': purchaseConsignmentReturnsSrc,
  };

  for (const [name, file, marker] of HANDLERS) {
    it(`${name} calls unlinkedEditRefusal`, () => {
      expect(handlerSlice(SRC[file], file, marker)).toContain('unlinkedEditRefusal');
    });
  }

  it('the purchase-return ADD-LINE path calls the insert guard', () => {
    expect(handlerSlice(purchaseReturnsSrc, 'purchase-returns.ts', 'export const addPurchaseReturnItemHandler'))
      .toContain('findUnlinkedPrLines');
  });
});
