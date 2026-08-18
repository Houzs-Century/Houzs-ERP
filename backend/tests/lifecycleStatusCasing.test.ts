/* CANCEL VIA A STATUS PATCH MUST NOT DEPEND ON THE CALLER'S LETTER CASE.
 *
 * Four documents cancel through `PATCH .../status` and, unlike the Sales Order,
 * Delivery Order and Sales Invoice handlers, none of them normalised the
 * incoming status before gating on it:
 *
 *   consignment-notes.ts       patchConsignmentNoteStatusHandler
 *   consignment-returns.ts     patchConsignmentReturnStatusHandler
 *   delivery-returns.ts        patchDeliveryReturnStatusHandler
 *   consignment-orders.ts      patchConsignmentOrderStatusHandler
 *
 * Every gate read `body.status === 'CANCELLED'`, so a lowercase 'cancelled'
 *   - skipped the already-cancelled idempotent echo,
 *   - skipped the ATOMIC `.neq('status','CANCELLED')` single-flight,
 *   - skipped the downstream lock (notes + orders),
 *   - skipped the inventory resync (notes + both returns) — the damage: the
 *     document reads cancelled while its stock never moved back,
 * and persisted the caller's spelling verbatim. Meanwhile the READ side of the
 * same files (`resyncNoteInventory`, `resyncReturnInventory`,
 * `resyncInventoryForReturn`) uppercases the stored status before deciding
 * `cancelled`, so the two halves of one file disagreed about the same row.
 *
 * That is the Sales Invoice bug this repo already paid for once — see
 * SI_STATUS_CANON in sales-invoices.ts, "a lowercase 'cancelled' slipped past
 * the `status === 'CANCELLED'` gate and skipped the revenue reversal" — with
 * stock in place of revenue, and it was never lifted to the siblings.
 *
 * Driven through a bare Hono app whose middleware injects a fake scm supabase
 * client + a company context, mounting the EXPORTED handlers rather than the
 * routers: the supabaseAuth bridge cannot run in this harness. Same approach as
 * purchaseReturnLineMovementErrors.test.ts.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchConsignmentNoteStatusHandler } from '../src/scm/routes/consignment-notes';
import { patchConsignmentReturnStatusHandler } from '../src/scm/routes/consignment-returns';
import { patchDeliveryReturnStatusHandler } from '../src/scm/routes/delivery-returns';
import { patchConsignmentOrderStatusHandler } from '../src/scm/routes/consignment-orders';
import { completePurchaseReturnHandler } from '../src/scm/routes/purchase-returns';

const CO = 1;
type Row = Record<string, any>;

/* Permissive fake PostgREST builder. Two things beyond the usual shape matter
   here and both are load-bearing:
     • `single()` reports ZERO rows as an ERROR, which is what PostgREST does
       (PGRST116) — the whole point of the `.maybeSingle()` half of this fix;
     • `select(col, { head, count })` resolves with a `count`, which is how the
       downstream locks ask "does a child exist". */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private wantCount = false;
  constructor(private rows: Row[], private seq: { n: number }) {}
  select(_cols?: string, opts?: { head?: boolean; count?: string }) {
    if (opts?.count) this.wantCount = true;
    return this;
  }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    this.inserted = (Array.isArray(p) ? p : [p]).map((r) => (r.id ? r : { ...r, id: `row-${++this.seq.n}` }));
    return this;
  }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  gte() { return this; }
  lte() { return this; }
  not() { return this; }
  like() { return this; }
  is() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: null });
  }
  single() {
    const h = this.run();
    // PostgREST answers zero rows with PGRST116, NOT with data:null.
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'PGRST116: no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    const hit = this.run();
    const out = this.wantCount
      ? { data: hit, count: hit.length, error: null }
      : { data: hit, error: null };
    return Promise.resolve(out).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>) {
  const seq = { n: 0 };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), seq),
      rpc: async () => ({ data: null, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Tester' } } as never);
    /* `*` puts the caller in the view-all sales tier, so the Consignment Order
       handler's selfScopedConsignmentBlocked short-circuits before
       resolveSalesScopeIds, which would otherwise need a real worker `env` to
       walk the manager tree. The self-scope guard is not what this file is
       about — the casing of the status is. */
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions: ['*'] } as never);
    await next();
  });
  app.patch('/consignment-notes/:id/status', patchConsignmentNoteStatusHandler as never);
  app.patch('/consignment-returns/:id/status', patchConsignmentReturnStatusHandler as never);
  app.patch('/delivery-returns/:id/status', patchDeliveryReturnStatusHandler as never);
  app.patch('/consignment-orders/:docNo/status', patchConsignmentOrderStatusHandler as never);
  app.patch('/purchase-returns/:id/complete', completePurchaseReturnHandler as never);
  return app;
}

