/* What the PO->SO coverage resolver COSTS, and what it ANSWERS, asserted
 * together — because either one alone is worthless.
 *
 * resolvePoSoCoveragePerSkuForPos is the single most expensive read path shared
 * by three list endpoints: the Purchase Order list, the Goods Received list and
 * the Purchase Invoice list all call it once per page. Inside it, two reads
 * dominate — computeMrp (an engine of its own, ~100 round trips against
 * production company 1) and tracePoDeliveredLedger — and NEITHER consumes
 * anything the stored-origin chain in between them produces. They were issued
 * last all the same.
 *
 * Moving WHEN a read is issued is only safe if the answer is untouched, so this
 * file pins three things at once:
 *
 *   1. the ANSWER — the exact per-SKU origins, with all three precedence layers
 *      live in the fixture (a delivered DO lock, a stored raise-link, and an MRP
 *      floating assignment) so a re-order that dropped or reshuffled a layer
 *      cannot pass;
 *   2. the COST — reads per table. Not a budget: a pin. A future change that
 *      adds a round trip to this path has to say so here, and one that removes a
 *      duplicate has to lower a number here on purpose.
 *   3. the OVERLAP — that the delivered ledger and the MRP engine are in flight
 *      BEFORE the stored-origin chain reaches its SO-header validation read.
 *      That is the property the 2026-08-17 change created; without it this
 *      assertion fails, which is the point.
 *
 * The fake speaks PostgREST, applies the predicates, and throws on anything it
 * does not implement (tests/fakePostgrest.ts) — a fake that silently ignored a
 * filter would report a clean run for a query returning different rows.
 *
 * ONE LIMIT, STATED. The fake has no `.is()`, so do-unlinked-coverage's second
 * pass takes its own fail-soft fallback here and logs that it did. That is
 * identical in both arms and does not affect what is being compared — but it
 * does mean the counts below are the counts of THIS shape, not of every shape
 * production can take.
 *
 * MEASURED, not reasoned: the per-table counts in the second test were run
 * against origin/main's resolver (the pre-change file, restored into the tree
 * for the run) and against this branch's. They are IDENTICAL. Only the third
 * test differs between the arms — on origin/main it fails with
 * `expected 21 to be less than 4`, which is the sequencing this change removed.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';
import { resolvePoSoCoveragePerSkuForPos } from '../src/scm/routes/po-so-coverage';
import { makeFakePostgrest, type FakeDb, type Relationship, type Row } from './fakePostgrest';

/* The foreign keys PostgREST resolves the embeds through — MRP's demand read
   embeds the SO header on the line, and its supply read embeds the PO header on
   the PO line. */
const RELATIONSHIPS: Relationship[] = [
  { child: 'mfg_sales_order_items', childCol: 'doc_no', parent: 'mfg_sales_orders', parentCol: 'doc_no' },
  { child: 'purchase_order_items', childCol: 'purchase_order_id', parent: 'purchase_orders', parentCol: 'id' },
  { child: 'delivery_order_items', childCol: 'delivery_order_id', parent: 'delivery_orders', parentCol: 'id' },
  { child: 'delivery_return_items', childCol: 'delivery_return_id', parent: 'delivery_returns', parentCol: 'id' },
  { child: 'supplier_material_bindings', childCol: 'supplier_id', parent: 'suppliers', parentCol: 'id' },
];

const CO = 1;
const PO_ID = 'po-1';
const PO_NO = 'HC-PO-2608-001';
const SKU = 'BF-100';
/* A second SKU on the same PO with NO stored link and NO delivered goods, so
   its only possible assignment is the MRP floating one. Without it the merge
   would discard every MRP row (the delivered lock outranks it on SKU one) and
   this file would pass while the engine's answer was thrown away. */
const SKU_MRP = 'BF-200';
const DD = '2026-12-01';

/* Every table the three read streams touch. Absent tables would default to
   empty inside the fake, but naming them keeps the corpus visible: a read of a
   table NOT listed here is a read this fixture never intended to model. */
