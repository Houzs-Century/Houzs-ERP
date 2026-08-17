// The edit-path half of the unlinked-line back door. Every case here asserts a
// DECISION (refuse / allow), and the exploit cases were each written FIRST and
// observed to fail against the unwired handlers before the call sites existed.
//
// The exploit these cover, in two saves:
//   1. add a line whose code is NOT on the parent the document names — allowed,
//      correctly, because that is the service / freight / ad-hoc carve-out;
//   2. PATCH that line's code to one that IS on the parent — which used to sail
//      through, because the stored link is still NULL and every cap and recount
//      on these chains is gated on that link being non-null.

import { describe, it, expect } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { unlinkedEditRefusal, doPendingItemCodesOf } from './unlinked-line-edit-guard';
/* Source text of each router, so the WIRING of the guard is asserted too — a
   guard nothing calls is the exact failure mode this whole unit is about, and
   it is the one thing a unit test of the rule cannot see. Same `?raw` idiom
   convert-ceilings.test.ts already uses for the PO router. */
import grnsSrc from '../routes/grns.ts?raw';
import purchaseReturnsSrc from '../routes/purchase-returns.ts?raw';
import deliveryReturnsSrc from '../routes/delivery-returns.ts?raw';
import salesInvoicesSrc from '../routes/sales-invoices.ts?raw';

const PO_ID = 'po-1';
const GRN_ID = 'grn-1';
const DO_ID = 'do-1';

/** A PO carrying the given materials — the GRN chain's parent. */
const poWith = (materials: string[]) =>
  fakeSb({
    purchase_order_items: materials.map((m, i) => ({
      id: `poi-${i}`, purchase_order_id: PO_ID, material_code: m,
    })),
  });

/** A GRN carrying the given materials — the purchase-return chain's parent. */
const grnWith = (materials: string[]) =>
  fakeSb({
    grn_items: materials.map((m, i) => ({
      id: `gi-${i}`, grn_id: GRN_ID, material_code: m,
    })),
  });

/** A DO carrying the given items — the delivery-return chain's parent. */
const doWith = (items: string[]) =>
  fakeSb({
    delivery_order_items: items.map((m, i) => ({
      id: `doi-${i}`, delivery_order_id: DO_ID, item_code: m,
    })),
  });

/** A DISPATCHED DO whose lines have `qty` delivered and nothing invoiced or
 *  returned — so every line is still Pending, the SI chain's shadow case. */
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

/* ── The exploit, per chain ──────────────────────────────────────────────── */

describe('unlinkedEditRefusal — the re-point exploit', () => {
  it('REFUSES re-pointing an unlinked GRN line at one of the PO\'s own materials', async () => {
    // Save 2 of the exploit. Without this the stock goes in a second time while
    // purchase_order_items.received_qty never moves, so the PO line still reads
    // fully outstanding and the same delivery is received again.
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
    // grn_items.returned_qty is only touched when grn_item_id is set, so the
    // receipt still reads fully un-returned and the goods go out twice.
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
    // The double-invoice: the customer is billed twice for goods delivered once.
    const out = await unlinkedEditRefusal(
      doPendingWith([{ code: 'NTYR-PILLOW', qty: 10 }]), 'sales-invoice',
      { parentId: DO_ID, storedLink: null, storedCode: 'CONSULT-FEE', patchCode: 'NTYR-PILLOW' },
    );
    expect(out?.error).toBe('unlinked_line_repoint');
  });

  it('matches across case and whitespace on EITHER side', async () => {
    // Both sides are hand-entered; a stored " foam-40d " that fails to match a
    // typed "FOAM-40D" would read as genuinely ad-hoc and let the edit through.
    const out = await unlinkedEditRefusal(poWith([' foam-40d ']), 'grn', {
      parentId: PO_ID, storedLink: null, storedCode: 'SAMPLE', patchCode: '  FOAM-40D ',
    });
    expect(out?.error).toBe('unlinked_line_repoint');
  });
});

/* ── The carve-outs that must survive ────────────────────────────────────── */

