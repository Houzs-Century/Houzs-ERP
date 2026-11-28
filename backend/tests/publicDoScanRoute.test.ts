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
/** Tables told to answer the way PostgREST does when a query fails: no rows AND
 *  an `error`. supabase-js does not throw, so this is the ONLY shape a caller
 *  can tell a blip from an empty document by. */
let failing = new Set<string>();
/** Peak number of status WRITES in flight at once. 1 = strictly sequential. */
let peakConcurrentWrites = 0;
let inFlightWrites = 0;
/** Delivery orders whose status UPDATE answers with a database error. */
let failStatusWriteIds = new Set<string>();

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private fails = false;
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private wantCount = false;
  constructor(private rows: Row[], fails = false) { this.fails = fails; }
  select(_cols?: string, opts?: { head?: boolean; count?: string }) {
    if (opts?.count) this.wantCount = true;
    return this;
  }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  /* Status writes are counted so the run's SEQUENTIAL rule is a measurement
     rather than a comment. An `await` between two of them is the whole defence
     against the deadlock Hookka paid for. */
  private async gate<T>(make: () => T): Promise<T> {
    const isStatusWrite = this.op === 'update' && 'status' in this.patch;
    if (!isStatusWrite) return make();
    inFlightWrites += 1;
    peakConcurrentWrites = Math.max(peakConcurrentWrites, inFlightWrites);
    await new Promise((r) => setTimeout(r, 0));
    const out = make();
    inFlightWrites -= 1;
    return out;
  }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  is(col: string, val: unknown) {
    if (val === null) this.preds.push((r) => r[col] === null || r[col] === undefined);
    else this.preds.push((r) => r[col] === val);
    return this;
  }
  /* FAITHFUL, not a no-op. The stop read relies on `.order('stop_no')` for the
     sequence the dispatcher built, and a harness that ignores it certifies an
     ordering nobody checked — the exact "a checker that cannot match reports a
     clean run" trap. With this, deleting the .order() from the route turns the
     stop-order assertion red. */
  private sortBy: { col: string; asc: boolean } | null = null;
  order(col: string, opts?: { ascending?: boolean }) {
    this.sortBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    if (this.sortBy) {
      const { col, asc } = this.sortBy;
      hit.sort((a, b) => {
        const x = a[col], y = b[col];
        if (x === y) return 0;
        return (x > y ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    return hit;
  }
  maybeSingle() {
    if (this.fails) return Promise.resolve({ data: null, error: { message: 'connection closed' } });
    if (this.op === 'update' && 'status' in this.patch
      && this.rows.some((r) => failStatusWriteIds.has(r.id) && this.preds.every((p) => p(r)))) {
      return Promise.resolve({ data: null, error: { message: 'deadlock detected' } });
    }
    return this.gate(() => { const h = this.run(); return { data: h[0] ?? null, error: null }; });
  }
  single() {
    return this.gate(() => {
      const h = this.run();
      return { data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } };
    });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    if (this.fails) {
      return Promise.resolve({ data: null, count: null, error: { message: 'connection closed' } }).then(res, rej);
    }
    const hit = this.run();
    return Promise.resolve(
      this.wantCount ? { data: hit, count: hit.length, error: null } : { data: hit, error: null },
    ).then(res, rej);
  }
}

const fakeClient = () => ({
  from: (t: string) => { touched.push(t); return new FakeQuery((tables[t] ||= []), failing.has(t)); },
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
    trips: [],
    trip_stops: [],
    inventory_movements: [],
    mfg_sales_orders: [],
    mfg_sales_order_items: [],
    delivery_return_items: [],
  };
  touched = [];
  failing = new Set();
  peakConcurrentWrites = 0;
  inFlightWrites = 0;
  failStatusWriteIds = new Set();
}

const env = {} as never;
const get = (t: string) => publicDoScan.request(`/${t}`, {}, env);
const advance = (t: string, to: unknown) =>
  publicDoScan.request(`/${t}/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to }),
  }, env);

const batchLookup = (tokens: unknown) =>
  publicDoScan.request('/batch/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tokens }),
  }, env);
const batchAdvance = (tokens: unknown, to: unknown) =>
  publicDoScan.request('/batch/advance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tokens, to }),
  }, env);

/** A second and third delivery order, each with its own token. */
const TOKEN_2 = 'c'.repeat(64);
const TOKEN_3 = 'd'.repeat(64);
const doRow = (id: string, token: string, over: Row = {}): Row => ({
  id, do_number: `HC-DO-2608-${id}`, company_id: CO, status: 'LOADED', on_hold: false,
  debtor_name: 'A Customer', city: 'Klang', state: 'Selangor',
  qr_token: token, qr_revoked_at: null, so_doc_no: null, ...over,
});

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
    /* `kind` joined the payload when the packing list became scannable too: one
       token space, two kinds, and the page branches on what the SERVER reports
       rather than guessing from the token, which is identical for both by
       design. Still no money, no address, no contact. */
    expect(Object.keys(body).sort()).toEqual(
      ['area', 'blockReason', 'customerName', 'doNumber', 'itemCount', 'kind', 'status', 'step'].sort(),
    );
    expect(body.kind).toBe('do');
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

describe('an unanswered read is never rendered as an empty one', () => {
  test('a failed line count is null, NEVER 0 — "0 lines" would be a claim about the load', async () => {
    /* The document itself still resolves; only the count read fails. That is
       exactly the case an unbound `error` renders as a delivery order with
       nothing on it, which is a statement about the lorry rather than a report
       of what we hold. */
    failing.add('delivery_order_items');
    const body = await (await get(TOKEN)).json() as { itemCount: number | null; doNumber: string };
    expect(body.doNumber).toBe('HC-DO-2608-001');
    expect(body.itemCount, 'a failed count must not read as an empty document').toBeNull();
  });

  test('a failed token resolve is 503 "try again", NOT "unknown code"', async () => {
    /* A blip must not tell a driver standing at a lorry that his paper is dead.
       It leaks nothing either — a failed read fails for every token alike, so
       the answer says nothing about the one in hand, unlike revocation. */
    failing.add('delivery_orders');
    expect((await get(TOKEN)).status).toBe(503);
    expect((await advance(TOKEN, 'DISPATCHED')).status).toBe(503);
  });

  test('…and REVOCATION is still folded into the unknown answer', async () => {
    /* The distinction above must not have opened a door: a revoked token gets
       the unknown answer, not a third one. */
    seed({ qr_token: REVOKED, qr_revoked_at: '2026-08-26T00:00:00Z' });
    const revoked = await get(REVOKED);
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe(await (await get('c'.repeat(64))).text());
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

// ────────────────────────────────────────────────────────────────────────────
// THE PACKING LIST — one scan, the whole run.
//
// The spec quotes the owner: 「scan packing list 会将该 list 内的货物统一全部出
// 完」. A packing list is a TRIP, and a trip is a row (scm.trips, mig 0053) with
// company_id NOT NULL on it (mig 0083) — the same properties the delivery-order
// token rests on, which is why this is the same mechanism and not a second one.
//
// The properties that are NEW here, and each is a way a dock could be misled:
//   · every drop moves, in stop order, ONE AT A TIME
//   · one refusal never aborts the rest, and every drop gets its own line
//   · a drop on ANOTHER COMPANY'S books is refused, and named only by its stop
//     number — printing its document number would be the leak
//   · a re-scan of the sheet says "already done" per drop and drags nothing on
// ────────────────────────────────────────────────────────────────────────────
const TRIP_TOKEN = 'd'.repeat(64);

/** A run of `n` drops, all on `status`, all this company's unless overridden. */
function seedRun(opts: {
  members?: Array<{ status?: string; company_id?: number; on_hold?: boolean }>;
  tripCompany?: number;
} = {}) {
  seed();
  const list = opts.members ?? [{}, {}];
  tables.trips = [{
    id: 'trip-1', company_id: opts.tripCompany ?? CO, trip_no: 'TRIP-2608-001',
    trip_date: '2026-08-26', status: 'PLANNED', qr_token: TRIP_TOKEN, qr_revoked_at: null,
  }];
  tables.trip_stops = [];
  tables.delivery_orders = [];
  tables.delivery_order_items = [];
  list.forEach((m, i) => {
    const id = `run-do-${i + 1}`;
    /* Stops are seeded OUT OF ORDER on purpose — the route must sort by
       stop_no, not trust insertion order. */
    tables.trip_stops.unshift({
      id: `stop-${i + 1}`, trip_id: 'trip-1', stop_no: i + 1, do_id: id, company_id: CO,
    });
    tables.delivery_orders.push({
      id, do_number: `HC-DO-2608-10${i + 1}`, company_id: m.company_id ?? CO,
      status: m.status ?? 'LOADED', on_hold: m.on_hold ?? false,
      debtor_name: `Customer ${i + 1}`, city: 'Klang', state: 'Selangor',
      qr_token: null, qr_revoked_at: null, so_doc_no: null,
    });
    tables.delivery_order_items.push({
      id: `${id}-l1`, delivery_order_id: id, company_id: CO, item_code: 'X', qty: 1, so_item_id: null,
    });
  });
  touched = [];
  failing = new Set();
}

describe('scanning the packing list', () => {
  test('the sheet reads as a RUN, in stop order, with a drop count and no money', async () => {
    seedRun({ members: [{}, {}, {}] });
    const res = await get(TRIP_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.kind).toBe('trip');
    expect(body.tripNo).toBe('TRIP-2608-001');
    expect(body.members.map((m: any) => m.stopNo)).toEqual([1, 2, 3]);
    expect(body.step.status).toBe('DISPATCHED');
    const text = JSON.stringify(body);
    for (const leak of ['Jalan', '41200', '+60', 'total_sen']) expect(text).not.toContain(leak);
  });

  test('ONE scan advances EVERY drop on the run', async () => {
    seedRun({ members: [{}, {}, {}] });
    const body = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.outcome).toBe('DONE');
    expect(body.members).toHaveLength(3);
    expect(body.members.every((m: any) => m.outcome === 'DONE')).toBe(true);
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'DISPATCHED', 'DISPATCHED']);
    // Through the shared office writer: it stamps dispatched_at.
    expect(tables.delivery_orders.every((d) => d.dispatched_at)).toBe(true);
  });

  test('a re-scan of the sheet says already-done per drop and drags nothing on', async () => {
    seedRun({ members: [{}, {}] });
    await advance(TRIP_TOKEN, 'DISPATCHED');
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'DISPATCHED']);
    const again = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(again.members.every((m: any) => m.outcome === 'ALREADY_DONE')).toBe(true);
    // The killer assertion: nothing walked on to IN_TRANSIT.
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'DISPATCHED']);
  });

  test('one held drop does NOT abort the rest, and is named', async () => {
    seedRun({ members: [{}, { on_hold: true }, {}] });
    const body = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.outcome).toBe('PARTIAL');
    const byStop = Object.fromEntries(body.members.map((m: any) => [m.stopNo, m]));
    expect(byStop[1].outcome).toBe('DONE');
    expect(byStop[2].outcome).toBe('BLOCKED');
    expect(byStop[2].message).toContain('on hold');
    expect(byStop[3].outcome).toBe('DONE');
    // The two movable drops really moved; the held one really did not.
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'LOADED', 'DISPATCHED']);
  });

  /* SEQUENTIAL, MEASURED. Two drops on one run frequently share a sales order,
     and the status writer updates it on the delivered hop; firing them together
     takes that shared row in different lock order and deadlocks. Hookka wrote
     the incident down after paying for it. This counts writes in flight rather
     than reading the source, so a Promise.all introduced tomorrow fails here. */
  test('the drops are written ONE AT A TIME, never in parallel', async () => {
    seedRun({ members: [{}, {}, {}, {}, {}] });
    const body = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.members).toHaveLength(5);
    expect(peakConcurrentWrites, 'status writes overlapped — the run is running in parallel').toBe(1);
  });

  test('the run offers the rung its FURTHEST-BEHIND drop is ready for', async () => {
    /* A straggler must not be skipped: one drop already advanced by its own DO
       QR should not carry the whole sheet past the one that has not moved. */
    seedRun({ members: [{ status: 'DISPATCHED' }, { status: 'LOADED' }] });
    const body = await (await get(TRIP_TOKEN)).json() as any;
    expect(body.step.status).toBe('DISPATCHED');
  });
});

describe('the packing list QR marks the WHOLE lorry Loaded, and nothing else', () => {
  /* Owner, 2026-11-27: one scan of the packing list when the lorry is full marks every
     delivery order on it Loaded (DB DISPATCHED). Never confirms a Draft, never moves
     anything past Loaded or back, and never touches a cancelled one. */
  const MIXED = [
    { status: 'LOADED' }, { status: 'DISPATCHED' }, { status: 'IN_TRANSIT' },
    { status: 'DELIVERED' }, { status: 'DRAFT' }, { status: 'CANCELLED' }, { status: 'SIGNED' },
  ];
  const seedMixed = () => {
    seedRun({ members: MIXED });
    // Every confirmed DO already has its stock OUT on file (the confirm wrote it).
    tables.inventory_movements = tables.delivery_orders
      .filter((d) => d.status !== 'DRAFT' && d.status !== 'CANCELLED')
      .map((d) => ({ id: `mv-${d.id}`, source_doc_type: 'DO', source_doc_id: d.id, movement_type: 'OUT', qty: 1 }));
    tables.delivery_order_crew = tables.delivery_orders.map((d) => ({
      do_id: d.id, company_id: CO, lorry_plate: 'VJK 8821',
    }));
  };

  test('mixed statuses: only Confirmed moves to Loaded; the rest are left alone and named', async () => {
    seedMixed();
    const res = await advance(TRIP_TOKEN, 'DISPATCHED');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.mode).toBe('load_all');
    expect(body.members.map((m: any) => m.outcome)).toEqual(
      ['DONE', 'ALREADY_DONE', 'PAST', 'PAST', 'BLOCKED', 'BLOCKED', 'PAST'],
    );
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(
      ['DISPATCHED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'DRAFT', 'CANCELLED', 'SIGNED'],
    );
    expect(body.headline).toBe('Lorry VJK 8821: 2 of 7 delivery orders loaded');
    expect(body.members[0].customerName).toBe('Customer 1');
    expect(body.members[4].message).toContain('Draft');
    expect(body.members[5].message).toContain('cancelled');
    // The confirm already took the stock out; loading writes no second movement,
    // and the Draft got none at all.
    expect(tables.inventory_movements).toHaveLength(5);
    expect(tables.inventory_movements.some((m) => m.source_doc_id === 'run-do-5')).toBe(false);
  });

  test('scanning twice changes nothing the second time', async () => {
    seedMixed();
    await advance(TRIP_TOKEN, 'DISPATCHED');
    const after1 = JSON.stringify(tables.delivery_orders);
    const again = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(again.moved).toBe(0);
    expect(again.members.some((m: any) => m.outcome === 'DONE')).toBe(false);
    expect(again.headline).toBe('Lorry VJK 8821: 2 of 7 delivery orders loaded');
    expect(JSON.stringify(tables.delivery_orders)).toBe(after1);
  });

  test('a drop the office writer refuses is reported "not loaded" and the rest still load', async () => {
    seedRun({ members: [{}, {}, {}] });
    failStatusWriteIds = new Set(['run-do-2']);
    const body = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.outcome).toBe('PARTIAL');
    expect(body.members.map((m: any) => m.outcome)).toEqual(['DONE', 'FAILED', 'DONE']);
    expect(body.members[1].message).toMatch(/^Not loaded: /);
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'LOADED', 'DISPATCHED']);
    expect(body.headline).toContain('2 of 3');
  });

  test('a drop that moved on after it was read is refused, never dragged back to Loaded', async () => {
    /* The run reads the status, then each write happens later. If the driver's own DO
       scan moved this one to In Transit in between, writing DISPATCHED would move it
       backwards: the office writer's expectFrom check refuses that. */
    seedRun({ members: [{}] });
    const row = tables.delivery_orders[0];
    let reads = 0;
    let stored = 'IN_TRANSIT';
    Object.defineProperty(row, 'status', {
      enumerable: true, configurable: true,
      get: () => (reads++ === 0 ? 'LOADED' : stored),
      set: (v: string) => { stored = v; },
    });
    const body = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.members[0].outcome).toBe('FAILED');
    expect(body.members[0].message).toContain('status changed');
    expect(stored).toBe('IN_TRANSIT');
  });

  test('the packing list refuses any other step, so it can never walk the lorry on', async () => {
    seedRun({ members: [{ status: 'DISPATCHED' }, { status: 'DISPATCHED' }] });
    for (const to of ['IN_TRANSIT', 'DELIVERED', 'LOADED']) {
      const res = await advance(TRIP_TOKEN, to);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe('load_only');
    }
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'DISPATCHED']);
  });

  test('the page is told what each drop will do before the press', async () => {
    seedMixed();
    const body = await (await get(TRIP_TOKEN)).json() as any;
    expect(body.mode).toBe('load_all');
    expect(body.lorryPlate).toBe('VJK 8821');
    expect(body.step).toMatchObject({ status: 'DISPATCHED', label: 'Mark whole lorry loaded' });
    expect(body.members.map((m: any) => m.willLoad)).toEqual([true, false, false, false, false, false, false]);
    expect(body.members[1].note).toContain('Already loaded');
  });

  test('a lorry already fully loaded offers no button', async () => {
    seedRun({ members: [{ status: 'DISPATCHED' }, { status: 'IN_TRANSIT' }] });
    const body = await (await get(TRIP_TOKEN)).json() as any;
    expect(body.step).toBeNull();
    expect(body.blockReason).toContain('already loaded');
  });

  test('a lorry with only a Draft left says how many are loaded and offers no button', async () => {
    seedRun({ members: [{ status: 'DISPATCHED' }, { status: 'DRAFT' }] });
    const body = await (await get(TRIP_TOKEN)).json() as any;
    expect(body.step).toBeNull();
    expect(body.blockReason).toContain('1 of 2 already loaded');
    expect(body.members[1].note).toContain('Draft');
  });

  test('the lorry plate is read in the run\'s company only', async () => {
    seedRun({ members: [{}] });
    tables.delivery_order_crew = [
      { do_id: 'run-do-1', company_id: OTHER_CO, lorry_plate: 'OTHER 1' },
    ];
    const body = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.lorryPlate).toBeNull();
    expect(body.headline).toBe('Packing list TRIP-2608-001: 1 of 1 delivery order loaded');
  });

  test('a delivery order\'s own QR still moves exactly one step at a time', async () => {
    seed({ status: 'DISPATCHED' });
    const res = await advance(TOKEN, 'IN_TRANSIT');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).outcome).toBe('DONE');
    expect(tables.delivery_orders[0].status).toBe('IN_TRANSIT');
  });
});

/* ── THE LORRY-DAY SHEET: a packing list printed per lorry per day, no trip ──
   Its token (scm.packing_scan_sets) names the DOs PRINTED on it. The scan loads
   those, through the same code as the trip sheet, and leaves alone any whose
   lorry changed since printing. */
const SHEET_TOKEN = 'k7m2n9p4q8';
const uuidFor = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function seedLorryDay(opts: {
  members?: Array<{ status?: string; plate?: string | null; vehicle?: string | null; company_id?: number; on_hold?: boolean }>;
  sheetCompany?: number;
  revoked?: boolean;
  preparedAt?: string | null;
  loadedAt?: string | null;
  region?: string;
} = {}) {
  seed();
  const list = opts.members ?? [{}, {}];
  tables.delivery_orders = [];
  tables.delivery_order_items = [];
  tables.delivery_order_crew = [];
  list.forEach((m, i) => {
    const id = uuidFor(i + 1);
    tables.delivery_orders.push({
      id, do_number: `HC-DO-2611-20${i + 1}`, company_id: m.company_id ?? CO,
      status: m.status ?? 'LOADED', on_hold: m.on_hold ?? false, vehicle: m.vehicle ?? null,
      debtor_name: `Customer ${i + 1}`, city: 'Klang', state: 'Selangor',
      qr_token: null, qr_revoked_at: null, so_doc_no: null,
    });
    const plate = m.plate === undefined ? 'VJK 8821' : m.plate;
    if (plate !== null) tables.delivery_order_crew.push({ do_id: id, company_id: m.company_id ?? CO, lorry_plate: plate });
    tables.inventory_movements.push({ id: `mv-${id}`, source_doc_type: 'DO', source_doc_id: id, movement_type: 'OUT', qty: 1 });
  });
  tables.packing_scan_sets = [{
    id: 'sheet-1', company_id: opts.sheetCompany ?? CO,
    sheet_kind: opts.region ? 'region' : 'lorry',
    lorry_plate: opts.region ? null : 'VJK 8821',
    region: opts.region ?? null,
    delivery_date: '2026-11-28',
    do_ids: list.map((_, i) => uuidFor(i + 1)), qr_token: SHEET_TOKEN,
    prepared_at: opts.preparedAt === undefined ? '2026-11-28T00:30:00Z' : opts.preparedAt,
    prepared_by_scan: opts.preparedAt !== null,
    loaded_at: opts.loadedAt ?? null,
    qr_revoked_at: opts.revoked ? '2026-11-28T02:00:00Z' : null,
  }];
  touched = [];
  failing = new Set();
}

describe('the lorry-day packing list QR (no trip behind it)', () => {
  test('one scan loads every printed Confirmed DO; the rest are left alone and named', async () => {
    seedLorryDay({ members: [{}, { status: 'DISPATCHED' }, { status: 'DRAFT' }, { status: 'IN_TRANSIT' }, {}] });
    const res = await advance(SHEET_TOKEN, 'DISPATCHED');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.kind).toBe('lorry_day');
    expect(body.members.map((m: any) => m.outcome)).toEqual(['DONE', 'ALREADY_DONE', 'BLOCKED', 'PAST', 'DONE']);
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'DISPATCHED', 'DRAFT', 'IN_TRANSIT', 'DISPATCHED']);
    expect(body.headline).toBe('Lorry VJK 8821: 3 of 5 delivery orders loaded');
    expect(body.members[0]).toMatchObject({ stopNo: 1, doNumber: 'HC-DO-2611-201', customerName: 'Customer 1' });
    expect(tables.inventory_movements).toHaveLength(5);
  });

  test('a DO moved to another lorry since printing is NOT loaded, and is reported', async () => {
    seedLorryDay({ members: [{}, { plate: 'WXY 1234' }, { plate: null }, { plate: null, vehicle: 'vjk-8821' }] });
    const body = await (await advance(SHEET_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.members.map((m: any) => m.outcome)).toEqual(['DONE', 'MOVED', 'MOVED', 'DONE']);
    expect(body.members[1].message).toContain('another lorry');
    expect(body.members[2].message).toContain('Taken off');
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'LOADED', 'LOADED', 'DISPATCHED']);
    expect(body.outcome).toBe('PARTIAL');
  });

  test('a DO added to the lorry after printing is not on the sheet, so it is not loaded', async () => {
    seedLorryDay({ members: [{}] });
    tables.delivery_orders.push({ id: uuidFor(99), do_number: 'HC-DO-2611-299', company_id: CO, status: 'LOADED', on_hold: false });
    tables.delivery_order_crew.push({ do_id: uuidFor(99), company_id: CO, lorry_plate: 'VJK 8821' });
    const body = await (await advance(SHEET_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.members).toHaveLength(1);
    expect(tables.delivery_orders.find((d) => d.id === uuidFor(99))!.status).toBe('LOADED');
  });

  test('scanning twice changes nothing the second time: the loaded sheet refuses a second load', async () => {
    seedLorryDay({ members: [{}, {}, { status: 'DRAFT' }] });
    await advance(SHEET_TOKEN, 'DISPATCHED');
    const after1 = JSON.stringify(tables.delivery_orders);
    const again = await advance(SHEET_TOKEN, 'DISPATCHED');
    expect(again.status).toBe(409);
    expect((await again.json() as any).message).toContain('already marked loaded');
    expect(JSON.stringify(tables.delivery_orders)).toBe(after1);
  });

  test('the sheet\'s company is the whole scope: another company\'s DO on it is never written', async () => {
    seedLorryDay({ members: [{}, { company_id: OTHER_CO }] });
    const body = await (await advance(SHEET_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.members[0].outcome).toBe('DONE');
    expect(body.members[1].outcome).toBe('MOVED');
    expect(body.members[1].doNumber).toBeNull();
    expect(tables.delivery_orders[1].status).toBe('LOADED');
    expect(JSON.stringify(body)).not.toContain('HC-DO-2611-202');
  });

  test('a revoked sheet gets the SAME answer an unknown token gets, and writes nothing', async () => {
    seedLorryDay({ revoked: true });
    const revoked = await get(SHEET_TOKEN);
    const unknown = await get('m3n4p5q6r7');
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe(await unknown.text());
    expect((await advance(SHEET_TOKEN, 'DISPATCHED')).status).toBe(404);
    expect(tables.delivery_orders.every((d) => d.status === 'LOADED')).toBe(true);
  });

  test('the page is told what each printed DO will do, and only Loaded is accepted', async () => {
    seedLorryDay({ members: [{}, { plate: 'WXY 1234' }] });
    const body = await (await get(SHEET_TOKEN)).json() as any;
    expect(body).toMatchObject({ kind: 'lorry_day', mode: 'load_all', lorryPlate: 'VJK 8821', tripDate: '2026-11-28', tripNo: null });
    expect(body.members.map((m: any) => m.willLoad)).toEqual([true, false]);
    expect(body.members[1].note).toContain('another lorry');
    expect((await advance(SHEET_TOKEN, 'IN_TRANSIT')).status).toBe(400);
  });

  test('a failed read of the sheet\'s DOs or crew is 503, never an empty sheet', async () => {
    seedLorryDay();
    failing.add('delivery_order_crew');
    expect((await get(SHEET_TOKEN)).status).toBe(503);
    expect((await advance(SHEET_TOKEN, 'DISPATCHED')).status).toBe(503);
    expect(tables.delivery_orders.every((d) => d.status === 'LOADED')).toBe(true);
  });

  test('scanned into the basket, the sheet is refused as a packing list', async () => {
    seedLorryDay();
    const body = await (await batchLookup([SHEET_TOKEN])).json() as any;
    expect(body.lines[0].blockReason).toContain('packing list');
  });
});

const stepPost = (t: string, step: unknown) =>
  publicDoScan.request(`/${t}/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step }),
  }, env);