function fixture(): Record<string, Row[]> {
  return {
    purchase_orders: [{ id: PO_ID, po_number: PO_NO, notes: null, company_id: CO, status: 'SUBMITTED' }],
    purchase_order_items: [{
      id: 'poi-1', purchase_order_id: PO_ID, material_code: SKU, item_group: 'bedframe',
      /* so_item_id is the layer-(b) stored raise-link: this PO line was raised
         FROM sales order SO-STORED. */
      so_item_id: 'si-stored', variants: {}, qty: 5, received_qty: 0,
      delivery_date: '2026-11-01', supplier_delivery_date_2: null,
      supplier_delivery_date_3: null, supplier_delivery_date_4: null,
      warehouse_id: 'W1', company_id: CO,
    }, {
      id: 'poi-2', purchase_order_id: PO_ID, material_code: SKU_MRP, item_group: 'bedframe',
      so_item_id: null, variants: {}, qty: 3, received_qty: 0,
      delivery_date: '2026-11-01', supplier_delivery_date_2: null,
      supplier_delivery_date_3: null, supplier_delivery_date_4: null,
      warehouse_id: 'W1', company_id: CO,
    }],
    purchase_order_item_allocations: [],
    mfg_sales_orders: [
      { doc_no: 'SO-STORED', customer_delivery_date: DD, amended_delivery_date: null, status: 'CONFIRMED', so_date: '2026-07-01', debtor_name: 'Acme', processing_date: null, customer_state: null, sales_location: null, company_id: CO },
      { doc_no: 'SO-FLOAT', customer_delivery_date: DD, amended_delivery_date: null, status: 'CONFIRMED', so_date: '2026-07-02', debtor_name: 'Beta', processing_date: null, customer_state: null, sales_location: null, company_id: CO },
      { doc_no: 'SO-SHIPPED', customer_delivery_date: DD, amended_delivery_date: null, status: 'CONFIRMED', so_date: '2026-07-03', debtor_name: 'Gamma', processing_date: null, customer_state: null, sales_location: null, company_id: CO },
    ],
    mfg_sales_order_items: [
      { id: 'si-stored', doc_no: 'SO-STORED', item_code: SKU, description: 'Baron', item_group: 'bedframe', variants: {}, qty: 1, warehouse_id: 'W1', line_delivery_date: DD, line_no: 1, created_at: '2026-07-01T00:00:00Z', cancelled: false, company_id: CO },
      { id: 'si-float', doc_no: 'SO-FLOAT', item_code: SKU, description: 'Baron', item_group: 'bedframe', variants: {}, qty: 4, warehouse_id: 'W1', line_delivery_date: DD, line_no: 1, created_at: '2026-07-02T00:00:00Z', cancelled: false, company_id: CO },
      { id: 'si-mrp', doc_no: 'SO-FLOAT', item_code: SKU_MRP, description: 'Baron 200', item_group: 'bedframe', variants: {}, qty: 3, warehouse_id: 'W1', line_delivery_date: DD, line_no: 2, created_at: '2026-07-02T00:01:00Z', cancelled: false, company_id: CO },
      { id: 'si-shipped', doc_no: 'SO-SHIPPED', item_code: SKU, description: 'Baron', item_group: 'bedframe', variants: {}, qty: 1, warehouse_id: 'W1', line_delivery_date: DD, line_no: 1, created_at: '2026-07-03T00:00:00Z', cancelled: false, company_id: CO },
    ],
    mfg_products: [
      { code: SKU, category: 'bedframe', name: 'Baron Bedframe', company_id: CO },
      { code: SKU_MRP, category: 'bedframe', name: 'Baron 200 Bedframe', company_id: CO },
    ],
    /* Layer (a): the goods for SO-SHIPPED left on DO-1, drawn from a lot stamped
       with this PO number. That makes SO-SHIPPED a LOCKED assignment, which
       outranks both the stored link and the MRP guess. */
    inventory_lots: [{ id: 'lot-1', batch_no: PO_NO, company_id: CO }],
    inventory_lot_consumptions: [{
      source_doc_type: 'DO', source_doc_id: 'do-1', lot_id: 'lot-1',
      product_code: SKU, variant_key: '', qty_consumed: 1, company_id: CO,
    }],
    inventory_movements: [],
    delivery_orders: [{ id: 'do-1', so_doc_no: 'SO-SHIPPED', do_number: 'DO-1', status: 'POSTED', company_id: CO }],
    delivery_order_items: [{
      delivery_order_id: 'do-1', so_item_id: 'si-shipped', item_code: SKU,
      item_group: 'bedframe', variants: {}, qty: 1, company_id: CO,
    }],
    delivery_return_items: [],
    delivery_returns: [],
    inventory_balances: [],
    warehouses: [{ id: 'W1', code: 'W1', name: 'Main', is_active: true, company_id: CO }],
    state_warehouse_mappings: [],
    supplier_material_bindings: [],
    suppliers: [],
    mrp_category_lead_times: [],
    fabric_trackings: [],
  };
}

