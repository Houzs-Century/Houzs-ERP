// PATCH /purchase-invoices/:id/post answers 200 whether or not the AP journal
// was written — the confirm deliberately never un-posts an invoice whose entry
// failed. The New-PI screen then said "AP liability recorded" every time. These
// tests pin the `ledger` field the screen now reads, for each outcome, on both
// branches of the handler (the DRAFT confirm and the already-POSTED ensure).
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PostPiResult } from '../src/scm/routes/accounting';

const postPi = vi.fn<(sb: unknown, invoiceNumber: string) => Promise<PostPiResult>>();
vi.mock('../src/scm/routes/accounting', async (orig) => ({
  ...(await orig<typeof import('../src/scm/routes/accounting')>()),
  postPiAccounting: (sb: unknown, n: string) => postPi(sb, n),
}));
vi.mock('../src/scm/lib/recost', async (orig) => ({
  ...(await orig<typeof import('../src/scm/lib/recost')>()),
  recostForPi: async () => undefined,
}));

const { postPurchaseInvoiceHandler } = await import('../src/scm/routes/purchase-invoices');

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  gte() { return this; }
  lte() { return this; }
  not() { return this; }
  is() { return this; }
  or() { return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

function app(status: string) {
  const tables: Record<string, Row[]> = {
    purchase_invoices: [{ id: 'pi-1', invoice_number: 'PI-1', company_id: 1, status, total_sen: 100 }],
  };
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      schema() { return this; },
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.patch('/purchase-invoices/:id/post', postPurchaseInvoiceHandler as never);
  return a;
}

const post = async (status: string) => {
  const res = await app(status).request('/purchase-invoices/pi-1/post', { method: 'PATCH' });
  return { status: res.status, body: (await res.json()) as { ledger?: unknown } };
};

beforeEach(() => postPi.mockReset());

describe.each(['DRAFT', 'POSTED'])('PI post from %s — what the answer says about the journal', (from) => {
  test('journal written: posted with its number', async () => {
    postPi.mockResolvedValue({ ok: true, status: 'posted', jeNo: 'JE-9', jeId: 'j9', totalSen: 100 });
    const r = await post(from);
    expect(r.status).toBe(200);
    expect(r.body.ledger).toEqual({ posted: true, status: 'posted', jeNo: 'JE-9' });
  });

  test('a product group with no purchase account: NOT posted, and the reason travels', async () => {
    postPi.mockResolvedValue({ ok: false, status: 'group_unbound', reason: 'Group SOFA has no purchase account.' });
    const r = await post(from);
    expect(r.status).toBe(200);
    expect(r.body.ledger).toEqual({ posted: false, status: 'group_unbound', reason: 'Group SOFA has no purchase account.' });
  });

  test('a zero-total invoice: NOT posted', async () => {
    postPi.mockResolvedValue({ ok: false, status: 'zero_total' });
    expect((await post(from)).body.ledger).toEqual({ posted: false, status: 'zero_total', reason: null });
  });

  test('migrated paperwork: no journal here, and it is not called a failure', async () => {
    postPi.mockResolvedValue({ ok: true, status: 'migrated_source' });
    expect((await post(from)).body.ledger).toEqual({ posted: false, status: 'migrated_source', reason: null });
  });
});

test('a cancelled invoice is not re-posted and carries no ledger claim', async () => {
  const r = await post('CANCELLED');
  expect(postPi).not.toHaveBeenCalled();
  expect(r.body.ledger).toBeUndefined();
});