describe('the packing list QR is scanned twice: prepared, then loaded (owner 2026-11-28)', () => {
  test('a fresh sheet offers "prepared"; pressing it records the time and writes no DO status', async () => {
    seedLorryDay({ members: [{}, {}], preparedAt: null });
    const page = await (await get(SHEET_TOKEN)).json() as any;
    expect(page).toMatchObject({ nextStep: 'prepare', preparedAt: null, loadedAt: null });
    expect(page.step).toMatchObject({ status: 'prepare', label: 'Mark packing list prepared' });
    const before = JSON.stringify(tables.delivery_orders);
    const res = await stepPost(SHEET_TOKEN, 'prepare');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ mode: 'prepare', outcome: 'DONE', kind: 'lorry_day' });
    expect(body.headline).toBe('Lorry VJK 8821: packing list prepared');
    expect(tables.packing_scan_sets[0]!.prepared_at).toBe(body.preparedAt);
    expect(tables.packing_scan_sets[0]!.prepared_by_scan).toBe(true);
    expect(tables.packing_scan_sets[0]!.loaded_at).toBeNull();
    expect(JSON.stringify(tables.delivery_orders)).toBe(before);
    expect(touched).not.toContain('inventory_movements');
  });

  test('a double tap on "prepared" keeps the first time and is answered as already done', async () => {
    seedLorryDay({ preparedAt: null });
    const first = await (await stepPost(SHEET_TOKEN, 'prepare')).json() as any;
    const second = await stepPost(SHEET_TOKEN, 'prepare');
    expect(second.status).toBe(200);
    const body = await second.json() as any;
    expect(body.outcome).toBe('ALREADY_DONE');
    expect(body.preparedAt).toBe(first.preparedAt);
    expect(tables.packing_scan_sets[0]!.prepared_at).toBe(first.preparedAt);
  });

  test('a stale page pressing "loaded" on an unprepared sheet is refused, and nothing moves', async () => {
    seedLorryDay({ preparedAt: null });
    const res = await stepPost(SHEET_TOKEN, 'load');
    expect(res.status).toBe(409);
    expect((await res.json() as any).message).toContain('Reload the page');
    expect(tables.delivery_orders.every((d) => d.status === 'LOADED')).toBe(true);
    expect(tables.packing_scan_sets[0]!.loaded_at).toBeNull();
    const legacy = await advance(SHEET_TOKEN, 'DISPATCHED');
    expect(legacy.status).toBe(409);
  });

  test('the second scan loads every DO, records the loaded time, and shows both times after', async () => {
    seedLorryDay({ members: [{}, { status: 'DRAFT' }] });
    const page = await (await get(SHEET_TOKEN)).json() as any;
    expect(page).toMatchObject({ nextStep: 'load', preparedAtText: '2026/11/28 08:30' });
    expect(page.step).toMatchObject({ status: 'DISPATCHED', label: 'Mark whole lorry loaded' });
    const body = await (await stepPost(SHEET_TOKEN, 'load')).json() as any;
    expect(body.outcome).toBe('PARTIAL');
    expect(body.loadedAt).toBeTruthy();
    expect(tables.packing_scan_sets[0]!.loaded_at).toBe(body.loadedAt);
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'DRAFT']);
    const after = await (await get(SHEET_TOKEN)).json() as any;
    expect(after).toMatchObject({ nextStep: 'done', step: null, preparedAtText: '2026/11/28 08:30' });
    expect(after.loadedAtText).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(after.members).toHaveLength(2);
    expect(after.members.every((m: any) => m.willLoad === false)).toBe(true);
  });

  test('a lorry already loaded DO by DO still offers "loaded", so the loaded time can be recorded', async () => {
    seedLorryDay({ members: [{ status: 'DISPATCHED' }, { status: 'DISPATCHED' }] });
    const page = await (await get(SHEET_TOKEN)).json() as any;
    expect(page.blockReason).toBeNull();
    expect(page.step.note).toContain('records the time');
    const body = await (await stepPost(SHEET_TOKEN, 'load')).json() as any;
    expect(body.moved).toBe(0);
    expect(tables.packing_scan_sets[0]!.loaded_at).toBeTruthy();
  });

  test('pressing "prepared" on a sheet already loaded is refused as stale', async () => {
    seedLorryDay({ loadedAt: '2026-11-28T03:00:00Z' });
    const res = await stepPost(SHEET_TOKEN, 'prepare');
    expect(res.status).toBe(409);
    expect(tables.packing_scan_sets[0]!.prepared_at).toBe('2026-11-28T00:30:00Z');
  });

  test('an unknown step word is refused before anything is written', async () => {
    seedLorryDay({ preparedAt: null });
    expect((await stepPost(SHEET_TOKEN, 'ship')).status).toBe(400);
    expect(tables.packing_scan_sets[0]!.prepared_at).toBeNull();
  });

  test('a failed save of the prepared time is 503, not a success', async () => {
    seedLorryDay({ preparedAt: null });
    failing.add('packing_scan_sets');
    expect((await stepPost(SHEET_TOKEN, 'prepare')).status).toBe(503);
  });

  test('the prepared stamp is scoped to the sheet\'s own company', async () => {
    seedLorryDay({ preparedAt: null });
    tables.packing_scan_sets.push({ ...tables.packing_scan_sets[0]!, id: 'sheet-1', company_id: OTHER_CO, qr_token: 'zzzzzzzzzz' });
    await stepPost(SHEET_TOKEN, 'prepare');
    expect(tables.packing_scan_sets[1]!.prepared_at).toBeNull();
  });

  test('a trip packing list keeps its one-step load: a "prepared" press is refused, nothing moves', async () => {
    seedRun({ members: [{ status: 'LOADED' }] });
    const res = await stepPost(TRIP_TOKEN, 'prepare');
    expect(res.status).toBe(400);
    expect(tables.delivery_orders.every((d) => d.status === 'LOADED')).toBe(true);
    const page = await (await get(TRIP_TOKEN)).json() as any;
    expect(page.nextStep).toBeNull();
    expect(page.step).toMatchObject({ status: 'DISPATCHED' });
  });
});