/* An instrumented view of the fake: same rows, same predicates, but every
   awaited builder costs LATENCY_MS and its ISSUE is recorded. Sequential code
   therefore produces a strictly ordered issue log; overlapping code does not,
   and that difference is what assertion 3 reads. */
const LATENCY_MS = 5;

function instrument(db: FakeDb) {
  const issued: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (table: string, b: any): any => new Proxy(function () { /* proxy target */ } as never, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
          issued.push(table);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const done = <T>(v: T): T => { inFlight -= 1; return v; };
          return new Promise((res) => setTimeout(res, LATENCY_MS))
            .then(() => b as PromiseLike<unknown>)
            .then(done, (e: unknown) => { inFlight -= 1; throw e; })
            .then(onF, onR);
        };
      }
      return (...args: unknown[]) => {
        const r = b[prop](...args);
        return r === b ? wrap(table, b) : r;
      };
    },
  });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sb: { from: (t: string) => wrap(t, db.from(t) as any) } as any,
    issued,
    maxInFlight: () => maxInFlight,
  };
}

/* The context the resolver reads: the active company (every read is scoped by
   it) and c.env.DB, which loadLeadBuffers opens. loadLeadBuffers catches its own
   failures and falls back to no buffers, so a DB that refuses is the honest
   stand-in for "no procurement-agent setting stored". */
