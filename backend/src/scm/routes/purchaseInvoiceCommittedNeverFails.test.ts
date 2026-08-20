/* Once the invoice is committed, the answer is 201 — whatever happens after.
 *
 * The create's tail runs five side-effects, and every one of them promises in
 * its own docblock never to throw into its caller: recordPiCreate ("best-effort
 * by design"), recordParentlessCreate, reallocatePiCharges ("Best-effort
 * (audit-DLQ pattern)"), recomputeGrnInvoiced ("Best-effort, never throws"),
 * recostForPi ("never throws into the caller"). A promise kept by five
 * try/catch blocks is not the same fact as a guarantee: a TypeError raised
 * ABOVE a catch, a subrequest cap reached mid-cascade, or a client call that
 * rejects rather than resolving with an `error` all unwind past the lot of them
 * into app.onError, which answers 500 "Something went wrong. Please try again."
 *
 * WHY THAT 500 IS THE DANGEROUS ONE. The invoice, its lines, its audit row and
 * its AutoCount ledger row are already committed. The operator is told the save
 * failed and presses Save again — and this handler now RELEASES the idempotency
 * claim on its refusals, so the only thing that used to stand between that
 * second press and a second payable is gone on exactly the requests where the
 * first one really did commit. The release and the lie must not be able to
 * meet, which is why the two changes shipped together.
 *
 * recordPiCreate stands in for all five here. It is the FIRST thing the tail
 * calls, so a throw from it also proves that the four behind it are inside the
 * same guard; and mocking it is how a test reaches the failure mode the
 * try/catch blocks exist for, which by construction cannot be reached through
 * them. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_invoices: [],
  purchase_invoice_items: [],
  grns: [{
    id: 'grn-1', grn_number: 'HC-GRN-2608-002', company_id: 1,
    purchase_order_id: 'po-1', supplier_id: 'sup-1', currency: 'MYR',
    exchange_rate: 1, migrated_no_stock: false, status: 'POSTED',
  }],
  grn_items: [{
    id: 'gi-1', grn_id: 'grn-1', item_code: '9028-1NA', material_kind: 'mfg_product',
    material_name: 'Sofa module', qty_accepted: 1, invoiced_qty: 0, returned_qty: 0,
    unit_price_sen: 0, allocated_charge_sen: 0, company_id: 1,
  }],
  purchase_orders: [{ id: 'po-1', po_number: 'HC-PO-2608-002', company_id: 1 }],
  suppliers: [{ id: 'sup-1', name: 'S', company_id: 1 }],
  mfg_products: [], currencies: [], app_config: [], autocount_outbox: [],
  entity_audit_log: [], inventory_lots: [], inventory_movements: [],
  inventory_lot_consumptions: [], companies: [{ id: 1, code: 'HOUZS' }],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

/* The shape of the failure this guards: something above the audit writer's own
   catch. A TypeError, not a rejected query, because a rejected query is what
   the catch was written for and would prove nothing. */
vi.mock('../lib/pi-audit-trail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/pi-audit-trail')>()),
  recordPiCreate: async () => { throw new TypeError("Cannot read properties of undefined (reading 'id')"); },
}));

const CALLER = {
  id: 7, email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { purchaseInvoices } = await import('./purchase-invoices');

describe('a committed Purchase Invoice is never reported as a failure', () => {
  it('answers 201 when a post-commit side-effect throws, and the invoice stands', async () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('user', CALLER);
      c.set('companyId', 1);
      c.set('companyCode', 'HOUZS');
      await next();
    });
    app.route('/', purchaseInvoices);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        supplierId: 'sup-1', grnId: 'grn-1', invoiceDate: '2026-08-19',
        currency: 'MYR', exchangeRate: 1, allocationMethod: 'QTY',
        items: [{
          grnItemId: 'gi-1', materialKind: 'mfg_product', itemCode: '9028-1NA',
          materialName: 'Sofa module', qty: 1, unitPriceSen: 0, itemGroup: 'sofa',
        }],
      }),
    });

    expect(res.status).toBe(201);
    /* The two facts together are the point: the operator was told the truth AND
       the truth is that one invoice exists. */
    expect(await res.json()).toMatchObject({ invoiceNumber: expect.stringContaining('PI-') });
    expect(sb.tables.purchase_invoices).toHaveLength(1);
    expect(sb.tables.purchase_invoice_items).toHaveLength(1);
  });
});