describe('the two-step scan, every remaining scenario (owner 2026-11-28)', () => {
  test('two phones press "prepared" at the same moment: one prepared time, both told it is prepared', async () => {
    seedLorryDay({ preparedAt: null });
    const [a, b] = await Promise.all([stepPost(SHEET_TOKEN, 'prepare'), stepPost(SHEET_TOKEN, 'prepare')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ja, jb] = [await a.json() as any, await b.json() as any];
    expect(ja.preparedAt).toBe(jb.preparedAt);
    expect(tables.packing_scan_sets[0]!.prepared_at).toBe(ja.preparedAt);
    expect(jb.message).toContain('Prepared at');
  });

  test('a mixed sheet: only Confirmed loads, each line says why, PARTIAL, and the loaded time is still recorded', async () => {
    seedLorryDay({
      members: [{}, { status: 'DRAFT' }, { status: 'CANCELLED' }, { on_hold: true }, { status: 'DISPATCHED' }, { status: 'IN_TRANSIT' }],
    });
    const body = await (await stepPost(SHEET_TOKEN, 'load')).json() as any;
    expect(body.members.map((m: any) => m.outcome)).toEqual(['DONE', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'ALREADY_DONE', 'PAST']);
    expect(body.members[1].message).toContain('Draft');
    expect(body.members[2].message).toContain('cancelled');
    expect(body.members.every((m: any) => typeof m.message === 'string' && m.message.length > 0)).toBe(true);
    expect(body.outcome).toBe('PARTIAL');
    expect(tables.delivery_orders.map((d) => d.status)).toEqual(['DISPATCHED', 'DRAFT', 'CANCELLED', 'LOADED', 'DISPATCHED', 'IN_TRANSIT']);
    expect(tables.packing_scan_sets[0]!.loaded_at).toBeTruthy();
  });

  test('a revoked sheet refuses "prepared" with the unknown-code answer and writes nothing', async () => {
    seedLorryDay({ revoked: true, preparedAt: null });
    const res = await stepPost(SHEET_TOKEN, 'prepare');
    expect(res.status).toBe(404);
    expect(tables.packing_scan_sets[0]!.prepared_at).toBeNull();
    expect((await stepPost('m3n4p5q6r7', 'prepare')).status).toBe(404);
  });

  test('a QR printed before this change (row has no kind and no times) starts fresh: first scan = prepared', async () => {
    seedLorryDay({ preparedAt: null });
    const legacy = tables.packing_scan_sets[0]!;
    delete legacy.sheet_kind; delete legacy.region; delete legacy.prepared_at; delete legacy.loaded_at; delete legacy.prepared_by_scan;
    const page = await (await get(SHEET_TOKEN)).json() as any;
    expect(page).toMatchObject({ kind: 'lorry_day', nextStep: 'prepare', lorryPlate: 'VJK 8821' });
    const body = await (await stepPost(SHEET_TOKEN, 'prepare')).json() as any;
    expect(body.outcome).toBe('DONE');
    expect(legacy.prepared_at).toBe(body.preparedAt);
    expect(tables.delivery_orders.every((d) => d.status === 'LOADED')).toBe(true);
  });
});

describe('the region packing list QR ignores lorries (owner 2026-11-28)', () => {
  test('every printed DO is decided on its own status: a DO on another lorry or on none is loaded', async () => {
    seedLorryDay({ region: 'KL', members: [{}, { plate: 'WXY 1234' }, { plate: null }, { status: 'DRAFT' }] });
    const page = await (await get(SHEET_TOKEN)).json() as any;
    expect(page).toMatchObject({ kind: 'region_day', region: 'KL', title: 'Region KL', lorryPlate: null });
    expect(page.members.map((m: any) => m.willLoad)).toEqual([true, true, true, false]);
    const body = await (await stepPost(SHEET_TOKEN, 'load')).json() as any;
    expect(body.members.map((m: any) => m.outcome)).toEqual(['DONE', 'DONE', 'DONE', 'BLOCKED']);
    expect(body.headline).toBe('Region KL: 3 of 4 delivery orders loaded');
    expect(touched).not.toContain('delivery_order_crew');
    expect(tables.packing_scan_sets[0]!.loaded_at).toBeTruthy();
  });

  test('the region sheet is two-step too', async () => {
    seedLorryDay({ region: 'KL', preparedAt: null });
    const body = await (await stepPost(SHEET_TOKEN, 'prepare')).json() as any;
    expect(body).toMatchObject({ kind: 'region_day', headline: 'Region KL: packing list prepared' });
    expect(tables.delivery_orders.every((d) => d.status === 'LOADED')).toBe(true);
  });

  test('another company\'s DO on a region sheet is still never written', async () => {
    seedLorryDay({ region: 'KL', members: [{}, { company_id: OTHER_CO }] });
    const body = await (await stepPost(SHEET_TOKEN, 'load')).json() as any;
    expect(body.members[1].outcome).toBe('MOVED');
    expect(tables.delivery_orders[1].status).toBe('LOADED');
  });
});

describe('a packing list cannot move another company\'s goods', () => {
  test('a foreign drop is REFUSED, and named only by its stop number', async () => {
    seedRun({ members: [{}, { company_id: OTHER_CO }] });
    const body = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.outcome).toBe('PARTIAL');
    const foreign = body.members.find((m: any) => m.stopNo === 2);
    expect(foreign.outcome).toBe('BLOCKED');
    expect(foreign.doNumber, "the other company's document number was printed").toBeNull();
    expect(foreign.message).toContain('another company');
    // It was never written.
    expect(tables.delivery_orders.find((d) => d.company_id === OTHER_CO)!.status).toBe('LOADED');
    expect(tables.delivery_orders.find((d) => d.company_id === CO)!.status).toBe('DISPATCHED');
  });

  test('the GET withholds a foreign drop\'s number and customer too', async () => {
    seedRun({ members: [{}, { company_id: OTHER_CO }] });
    const body = await (await get(TRIP_TOKEN)).json() as any;
    const foreign = body.members.find((m: any) => m.stopNo === 2);
    expect(foreign.doNumber).toBeNull();
    expect(JSON.stringify(body)).not.toContain('HC-DO-2608-102');
    expect(JSON.stringify(body)).not.toContain('Customer 2');
  });

  test('the write is scoped to the RUN\'s company, not the member\'s', async () => {
    /* A trip whose own company is 2 must not move a company-1 delivery order
       even though that DO exists and is advanceable — the scope is the run's. */
    seedRun({ members: [{}], tripCompany: OTHER_CO });
    const body = await (await advance(TRIP_TOKEN, 'DISPATCHED')).json() as any;
    expect(body.members[0].outcome).toBe('BLOCKED');
    expect(tables.delivery_orders[0].status).toBe('LOADED');
  });
});

