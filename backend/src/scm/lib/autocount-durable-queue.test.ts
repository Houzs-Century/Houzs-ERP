// Hard rule 4, as tests: "a save that succeeds in the ERP while its sync is
// silently lost MUST BE IMPOSSIBLE — a durable queue plus a LOUD alarm...
// making failure VISIBLE, not distrusting the link."
//
// autocount-outbox.test.ts already pins the queue's SHAPE (what is enqueued,
// what a dispatch does with one row). This file pins the two properties that
// file cannot see, because both are about what happens ACROSS sweeps:
//
//   1. a dropped tunnel must not spend the retry budget in half an hour;
//   2. a row that is undeliverable must reach a HUMAN, in the ERP, not a log.
//
// The alarm assertions run the REAL postPersonalNotice against a fake DB, so
// what is proved is that a row lands in `announcements` with source
// 'ac_writeback' — the row the notification bell serves at
// /api/announcements/banner?scope=system. A mock would only have proved that
// one function calls another.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { resetWritebackFlagCache } from './autocount-writeback-flag';
import { AC_ALARM_SOURCE, STALL_ALARM_MS } from './autocount-alarm';
import {
  backoffMs,
  dispatchOne,
  drainAutoCountOutbox,
  enqueueEdit,
  MAX_ATTEMPTS,
  type AcOutboxRow,
} from './autocount-outbox';

type Row = Record<string, any>;

// ── the fakes ───────────────────────────────────────────────────────────────

/* PostgREST stand-in. Same idea as autocount-outbox.test.ts's, plus the three
   operators this file's queries use: lte (the backoff gate), is / not (the
   alarm's alerted_at IS NULL), and select(col, {count, head}).
   lt/lte compare as NUMBERS only when both sides are numeric — the columns
   filtered here are ISO timestamps, which compare correctly as strings and
   would silently become NaN under a Number() cast. */
function fakeSb(tables: Record<string, Row[]>) {
  const cmp = (a: unknown, b: unknown) => {
    const na = Number(a); const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    const sa = String(a ?? ''); const sb2 = String(b ?? '');
    return sa < sb2 ? -1 : sa > sb2 ? 1 : 0;
  };
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let pendingInsert: Row | null = null;
    let pendingUpdate: Row | null = null;
    let wantCount = false;
    let headOnly = false;
    const matched = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const rows = () => (limitN == null ? matched() : matched().slice(0, limitN));
    const settle = () => {
      if (pendingInsert) {
        tables[table].push({ id: `row-${tables[table].length + 1}`, ...pendingInsert });
        return { data: null, count: null, error: null };
      }
      if (pendingUpdate) {
        for (const r of rows()) Object.assign(r, pendingUpdate);
        return { data: null, count: null, error: null };
      }
      if (wantCount) return { data: headOnly ? null : rows(), count: matched().length, error: null };
      return { data: rows(), count: null, error: null };
    };
    const builder: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) wantCount = true;
        if (opts?.head) headOnly = true;
        return builder;
      },
      insert(payload: Row) { pendingInsert = payload; return builder; },
      update(patch: Row) { pendingUpdate = patch; return builder; },
      eq(col: string, val: unknown) { filters.push((r) => String(r[col]) === String(val)); return builder; },
      neq(col: string, val: unknown) { filters.push((r) => String(r[col]) !== String(val)); return builder; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
      lt(col: string, val: unknown) { filters.push((r) => r[col] != null && cmp(r[col], val) < 0); return builder; },
      lte(col: string, val: unknown) { filters.push((r) => r[col] != null && cmp(r[col], val) <= 0); return builder; },
      is(col: string, val: unknown) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      not(col: string, _op: string, val: unknown) { filters.push((r) => (val === null ? r[col] != null : r[col] !== val)); return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
    };
    return builder;
  };
  return { from, tables } as never as { from: (t: string) => any; tables: Record<string, Row[]> };
}

/* D1-shaped stand-in for the PUBLIC schema, which is where the alarm lands:
   users (for the reporting chain and the admin fallback) and announcements. */
