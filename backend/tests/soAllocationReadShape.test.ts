/* What ONE global stock-allocation sweep COSTS, asserted as round trips.
 *
 * The sweep is what a salesperson waits for on every SO create and every line
 * add / edit / delete (mfg-sales-orders.ts calls it inline at five sites). On
 * production, 2026-08-16, probe-so-save-cost measured it at 123 serial
 * Worker->PostgREST round trips — and 71 of those were ONE read fetching 83
 * rows, because its cost is set by the number of SO-line ids chunked 200 at a
 * time into a URL and not by the rows that exist.
 *
 * Two things have to be true after inverting those reads, and this file asserts
 * both, because either one alone is worthless:
 *
 *   1. the sweep makes FEWER round trips (the point), and specifically stops
 *      reading delivery_order_items / purchase_order_items by chunked id;
 *   2. it computes exactly the SAME allocation (the constraint). The fixture
 *      carries every case the inverted reads could have broken: a line already
 *      fully delivered, a DRAFT delivery order that must not count, a returned
 *      delivery that re-opens a line, a bound PO with stock received, a bound PO
 *      with nothing received, a cancelled SO line, and a DO line hanging off a
 *      CANCELLED sales order that must never be read at all.
 *
 * The fixture is 300 sales orders / 1,200 live lines on purpose: below
 * chunkIn's 200-id batch size the old shape and the new one cost the same and
 * the test could not tell them apart.
 */
import { describe, it, expect } from 'vitest';
import { recomputeSoStockAllocation } from '../src/scm/lib/so-stock-allocation';
import { makeFakePostgrest, type Relationship, type Row } from './fakePostgrest';

/* The foreign keys PostgREST resolves the embeds through. Both were confirmed
   present on production, exactly once each, by probe-so-sweep-inversion:
   delivery_order_items_so_item_id_mfg_sales_order_items_id_fk and
   purchase_order_items_so_item_id_mfg_sales_order_items_id_fk. */
const RELATIONSHIPS: Relationship[] = [
  { child: 'mfg_sales_order_items', childCol: 'doc_no', parent: 'mfg_sales_orders', parentCol: 'doc_no' },
  { child: 'delivery_order_items', childCol: 'so_item_id', parent: 'mfg_sales_order_items', parentCol: 'id' },
  { child: 'purchase_order_items', childCol: 'so_item_id', parent: 'mfg_sales_order_items', parentCol: 'id' },
];

const SO_COUNT = 300;
const docNo = (i: number) => `SO-${String(i).padStart(4, '0')}`;

function fixture() {
  const orders: Row[] = [];
  const lines: Row[] = [];
  for (let i = 0; i < SO_COUNT; i++) {
    orders.push({
      doc_no: docNo(i), status: 'CONFIRMED', created_at: '2026-08-01T00:00:00Z',
      customer_delivery_date: null, company_id: 1, proceeded_at: '2026-08-01T00:00:00Z',
      generation: 1,
    });
    for (const [suffix, code, group] of [
      ['mat', 'MAT', 'mattress'],
      ['bed', 'BED', 'bedframe'],
      ['sofa', 'SOFA1', 'sofa'],
      ['svc', 'DELIVERY', 'service'],
    ] as const) {
      lines.push({
        id: `${docNo(i)}-${suffix}`, doc_no: docNo(i), item_code: code, item_group: group,
        variants: null, qty: 1, warehouse_id: 'WH1', stock_status: 'PENDING',
        stock_qty_ready: 0, cancelled: false, allocated_batch_no: null,
      });
    }
  }
  /* A cancelled line: never allocated, never read by the inverted joins. */
  lines.push({
    id: 'SO-0000-dead', doc_no: docNo(0), item_code: 'MAT', item_group: 'mattress',
    variants: null, qty: 5, warehouse_id: 'WH1', stock_status: 'PENDING',
    stock_qty_ready: 0, cancelled: true, allocated_batch_no: null,
  });
  /* A CANCELLED sales order with a delivered line. The old read reached it only
     because its line id was never in the chunk list; the new read must exclude
     it through the embedded status filter instead. */
  orders.push({
    doc_no: 'SO-DEAD', status: 'CANCELLED', created_at: '2026-07-01T00:00:00Z',
    customer_delivery_date: null, company_id: 1, proceeded_at: '2026-07-01T00:00:00Z', generation: 1,
  });
  lines.push({
    id: 'SO-DEAD-mat', doc_no: 'SO-DEAD', item_code: 'MAT', item_group: 'mattress',
    variants: null, qty: 1, warehouse_id: 'WH1', stock_status: 'PENDING',
    stock_qty_ready: 0, cancelled: false, allocated_batch_no: null,
  });

  return {
    mfg_sales_orders: orders,
    mfg_sales_order_items: lines,
    mfg_products: [
      { code: 'MAT', category: 'MATTRESS' },
      { code: 'BED', category: 'BEDFRAME' },
      { code: 'SOFA1', category: 'SOFA' },
      { code: 'DELIVERY', category: 'SERVICE' },
    ],
    delivery_orders: [
      { id: 'DO-LIVE', status: 'DELIVERED' },
      { id: 'DO-DRAFT', status: 'DRAFT' },
    ],
    delivery_order_items: [
      // SO-0000's mattress is fully delivered -> drops out of the walk entirely.
      { id: 'DOI-1', so_item_id: 'SO-0000-mat', qty: 1, delivery_order_id: 'DO-LIVE' },
      // A DRAFT DO has not shipped. It must not shrink SO-0001's remaining.
      { id: 'DOI-2', so_item_id: 'SO-0001-mat', qty: 1, delivery_order_id: 'DO-DRAFT' },
      // Delivered then returned -> remaining goes back to 1 and it allocates.
      { id: 'DOI-3', so_item_id: 'SO-0002-mat', qty: 1, delivery_order_id: 'DO-LIVE' },
      // Hangs off a CANCELLED sales order: must never be read.
      { id: 'DOI-DEAD', so_item_id: 'SO-DEAD-mat', qty: 1, delivery_order_id: 'DO-LIVE' },
    ],
    delivery_returns: [{ id: 'DR-1', status: 'POSTED' }],
    delivery_return_items: [
      { do_item_id: 'DOI-3', qty_returned: 1, delivery_return_id: 'DR-1' },
    ],
    purchase_order_items: [
      // Received against its own SO line -> bound mode makes it READY.
      { so_item_id: 'SO-0003-bed', qty: 1, received_qty: 1 },
      // Raised but nothing received -> changes nothing.
      { so_item_id: 'SO-0004-bed', qty: 1, received_qty: 0 },
    ],
    /* Pooled mattress stock for everyone; no bedframe and no sofa stock, so the
       only bedframe that can go READY is the bound one. */
    inventory_balances: [
      { warehouse_id: 'WH1', product_code: 'MAT', variant_key: null, qty: 500 },
    ],
    v_inventory_lots_open: [],
    stock_allocation_recompute_lock: [{ lock_key: 'GLOBAL', locked_by: null, locked_until: null }],
    mfg_so_audit_log: [],
    mfg_so_status_changes: [],
    staff: [],
  } as Record<string, Row[]>;
}

