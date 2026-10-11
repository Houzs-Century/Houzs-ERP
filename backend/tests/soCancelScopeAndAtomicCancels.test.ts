/* Two lifecycle-action defects found by the 2026-08-17 cancel/confirm/post audit
   and fixed on 2026-08-18. Both are pinned here because a fix with no test that
   BITES is unfixed (CLAUDE.md), and both of these are invisible in normal use:
   one only shows up with a doc number from the other company's books, the other
   only under two concurrent cancels.

   1. PATCH /mfg-sales-orders/:docNo/status carried no company predicate of its
      own. mfg_sales_orders is ONE cross-company table whose doc_no is `text
      PRIMARY KEY` (scripts/scm-schema/2990s-full-schema.sql:638; mig 0083 added
      company_id as a COLUMN, not a per-tenant table), and doc numbers are
      structured — 2990-SO-2607-005 — so they are guessable. The SCM client is
      service-role, so RLS never evaluates.

      MEASURED, because the first reading of this was WRONG and the tests below
      are marked accordingly. The audit that raised it said selfScopedSalesBlocked
      is "a salesperson filter, not a tenancy one". It is BOTH: its step 1
      (mfg-sales-orders.ts:765) is `scopeToCompany(...).maybeSingle()` and returns
      true — a clean 404 — for a doc outside the active company, for every tier
      including view-all. Verified 2026-08-18 by neutering scopeToCompanyId inside
      this router and re-running: the cross-company PATCH still answered
      `404 {"error":"not_found"}`. So a plain cross-tenant cancel was NOT open.

      What WAS open, and is what the fix closes:
        · scopeToCompany DEGRADES to no predicate when the company is unresolved
          (deliberate for reads — see THE ALLOW-LIST SENTINEL in companyScope.ts).
          On a WRITE that degrades to "act on all companies", which is why writes
          use requireActiveCompanyId instead (companyScope.ts's STRICT section).
        · the UPDATE itself carried no company predicate. Nothing re-checks
          between two PostgREST round trips, so a scoped read followed by an open
          update is not a scoped write (CLAUDE.md rule (a)).
      Only the last two tests in this block BITE; the two cross-company ones pass
      against the pre-fix code too and are here to pin behaviour, which is said
      out loud rather than left for the next reader to discover.

   2. The PO and PC-Order cancels flipped ACTIVE→CANCELLED with an unconditional
      UPDATE, while six sibling cancels (grns.ts:2566, sales-invoices.ts:2451,
      delivery-returns.ts:1692, consignment-returns.ts:1112, dp-orders.ts:425,
      stock-transfers.ts:454) all carry `.neq('status','CANCELLED')`. NOT a money
      bug — enqueueCancel dedupes on `cancel:<docType>:<docNo>` and mig
      0277_scm_autocount_outbox.sql:71-72 has a partial unique index on
      (dedupe_key) WHERE status='pending', so a double cancel cannot double-queue
      AutoCount. What it buys is one audit row and one cancelled_at per document.

   Harness copied from companyScopeHardening.test.ts: the EXPORTED handlers on a
   bare Hono app over a fake PostgREST builder, because the supabaseAuth bridge
   cannot run here. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchMfgSalesOrderStatusHandler } from '../src/scm/routes/mfg-sales-orders';
import { cancelPurchaseOrderHandler } from '../src/scm/routes/mfg-purchase-orders';
import { cancelPurchaseConsignmentOrderHandler } from '../src/scm/routes/purchase-consignment-orders';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — same shape and same reason as
   companyScopeHardening.test.ts's: the handlers reach far past the statement
   under test, so every method chains and an unknown table reads as empty.
   `onUpdate` is the one addition: it fires just before an UPDATE is applied, so
   a test can move the row underneath the handler and reproduce a lost race
   without depending on promise interleaving. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(
    private rows: Row[],
    private table: string,
    private log: string[],
    private onUpdate?: (table: string) => void,
  ) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) {
    this.log.push(`${this.table}.${this.op}:eq:${col}`);
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col: string, val: unknown) {
    this.log.push(`${this.table}.${this.op}:neq:${col}`);
    this.preds.push((r) => String(r[col]) !== String(val));
    return this;
  }
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
    if (this.op === 'update') this.onUpdate?.(this.table);
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

function harness(tables: Record<string, Row[]>, companyId: number | undefined, onUpdate?: (t: string) => void) {
  const log: string[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, log, onUpdate),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('companyCode' as never, 'HC' as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/mfg-sales-orders/:docNo/status', patchMfgSalesOrderStatusHandler as never);
  app.patch('/purchase-orders/:id/cancel', cancelPurchaseOrderHandler as never);
  app.patch('/pc-orders/:id/cancel', cancelPurchaseConsignmentOrderHandler as never);
  return { app, log };
}

const jsonPatch = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

// ── 1. SO status PATCH — the tenant boundary ────────────────────────────────
describe('PATCH /mfg-sales-orders/:docNo/status is scoped to the caller\'s company', () => {
  const sos = (): Row[] => [
    { doc_no: 'HC-SO-2607-001', company_id: CO_A, status: 'CONFIRMED', version: 1, debtor_code: 'C1' },
    { doc_no: '2990-SO-2607-005', company_id: CO_B, status: 'CONFIRMED', version: 1, debtor_code: 'C2' },
  ];

  test('A cannot move B\'s order by doc number, and B\'s order is left UNCHANGED', async () => {
    /* PINS, does not bite — see the header: selfScopedSalesBlocked step 1 already
       produced this 404. Both halves are still asserted, because a 404 that wrote
       anyway would pass a status-only assertion. */
    const t = { mfg_sales_orders: sos() };
    const res = await jsonPatch(harness(t, CO_A).app, '/mfg-sales-orders/2990-SO-2607-005/status',
      { status: 'READY_TO_SHIP', version: 1 });
    expect(res.status).toBe(404);
    const victim = t.mfg_sales_orders.find((s) => s.doc_no === '2990-SO-2607-005')!;
    expect(victim.status).toBe('CONFIRMED');
    expect(victim.version).toBe(1);
  });

  test('the cross-company miss reads as a clean not-found, never a 500', async () => {
    /* PINS the shape the fix had to preserve: `maybeSingle`, not `single`, on a
       by-id statement carrying a company predicate. `single()` turns an honest
       404 into a 500, and a 500 reads to the operator as "the system is broken"
       rather than "that is not your document" (CLAUDE.md). */
    const t = { mfg_sales_orders: sos() };
    const res = await jsonPatch(harness(t, CO_A).app, '/mfg-sales-orders/2990-SO-2607-005/status',
      { status: 'CANCELLED', version: 1 });
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('not_found');
  });

  test('A CAN still move its own order — the scope must not hide a company\'s own data', async () => {
    const t = { mfg_sales_orders: sos() };
    const res = await jsonPatch(harness(t, CO_A).app, '/mfg-sales-orders/HC-SO-2607-001/status',
      { status: 'READY_TO_SHIP', version: 1 });
    expect(res.status).toBe(200);
    expect(t.mfg_sales_orders.find((s) => s.doc_no === 'HC-SO-2607-001')!.status).toBe('READY_TO_SHIP');
  });

  test('an unresolved company REFUSES rather than acting across all companies', async () => {
    /* BITES. This is half of what the fix actually changed: the pre-existing gate
       used scopeToCompany, which drops its predicate when the company is
       unresolved, so the handler acted on ALL companies' rows. requireActiveCompanyId
       has no default and no `??` — this repo has pooled the two books twice for
       exactly that reason (companyScope.ts's STRICT section). */
    const t = { mfg_sales_orders: sos() };
    const res = await jsonPatch(harness(t, undefined).app, '/mfg-sales-orders/HC-SO-2607-001/status',
      { status: 'READY_TO_SHIP', version: 1 });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('company_unresolved');
    expect(t.mfg_sales_orders.every((s) => s.status === 'CONFIRMED')).toBe(true);
  });

  test('the company predicate is on the UPDATE, not only on the read before it', async () => {
    /* BITES, and is the other half. CLAUDE.md rule (a): nothing re-checks between
       two PostgREST round trips, so a scoped read followed by an open UPDATE is
       not a scoped write. Asserted on the statement log rather than end-to-end
       precisely because no response code can tell the two apart — the read had
       already refused, which is what made this invisible for so long. */
    const t = { mfg_sales_orders: sos() };
    const h = harness(t, CO_A);
    await jsonPatch(h.app, '/mfg-sales-orders/HC-SO-2607-001/status', { status: 'READY_TO_SHIP', version: 1 });
    expect(h.log).toContain('mfg_sales_orders.update:eq:company_id');
  });
});

