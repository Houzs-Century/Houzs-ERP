import { beforeEach, describe, expect, test } from 'vitest';
import { enqueuePoCreate } from './autocount-outbox';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { fakeSb, type Row } from './fake-postgrest';

/* WHICH QUANTITY GOES WITH WHICH SOURCE LINE on a /so-to-po — 2026-09-14.
 *
 * composeSoToPo zips `shape.dtlKeys` with the composed details BY INDEX, and the
 * host applies each Detail's Qty / UnitPrice / Location / DeliveryDate to the
 * purchase line it transferred from THAT Detail's DtlKey (AcSyncService.cs
 * SoToPo phase two, `qtyByKey` and `EditDetail(newKeyBySourceKey[srcKey])`).
 * The details are read in (created_at, id) order; the keys came from
 * readPoTransferFacts, which read the purchase lines with NO order at all.
 *
 * Production (probe run 34826755295) — HC-PO-2609-032 sent
 *   Details [{DtlKey 345768, Qty 2}, {DtlKey 345765, Qty 1}, {DtlKey 345764, Qty 1}]
 * where 345768 is the CROWN (SS+S) sales line (qty 1) and 345764 is STAR-(SS)
 * (qty 2): the purchase order in the book was told CROWN x2 and STAR (SS) x1,
 * each at the other's cost. HC-PO-2609-010, -068 and -086 carry the same reversal.
 *
 * The fixture inserts the purchase lines in the REVERSE of their (created_at, id)
 * order — which is exactly the order the unordered read came back in on
 * production — so an unordered read and an ordered one disagree.
 */
const LINES: Row[] = [
  { id: 'pl-1', so: 'so-a', key: 345764, code: 'STAR-(SS)', qty: 2, price: 50_000 },
  { id: 'pl-2', so: 'so-b', key: 345765, code: 'STAR-(K)', qty: 1, price: 60_000 },
  { id: 'pl-3', so: 'so-c', key: 345768, code: 'CROWN (SS+S)', qty: 1, price: 70_000 },
];

const seeded = () => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: 'all' }],
  autocount_outbox: [],
  suppliers: [{ id: 'sup-nb', code: '400-N002', name: 'NB FURNITURE (M) SDN BHD', company_id: 1 }],
  warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL Warehouse' }],
  purchase_orders: [{
    id: 'po-032', po_number: 'HC-PO-2609-032', po_date: '2026-09-09', supplier_id: 'sup-nb',
    notes: null, purchase_location_id: 'wh-kl', company_id: 1, linked_ac_docno: null,
  }],
  mfg_sales_orders: [{ doc_no: 'HC-SO-004928', company_id: 1, linked_ac_docno: 'SO-004928' }],
  mfg_sales_order_items: LINES.map((l) => ({
    id: l.so, doc_no: 'HC-SO-004928', item_code: l.code, linked_ac_dtlkey: l.key,
  })),
  purchase_order_item_allocations: [],
  supplier_material_bindings: [],
  purchase_order_items: [...LINES].reverse().map((l) => ({
    id: l.id, purchase_order_id: 'po-032', so_item_id: l.so, item_code: l.code, item_group: 'bedframe',
    description: l.code, description2: null, qty: l.qty, unit_price_sen: l.price, variants: null,
    linked_ac_dtlkey: null, warehouse_id: 'wh-kl', delivery_date: '2026-09-30', photo_urls: [],
    created_at: '2026-09-09T06:54:37.363668+00:00',
  })),
});

beforeEach(() => resetWritebackFlagCache());

describe('/so-to-po pairs every source key with ITS OWN line', () => {
  test('Details[i].DtlKey is the sales key of the line whose Qty and UnitPrice Details[i] carries', async () => {
    const sb = seeded();
    const out = await enqueuePoCreate(sb as never, { companyId: 1, poId: 'po-032' });
    expect(out.queued).toBe(true);
    const row = sb.tables.autocount_outbox[0];
    expect(row.op, 'the fixture must take the TRANSFER arm').toBe('so_to_po');
    const payload = row.payload as { body: { DtlKeys: number[]; Details: Array<{ DtlKey: number; Qty: number; UnitPrice: number }> }; lineWriteback: { ids: string[][] } };
    const byKey = new Map(LINES.map((l) => [l.key, l]));
    for (const d of payload.body.Details) {
      const line = byKey.get(d.DtlKey)!;
      expect({ key: d.DtlKey, qty: d.Qty, price: d.UnitPrice }).toEqual({ key: line.key, qty: line.qty, price: line.price / 100 });
    }
    /* And the key store's ids answer to the same order the keys were sent in. */
    const byId = new Map(LINES.map((l) => [l.id, l]));
    expect(payload.lineWriteback.ids.map((g) => byId.get(g[0])!.key)).toEqual(payload.body.DtlKeys);
  });
});
