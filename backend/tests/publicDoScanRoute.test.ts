// ----------------------------------------------------------------------------
// The no-login delivery-order scan, driven through the REAL route.
//
// Every property here is one a stranger could otherwise exploit, so each is
// exercised against the shipped handler rather than asserted about its source:
//
//   · an unknown token 404s
//   · a REVOKED token gets the SAME answer an unknown one gets — byte for byte,
//     because a different message tells whoever holds a leaked paper that the
//     code used to be real, which is the one fact the kill switch withholds
//   · a malformed token never reaches the database at all
//   · a repeat scan reports "already done" instead of silently taking the NEXT
//     rung — the defect a naive re-scan would produce
//   · no rung goes backwards
//   · the response carries no price, no address, no contact
//
// The status write goes through `patchDeliveryOrderStatusHandler`, imported for
// real: the point of the public route is that there is NO second write path, so
// a test that mocked the writer would be testing the wrong thing.
//
// The fake PostgREST is the harness from doOverDeliveryUnlinkedRoute.test.ts,
// with one addition it needs: `select(col, { head, count })` returns a COUNT, so
// the line-count field on the public summary is a real answer rather than a
// harness zero.
// ----------------------------------------------------------------------------
import { describe, expect, test, vi, beforeEach } from 'vitest';

const CO = 1;
const OTHER_CO = 2;
type Row = Record<string, any>;

/** Every table the fake serves, rebuilt per test. */
let tables: Record<string, Row[]> = {};
/** Every `.from(<table>)` the route made, in order — the DB-touch tripwire. */
let touched: string[] = [];

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private wantCount = false;
  constructor(private rows: Row[]) {}
  select(_cols?: string, opts?: { head?: boolean; count?: string }) {
    if (opts?.count) this.wantCount = true;
    return this;
  }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
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
    const hit = this.run();
    return Promise.resolve(
      this.wantCount ? { data: hit, count: hit.length, error: null } : { data: hit, error: null },
    ).then(res, rej);
  }
}

const fakeClient = () => ({
  from: (t: string) => { touched.push(t); return new FakeQuery((tables[t] ||= [])); },
  rpc: async () => ({ data: true, error: null }),
});

vi.mock('../src/db/supabase', () => ({
  getSupabaseService: () => fakeClient(),
}));

const { publicDoScan } = await import('../src/routes/publicDoScan');

const TOKEN = 'a'.repeat(64);
const REVOKED = 'b'.repeat(64);

function seed(overrides: Row = {}, extra: Row[] = []) {
  tables = {
    delivery_orders: [
      {
        id: 'do-1', do_number: 'HC-DO-2608-001', company_id: CO, status: 'LOADED',
        on_hold: false, debtor_name: 'A Customer', city: 'Klang', state: 'Selangor',
        qr_token: TOKEN, qr_revoked_at: null, so_doc_no: null,
        /* Deliberately present on the ROW and deliberately absent from the
           response — the summary is built from named fields, so a column the
           table happens to carry cannot leak by riding along. */
        delivery_address: '12 Jalan Something, 41200 Klang',
        contact_phone: '+60123456789',
        total_sen: 123456,
        ...overrides,
      },
      ...extra,
    ],
    delivery_order_items: [
      { id: 'l1', delivery_order_id: 'do-1', company_id: CO, item_code: 'X', qty: 1, so_item_id: null },
      { id: 'l2', delivery_order_id: 'do-1', company_id: CO, item_code: 'Y', qty: 2, so_item_id: null },
      /* The other company's line on a same-named document. If the count were
         unscoped it would be 3. */
      { id: 'l3', delivery_order_id: 'do-1', company_id: OTHER_CO, item_code: 'Z', qty: 9, so_item_id: null },
    ],
    inventory_movements: [],
    mfg_sales_orders: [],
    mfg_sales_order_items: [],
    delivery_return_items: [],
  };
  touched = [];
}

