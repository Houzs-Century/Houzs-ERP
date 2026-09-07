/* The invoice-chain half of the key-without-identity guard.
 *
 * Two chains take the source line id from the CLIENT and never compare the
 * item: `sales_invoice_items.do_item_id` and
 * `purchase_invoice_items.grn_item_id` (docs/bugs/0672 site 15). What that
 * permits was then measured in production, 2026-09-07 23:37 local, run
 * 34139187692: 2 wrong of 182 linked sales-invoice lines, 3 wrong of 198
 * linked purchase-invoice lines. docs/bugs/0676.
 *
 * These assertions are BEHAVIOURAL — they call the rule. The companion
 * assertions that the rule is APPLIED AT EVERY CALL SITE are structural and
 * live in invoiceSourceGuardCallSites.test.mjs, because a call-site population
 * is exactly what a unit test cannot see (docs/bugs/0099).
 */
import { describe, it, expect } from 'vitest';
import {
  invoiceSourceItemMismatch,
  checkInvoiceSourceItemIdentity,
} from '../src/scm/lib/invoice-source-item-identity';

const DO_LINE = { id: 'do-line-1', item_code: 'REGAL-KING' };
const GR_LINE = { id: 'gr-line-1', item_code: 'TRION-QUEEN' };

describe('invoiceSourceItemMismatch — the pure rule', () => {
  it('passes a line that names the delivery line it was raised from', () => {
    expect(invoiceSourceItemMismatch('DO',
      [{ sourceItemId: 'do-line-1', itemCode: 'REGAL-KING' }], [DO_LINE])).toBeNull();
  });

  it('refuses a sales-invoice line billing a product the delivery line is not', () => {
    const m = invoiceSourceItemMismatch('DO',
      [{ sourceItemId: 'do-line-1', itemCode: 'TRION-QUEEN' }], [DO_LINE]);
    expect(m?.error).toBe('source_link_material_mismatch');
    expect(m?.sourceItemCode).toBe('REGAL-KING');
    expect(m?.itemCode).toBe('TRION-QUEEN');
    expect(m?.reason).toContain('Delivery Order line');
  });

  it('refuses a purchase-invoice line billing a product the receipt line is not', () => {
    const m = invoiceSourceItemMismatch('GR',
      [{ sourceItemId: 'gr-line-1', itemCode: 'REGAL-KING' }], [GR_LINE]);
    expect(m?.error).toBe('source_link_material_mismatch');
    expect(m?.reason).toContain('Goods Receipt line');
  });

  /* The owner's rule: an invoice MAY carry a direct/standalone line, and mig
     0303 says the nullable column is deliberate. A line with no source is not
     this guard's business and must not be refused. */
  it('ignores a line with no source — a direct line is legitimate', () => {
    expect(invoiceSourceItemMismatch('DO', [
      { sourceItemId: null, itemCode: 'ANYTHING' },
      { sourceItemId: undefined, itemCode: 'ANYTHING ELSE' },
    ], [])).toBeNull();
  });

  /* Trim / case / inner whitespace only. Anything looser hides a real
     mismatch; anything stricter reports formatting as a wrong product. */
  it('reads a code the way a person does, not byte for byte', () => {
    expect(invoiceSourceItemMismatch('DO',
      [{ sourceItemId: 'do-line-1', itemCode: '  regal-king ' }], [DO_LINE])).toBeNull();
    expect(invoiceSourceItemMismatch('DO',
      [{ sourceItemId: 'do-line-1', itemCode: 'REGAL-KING' }],
      [{ id: 'do-line-1', item_code: 'REGAL   KING' }])).not.toBeNull();
  });

  /* Skipping an unresolvable source is how a guard reports clean over a
     population it never saw — the signature false negative of this whole bug
     class. */
  it('refuses a source id that resolved to nothing, rather than skipping it', () => {
    const m = invoiceSourceItemMismatch('DO',
      [{ sourceItemId: 'not-there', itemCode: 'REGAL-KING' }], []);
    expect(m?.error).toBe('source_link_material_mismatch');
    expect(m?.sourceItemCode).toBeNull();
  });

  it('refuses a source line with no item code at all', () => {
    expect(invoiceSourceItemMismatch('DO',
      [{ sourceItemId: 'do-line-1', itemCode: '' }],
      [{ id: 'do-line-1', item_code: null }])).not.toBeNull();
  });

  it('reports the FIRST offender and names it, so the operator can act', () => {
    const m = invoiceSourceItemMismatch('DO', [
      { sourceItemId: 'do-line-1', itemCode: 'REGAL-KING' },
      { sourceItemId: 'do-line-2', itemCode: 'REGAL-KING' },
    ], [DO_LINE, { id: 'do-line-2', item_code: 'AMN-SOFA PILLOW' }]);
    expect(m?.sourceItemId).toBe('do-line-2');
    expect(m?.reason).toContain('AMN-SOFA PILLOW');
  });
});

