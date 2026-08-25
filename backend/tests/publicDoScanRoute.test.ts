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