function fakeDb(state: { users: Row[]; roles: Row[]; announcements: Row[] }) {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { args = a; return api; },
        async first() {
          if (sql.includes('manager_id FROM users')) {
            const u = state.users.find((x) => Number(x.id) === Number(args[0]));
            return u ? { manager_id: u.manager_id ?? null } : null;
          }
          if (sql.includes('FROM announcements')) {
            const [source, title, target] = args as string[];
            return state.announcements.find(
              (a) => a.source === source && a.title === title && a.target_user_ids === target && a.acked !== true,
            ) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes('JOIN roles')) {
            const admin = state.roles.filter((r) => String(r.permissions).includes('"*"')).map((r) => r.id);
            return {
              results: state.users
                .filter((u) => u.status === 'active' && admin.includes(u.role_id))
                .map((u) => ({ id: u.id })),
            };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO announcements')) {
            const [id, title, body, expires_at, created_at, target_user_ids, category, source] = args as string[];
            state.announcements.push({ id, title, body, expires_at, created_at, target_user_ids, category, source });
          }
          return { success: true };
        },
      };
      return api;
    },
  };
}

/* The drain takes its client as an injected parameter (@cloudflare/vitest-pool-
   workers does not support vi.mock, so a seam is the only way in). `drain` below
   passes whatever the test just built. */
let currentSb: ReturnType<typeof fakeSb>;

const on = (extra: Record<string, Row[]> = {}) => {
  currentSb = fakeSb({
    app_config: [{ key: 'scm.autocount_writeback', value: 'all' }],
    autocount_outbox: [],
    ...extra,
  });
  return currentSb;
};

const outbox = (sb: { tables: Record<string, Row[]> }) => sb.tables.autocount_outbox ?? [];

/** The sweep, against whatever client the test just built. */
const drain = (env: unknown, fetchImpl: typeof fetch) =>
  drainAutoCountOutbox(env as never, 20, fetchImpl, currentSb as never);

const AC_ENV = { AC_SYNC_URL: 'http://ac.local:8900', AC_SYNC_KEY: 'k' };

const publicState = () => ({
  users: [
    { id: 7, status: 'active', role_id: 2, manager_id: 3 },
    { id: 3, status: 'active', role_id: 2, manager_id: null },
    { id: 1, status: 'active', role_id: 1, manager_id: null },
  ],
  roles: [{ id: 1, permissions: '["*"]' }, { id: 2, permissions: '["scm.so.write"]' }],
  announcements: [] as Row[],
});

const envWith = (state: ReturnType<typeof publicState>, extra: Record<string, unknown> = {}) =>
  ({ ...AC_ENV, ...extra, DB: fakeDb(state) }) as never;

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ob = (over: Partial<AcOutboxRow> = {}): AcOutboxRow => ({
  id: 'ob-1',
  company_id: 1,
  op: 'create_so',
  doc_type: 'SO',
  doc_no: 'HC-SO-9',
  doc_id: null,
  payload: { body: { DocNo: 'HC-SO-9' } },
  status: 'pending',
  attempts: 0,
  dedupe_key: 'create_so:HC-SO-9',
  ...over,
});