function ctx(): Context<never> {
  return {
    get: (k: string) => (k === 'companyId' ? CO : k === 'allowedCompanyIds' ? [CO] : undefined),
    env: { DB: { prepare: () => { throw new Error('no D1 in this harness'); } } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('resolvePoSoCoveragePerSkuForPos — the answer, the cost and the overlap', () => {
  it('merges all three precedence layers, and the delivered lock wins', async () => {
    const db = makeFakePostgrest(fixture(), RELATIONSHIPS);
    const inst = instrument(db);
    const out = await resolvePoSoCoveragePerSkuForPos(inst.sb, ctx(), [PO_ID]);

    const origins = out.get(PO_ID);
    expect(origins).toBeDefined();
    expect(origins!.map((o) => o.itemCode).sort()).toEqual([SKU, SKU_MRP]);

    const sku = origins!.find((o) => o.itemCode === SKU)!;
    /* The PO line carries a stored so_item_id, so this SKU is source-LINKED —
       the list cell marks it apart from an MRP-only guess. */
    expect(sku.storedLink).toBe(true);
    /* Layer (a) delivered lock is the winner for this SKU: SO-SHIPPED's goods
       physically left against this PO number. It is `locked`. */
    expect(sku.assignments.map((a) => a.soDocNo)).toEqual(['SO-SHIPPED']);
    expect(sku.assignments[0]!.locked).toBe(true);
    expect(sku.assignments[0]!.deliveryDate).toBe(DD);
    /* Layer (b) still rides the parallel provenance slot — "bought for" is a
       different question from "who won precedence", and the list renders both. */
    expect(sku.provenance.map((p) => p.soDocNo)).toEqual(['SO-STORED']);

    /* Layer (c): the second SKU has neither a delivered lock nor a stored link,
       so what it shows is the MRP engine's floating allocation and nothing else.
       This is the assertion that fails if the hoisted computeMrp stops being
       awaited, or is awaited after the merge. */
    const mrpOnly = origins!.find((o) => o.itemCode === SKU_MRP)!;
    expect(mrpOnly.storedLink).toBe(false);
    expect(mrpOnly.assignments.map((a) => a.soDocNo)).toEqual(['SO-FLOAT']);
    expect(mrpOnly.assignments[0]!.locked).toBe(false);
    expect(mrpOnly.assignments[0]!.source).toBe('mrp');
    expect(mrpOnly.provenance).toEqual([]);
  });

  it('reads each table exactly as many times as it did before the reads were re-ordered', async () => {
    const db = makeFakePostgrest(fixture(), RELATIONSHIPS);
    const inst = instrument(db);
    await resolvePoSoCoveragePerSkuForPos(inst.sb, ctx(), [PO_ID]);

    /* A PIN, not a budget. Every number here is a round trip an operator waits
       for. Raising one is a decision that belongs in a diff with a reason;
       lowering one (by removing a duplicate read) is the work this file exists
       to make visible. Two of these are known DUPLICATES across the pair of
       resolvers the PO and GRN lists call together — see the perf write-up. */
    expect(Object.fromEntries(db.reads)).toEqual({
      purchase_orders: 1,                 // header: po_number + "From SOs:" notes
      purchase_order_items: 2,            // stored-link chain 1 + MRP supply page 1
      purchase_order_item_allocations: 1, // mig 0235 links for the page's PO lines
      mfg_sales_order_items: 5,           // stored chain 2, MRP demand 1, deliverable 1, DO-lock 1
      mfg_sales_orders: 3,                // stored validation, deliverable heads, DO-lock validation
      mfg_products: 2,                    // MRP category walk + by-code
      inventory_lots: 1,                  // delivered ledger
      inventory_lot_consumptions: 1,
      inventory_movements: 2,             // delivered ledger + MRP committed shipments
      inventory_balances: 1,
      warehouses: 1,
      state_warehouse_mappings: 1,
      supplier_material_bindings: 1,
      mrp_category_lead_times: 1,
      delivery_order_items: 2,            // deliverable remaining + DO-lock lines
      delivery_orders: 2,                 // DO-lock headers + MRP committed shipments
      delivery_return_items: 1,
    });
    expect(db.totalReads()).toBe(28);
  });

  it('has the delivered ledger and the MRP engine in flight before the stored-origin chain validates its SOs', async () => {
    const db = makeFakePostgrest(fixture(), RELATIONSHIPS);
    const inst = instrument(db);
    await resolvePoSoCoveragePerSkuForPos(inst.sb, ctx(), [PO_ID]);

    const first = (t: string) => inst.issued.indexOf(t);
    /* `mfg_sales_orders` is first touched by the stored-origin chain's candidate
       validation — the FIFTH read of that chain. Before 2026-08-17 the ledger's
       first read (inventory_lots) and the MRP engine's stock read
       (inventory_balances) were both issued only AFTER that chain had finished,
       so both of these were greater, not less. Neither read's text, filters or
       arguments changed; only the moment it is issued. */
    expect(first('inventory_lots')).toBeGreaterThanOrEqual(0);
    expect(first('inventory_lots')).toBeLessThan(first('mfg_sales_orders'));
    expect(first('inventory_balances')).toBeLessThan(first('mfg_sales_orders'));
    /* And they genuinely overlap rather than merely being re-ordered. */
    expect(inst.maxInFlight()).toBeGreaterThanOrEqual(3);
  });
});