describe('the trip token behaves like the delivery-order one', () => {
  test('a revoked run token gets the SAME answer an unknown one gets', async () => {
    seedRun();
    tables.trips[0].qr_revoked_at = '2026-08-26T00:00:00Z';
    const revoked = await get(TRIP_TOKEN);
    const unknown = await get('e'.repeat(64));
    expect(revoked.status).toBe(unknown.status);
    expect(await revoked.text()).toBe(await unknown.text());
    expect((await advance(TRIP_TOKEN, 'DISPATCHED')).status).toBe(404);
  });

  test('a failed stop read is 503, never an empty run', async () => {
    /* An empty member list would read as "nothing to do on this run" — a claim
       about the lorry, from a read that did not answer. */
    seedRun();
    failing.add('trip_stops');
    expect((await get(TRIP_TOKEN)).status).toBe(503);
    expect((await advance(TRIP_TOKEN, 'DISPATCHED')).status).toBe(503);
  });

  test('a run row with no usable company is refused', async () => {
    seedRun();
    tables.trips[0].company_id = null;
    expect((await get(TRIP_TOKEN)).status).toBe(404);
  });
});

describe('a basket of papers, scanned in a row, moved with one press', () => {
  /* THE OWNER, 2026-08-26: 「我不能 scan 好几个 DO，然后一起点 load 吗？包括我的
     dispatch 也是一样」. Everything below is a property of what happens when the
     pile is NOT uniform, because a uniform pile is not what a storekeeper picks
     up. */

  test('only the documents on the pressed rung move; the rest each say why', async () => {
    seed({}, [
      // Behind: still LOADED, so DISPATCHED is exactly its next rung.
      doRow('do-2', TOKEN_2),
      // Ahead: already IN_TRANSIT, so DISPATCHED is behind it.
      doRow('do-3', TOKEN_3, { status: 'IN_TRANSIT' }),
    ]);
    // do-1 is LOADED from the seed; do-2 LOADED; do-3 IN_TRANSIT.
    const res = await batchAdvance([TOKEN, TOKEN_2, TOKEN_3], 'DISPATCHED');
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const by = (n: string) => body.lines.find((l: any) => l.doNumber === n);
    expect(by('HC-DO-2608-001').outcome).toBe('DONE');
    expect(by('HC-DO-2608-do-2').outcome).toBe('DONE');
    /* The one that was already past it is ALREADY_DONE — an answer, not an
       error, and crucially NOT dragged on to the next rung. */
    expect(by('HC-DO-2608-do-3').outcome).toBe('ALREADY_DONE');

    // And the row itself did not move.
    const three = tables.delivery_orders.find((r) => r.id === 'do-3');
    expect(three!.status).toBe('IN_TRANSIT');

    expect(body.outcome).toBe('DONE');
    expect(body.moved).toBe(2);
    expect(body.already).toBe(1);
  });

  test('a held or cancelled paper in the pile blocks only itself, and the headline says so', async () => {
    seed({}, [
      doRow('do-2', TOKEN_2, { on_hold: true }),
      doRow('do-3', TOKEN_3, { status: 'CANCELLED' }),
    ]);
    const body = await (await batchAdvance([TOKEN, TOKEN_2, TOKEN_3], 'DISPATCHED')).json() as any;

    const by = (n: string) => body.lines.find((l: any) => l.doNumber === n);
    expect(by('HC-DO-2608-001').outcome).toBe('DONE');
    expect(by('HC-DO-2608-do-2').outcome).toBe('BLOCKED');
    expect(by('HC-DO-2608-do-2').message).toContain('on hold');
    expect(by('HC-DO-2608-do-3').outcome).toBe('BLOCKED');
    expect(by('HC-DO-2608-do-3').message).toContain('cancelled');

    /* ONE REFUSAL OUTRANKS TWENTY SUCCESSES. A storekeeper who reads "all done"
       and walks away from a paper that did not move is the failure this
       wording exists to prevent. */
    expect(body.outcome).toBe('PARTIAL');
    expect(body.message).toContain('not moved');

    for (const id of ['do-2', 'do-3']) {
      const row = tables.delivery_orders.find((r) => r.id === id)!;
      expect(row.status).not.toBe('DISPATCHED');
    }
  });

  test('the writes are STRICTLY SEQUENTIAL — the deadlock Hookka paid for', async () => {
    /* Two delivery orders frequently share one sales order, and the DELIVERED
       hop updates that shared row. peakConcurrentWrites is a MEASUREMENT: make
       the loop concurrent and this goes above 1. */
    seed({ status: 'IN_TRANSIT' }, [
      doRow('do-2', TOKEN_2, { status: 'IN_TRANSIT' }),
      doRow('do-3', TOKEN_3, { status: 'IN_TRANSIT' }),
    ]);
    const body = await (await batchAdvance([TOKEN, TOKEN_2, TOKEN_3], 'DELIVERED')).json() as any;
    expect(body.moved).toBe(3);
    expect(peakConcurrentWrites).toBe(1);
  });

  test('a token repeated in one basket is walked once, not twice', async () => {
    /* A held paper decodes every frame. If the basket reached the loop with the
       same token twice, the second walk would find the document one rung on and
       report ALREADY_DONE against a line nobody scanned twice. */
    seed();
    const body = await (await batchAdvance([TOKEN, TOKEN, TOKEN], 'DISPATCHED')).json() as any;
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].outcome).toBe('DONE');
    expect(body.moved).toBe(1);
  });

  test('one bad decode does not cost the operator the rest of the pile', async () => {
    seed({}, [doRow('do-2', TOKEN_2)]);
    const body = await (await batchAdvance(
      [TOKEN, 'not-a-token', 42, null, TOKEN_2], 'DISPATCHED',
    )).json() as any;
    /* The junk is DROPPED, not refused — two real papers still move. */
    expect(body.lines).toHaveLength(2);
    expect(body.moved).toBe(2);
  });

  test('an unknown token reports as unknown and the pile continues', async () => {
    seed({}, [doRow('do-2', TOKEN_2)]);
    const body = await (await batchAdvance([TOKEN, 'e'.repeat(64), TOKEN_2], 'DISPATCHED')).json() as any;
    const unknown = body.lines.filter((l: any) => l.outcome === 'UNKNOWN');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].doNumber).toBeNull();
    expect(body.moved).toBe(2);
    expect(body.outcome).toBe('PARTIAL');
  });

  test('a rung the ladder does not have is refused before any query', async () => {
    seed();
    for (const bad of ['ON_HOLD', 'SIGNED', 'DRAFT', 'INVOICED', '', 'nonsense']) {
      touched = [];
      const res = await batchAdvance([TOKEN], bad);
      expect(res.status, `to=${bad}`).toBe(400);
      expect(touched, `to=${bad} queried ${touched.join()}`).toEqual([]);
    }
  });

  test('an empty basket is refused rather than reported as a success', async () => {
    seed();
    const res = await batchAdvance([], 'DISPATCHED');
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('nothing_scanned');
  });

  test('lookup reports each paper WITHOUT moving anything', async () => {
    seed({}, [doRow('do-2', TOKEN_2, { status: 'IN_TRANSIT' })]);
    const before = tables.delivery_orders.map((r) => r.status);
    const body = await (await batchLookup([TOKEN, TOKEN_2])).json() as any;

    expect(body.lines).toHaveLength(2);
    expect(body.lines[0].step.status).toBe('DISPATCHED');
    expect(body.lines[1].step.status).toBe('DELIVERED');
    expect(tables.delivery_orders.map((r) => r.status)).toEqual(before);
  });

  test('lookup leaks no more than the single-paper read does', async () => {
    seed();
    const text = await (await batchLookup([TOKEN])).text();
    for (const secret of ['Jalan Something', '+60123456789', '123456', 'total_sen']) {
      expect(text, `leaked ${secret}`).not.toContain(secret);
    }
  });

  test('a packing list dropped into a basket is named, not silently skipped', async () => {
    seed();
    tables.trips.push({
      id: 'trip-1', trip_no: 'TR-2608-001', company_id: CO, status: 'PLANNED',
      trip_date: '2026-08-26', qr_token: TOKEN_2, qr_revoked_at: null,
    });
    const body = await (await batchAdvance([TOKEN_2], 'DISPATCHED')).json() as any;
    expect(body.lines[0].outcome).toBe('BLOCKED');
    expect(body.lines[0].message).toContain('packing list');
  });

  test('a basket larger than the cap is refused with a number the operator can act on', async () => {
    seed();
    const many = Array.from({ length: 61 }, (_, i) => String(i).padStart(64, 'f'));
    const res = await batchAdvance(many, 'DISPATCHED');
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toContain('60');
  });
});