beforeEach(() => {
  resetWritebackFlagCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ── 1. the queue survives the link being down ───────────────────────────────

describe('retry backoff — a dropped tunnel must not empty the queue into failed', () => {
  test('a retryable failure holds the row off, and the hold grows with each attempt', async () => {
    const sb = on({ autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }] });
    const fetchImpl = vi.fn(async () => { throw new Error('tunnel down'); }) as never;

    const t0 = Date.now();
    expect(await dispatchOne(envWith(publicState()), sb as never, ob(), fetchImpl)).toBe('retry');
    const first = outbox(sb)[0];
    expect(first.status).toBe('pending');
    /* WITHOUT the backoff this column is never written, so `next_attempt_at`
       is undefined and the row is re-tried on the very next sweep. */
    expect(first.next_attempt_at).toBeDefined();
    expect(Date.parse(first.next_attempt_at) - t0).toBeGreaterThanOrEqual(4 * 60_000);

    const sb2 = on({ autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 3 }] });
    const t1 = Date.now();
    expect(await dispatchOne(envWith(publicState()), sb2 as never, ob({ attempts: 3 }), fetchImpl)).toBe('retry');
    const later = outbox(sb2)[0];
    expect(Date.parse(later.next_attempt_at) - t1).toBeGreaterThanOrEqual(35 * 60_000);
  });

  test('the schedule spans more than one working night, so an overnight outage still retries in the morning', () => {
    let total = 0;
    for (let a = 1; a < MAX_ATTEMPTS; a += 1) total += backoffMs(a);
    expect(total).toBeGreaterThan(10 * 60 * 60 * 1000);
  });

  test('the sweep leaves a row alone until its backoff has elapsed', async () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const sb = on({
      autocount_outbox: [{
        id: 'ob-1', company_id: 1, op: 'create_so', doc_type: 'SO', doc_no: 'HC-SO-9',
        payload: { body: {} }, status: 'pending', attempts: 1, next_attempt_at: soon,
      }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'SO-1' })) as never;

    const r = await drain(envWith(publicState()), fetchImpl);
    /* WITHOUT the gate the sweep selects every pending row regardless of when
       it was last tried, so this fetch fires and processed is 1. */
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.processed).toBe(0);
    expect(outbox(sb)[0].status).toBe('pending');
  });

  test('a row whose backoff HAS elapsed is picked up — the gate delays, it does not strand', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const sb = on({
      autocount_outbox: [{
        id: 'ob-1', company_id: 1, op: 'create_so', doc_type: 'SO', doc_no: 'HC-SO-9',
        payload: { body: {} }, status: 'pending', attempts: 1, next_attempt_at: past,
      }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'SO-1' })) as never;

    const r = await drain(envWith(publicState()), fetchImpl);
    expect(r.sent).toBe(1);
    expect(outbox(sb)[0].status).toBe('sent');
  });
});

// ── 2. a permanent wait stops being invisible ───────────────────────────────

describe('the permanent waiting row', () => {
  const waitingRow = (over: Partial<AcOutboxRow> = {}) => ob({
    op: 'so_to_do',
    doc_type: 'DO',
    payload: {
      body: {},
      fromDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: 'HC-SO-9' },
      writeback: { table: 'delivery_orders', keyCol: 'id', key: 'do-1' },
    },
    ...over,
  });

  test('waiting on a parent stamps a clock, and the clock does not restart on the next sweep', async () => {
    const sb = on({
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0 }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: null }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true })) as never;

    expect(await dispatchOne(envWith(publicState()), sb as never, waitingRow(), fetchImpl)).toBe('waiting');
    /* WITHOUT the clock this is undefined, and a row waiting for three days is
       indistinguishable from one waiting for forty seconds. */
    const stamped = outbox(sb)[0].first_waiting_at;
    expect(stamped).toBeDefined();

    // Second sweep, same stall: the age must keep growing, not reset.
    expect(await dispatchOne(
      envWith(publicState()), sb as never, waitingRow({ first_waiting_at: stamped }), fetchImpl,
    )).toBe('waiting');
    expect(outbox(sb)[0].first_waiting_at).toBe(stamped);
  });

  test('the clock is cleared once the row stops waiting, so a past stall is not reported as a current one', async () => {
    const sb = on({
      autocount_outbox: [{ id: 'ob-1', status: 'pending', attempts: 0, first_waiting_at: '2020-01-01T00:00:00.000Z' }],
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000123' }],
      delivery_orders: [{ id: 'do-1', linked_ac_docno: null }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, docNo: 'DO-000045' })) as never;

    expect(await dispatchOne(
      envWith(publicState()), sb as never,
      waitingRow({ first_waiting_at: '2020-01-01T00:00:00.000Z' }), fetchImpl,
    )).toBe('sent');
    expect(outbox(sb)[0].first_waiting_at).toBeNull();
  });
});

