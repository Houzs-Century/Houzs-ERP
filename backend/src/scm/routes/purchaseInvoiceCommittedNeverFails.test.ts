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
    expect(await res.json()).toMatchObject({ invoiceNumber: expect.stringContaining('PI-') });
    expect(sb.tables.purchase_invoices).toHaveLength(1);
    expect(sb.tables.purchase_invoice_items).toHaveLength(1);
  });
});
