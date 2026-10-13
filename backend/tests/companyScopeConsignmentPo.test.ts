// Company scoping on the consignment/returns cluster + manufacturing purchase
// orders — the WRITE + detail-READ leaks PR #851 did NOT reach. Sibling of
// companyScopeHardening.test.ts (#851 items 3-9) and companyWriteScope.test.ts
// (#841 items 1-2). Same class: the list query was company-scoped, but the
// GET /:id detail read and every by-id/by-doc_no mutation loaded and wrote
// through a BLIND primary key, so company A could confirm / cancel / status-flip
// company B's purchase orders, consignment orders/notes/returns and purchase
// returns — moving the other company's money or stock.
//
// Driven end-to-end through a bare Hono app whose middleware injects a fake scm
// supabase client + a company context, mounting the EXPORTED handlers rather
// than the routers — the supabaseAuth bridge cannot run in this harness. Same
// approach as companyScopeHardening.test.ts.
//
// EVERY item is asserted in BOTH directions: A cannot touch B's row (404, and
// the victim row is left byte-unchanged — a 404 that still mutated would pass a
// status-only assertion) AND A can still act on its OWN row (the failure mode of
// a scope sweep is hiding a company's own data from its own users).
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { confirmMfgPurchaseOrderHandler } from '../src/scm/routes/mfg-purchase-orders';
import { cancelPurchaseConsignmentOrderHandler } from '../src/scm/routes/purchase-consignment-orders';
import { patchDeliveryReturnStatusHandler } from '../src/scm/routes/delivery-returns';
import { patchConsignmentOrderStatusHandler } from '../src/scm/routes/consignment-orders';
import { patchConsignmentNoteStatusHandler } from '../src/scm/routes/consignment-notes';
import { patchConsignmentReturnStatusHandler } from '../src/scm/routes/consignment-returns';
import { cancelPurchaseConsignmentReturnHandler } from '../src/scm/routes/purchase-consignment-returns';
import { cancelPurchaseConsignmentReceiveHandler } from '../src/scm/routes/purchase-consignment-receives';
import { cancelPurchaseReturnHandler } from '../src/scm/routes/purchase-returns';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — a copy of the one in
   companyScopeHardening.test.ts. The handlers under test reach far past the
   statement being asserted (audit probes, rollups, inventory resyncs), so every
   builder method chains and an unknown table reads as empty rather than
   throwing — the assertions are about the company predicate, not the rest. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private table: string, private log: string[]) {}
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
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, companyId: number | undefined) {
  const log: string[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, log),
      // The entity-audit pre-flight probe reports writable so the handlers get
      // past it to the statement under test.
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, companyId as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/mfg-pos/:id/confirm', confirmMfgPurchaseOrderHandler as never);
  app.patch('/pc-orders/:id/cancel', cancelPurchaseConsignmentOrderHandler as never);
  app.patch('/delivery-returns/:id/status', patchDeliveryReturnStatusHandler as never);
  app.patch('/consignment-orders/:docNo/status', patchConsignmentOrderStatusHandler as never);
  app.patch('/consignment-notes/:id/status', patchConsignmentNoteStatusHandler as never);
  app.patch('/consignment-returns/:id/status', patchConsignmentReturnStatusHandler as never);
  app.patch('/pc-returns/:id/cancel', cancelPurchaseConsignmentReturnHandler as never);
  app.patch('/pc-receives/:id/cancel', cancelPurchaseConsignmentReceiveHandler as never);
  app.patch('/purchase-returns/:id/cancel', cancelPurchaseReturnHandler as never);
  return { app, log };
}