// ── 3. the loud alarm ───────────────────────────────────────────────────────

describe('a lost sync reaches a human in the ERP, not a log', () => {
  const failedRow = (over: Record<string, unknown> = {}) => ({
    id: 'ob-1', company_id: 1, op: 'create_so', doc_type: 'SO', doc_no: 'HC-SO-9',
    payload: { body: {} }, status: 'failed', attempts: MAX_ATTEMPTS,
    last_error: 'Gave up after 8 attempts. Last error: tunnel down',
    created_by: 7, created_at: '2026-08-11T00:00:00.000Z', alerted_at: null,
    first_waiting_at: null,
    ...over,
  });

  test('a FAILED row posts a WARNING notice to the person who saved it and their manager', async () => {
    const sb = on({ autocount_outbox: [failedRow()] });
    const state = publicState();
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true })) as never;

    const r = await drain(envWith(state), fetchImpl);

    /* WITHOUT the alarm this array stays EMPTY: the only trace of a document
       that exists in the ERP and not in AutoCount was a console.error in a
       Workers cron. */
    expect(state.announcements).toHaveLength(1);
    const notice = state.announcements[0];
    expect(notice.source).toBe(AC_ALARM_SOURCE);
    expect(notice.category).toBe('WARNING');
    expect(notice.title).toContain('SO HC-SO-9');
    expect(notice.body).toContain('tunnel down');
    // The saver (7) AND their manager (3): an alarm must not die with one person.
    expect(JSON.parse(notice.target_user_ids)).toEqual([3, 7]);
    expect(r.alarmsRaised).toBe(1);
    // The receipt, so the next sweep does not badger the same people again.
    expect(outbox(sb)[0].alerted_at).toBeTruthy();
  });

  test('the same failure is not re-announced on every sweep', async () => {
    const state = publicState();
    on({ autocount_outbox: [failedRow()] });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true })) as never;

    await drain(envWith(state), fetchImpl);
    const second = await drain(envWith(state), fetchImpl);

    expect(state.announcements).toHaveLength(1);
    expect(second.alarmsRaised).toBe(0);
    // Still counted, though — an alarm that was acknowledged is not a fix.
    expect(second.alarmsOutstanding).toBe(1);
  });

  test('a row with no author still reaches somebody — the administrators', async () => {
    const state = publicState();
    on({ autocount_outbox: [failedRow({ created_by: null })] });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true })) as never;

    await drain(envWith(state), fetchImpl);
    expect(state.announcements).toHaveLength(1);
    // user 1 holds the '*' role. An alarm with no audience is the failure this prevents.
    expect(JSON.parse(state.announcements[0].target_user_ids)).toEqual([1]);
  });

  test('a row that has been WAITING past the stall threshold is alarmed too', async () => {
    const old = new Date(Date.now() - STALL_ALARM_MS - 60_000).toISOString();
    const state = publicState();
    on({
      autocount_outbox: [{
        ...failedRow(), status: 'pending', attempts: 0, op: 'so_to_do', doc_type: 'DO', doc_no: 'DO-77',
        last_error: 'waiting: parent has no AutoCount document yet', first_waiting_at: old,
        next_attempt_at: new Date(Date.now() + 3_600_000).toISOString(),
      }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true })) as never;

    const r = await drain(envWith(state), fetchImpl);
    expect(r.alarmsRaised).toBe(1);
    expect(state.announcements[0].title).toContain('STALLED');
    expect(state.announcements[0].title).toContain('DO DO-77');
  });

  test('a row waiting only a moment is NOT alarmed — the threshold is what makes the alarm mean something', async () => {
    const state = publicState();
    on({
      autocount_outbox: [{
        ...failedRow(), status: 'pending', attempts: 0, op: 'so_to_do', doc_type: 'DO', doc_no: 'DO-77',
        first_waiting_at: new Date().toISOString(),
        next_attempt_at: new Date(Date.now() + 3_600_000).toISOString(),
      }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true })) as never;

    const r = await drain(envWith(state), fetchImpl);
    expect(r.alarmsRaised).toBe(0);
    expect(state.announcements).toHaveLength(0);
  });

  test('the alarm still fires when the write-back cannot send at all', async () => {
    const state = publicState();
    on({ autocount_outbox: [failedRow()] });
    /* AC_SYNC_URL unset — the shape production is in right now (wrangler.toml
       has it commented out). The old drain returned before it looked at
       anything, so a queue full of failures was completely silent. */
    const r = await drain({ DB: fakeDb(state) } as never, (async () => jsonRes(200, {})) as never);

    expect(r.skipped).toBe('ac_service_not_configured');
    expect(state.announcements).toHaveLength(1);
    expect(r.alarmsRaised).toBe(1);
  });
});