describe('unlinkedEditRefusal — what must still pass', () => {
  it('ALLOWS a service / freight / ad-hoc line whose code is on NO parent', async () => {
    // The whole reason the link column is nullable. A blanket "every line must
    // link" would break this, which is why the rule is narrow.
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

  it('ALLOWS a patch that does not touch the code — the effective-value trap', async () => {
    // A qty-only or price-only edit must not start refusing. `patchCode`
    // undefined means the field is absent from the body, which is NOT the same
    // as the caller clearing it.
    const out = await unlinkedEditRefusal(poWith(['FOAM-40D']), 'grn', {
      parentId: PO_ID, storedLink: null, storedCode: 'FOAM-40D', patchCode: undefined,
    });
    expect(out).toBeNull();
  });

  it('ALLOWS a client that echoes the SAME code back unchanged', async () => {
    // These detail screens seed each line draft off the GET payload and post the
    // whole line back on save, so an unchanged code arrives as a defined value.
    // Refusing it would 409 every save on an orphaned line.
    const out = await unlinkedEditRefusal(poWith(['FOAM-40D']), 'grn', {
      parentId: PO_ID, storedLink: null, storedCode: 'FOAM-40D', patchCode: 'FOAM-40D',
    });
    expect(out).toBeNull();
  });

  it('ALLOWS an edit to a line that was ALREADY on the parent — blame the actor', async () => {
    // Every link column is ON DELETE SET NULL, so deleting a parent line orphans
    // its children: this state arrives through no act of the operator's. The
    // guard fires on the TRANSITION, not on inherited state.
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
    // Owner's ruling: a Sales Invoice MAY carry direct/standalone lines, and a
    // DO line with remaining 0 is not a double-invoice vector.
    const out = await unlinkedEditRefusal(
      doPendingWith([{ code: 'NTYR-PILLOW', qty: 10, invoiced: 10 }]), 'sales-invoice',
      { parentId: DO_ID, storedLink: null, storedCode: 'CONSULT-FEE', patchCode: 'NTYR-PILLOW' },
    );
    expect(out).toBeNull();
  });

  it('does NOT behave like a boolean already-converted flag (owner ruling 1)', async () => {
    // This business batch-ships. A PO line already partly received still accepts
    // another receipt; nothing here counts conversions. A LINKED line on a PO
    // that has already been received twice is still allowed through.
    const sb = fakeSb({
      purchase_order_items: [{ id: 'poi-0', purchase_order_id: PO_ID, material_code: 'FOAM-40D', qty: 100, received_qty: 60 }],
    });
    const out = await unlinkedEditRefusal(sb, 'grn', {
      parentId: PO_ID, storedLink: 'poi-0', storedCode: 'FOAM-40D', patchCode: 'FOAM-40D',
    });
    expect(out).toBeNull();
  });
});

/* ── Fail closed ─────────────────────────────────────────────────────────── */

describe('unlinkedEditRefusal — a guard that cannot read the parent must refuse', () => {
  it('REFUSES when the parent read fails, rather than reading it as "nothing on the parent"', async () => {
    // This is the piLocked defect, and it was live in all four parent-set
    // readers: `const { data } = await …` turned a transient blip into an empty
    // set, an empty set into "no offenders", and "no offenders" into ALLOWED —
    // disabling the guard on exactly the write it exists to refuse.
    const sb = fakeSb(
      { purchase_order_items: [{ id: 'poi-0', purchase_order_id: PO_ID, material_code: 'FOAM-40D' }] },
      { purchase_order_items: ['material_code'] },
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

  it('doPendingItemCodesOf reports a failed DO read instead of answering "none pending"', async () => {
    const sb = fakeSb(
      { delivery_order_items: [{ id: 'doi-0', delivery_order_id: DO_ID, item_code: 'X', qty: 1 }] },
      { delivery_order_items: ['item_code'] },
    );
    const out = await doPendingItemCodesOf(sb, DO_ID);
    expect(out.ok).toBe(false);
  });
});

/* ── WIRING: the guard must actually be CALLED by each handler ───────────── */

/**
 * The source of ONE handler, sliced out of its router.
 *
 * This is the assertion that a unit test of the rule cannot make: the rule was
 * correct before this change too — it simply was not called. Slicing per handler
 * means an extraction that moves the call OUT of the handler fails here rather
 * than passing quietly, which is the failure mode this whole unit is about.
 *
 * A missing marker THROWS. If a route is renamed, this test must fail loudly
 * rather than silently assert against an empty string.
 */
function handlerSlice(src: string, label: string, startMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `handler start marker not found in ${label}: ${startMarker}`).toBeGreaterThan(-1);
  const rest = src.slice(start + startMarker.length);
  // To the handler's own closing `});` / `};` at column 0 — ONE handler's body.
  const end = rest.search(/\n\}\)?;\n/);
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
  ];
  const SRC: Record<string, string> = {
    'grns.ts': grnsSrc,
    'purchase-returns.ts': purchaseReturnsSrc,
    'delivery-returns.ts': deliveryReturnsSrc,
    'sales-invoices.ts': salesInvoicesSrc,
  };

  for (const [name, file, marker] of HANDLERS) {
    it(`${name} calls unlinkedEditRefusal`, () => {
      expect(handlerSlice(SRC[file], file, marker)).toContain('unlinkedEditRefusal');
    });
  }

  it('the purchase-return ADD-LINE path calls the insert guard', () => {
    // Found while verifying this unit: the other four chains guard their
    // add-a-line path, this one never did — so a PR line receiving the parent
    // GRN's own material could be added unlinked in ONE save, no edit needed.
    expect(handlerSlice(purchaseReturnsSrc, 'purchase-returns.ts', 'export const addPurchaseReturnItemHandler'))
      .toContain('findUnlinkedPrLines');
  });
});