describe('SO stock-allocation sweep — read shape', () => {
  it('computes the same allocation without reading the child tables by chunked id', async () => {
    const db = makeFakePostgrest(fixture(), RELATIONSHIPS);

    const result = await recomputeSoStockAllocation(db as never);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();

    // ── the constraint: the allocation itself ────────────────────────────────
    const byId = new Map(db.tables.mfg_sales_order_items!.map((l) => [l.id as string, l]));
    const status = (id: string) => byId.get(id)?.stock_status;
    const ready = (id: string) => byId.get(id)?.stock_qty_ready;

    // fully delivered -> not in the walk at all, so its stored status is untouched
    expect(status('SO-0000-mat')).toBe('PENDING');
    // a DRAFT DO delivered nothing -> the line still needs stock, and gets it
    expect(status('SO-0001-mat')).toBe('READY');
    expect(ready('SO-0001-mat')).toBe(1);
    // delivered then returned -> re-opened and allocated
    expect(status('SO-0002-mat')).toBe('READY');
    // bound mode: received against its own PO, with an empty pooled bucket
    expect(status('SO-0003-bed')).toBe('READY');
    // a PO with nothing received changes nothing
    expect(status('SO-0004-bed')).toBe('PENDING');
    // a cancelled line and a cancelled order's line are never touched
    expect(status('SO-0000-dead')).toBe('PENDING');
    expect(status('SO-DEAD-mat')).toBe('PENDING');
    // sofa has no covering batch -> stays PENDING, so nothing flips there
    expect(status('SO-0005-sofa')).toBe('PENDING');
    // service lines never carry stock
    expect(status('SO-0005-svc')).toBe('PENDING');

    // 299 mattress lines (SO-0000's is delivered) + one bound bedframe
    expect(result.linesFlipped).toBe(SO_COUNT - 1 + 1);
    // no order becomes ship-ready while its sofa line is PENDING
    expect(result.ordersAdvanced).toBe(0);
    expect(result.ordersRegressed).toBe(0);

    // ── the point: what it cost ──────────────────────────────────────────────
    /* Both of these are read THROUGH mfg_sales_order_items now, as embedded
       resources, so the sweep issues no request of its own against either. The
       same fixture on the parent commit cost 6 and 2 — the numbers below are
       what this file measured, not what it was hoped to measure. */
    expect(db.reads.get('delivery_order_items') ?? 0).toBe(0);
    expect(db.reads.get('purchase_order_items') ?? 0).toBe(0);

    /* mfg_sales_order_items, unchanged at 4 — and that is the trade, stated
       plainly. It was 2 chunks for the line load + 2 chunks re-reading
       allocated_batch_no; it is now 2 chunks for the line load (which carries
       allocated_batch_no) + 1 embedded DO read + 1 embedded PO read. Four
       requests either way, but two of them no longer grow with the id count. */
    expect(db.reads.get('mfg_sales_order_items')).toBe(4);

    /* The whole sweep: 20 SELECT round trips before the read inversion, 12
       after it, 13 now. The eight that went are six delivery_order_items chunks
       and two purchase_order_items chunks; the two allocated_batch_no chunks
       were traded for the two embedded reads counted above.

       The ONE that came back is the audit-row company backfill, which used to
       put every changed SO's doc_no into a single `.in('doc_no', …)`. This sweep
       runs unscoped over the whole tenant, so that list grows with the order
       book — 300 docs here is ~5.7KB of URL and 2,726 would be ~52KB, i.e. a 400
       rather than a query. Chunked at 200 it is 2 requests for this fixture. A
       round trip is the currency this file is written in, so the trade is stated
       rather than absorbed: one extra request, in exchange for a read that
       cannot stop working as the customer imports. */
    expect(db.totalReads()).toBe(13);
  });
});
