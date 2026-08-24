// The over-delivery guard at the CONFIRM chokepoint (DRAFT -> LOADED since
// 2026-08-22), exercised through the real route handler — not just the pure
// invariant. That hop is where the inventory OUT fires, so it is the last
// moment a delivery can be refused before its stock leaves.
//
// doOverDelivery.test.ts pins findOverDeliveredSoItems (the LINKED half) and
// do-over-delivery.test.ts pins findOverDeliveredUnlinkedItems (the pure guard).
// Neither proves the handler WIRES the unlinked guard in front of the flip/deduct
// — that wiring is the fix (PR #2522). This suite drives
// patchDeliveryOrderStatusHandler with a fake PostgREST so the two cases the
// wiring exists to separate are pinned against the route itself:
//
//   1. an UNLINKED duplicate — the 2990-DO-2607-005 shape, a DRAFT DO whose
//      lines carry no so_item_id for an item the named SO has already fully
//      delivered — is now REFUSED 409 over_delivery before any stock leaves.
//   2. a legitimate multi-DO SPLIT — a second DRAFT DO taking the SO line's
//      remaining open qty — still SHIPS (the guard does not refuse it).
//
// Harness mirrors doStatusCaseNormalisation.test.ts, with ONE deliberate
// difference: `.is(col, null)` actually filters here. The coverage engine
// (do-unlinked-coverage.ts) reads unlinked lines with `.is('so_item_id', null)`,
// and a no-op `.is()` would let a LINKED line masquerade as unlinked coverage —
// a harness artefact, not the code's behaviour. Filtering null keeps the fake
// faithful to Postgres, which is what makes case 2 a real pass rather than a
// false refusal manufactured by the mock.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  // Faithful to Postgres: `.is(col, null)` matches only null/undefined. The
  // sibling harness leaves this a no-op; here it decides linked vs unlinked.
  is(col: string, val: unknown) {
    if (val === null) this.preds.push((r) => r[col] === null || r[col] === undefined);
    else this.preds.push((r) => r[col] === val);
    return this;
  }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return app;
}

/* CONFIRM IS DRAFT -> LOADED SINCE 2026-08-22, and this helper had to move with
   it. The office Confirm button used to write DISPATCHED; the owner moved the
   stock deduction to the confirm step, so LOADED is both what Confirm writes and
   the hop the over-delivery guard now defends. Sending DISPATCHED here would
   still pass — DRAFT -> DISPATCHED remains a legal pre-ship -> shipped hop — but
   it would be testing a transition no screen performs. */