/* A minimal stand-in for the PostgREST-shaped scm client. It records the scope
   it was given, because an unscoped read is how this guard would leak — and
   compare against — another company's rows. */
function fakeSb(rows: Array<{ id: string; item_code: string | null }>, opts: { error?: string } = {}) {
  const seen: Record<string, unknown> = {};
  const api = {
    seen,
    from(table: string) { seen.table = table; return api; },
    select(cols: string) { seen.select = cols; return api; },
    in(col: string, ids: string[]) { seen.inColumn = col; seen.ids = ids; return api; },
    eq(col: string, val: unknown) {
      seen.eqColumn = col; seen.eqValue = val;
      return Promise.resolve(opts.error ? { data: null, error: { message: opts.error } } : { data: rows, error: null });
    },
  };
  return api;
}

describe('checkInvoiceSourceItemIdentity — the guard, read included', () => {
  it('does nothing and takes no read when no line carries a source', async () => {
    const sb = fakeSb([]);
    expect(await checkInvoiceSourceItemIdentity(sb, 'DO',
      [{ sourceItemId: null, itemCode: 'X' }], 1)).toBeNull();
    expect(sb.seen.table).toBeUndefined();
  });

  it('reads the right table and SCOPES it to the company', async () => {
    const sb = fakeSb([DO_LINE]);
    await checkInvoiceSourceItemIdentity(sb, 'DO',
      [{ sourceItemId: 'do-line-1', itemCode: 'REGAL-KING' }], 7);
    expect(sb.seen.table).toBe('delivery_order_items');
    expect(sb.seen.eqColumn).toBe('company_id');
    expect(sb.seen.eqValue).toBe(7);
  });

  it('reads grn_items for the purchase chain', async () => {
    const sb = fakeSb([GR_LINE]);
    await checkInvoiceSourceItemIdentity(sb, 'GR',
      [{ sourceItemId: 'gr-line-1', itemCode: 'TRION-QUEEN' }], 1);
    expect(sb.seen.table).toBe('grn_items');
  });

  it('refuses a cross-product bind with 409', async () => {
    const r = await checkInvoiceSourceItemIdentity(fakeSb([DO_LINE]), 'DO',
      [{ sourceItemId: 'do-line-1', itemCode: 'TRION-QUEEN' }], 1);
    expect(r?.status).toBe(409);
  });

  /* A guard that answers "clean" when its read failed is the defect wearing the
     guard's clothes. checkSiReopenOverRemaining paid for this once already. */
  it('FAILS CLOSED — a failed read is a 503, never a pass', async () => {
    const r = await checkInvoiceSourceItemIdentity(fakeSb([], { error: 'connection reset' }), 'DO',
      [{ sourceItemId: 'do-line-1', itemCode: 'REGAL-KING' }], 1);
    expect(r?.status).toBe(503);
    expect((r?.body as { error: string }).error).toBe('source_identity_unavailable');
  });

  it('de-duplicates the ids it asks for', async () => {
    const sb = fakeSb([DO_LINE]);
    await checkInvoiceSourceItemIdentity(sb, 'DO', [
      { sourceItemId: 'do-line-1', itemCode: 'REGAL-KING' },
      { sourceItemId: 'do-line-1', itemCode: 'REGAL-KING' },
    ], 1);
    expect(sb.seen.ids).toEqual(['do-line-1']);
  });
});
