import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { inventoryLotsHandler } from '../src/scm/routes/inventory';

/* ────────────────────────────────────────────────────────────────────────────
   GET /inventory/lots/:itemCode — every lot says whether it is CONSIGNMENT.

   Consignment stock sits in our warehouse and belongs to the supplier until it
   sells. It counts as QUANTITY on hand and must never count as VALUE, because
   valuing it books money against goods we do not own.

   The route read `v_inventory_lots_open` with `select('*')` and shipped the rows
   through untouched. That view's only predicate is `qty_remaining > 0`
   (mig 0307), so consignment lots ride along unlabelled — and the desktop Stock
   Card, the one consumer, multiplied `qty_remaining x unit_cost_sen` over all of
   them and printed the total as "FIFO Value".

   The classifier is NOT new and is not re-implemented here: `/breakdown/:itemCode`
   in this same file has skipped consignment lots on `isConsignmentLotSource`
   since BUG-HISTORY 2026-07-25, and `/reservations` already STAMPS the same flag
   on every row it returns. This route was the odd one out, which is how one page
   came to contradict itself — the per-warehouse table underneath the stat
   excluded exactly what the stat included.

   Classification is by the lot's SOURCE, never the warehouse's `is_consignment`
   flag: a PC Receive mis-posted into a normal warehouse is still not ours.
   ──────────────────────────────────────────────────────────────────────────── */

class FakeQuery {
  private preds: Array<(r: Record<string, unknown>) => boolean> = [];
  constructor(private rows: Array<Record<string, unknown>>) {}
  select() { return this; }
  order() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  then(res: (v: { data: unknown[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve({
      data: this.rows.filter((r) => this.preds.every((p) => p(r))),
      error: null as null,
    }).then(res, rej);
  }
}

const LOTS = [
  // A normal goods receipt — ours, and worth 500.00 a unit.
  { id: 'l1', company_id: 1, item_code: 'AKEMI-Q', warehouse_id: 'w1', qty_remaining: 2, unit_cost_sen: 50000, source_doc_type: 'GRN', source_doc_no: '2990-GRN-2607-023' },
  // A Purchase Consignment Receive — the supplier's goods, in our warehouse.
  { id: 'l2', company_id: 1, item_code: 'AKEMI-Q', warehouse_id: 'w1', qty_remaining: 3, unit_cost_sen: 40000, source_doc_type: 'PC_RECEIVE', source_doc_no: '2990-PCR-2606-001' },
  // A PCR delta top-up: written as STOCK_TRANSFER but KEEPING the receive
  // number, which is the shape the doc-type check alone would miss.
  { id: 'l3', company_id: 1, item_code: 'AKEMI-Q', warehouse_id: 'w1', qty_remaining: 1, unit_cost_sen: 40000, source_doc_type: 'STOCK_TRANSFER', source_doc_no: 'PCR-2606-002' },
  // A genuine inter-warehouse transfer mints its own non-PCR number: still ours.
  { id: 'l4', company_id: 1, item_code: 'AKEMI-Q', warehouse_id: 'w2', qty_remaining: 4, unit_cost_sen: 50000, source_doc_type: 'STOCK_TRANSFER', source_doc_no: '2990-ST-2607-004' },
];

function appWith(rows: Array<Record<string, unknown>>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: () => new FakeQuery(rows) } as never);
    c.set('activeCompanyId' as never, 1 as never);
    // A finance viewer, so unit_cost_sen survives stripInventoryFinance and the
    // value assertion below has numbers to add up. The consignment flag is NOT
    // finance-gated and must be present either way — asserted separately.
    c.set('houzsUser' as never, { position_name: 'Finance Manager', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.get('/lots/:itemCode', inventoryLotsHandler);
  return app;
}

const lotsOf = async (rows: Array<Record<string, unknown>>) => {
  const res = await appWith(rows).request('/lots/AKEMI-Q');
  expect(res.status).toBe(200);
  return (await res.json<{ lots: Array<Record<string, unknown>> }>()).lots;
};

describe('GET /inventory/lots/:itemCode carries the consignment verdict', () => {
  test('every lot is labelled, by SOURCE', async () => {
    const byId = new Map((await lotsOf(LOTS)).map((l) => [l.id as string, l]));
    expect(byId.get('l1')!.is_consignment).toBe(false); // plain GRN
    expect(byId.get('l2')!.is_consignment).toBe(true);  // PC_RECEIVE
    expect(byId.get('l3')!.is_consignment).toBe(true);  // PCR- top-up
    expect(byId.get('l4')!.is_consignment).toBe(false); // real transfer
  });

  test('the flag is a boolean on EVERY row, never absent', async () => {
    // An absent flag reads as falsy, i.e. "owned", so a lot the classifier never
    // saw would silently be valued. The consumer must not have to guess.
    for (const l of await lotsOf(LOTS)) expect(typeof l.is_consignment).toBe('boolean');
  });

  test('owned value excludes consignment — 2 x 500.00, not 6 lots worth', async () => {
    // This is the number the Stock Card prints. Computed here from the flag the
    // route now ships, so the assertion is about the WIRE, not about the page.
    const lots = await lotsOf(LOTS.filter((l) => l.warehouse_id === 'w1'));
    const owned = lots.filter((l) => !l.is_consignment)
      .reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost_sen), 0);
    const all = lots.reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost_sen), 0);
    expect(owned).toBe(100000);
    expect(all).toBe(260000); // what "FIFO Value" used to print: RM 1,600 of it not ours
  });
});
