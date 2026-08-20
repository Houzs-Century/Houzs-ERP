/* A Purchase Invoice whose every line is RM 0.00 is a LEGAL SHAPE, and the
   create must answer 201 for it.
 *
 * The owner's rule, 2026-08-19: "GRN 可以 save with zero cost… 我的 SO、DO 等等
 * 全部都可以的啊". Houzs suppliers do not price a purchase order — the price
 * appears on the supplier's goods-received document — and an all-FOC sales
 * order carries RM 0.00 the whole way down, so PO -> GRN -> PI at zero is the
 * ordinary shape of a free-of-charge chain, not a broken one.
 *
 * WHY THIS FILE EXISTS AS EVIDENCE AND NOT ONLY AS A GUARD. When
 * `POST /api/scm/purchase-invoices` answered 500 on production the first
 * hypothesis was arithmetic: a zero subtotal reaching a division, a `toFixed`
 * on undefined, an empty-array reduce, or the freight allocation splitting a
 * pool across a zero basis. This drives the real handler on exactly that
 * document — three sofa modules off HC-PO-2608-002's receipt, every line at
 * unit price 0, charge allocation "By quantity", MYR — and it is 201. The
 * arithmetic is guarded where it is done, and says so: landed-allocation.ts
 * declares the NO-OP GUARANTEE (pool 0 => allocated 0 everywhere) and the
 * DIVIDE-BY-ZERO GUARD (Sigma basis 0 => fall back to QTY, then to no
 * allocation at all), and recost.ts treats 0 as "no price known" rather than
 * dividing by it. So a zero-priced invoice is not the crash, and a future
 * change that makes it one fails here.
 *
 * The 500 the owner actually met is the idempotency dead end — the FIRST
 * refusal frozen against the page's one key and replayed forever. That is
 * reproduced in tests/purchaseInvoiceCreateRefusalDeadEnd.test.ts. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_invoices: [],
  purchase_invoice_items: [],
  grns: [{
    id: 'grn-1', grn_number: 'HC-GRN-2608-002', company_id: 1,
    purchase_order_id: 'po-1', supplier_id: 'sup-1', currency: 'MYR',
    exchange_rate: 1, migrated_no_stock: false, status: 'POSTED',
  }],
  /* The three modules one sofa decomposes into. The item code alone does not
     identify what was received, which is why the lines carry variants. */
  grn_items: [
    { id: 'gi-1', grn_id: 'grn-1', item_code: '9028-1A(LHF)', material_kind: 'mfg_product', material_name: 'Sofa module', qty_accepted: 1, invoiced_qty: 0, returned_qty: 0, unit_price_sen: 0, allocated_charge_sen: 0, company_id: 1 },
    { id: 'gi-2', grn_id: 'grn-1', item_code: '9028-1A(RHF)', material_kind: 'mfg_product', material_name: 'Sofa module', qty_accepted: 1, invoiced_qty: 0, returned_qty: 0, unit_price_sen: 0, allocated_charge_sen: 0, company_id: 1 },
    { id: 'gi-3', grn_id: 'grn-1', item_code: '9028-1NA', material_kind: 'mfg_product', material_name: 'Sofa module', qty_accepted: 1, invoiced_qty: 0, returned_qty: 0, unit_price_sen: 0, allocated_charge_sen: 0, company_id: 1 },
  ],
  purchase_orders: [{ id: 'po-1', po_number: 'HC-PO-2608-002', company_id: 1 }],
  suppliers: [{ id: 'sup-1', name: 'S', company_id: 1 }],
  mfg_products: [], currencies: [], app_config: [], autocount_outbox: [],
  entity_audit_log: [], inventory_lots: [], inventory_movements: [],
  inventory_lot_consumptions: [], companies: [{ id: 1, code: 'HOUZS' }],
});

/* supabaseAuth replaces whatever the caller set with the service client, so the
   fake has to be injected at that seam rather than through the context. */
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

/* A Houzs integer id: supabaseAuth translates it and pins `user` to the system
   scm.staff uuid. Seeding the PINNED uuid instead makes the middleware take its
   once-per-request early return, so `supabase` is never set and every case
   fails on a TypeError that has nothing to do with the rule under test. */
const CALLER = {
  id: 7, email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { purchaseInvoices } = await import('./purchase-invoices');

async function post(body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('companyCode', 'HOUZS');
    await next();
  });
  app.route('/', purchaseInvoices);
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const line = (grnItemId: string, itemCode: string) => ({
  grnItemId, materialKind: 'mfg_product', itemCode, materialName: itemCode,
  qty: 1, unitPriceSen: 0, itemGroup: 'sofa',
  variants: { fabric_code: 'F1', seat_height: '18"', leg_height: '4"' },
});

const items = (): Row[] => sb.tables.purchase_invoice_items;

describe('POST /purchase-invoices — every line at RM 0.00', () => {
  it('saves, and the zero survives onto the lines and the header', async () => {
    const res = await post({
      supplierId: 'sup-1', purchaseOrderId: 'po-1', grnId: 'grn-1',
      invoiceDate: '2026-08-19', currency: 'MYR', exchangeRate: 1,
      /* The header's own "Charge allocation" control, at its default. A zero
         subtotal is the basis the freight split would divide by. */
      allocationMethod: 'QTY', asDraft: false,
      items: [line('gi-1', '9028-1A(LHF)'), line('gi-2', '9028-1A(RHF)'), line('gi-3', '9028-1NA')],
    });

    expect(res.status).toBe(201);
    const header = sb.tables.purchase_invoices[0]!;
    /* INTEGER SEN, and the zero is a value rather than an absence — a document
       total that came back as a catalogue price would be the RM-0 defect this
       tree has already fixed twice on the sales side (#2470, #2474). */
    expect(header.subtotal_sen).toBe(0);
    expect(header.total_sen).toBe(0);
    expect(items()).toHaveLength(3);
    for (const it of items()) {
      expect(it.unit_price_sen).toBe(0);
      expect(it.line_total_sen).toBe(0);
      /* No freight line, so nothing to allocate — and nothing allocated. The
         column stays untouched rather than being written a NaN. */
      expect(it.allocated_charge_sen ?? 0).toBe(0);
    }
  });

  /* The receipt line has to stop showing as outstanding, at zero price as at
     any other — otherwise the same modules can be billed a second time. */
  it('consumes the receipt lines it billed', async () => {
    for (const g of sb.tables.grn_items) g.invoiced_qty = 0;
    sb.tables.purchase_invoices.length = 0;
    sb.tables.purchase_invoice_items.length = 0;

    await post({
      supplierId: 'sup-1', grnId: 'grn-1', invoiceDate: '2026-08-19',
      currency: 'MYR', exchangeRate: 1, allocationMethod: 'QTY',
      items: [line('gi-1', '9028-1A(LHF)')],
    });

    expect(sb.tables.grn_items.find((g) => g.id === 'gi-1')!.invoiced_qty).toBe(1);
    expect(sb.tables.grn_items.find((g) => g.id === 'gi-2')!.invoiced_qty).toBe(0);
  });
});