const send = (app: Hono, method: string, url: string, body?: Row) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/* Each document, its table, the row it starts from, and the URL that cancels
   it. The point of the table is that these four are ONE defect, so they get ONE
   set of assertions rather than four hand-written near-copies. */
const DOCS = [
  {
    name: 'Consignment Note',
    url: (id: string) => `/consignment-notes/${id}/status`,
    table: 'consignment_delivery_orders',
    row: (id: string, status: string) => ({
      id, company_id: CO, do_number: 'CSDO-1', consignment_so_doc_no: 'CS-1',
      status, warehouse_id: 'wh-1',
    }),
    finalError: 'note_cancelled_final',
  },
  {
    name: 'Consignment Return',
    url: (id: string) => `/consignment-returns/${id}/status`,
    table: 'consignment_delivery_returns',
    row: (id: string, status: string) => ({
      id, company_id: CO, return_number: 'CSDR-1', consignment_do_id: 'note-1',
      status, warehouse_id: 'wh-1',
    }),
    finalError: 'return_cancelled_final',
  },
  {
    name: 'Delivery Return',
    url: (id: string) => `/delivery-returns/${id}/status`,
    table: 'delivery_returns',
    row: (id: string, status: string) => ({
      id, company_id: CO, return_number: 'DR-1', status, warehouse_id: 'wh-1',
    }),
    finalError: 'dr_cancelled_final',
  },
] as const;

describe('status-PATCH cancel is case-insensitive on the way IN', () => {
  for (const doc of DOCS) {
    test(`${doc.name}: a lowercase "cancelled" persists the CANONICAL status`, async () => {
      const tables: Record<string, Row[]> = { [doc.table]: [doc.row('d-1', 'RECEIVED')] };
      const app = harness(tables);
      const res = await send(app, 'PATCH', doc.url('d-1'), { status: 'cancelled' });
      expect(res.status).toBe(200);
      /* The row, not the response: the response echoes whatever came back, but
         the ROW is what every later reader — including this same file's
         inventory resync — will judge. Before the fix this was 'cancelled'. */
      expect(tables[doc.table][0].status).toBe('CANCELLED');
    });

    test(`${doc.name}: a lowercase "cancelled" on an already-cancelled row is idempotent, not a refusal`, async () => {
      const tables: Record<string, Row[]> = { [doc.table]: [doc.row('d-1', 'CANCELLED')] };
      const app = harness(tables);
      const res = await send(app, 'PATCH', doc.url('d-1'), { status: 'cancelled' });
      /* Before the fix the lowercase missed the echo branch, fell through to the
         cancelled-is-final guard and answered 409 — so a retry of a cancel that
         had already landed reported a failure. */
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, any>;
      expect(JSON.stringify(body)).not.toContain(doc.finalError);
    });

    test(`${doc.name}: an UPPERCASE cancel is unchanged`, async () => {
      const tables: Record<string, Row[]> = { [doc.table]: [doc.row('d-1', 'RECEIVED')] };
      const app = harness(tables);
      const res = await send(app, 'PATCH', doc.url('d-1'), { status: 'CANCELLED' });
      expect(res.status).toBe(200);
      expect(tables[doc.table][0].status).toBe('CANCELLED');
    });
  }
});