// ── 2. The two cancels that lacked the atomic gate ──────────────────────────
describe('PO cancel is a single ACTIVE->CANCELLED transition', () => {
  const pos = (): Row[] => [
    { id: 'po-a', po_number: 'PO-A-1', company_id: CO_A, status: 'SUBMITTED', total_centi: 1000 },
  ];

  test('the UPDATE carries the .neq(status, CANCELLED) gate', async () => {
    const t = { purchase_orders: pos() };
    const h = harness(t, CO_A);
    const res = await jsonPatch(h.app, '/purchase-orders/po-a/cancel');
    expect(res.status).toBe(200);
    expect(t.purchase_orders[0].status).toBe('CANCELLED');
    expect(h.log).toContain('purchase_orders.update:neq:status');
  });

  test('losing the race is an idempotent echo, and writes no second audit row', async () => {
    /* The row is flipped to CANCELLED between the guarded read and the UPDATE —
       a concurrent cancel that committed first. The gate must match 0 rows and
       the handler must return the cancelled state without re-running the audit
       row and the SO-quota release below it. */
    const t: Record<string, Row[]> = { purchase_orders: pos(), entity_audit_log: [] };
    let flipped = false;
    const h = harness(t, CO_A, (table) => {
      if (table === 'purchase_orders' && !flipped) {
        flipped = true;
        t.purchase_orders[0].status = 'CANCELLED';
        t.purchase_orders[0].cancelled_at = 'FIRST-WINNER';
      }
    });
    const res = await jsonPatch(h.app, '/purchase-orders/po-a/cancel');
    expect(res.status).toBe(200);
    expect((await res.json() as Row).purchaseOrder.status).toBe('CANCELLED');
    // The winner's timestamp survives — the loser did not restamp it.
    expect(t.purchase_orders[0].cancelled_at).toBe('FIRST-WINNER');
    expect(t.entity_audit_log).toHaveLength(0);
  });
});