const confirm = (app: Hono, id: string) =>
  app.request(`/delivery-orders/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'LOADED' }),
  });

async function overDeliveryRefusal(res: Response): Promise<{ error?: string; conflicts?: string[] } | null> {
  if (res.status !== 409) return null;
  const body = await res.json().catch(() => ({})) as { error?: string; conflicts?: string[] };
  return body.error === 'over_delivery' ? body : null;
}

describe('DO status PATCH — unlinked over-delivery guard (route-level)', () => {
  test('an unlinked duplicate against a fully-delivered SO line is REFUSED 409', async () => {
    // SO-1 orders 2 of NTYR; a first (linked) DO already shipped all 2.
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [{ doc_no: 'SO-1', debtor_code: 'D1', debtor_name: 'Cust' }],
      mfg_sales_order_items: [
        { id: 'so-item-1', doc_no: 'SO-1', item_code: 'NTYR', item_group: null, qty: 2, cancelled: false },
      ],
      delivery_orders: [
        { id: 'do-first', do_number: 'DO-FIRST', company_id: CO, status: 'DISPATCHED', so_doc_no: 'SO-1' },
        // The DRAFT duplicate: header names SO-1, its line carries NO so_item_id.
        { id: 'do-dup', do_number: 'DO-DUP', company_id: CO, status: 'DRAFT', so_doc_no: 'SO-1' },
      ],
      delivery_order_items: [
        { id: 'doi-first', delivery_order_id: 'do-first', so_item_id: 'so-item-1', item_code: 'NTYR', qty: 2, parent: { status: 'DISPATCHED' } },
        { id: 'doi-dup', delivery_order_id: 'do-dup', so_item_id: null, item_code: 'NTYR', qty: 2, parent: { status: 'DRAFT' } },
      ],
      delivery_return_items: [],
    };
    const refusal = await overDeliveryRefusal(await confirm(harness(tables), 'do-dup'));
    expect(refusal).not.toBeNull();
    expect(refusal?.conflicts).toContain('NTYR');
    // Refused BEFORE the flip — the draft must still be a draft.
    expect(tables.delivery_orders.find((d) => d.id === 'do-dup')?.status).toBe('DRAFT');
  });

  test('a legitimate multi-DO split (second DO takes the remaining open qty) still SHIPS', async () => {
    // SO-2 orders 10 of MATT; a first (linked) DO shipped 6, leaving 4 open. A
    // second DRAFT DO with an unlinked line of 4 is exactly the rest — allowed.
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [{ doc_no: 'SO-2', debtor_code: 'D2', debtor_name: 'Cust2' }],
      mfg_sales_order_items: [
        { id: 'so-item-2', doc_no: 'SO-2', item_code: 'MATT', item_group: null, qty: 10, cancelled: false },
      ],
      delivery_orders: [
        { id: 'do-b-first', do_number: 'DO-B1', company_id: CO, status: 'DISPATCHED', so_doc_no: 'SO-2' },
        { id: 'do-b-split', do_number: 'DO-B2', company_id: CO, status: 'DRAFT', so_doc_no: 'SO-2' },
      ],
      delivery_order_items: [
        { id: 'doi-b-first', delivery_order_id: 'do-b-first', so_item_id: 'so-item-2', item_code: 'MATT', qty: 6, parent: { status: 'DISPATCHED' } },
        { id: 'doi-b-split', delivery_order_id: 'do-b-split', so_item_id: null, item_code: 'MATT', qty: 4, parent: { status: 'DRAFT' } },
      ],
      delivery_return_items: [],
    };
    const refusal = await overDeliveryRefusal(await confirm(harness(tables), 'do-b-split'));
    expect(refusal).toBeNull();
  });

  test('an ad-hoc unlinked line the SO never ordered is NOT flagged', async () => {
    // A replacement part riding along on a DO whose SO orders something else.
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [{ doc_no: 'SO-3', debtor_code: 'D3', debtor_name: 'Cust3' }],
      mfg_sales_order_items: [
        { id: 'so-item-3', doc_no: 'SO-3', item_code: 'NTYR', item_group: null, qty: 2, cancelled: false },
      ],
      delivery_orders: [
        { id: 'do-adhoc', do_number: 'DO-ADHOC', company_id: CO, status: 'DRAFT', so_doc_no: 'SO-3' },
      ],
      delivery_order_items: [
        { id: 'doi-adhoc', delivery_order_id: 'do-adhoc', so_item_id: null, item_code: 'SPARE-LEG', qty: 1, parent: { status: 'DRAFT' } },
      ],
      delivery_return_items: [],
    };
    const refusal = await overDeliveryRefusal(await confirm(harness(tables), 'do-adhoc'));
    expect(refusal).toBeNull();
  });
});

/*
 * A delivery order is not blocked by ITSELF at the confirm gate.
 *
 * THE ORIGINAL BUG, and it was real: `DO_PRESHIP_STATES` was {DRAFT, LOADED},
 * the confirm gate admitted both, but every engine that sums what a Sales Order
 * has already been delivered skipped only CANCELLED and DRAFT — so a LOADED DO
 * counted its OWN lines as delivered. The gate compared this DO's qty against a
 * remaining figure that had already subtracted it and refused whenever
 * 2 x own_qty > ordered_qty, which is every full delivery. Goods on the lorry,
 * confirm returns 409; the OUT never fires, stock on hand reads too high, MRP
 * does not reorder, and the operator's way out is cancel-and-re-raise — the
 * exact path that minted the DO-005 duplicate this file's first case refuses.
 *
 * WHAT CHANGED 2026-08-22, and why these cases now start from DRAFT. The owner
 * moved the deduction to the confirm step, so LOADED is a SHIPPED state and the
 * chokepoint these cases defend is DRAFT -> LOADED, not LOADED -> DISPATCHED.
 * The self-refusal cannot recur at that hop for a structural reason rather than
 * a lucky one: a DRAFT is excluded from the delivered sum, so the document being
 * confirmed is never inside the total it is measured against. The scenarios are
 * kept, with the subject document moved to the status the gate now runs on.
 */
describe('DO status PATCH — a delivery order is not blocked by itself', () => {
  test('REGRESSION: a DO delivering exactly what was ordered CONFIRMS', async () => {
    // SO-4 orders 2 of NTYR. One DRAFT DO carries both, linked. Nothing else
    // has shipped, so this is an ordinary full delivery.
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [{ doc_no: 'SO-4', debtor_code: 'D4', debtor_name: 'Cust4' }],
      mfg_sales_order_items: [
        { id: 'so-item-4', doc_no: 'SO-4', item_code: 'NTYR', item_group: null, qty: 2, cancelled: false },
      ],
      delivery_orders: [
        { id: 'do-loaded', do_number: 'DO-LOADED', company_id: CO, status: 'DRAFT', so_doc_no: 'SO-4' },
      ],
      delivery_order_items: [
        { id: 'doi-loaded', delivery_order_id: 'do-loaded', so_item_id: 'so-item-4', item_code: 'NTYR', qty: 2, parent: { status: 'DRAFT' } },
      ],
      delivery_return_items: [],
    };
    const refusal = await overDeliveryRefusal(await confirm(harness(tables), 'do-loaded'));
    expect(refusal).toBeNull();
    expect(tables.delivery_orders.find((d) => d.id === 'do-loaded')?.status).toBe('LOADED');
  });

  test('REGRESSION: the same, with UNLINKED lines — the header-attributed reading', async () => {
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [{ doc_no: 'SO-5', debtor_code: 'D5', debtor_name: 'Cust5' }],
      mfg_sales_order_items: [
        { id: 'so-item-5', doc_no: 'SO-5', item_code: 'MATT', item_group: null, qty: 3, cancelled: false },
      ],
      delivery_orders: [
        { id: 'do-loaded-u', do_number: 'DO-LOADED-U', company_id: CO, status: 'DRAFT', so_doc_no: 'SO-5' },
      ],
      delivery_order_items: [
        { id: 'doi-loaded-u', delivery_order_id: 'do-loaded-u', so_item_id: null, item_code: 'MATT', qty: 3, parent: { status: 'DRAFT' } },
      ],
      delivery_return_items: [],
    };
    const refusal = await overDeliveryRefusal(await confirm(harness(tables), 'do-loaded-u'));
    expect(refusal).toBeNull();
  });

  test('a DO that really WOULD over-deliver is still refused at Confirm', async () => {
    // The guard must lose its blind spot, not its teeth: SO-6 orders 2, a
    // DISPATCHED DO already shipped both, and the DRAFT one carries 2 more.
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [{ doc_no: 'SO-6', debtor_code: 'D6', debtor_name: 'Cust6' }],
      mfg_sales_order_items: [
        { id: 'so-item-6', doc_no: 'SO-6', item_code: 'NTYR', item_group: null, qty: 2, cancelled: false },
      ],
      delivery_orders: [
        { id: 'do-6-first', do_number: 'DO-6A', company_id: CO, status: 'DISPATCHED', so_doc_no: 'SO-6' },
        { id: 'do-6-loaded', do_number: 'DO-6B', company_id: CO, status: 'DRAFT', so_doc_no: 'SO-6' },
      ],
      delivery_order_items: [
        { id: 'doi-6-first', delivery_order_id: 'do-6-first', so_item_id: 'so-item-6', item_code: 'NTYR', qty: 2, parent: { status: 'DISPATCHED' } },
        { id: 'doi-6-loaded', delivery_order_id: 'do-6-loaded', so_item_id: 'so-item-6', item_code: 'NTYR', qty: 2, parent: { status: 'DRAFT' } },
      ],
      delivery_return_items: [],
    };
    const refusal = await overDeliveryRefusal(await confirm(harness(tables), 'do-6-loaded'));
    expect(refusal).not.toBeNull();
    expect(tables.delivery_orders.find((d) => d.id === 'do-6-loaded')?.status).toBe('DRAFT');
  });
});