describe('the downstream lock is reached whatever the case', () => {
  test('Consignment Note: a lowercase cancel still hits noteHasDownstream', async () => {
    const tables: Record<string, Row[]> = {
      consignment_delivery_orders: [{
        id: 'note-1', company_id: CO, do_number: 'CSDO-1', status: 'DISPATCHED', warehouse_id: 'wh-1',
      }],
      // A live child return — the lock must refuse.
      consignment_delivery_returns: [{ id: 'cr-1', company_id: CO, consignment_do_id: 'note-1', status: 'RECEIVED' }],
    };
    const app = harness(tables);
    const res = await send(app, 'PATCH', '/consignment-notes/note-1/status', { status: 'cancelled' });
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, any>).error).toBe('note_has_downstream');
    // And the note was NOT cancelled behind the refusal.
    expect(tables.consignment_delivery_orders[0].status).toBe('DISPATCHED');
  });

  test('Consignment Order: a lowercase cancel still hits coHasDownstream', async () => {
    const tables: Record<string, Row[]> = {
      consignment_sales_orders: [{ doc_no: 'CS-1', company_id: CO, status: 'CONFIRMED' }],
      // A live Consignment Note against this order — the lock must refuse.
      consignment_delivery_orders: [{ id: 'note-1', company_id: CO, consignment_so_doc_no: 'CS-1', status: 'DISPATCHED' }],
    };
    const app = harness(tables);
    const res = await send(app, 'PATCH', '/consignment-orders/CS-1/status', { status: 'cancelled' });
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, any>).error).toBe('co_has_downstream');
    expect(tables.consignment_sales_orders[0].status).toBe('CONFIRMED');
  });

  test('Consignment Order: with no child, a lowercase cancel persists CANCELLED', async () => {
    const tables: Record<string, Row[]> = {
      consignment_sales_orders: [{ doc_no: 'CS-1', company_id: CO, status: 'CONFIRMED' }],
      consignment_delivery_orders: [],
    };
    const app = harness(tables);
    const res = await send(app, 'PATCH', '/consignment-orders/CS-1/status', { status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(tables.consignment_sales_orders[0].status).toBe('CANCELLED');
  });
});

describe('a state-guarded lifecycle update reports zero rows as its own refusal, not a 500', () => {
  test('Purchase Return complete: a non-POSTED return gets 409 not_posted', async () => {
    const tables: Record<string, Row[]> = {
      purchase_returns: [{ id: 'pr-1', company_id: CO, return_number: 'PRT-1', status: 'CANCELLED' }],
    };
    const app = harness(tables);
    const res = await send(app, 'PATCH', '/purchase-returns/pr-1/complete', {});
    /* With `.single()` the `.eq('status','POSTED')` gate matched zero rows,
       PostgREST answered PGRST116, and the handler returned 500
       complete_failed — the documented 409 below was unreachable. */
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, any>).error).toBe('not_posted');
    // And nothing was written.
    expect(tables.purchase_returns[0].status).toBe('CANCELLED');
  });

  test('Purchase Return complete: a POSTED return still completes', async () => {
    const tables: Record<string, Row[]> = {
      purchase_returns: [{ id: 'pr-1', company_id: CO, return_number: 'PRT-1', status: 'POSTED' }],
    };
    const app = harness(tables);
    const res = await send(app, 'PATCH', '/purchase-returns/pr-1/complete', { creditNoteRef: 'CN-9' });
    expect(res.status).toBe(200);
    expect(tables.purchase_returns[0].status).toBe('COMPLETED');
    expect(tables.purchase_returns[0].credit_note_ref).toBe('CN-9');
  });
});