// ── 4. the counters that used to be silent ─────────────────────────────────

describe('the sweep says what it did NOT do', () => {
  test('an unconfigured service reports how much work is stranded', async () => {
    const state = publicState();
    on({
      autocount_outbox: [
        { id: 'a', company_id: 1, status: 'pending', attempts: 0, payload: { body: {} }, alerted_at: null },
        { id: 'b', company_id: 1, status: 'pending', attempts: 0, payload: { body: {} }, alerted_at: null },
        { id: 'c', company_id: 1, status: 'sent', attempts: 1, payload: { body: {} }, alerted_at: null },
      ],
    });

    const r = await drain({ DB: fakeDb(state) } as never, (async () => jsonRes(200, {})) as never);
    /* WITHOUT this the answer was {skipped:'ac_service_not_configured',
       processed:0, sent:0, failed:0} — indistinguishable from an empty queue,
       and the cron logged nothing at all because processed and failed were 0. */
    expect(r.undrainedBacklog).toBe(2);
  });

  test('rows held back by the company flag are counted, not silently skipped', async () => {
    const state = publicState();
    currentSb = fakeSb({
      // On for company 1 only; the row below belongs to company 2.
      app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
      autocount_outbox: [{
        id: 'ob-2', company_id: 2, op: 'create_so', doc_type: 'SO', doc_no: 'X-1',
        payload: { body: {} }, status: 'pending', attempts: 0,
        next_attempt_at: new Date(Date.now() - 1000).toISOString(), alerted_at: null,
      }],
    });
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true })) as never;

    const r = await drain(envWith(state), fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    /* WITHOUT the counter the loop `continue`d and every number stayed 0, so a
       company outside the flag accumulated pending rows invisibly. */
    expect(r.heldByFlag).toBe(1);
    expect(r.processed).toBe(0);
  });
});

// ── 5. an unexpected compose error is written down like the expected ones ──

describe('an unforeseen failure is recorded, not dropped', () => {
  test('a compose error that is neither AcReadError nor KeylessLineError still lands as a skipped row', async () => {
    /* mfg_sales_order_items rows whose `variants` is a value the composer
       cannot walk. The read SUCCEEDS, so this is not an AcReadError; the lines
       have keys, so it is not a KeylessLineError. Before the widening,
       noteReadFailure returned at its first line and NOTHING was recorded.
       The getter sits on `fabricColor` because that is a key composeDescription2
       actually reads (autocount-writeback.ts:253) — a getter on a key nobody
       touches never fires, and the test would pass for the wrong reason. */
    const sb = on({
      mfg_sales_orders: [{ doc_no: 'HC-SO-9', linked_ac_docno: 'SO-000021', so_date: '2026-08-11' }],
      mfg_sales_order_items: [{
        id: 'li-1', doc_no: 'HC-SO-9', item_code: 'SKU-1', qty: 1,
        unit_price_centi: 100, linked_ac_dtlkey: 1,
        variants: { get fabricColor(): string { throw new Error('boom'); } },
      }],
    });

    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'SO', docNo: 'HC-SO-9' })).toBe(false);
    const rows = outbox(sb);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].last_error).toContain('unexpected error');
    expect(rows[0].last_error).toContain('boom');
  });
});