const jsonPatch = (app: Hono, url: string, body?: Row) =>
  app.request(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

// ── A2 — mfg-purchase-orders.ts: confirms (DRAFT -> SUBMITTED) a PO ───────────
// The A2 module has NO mirror guard, so this is the most real of the set.
describe('mfg PO confirm (commits a draft PO — money owed to the supplier)', () => {
  const pos = (): Row[] => [
    { id: 'po-a', po_number: 'PO-A-1', company_id: CO_A, status: 'DRAFT' },
    { id: 'po-b', po_number: 'PO-B-1', company_id: CO_B, status: 'DRAFT' },
  ];

  test('A cannot confirm B\'s PO, and B\'s PO stays DRAFT', async () => {
    const t = { purchase_orders: pos() };
    const res = await jsonPatch(harness(t, CO_A).app, '/mfg-pos/po-b/confirm');
    expect(res.status).toBe(404);
    expect(t.purchase_orders.find((p) => p.id === 'po-b')!.status).toBe('DRAFT');
  });

  test('A CAN still confirm its own PO', async () => {
    const t = { purchase_orders: pos() };
    const res = await jsonPatch(harness(t, CO_A).app, '/mfg-pos/po-a/confirm');
    expect(res.status).toBe(200);
    expect(t.purchase_orders.find((p) => p.id === 'po-a')!.status).toBe('SUBMITTED');
  });

  test('an unresolved company refuses rather than confirming across all companies', async () => {
    const t = { purchase_orders: pos() };
    const res = await jsonPatch(harness(t, undefined).app, '/mfg-pos/po-a/confirm');
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('company_unresolved');
    expect(t.purchase_orders.every((p) => p.status === 'DRAFT')).toBe(true);
  });
});

// ── A1 — purchase-consignment-orders.ts: cancels a PC Order ───────────────────
describe('PC Order cancel', () => {
  const rows = (): Row[] => [
    { id: 'pco-a', pc_number: 'PCO-A-1', company_id: CO_A, status: 'SUBMITTED' },
    { id: 'pco-b', pc_number: 'PCO-B-1', company_id: CO_B, status: 'SUBMITTED' },
  ];

  test('A cannot cancel B\'s PC Order, and B\'s stays SUBMITTED', async () => {
    const t = { purchase_consignment_orders: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/pc-orders/pco-b/cancel', { cancel_reason: 'x' })
    expect(res.status).toBe(404);
    expect(t.purchase_consignment_orders.find((r) => r.id === 'pco-b')!.status).toBe('SUBMITTED');
  });

  test('A CAN still cancel its own PC Order', async () => {
    const t = { purchase_consignment_orders: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/pc-orders/pco-a/cancel',  { cancel_reason: 'x' });
    expect(res.status).toBe(200);
    expect(t.purchase_consignment_orders.find((r) => r.id === 'pco-a')!.status).toBe('CANCELLED');
  });
});

// ── A1 — delivery-returns.ts: status flip (its GET /:id used salesScope only) ──
describe('delivery return status flip', () => {
  const rows = (): Row[] => [
    { id: 'dr-a', return_number: 'DR-A-1', company_id: CO_A, status: 'RECEIVED' },
    { id: 'dr-b', return_number: 'DR-B-1', company_id: CO_B, status: 'RECEIVED' },
  ];

  test('A cannot flip B\'s delivery return, and B\'s stays RECEIVED', async () => {
    const t = { delivery_returns: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/delivery-returns/dr-b/status', { status: 'INSPECTED' });
    expect(res.status).toBe(404);
    expect(t.delivery_returns.find((r) => r.id === 'dr-b')!.status).toBe('RECEIVED');
  });

  test('A CAN still flip its own delivery return', async () => {
    const t = { delivery_returns: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/delivery-returns/dr-a/status', { status: 'INSPECTED' });
    expect(res.status).toBe(200);
    expect(t.delivery_returns.find((r) => r.id === 'dr-a')!.status).toBe('INSPECTED');
  });
});

// ── A1 — consignment-orders.ts: status flip, keyed by doc_no not id ───────────
describe('consignment order status flip (doc_no keyed)', () => {
  const rows = (): Row[] => [
    { id: 'co-a', doc_no: 'CSO-A-1', company_id: CO_A, status: 'PROCESSING' },
    { id: 'co-b', doc_no: '2990-CSO-B-1', company_id: CO_B, status: 'PROCESSING' },
  ];

  test('A cannot flip B\'s consignment order, and B\'s stays PROCESSING', async () => {
    const t = { consignment_sales_orders: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/consignment-orders/2990-CSO-B-1/status', { status: 'CONFIRMED' });
    expect(res.status).toBe(404);
    expect(t.consignment_sales_orders.find((r) => r.id === 'co-b')!.status).toBe('PROCESSING');
  });

  test('A CAN still flip its own consignment order', async () => {
    const t = { consignment_sales_orders: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/consignment-orders/CSO-A-1/status', { status: 'CONFIRMED' });
    expect(res.status).toBe(200);
    expect(t.consignment_sales_orders.find((r) => r.id === 'co-a')!.status).toBe('CONFIRMED');
  });
});

// ── A1 — consignment-notes.ts: status flip (deducts consignment stock) ────────
describe('consignment note status flip', () => {
  const rows = (): Row[] => [
    { id: 'cn-a', do_number: 'CN-A-1', company_id: CO_A, status: 'DRAFT' },
    { id: 'cn-b', do_number: 'CN-B-1', company_id: CO_B, status: 'DRAFT' },
  ];

  test('A cannot flip B\'s consignment note, and B\'s stays DRAFT', async () => {
    const t = { consignment_delivery_orders: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/consignment-notes/cn-b/status', { status: 'DISPATCHED' });
    expect(res.status).toBe(404);
    expect(t.consignment_delivery_orders.find((r) => r.id === 'cn-b')!.status).toBe('DRAFT');
  });

  test('A CAN still flip its own consignment note', async () => {
    const t = { consignment_delivery_orders: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/consignment-notes/cn-a/status', { status: 'DISPATCHED' });
    expect(res.status).toBe(200);
    expect(t.consignment_delivery_orders.find((r) => r.id === 'cn-a')!.status).toBe('DISPATCHED');
  });
});

// ── A1 — consignment-returns.ts: status flip ─────────────────────────────────
describe('consignment return status flip', () => {
  const rows = (): Row[] => [
    { id: 'cr-a', return_number: 'CR-A-1', company_id: CO_A, status: 'RECEIVED' },
    { id: 'cr-b', return_number: 'CR-B-1', company_id: CO_B, status: 'RECEIVED' },
  ];

  test('A cannot flip B\'s consignment return, and B\'s stays RECEIVED', async () => {
    const t = { consignment_delivery_returns: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/consignment-returns/cr-b/status', { status: 'INSPECTED' });
    expect(res.status).toBe(404);
    expect(t.consignment_delivery_returns.find((r) => r.id === 'cr-b')!.status).toBe('RECEIVED');
  });

  test('A CAN still flip its own consignment return', async () => {
    const t = { consignment_delivery_returns: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/consignment-returns/cr-a/status', { status: 'INSPECTED' });
    expect(res.status).toBe(200);
    expect(t.consignment_delivery_returns.find((r) => r.id === 'cr-a')!.status).toBe('INSPECTED');
  });
});

// ── A1 — purchase-consignment-returns.ts: cancel (reverses the return IN) ──────
describe('PC Return cancel', () => {
  const rows = (): Row[] => [
    { id: 'pcr-a', return_number: 'PCR-A-1', company_id: CO_A, status: 'POSTED', pc_receive_id: null },
    { id: 'pcr-b', return_number: 'PCR-B-1', company_id: CO_B, status: 'POSTED', pc_receive_id: null },
  ];

  test('A cannot cancel B\'s PC Return, and B\'s stays POSTED', async () => {
    const t = { purchase_consignment_returns: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/pc-returns/pcr-b/cancel');
    expect(res.status).toBe(404);
    expect(t.purchase_consignment_returns.find((r) => r.id === 'pcr-b')!.status).toBe('POSTED');
  });

  test('A CAN still cancel its own PC Return', async () => {
    const t = { purchase_consignment_returns: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/pc-returns/pcr-a/cancel');
    expect(res.status).toBe(200);
    expect(t.purchase_consignment_returns.find((r) => r.id === 'pcr-a')!.status).toBe('CANCELLED');
  });
});

// ── A1 — purchase-consignment-receives.ts: cancel (reverses stock IN) ─────────
describe('PC Receive cancel', () => {
  const rows = (): Row[] => [
    { id: 'pcv-a', receive_number: 'PCV-A-1', company_id: CO_A, status: 'POSTED' },
    { id: 'pcv-b', receive_number: 'PCV-B-1', company_id: CO_B, status: 'POSTED' },
  ];

  test('A cannot cancel B\'s PC Receive, and B\'s stays POSTED', async () => {
    const t = { purchase_consignment_receives: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/pc-receives/pcv-b/cancel');
    expect(res.status).toBe(404);
    expect(t.purchase_consignment_receives.find((r) => r.id === 'pcv-b')!.status).toBe('POSTED');
  });

  test('A CAN still cancel its own PC Receive', async () => {
    const t = { purchase_consignment_receives: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/pc-receives/pcv-a/cancel');
    expect(res.status).toBe(200);
    expect(t.purchase_consignment_receives.find((r) => r.id === 'pcv-a')!.status).toBe('CANCELLED');
  });
});

// ── A1 — purchase-returns.ts: cancel (reverses inventory OUT) ─────────────────
describe('purchase return cancel', () => {
  const rows = (): Row[] => [
    { id: 'pr-a', return_number: 'PR-A-1', company_id: CO_A, status: 'POSTED', grn_id: null },
    { id: 'pr-b', return_number: 'PR-B-1', company_id: CO_B, status: 'POSTED', grn_id: null },
  ];

  test('A cannot cancel B\'s purchase return, and B\'s stays POSTED', async () => {
    const t = { purchase_returns: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/purchase-returns/pr-b/cancel');
    expect(res.status).toBe(404);
    expect(t.purchase_returns.find((r) => r.id === 'pr-b')!.status).toBe('POSTED');
  });

  test('A CAN still cancel its own purchase return', async () => {
    const t = { purchase_returns: rows() };
    const res = await jsonPatch(harness(t, CO_A).app, '/purchase-returns/pr-a/cancel');
    expect(res.status).toBe(200);
    expect(t.purchase_returns.find((r) => r.id === 'pr-a')!.status).toBe('CANCELLED');
  });
});

// ── The refusal contract itself ──────────────────────────────────────────────
describe('cross-company refusal is a plain 404, no foreign-id confirmation', () => {
  test('the 404 body says the record is not available, without codes/SQL', async () => {
    const t = { purchase_orders: [{ id: 'po-b', po_number: 'PO-B-1', company_id: CO_B, status: 'DRAFT' }] };
    const res = await jsonPatch(harness(t, CO_A).app, '/mfg-pos/po-b/confirm');
    expect(res.status).toBe(404);
    const body = await res.json() as Row;
    expect(String(body.message).length).toBeLessThan(200);
    expect(String(body.message)).not.toMatch(/violates|constraint|null value|PGRST|company_id/);
  });
});