const env = {} as never;
const get = (t: string) => publicDoScan.request(`/${t}`, {}, env);
const advance = (t: string, to: unknown) =>
  publicDoScan.request(`/${t}/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to }),
  }, env);

beforeEach(() => seed());

describe('the token is the whole credential', () => {
  test('a malformed token never reaches the database', async () => {
    for (const bad of ['', 'abc', 'z'.repeat(64), `${'a'.repeat(63)}`, `${'a'.repeat(65)}`]) {
      touched = [];
      const res = await get(encodeURIComponent(bad) || 'x');
      expect(res.status).toBe(404);
      expect(touched, `"${bad.slice(0, 8)}…" queried ${touched.join()}`).toEqual([]);
    }
    touched = [];
    const post = await advance('nothex', 'DISPATCHED');
    expect(post.status).toBe(404);
    expect(touched).toEqual([]);
  });

  test('an unknown token 404s', async () => {
    const res = await get('c'.repeat(64));
    expect(res.status).toBe(404);
  });

  test('a REVOKED token gets the identical answer an unknown token gets', async () => {
    seed({ qr_token: REVOKED, qr_revoked_at: '2026-08-26T00:00:00Z' });
    const revoked = await get(REVOKED);
    const unknown = await get('c'.repeat(64));
    expect(revoked.status).toBe(unknown.status);
    expect(await revoked.text()).toBe(await unknown.text());
    // …and it cannot be advanced either.
    expect((await advance(REVOKED, 'DISPATCHED')).status).toBe(404);
  });
});

describe('what the public summary contains, and what it does not', () => {
  test('the five fields, the next rung, and nothing else', async () => {
    const body = await (await get(TOKEN)).json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['area', 'blockReason', 'customerName', 'doNumber', 'itemCount', 'status', 'step'].sort(),
    );
    expect(body.doNumber).toBe('HC-DO-2608-001');
    expect(body.customerName).toBe('A Customer');
    expect(body.area).toBe('Klang, Selangor');
    // Scoped: the other company's line on the same document id is not counted.
    expect(body.itemCount).toBe(2);
    expect((body.step as Record<string, string>).status).toBe('DISPATCHED');
  });

  test('no price, no address, no contact detail appears anywhere in the payload', async () => {
    const text = await (await get(TOKEN)).text();
    for (const leak of ['Jalan Something', '41200', '+60123456789', '123456', 'total_sen']) {
      expect(text, `payload leaked ${leak}`).not.toContain(leak);
    }
  });

  test('the delivered rung carries the sentence naming what it does NOT collect', async () => {
    seed({ status: 'IN_TRANSIT' });
    const body = await (await get(TOKEN)).json() as { step: { status: string; note: string } };
    expect(body.step.status).toBe('DELIVERED');
    expect(body.step.note).toContain('not a signed receipt');
    expect(body.step.note).toContain('Proof of Delivery');
  });
});

describe('the ladder, decided by the server', () => {
  test('one scan moves exactly one rung, through the office writer', async () => {
    const res = await advance(TOKEN, 'DISPATCHED');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'DONE', from: 'LOADED', to: 'DISPATCHED' });
    expect(tables.delivery_orders[0].status).toBe('DISPATCHED');
    // It really went through the shared writer: that handler stamps dispatched_at.
    expect(tables.delivery_orders[0].dispatched_at).toBeTruthy();
  });

  test('a repeat scan says already-done and does NOT take the next rung', async () => {
    await advance(TOKEN, 'DISPATCHED');
    expect(tables.delivery_orders[0].status).toBe('DISPATCHED');
    const again = await advance(TOKEN, 'DISPATCHED');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: 'ALREADY_DONE' });
    // The killer assertion: still DISPATCHED, never advanced to IN_TRANSIT.
    expect(tables.delivery_orders[0].status).toBe('DISPATCHED');
  });

  test('no rung goes backwards', async () => {
    seed({ status: 'IN_TRANSIT' });
    for (const back of ['LOADED', 'DISPATCHED']) {
      const res = await advance(TOKEN, back);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: 'ALREADY_DONE' });
      expect(tables.delivery_orders[0].status).toBe('IN_TRANSIT');
    }
  });

  test('a status the ladder does not have is refused before any query', async () => {
    for (const bogus of ['ON_HOLD', 'SIGNED', 'CANCELLED', 'COMPLETED', '']) {
      touched = [];
      const res = await advance(TOKEN, bogus);
      expect(res.status, `"${bogus}" was accepted`).toBe(400);
      expect(touched).toEqual([]);
    }
  });

  test('a held delivery order gets a sentence and no rung', async () => {
    seed({ on_hold: true });
    const body = await (await get(TOKEN)).json() as { step: unknown; blockReason: string };
    expect(body.step).toBeNull();
    expect(body.blockReason).toContain('on hold');
    const res = await advance(TOKEN, 'DISPATCHED');
    expect(await res.json()).toMatchObject({ outcome: 'BLOCKED' });
    expect(tables.delivery_orders[0].status).toBe('LOADED');
  });

  test('a cancelled delivery order cannot be moved by a scan', async () => {
    seed({ status: 'CANCELLED' });
    const body = await (await get(TOKEN)).json() as { step: unknown; blockReason: string };
    expect(body.step).toBeNull();
    expect(body.blockReason).toContain('cancelled');
    await advance(TOKEN, 'DISPATCHED');
    expect(tables.delivery_orders[0].status).toBe('CANCELLED');
  });
});

describe('the tenant boundary', () => {
  test('the company comes from the resolved ROW — every later statement carries it', async () => {
    /* The other company owns a row with the SAME id. If any statement after the
       resolve ran without the company predicate, the write would be ambiguous
       and could land on the wrong books. Scoped, it can only ever hit ours. */
    seed({}, [{
      id: 'do-1', do_number: 'X-DO-1', company_id: OTHER_CO, status: 'LOADED',
      on_hold: false, debtor_name: 'Someone Else', city: 'Ipoh', state: 'Perak',
      qr_token: null, qr_revoked_at: null,
    }]);
    const res = await advance(TOKEN, 'DISPATCHED');
    expect(res.status).toBe(200);
    const ours = tables.delivery_orders.find((r) => r.company_id === CO)!;
    const theirs = tables.delivery_orders.find((r) => r.company_id === OTHER_CO)!;
    expect(ours.status).toBe('DISPATCHED');
    expect(theirs.status, "the other company's row was touched").toBe('LOADED');
  });

  test('a row carrying no usable company is refused rather than served unscoped', async () => {
    seed({ company_id: null });
    expect((await get(TOKEN)).status).toBe(404);
    expect((await advance(TOKEN, 'DISPATCHED')).status).toBe(404);
  });
});