describe('PC Order cancel is a single ACTIVE->CANCELLED transition', () => {
  const pcos = (): Row[] => [
    { id: 'pco-a', pc_number: 'PCO-2607-001', company_id: CO_A, status: 'SUBMITTED' },
  ];

  test('the UPDATE carries the .neq(status, CANCELLED) gate', async () => {
    const t = { purchase_consignment_orders: pcos() };
    const h = harness(t, CO_A);
    const res = await jsonPatch(h.app, '/pc-orders/pco-a/cancel');
    expect(res.status).toBe(200);
    expect(t.purchase_consignment_orders[0].status).toBe('CANCELLED');
    expect(h.log).toContain('purchase_consignment_orders.update:neq:status');
  });

  test('losing the race echoes the cancelled state and does not restamp cancelled_at', async () => {
    const t: Record<string, Row[]> = { purchase_consignment_orders: pcos() };
    let flipped = false;
    const h = harness(t, CO_A, (table) => {
      if (table === 'purchase_consignment_orders' && !flipped) {
        flipped = true;
        t.purchase_consignment_orders[0].status = 'CANCELLED';
        t.purchase_consignment_orders[0].cancelled_at = 'FIRST-WINNER';
      }
    });
    const res = await jsonPatch(h.app, '/pc-orders/pco-a/cancel');
    expect(res.status).toBe(200);
    expect((await res.json() as Row).purchaseConsignmentOrder.status).toBe('CANCELLED');
    expect(t.purchase_consignment_orders[0].cancelled_at).toBe('FIRST-WINNER');
  });
});
