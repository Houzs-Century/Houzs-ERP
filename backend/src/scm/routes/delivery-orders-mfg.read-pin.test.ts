// PINS what the DO picker and both DO-create paths answer, so the read-path
// speed-up (perf/do-create-and-picker) can be shown to change nothing.
//
// Written and snapshotted against the code BEFORE that change. The snapshots
// hold every response body AND the ordered list of writes each create makes —
// the speed-up may only overlap or merge READS, so the write log must be
// byte-identical too.
//
// The fake resolves the PostgREST embeds these paths ask for (a DO line's
// parent DO, a return line's parent return, an SO line's DO lines), so both the
// old two-step reads and the embedded read run against ONE set of rows.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import type { Env, Variables } from '../env';

type Row = Record<string, unknown>;
type Write = { table: string; op: string; payload?: unknown; match?: string };

/* ── fixture ─────────────────────────────────────────────────────────────── */
function world(): Record<string, Row[]> {
  const soLine = (id: string, doc: string, code: string, qty: number, extra: Row = {}): Row => ({
    id, doc_no: doc, company_id: doc === 'SO-X' ? 2 : 1, item_code: code, item_group: 'ACCESSORY',
    description: `Item ${code}`, description2: null, uom: 'UNIT', qty, unit_price_sen: 10000, unit_cost_sen: 4000,
    discount_sen: 0, variants: {}, cancelled: false, warehouse_id: null, photo_urls: [],
    debtor_code: 'LINE-COPY', debtor_name: 'Line Copy', line_no: Number(id.replace(/\D/g, '')) || null,
    created_at: '2026-10-01T00:00:00+00:00', gap_inches: null, divan_height_inches: null, divan_price_sen: 0,
    leg_height_inches: null, leg_price_sen: 0, custom_specials: null, line_suffix: null, special_order_price_sen: 0,
    po_qty_picked: 0, ...extra,
  });
  return {
    mfg_sales_orders: [
      { id: 'h-a', doc_no: 'SO-A', company_id: 1, status: 'CONFIRMED', on_hold: false, debtor_code: 'D1', debtor_name: 'ALICE', ref: 'REF-A', customer_so_no: 'CSO-A' },
      { id: 'h-b', doc_no: 'SO-B', company_id: 1, status: 'CONFIRMED', on_hold: false, debtor_code: 'D2', debtor_name: 'BOB', ref: null, customer_so_no: null },
      { id: 'h-c', doc_no: 'SO-C', company_id: 1, status: 'DRAFT', on_hold: false, debtor_code: 'D1', debtor_name: 'ALICE', ref: null, customer_so_no: null },
      { id: 'h-z', doc_no: 'SO-Z', company_id: 1, status: 'CANCELLED', on_hold: false, debtor_code: 'D9', debtor_name: 'ZED', ref: null, customer_so_no: null },
      { id: 'h-x', doc_no: 'SO-X', company_id: 2, status: 'CONFIRMED', on_hold: false, debtor_code: 'D7', debtor_name: 'XENA', ref: null, customer_so_no: null },
    ],
    mfg_sales_order_items: [
      soLine('a1', 'SO-A', 'PIL-1', 4),
      soLine('a2', 'SO-A', 'PIL-1', 2),
      soLine('a3', 'SO-A', 'MAT-1', 3),
      soLine('a4', 'SO-A', 'SVC-1', 1, { item_group: 'SERVICE' }),
      soLine('a5', 'SO-A', 'MAT-1', 9, { cancelled: true }),
      soLine('b1', 'SO-B', 'PIL-1', 5),
      soLine('b2', 'SO-B', 'MAT-1', 1, { line_no: null }),
      soLine('c1', 'SO-C', 'PIL-1', 2),
      soLine('z1', 'SO-Z', 'PIL-1', 2),
      soLine('x1', 'SO-X', 'PIL-1', 2),
    ],
    delivery_orders: [
      { id: 'do-1', do_number: 'DO-2610-001', company_id: 1, so_doc_no: 'SO-A', status: 'DELIVERED' },
      { id: 'do-2', do_number: 'DO-2610-002', company_id: 1, so_doc_no: 'SO-A', status: 'DRAFT' },
      { id: 'do-3', do_number: 'DO-2610-003', company_id: 1, so_doc_no: 'SO-A', status: 'CANCELLED' },
      { id: 'do-4', do_number: 'DO-2610-004', company_id: 1, so_doc_no: 'SO-B', status: 'IN_TRANSIT' },
      { id: 'do-5', do_number: 'DO-2610-005', company_id: 1, so_doc_no: 'SO-A', status: 'LOADED' },
      { id: 'do-6', do_number: 'DO-2610-006', company_id: 1, so_doc_no: null, status: 'DELIVERED' },
    ],
    delivery_order_items: [
      { id: 'dl-01', delivery_order_id: 'do-1', so_item_id: 'a1', item_code: 'PIL-1', qty: 2, company_id: 1 },
      { id: 'dl-02', delivery_order_id: 'do-2', so_item_id: 'a1', item_code: 'PIL-1', qty: 1, company_id: 1 },
      { id: 'dl-03', delivery_order_id: 'do-3', so_item_id: 'a3', item_code: 'MAT-1', qty: 3, company_id: 1 },
      { id: 'dl-04', delivery_order_id: 'do-5', so_item_id: 'a3', item_code: 'MAT-1', qty: 1, company_id: 1 },
      { id: 'dl-05', delivery_order_id: 'do-1', so_item_id: 'a3', item_code: 'MAT-1', qty: 3, company_id: 1 },
      // Unlinked under SO-A: 3 x PIL-1 fills a1's last 2 then spills 1 onto a2.
      { id: 'dl-06', delivery_order_id: 'do-1', so_item_id: null, item_code: 'pil-1 ', qty: 3, company_id: 1 },
      { id: 'dl-07', delivery_order_id: 'do-4', so_item_id: 'b1', item_code: 'PIL-1', qty: 5, company_id: 1 },
      { id: 'dl-08', delivery_order_id: 'do-6', so_item_id: null, item_code: 'MAT-1', qty: 1, company_id: 1 },
      { id: 'dl-09', delivery_order_id: 'do-missing', so_item_id: 'a4', item_code: 'SVC-1', qty: 1, company_id: 1 },
      { id: 'dl-10', delivery_order_id: 'do-4', so_item_id: 'a5', item_code: 'MAT-1', qty: 1, company_id: 1 },
    ],
    delivery_returns: [
      { id: 'dr-1', status: 'RECEIVED', company_id: 1 },
      { id: 'dr-2', status: 'CANCELLED', company_id: 1 },
    ],
    delivery_return_items: [
      // a3 fully delivered, one unit back -> remaining 1; the cancelled return counts nothing.
      { id: 'ri-1', do_item_id: 'dl-05', qty_returned: 1, delivery_return_id: 'dr-1', company_id: 1 },
      { id: 'ri-2', do_item_id: 'dl-07', qty_returned: 2, delivery_return_id: 'dr-2', company_id: 1 },
      // A return on the UNLINKED shipment re-opens the SO line it was attributed to.
      { id: 'ri-3', do_item_id: 'dl-06', qty_returned: 1, delivery_return_id: 'dr-1', company_id: 1 },
    ],
    mfg_products: [
      { id: 'p1', code: 'PIL-1', category: 'ACCESSORY', company_id: 1, status: 'ACTIVE' },
      { id: 'p2', code: 'MAT-1', category: 'MATTRESS', company_id: 1, status: 'ACTIVE' },
      { id: 'p3', code: 'SVC-1', category: 'SERVICE', company_id: 1, status: 'ACTIVE' },
    ],
    warehouses: [{ id: 'wh-1', code: 'MAIN', name: 'Main', company_id: 1, is_default: true, active: true }],
    inventory_balances: [],
  };
}

/* ── PostgREST fake with the embeds these paths use ──────────────────────── */
/* capReturns: a server row cap below PAGE, on the return-line table only. */
type FakeOpts = { failEmbed?: boolean; failCount?: boolean; capReturns?: number; calls?: string[] };
function fakeSb(tables: Record<string, Row[]>, writes: Write[], opts: FakeOpts = {}) {
  let minted = 0;
  const pick = (r: Row | undefined, cols: string[]) => (r ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : null);
  const rowsOf = (t: string): Row[] => tables[t] ?? [];
  const byId = (t: string, id: unknown) => rowsOf(t).find((r) => r.id === id);
  const mk = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const sorts: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    let win: [number, number] | null = null;
    let lim: number | null = null;
    let sel = '';
    let head = false;
    let single = false;
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let payload: Row[] = [];
    let patch: Row = {};
    const matchDesc: string[] = [];
    const shape = (r: Row): Row => {
      const out: Row = { ...r };
      if (table === 'delivery_order_items') {
        const h = byId('delivery_orders', r.delivery_order_id);
        if (sel.includes('parent:delivery_orders')) out.parent = pick(h, ['status']);
        if (sel.includes('delivery_order:delivery_orders')) out.delivery_order = pick(h, ['so_doc_no', 'status']);
      }
      if (table === 'delivery_return_items' && sel.includes('parent:delivery_returns')) {
        out.parent = pick(byId('delivery_returns', r.delivery_return_id), ['status']);
      }
      if (table === 'mfg_sales_order_items' && sel.includes('do_lines:delivery_order_items')) {
        out.do_lines = rowsOf('delivery_order_items').filter((d) => d.so_item_id === r.id).map((d) => ({
          id: d.id, qty: d.qty,
          parent: pick(byId('delivery_orders', d.delivery_order_id), ['status']),
          delivery_order: pick(byId('delivery_orders', d.delivery_order_id), ['status']),
        }));
      }
      if (table === 'mfg_sales_order_items' && sel.includes('so:mfg_sales_orders')) {
        out.so = rowsOf('mfg_sales_orders').find((h) => h.doc_no === r.doc_no) ?? null;
      }
      return out;
    };
    const cmp = (a: unknown, b: unknown) => (typeof a === 'number' ? Number(a) - Number(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
    const matched = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (op === 'insert' || op === 'upsert') {
        const rows = payload.map((p) => ({ id: p.id ?? `${table}-new-${++minted}`, ...p }));
        (tables[table] ??= []).push(...rows);
        writes.push({ table, op, payload: payload.map((p) => ({ ...p })) });
        return { data: single ? rows[0] : rows, error: null };
      }
      if (op === 'update') {
        const hit = matched();
        for (const r of hit) Object.assign(r, patch);
        writes.push({ table, op, payload: patch, match: matchDesc.join('&') });
        return { data: single ? hit[0] ?? null : hit, error: null };
      }
      if (op === 'delete') {
        const hit = new Set(matched());
        tables[table] = (tables[table] ?? []).filter((r) => !hit.has(r));
        writes.push({ table, op, match: matchDesc.join('&') });
        return { data: null, error: null };
      }
      opts.calls?.push(`${table}${head ? ' (count)' : ''}`);
      if (opts.failEmbed && sel.includes('do_lines:')) return { data: null, error: { message: 'embed refused' } };
      let rows = matched();
      if (head) return opts.failCount ? { data: null, count: null, error: { message: 'count refused' } } : { data: null, count: rows.length, error: null };
      rows = [...rows].sort((a, b) => {
        for (const s of sorts) {
          const x = a[s.col] ?? null; const y = b[s.col] ?? null;
          if (x === y) continue;
          if (x === null) return s.nullsFirst ? -1 : 1;
          if (y === null) return s.nullsFirst ? 1 : -1;
          return cmp(x, y) * (s.asc ? 1 : -1);
        }
        return 0;
      });
      if (win) rows = rows.slice(win[0], win[1] + 1);
      if (lim != null) rows = rows.slice(0, lim);
      if (opts.capReturns != null && table === 'delivery_return_items') rows = rows.slice(0, opts.capReturns);
      const shaped = rows.map(shape);
      return single ? { data: shaped[0] ?? null, error: null } : { data: shaped, count: shaped.length, error: null };
    };
    const filt = (desc: string, f: (r: Row) => boolean) => { filters.push(f); matchDesc.push(desc); return proxy; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable fake, no static shape by design
    const proxy: any = new Proxy({}, {
      get(_t, prop) {
        switch (prop) {
          case 'then': return (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, ko);
          case 'select': return (cols?: string, opts?: { head?: boolean }) => { if (op === 'select') sel = cols ?? '*'; if (opts?.head) head = true; return proxy; };
          case 'eq': return (c: string, v: unknown) => filt(`${c}=${String(v)}`, (r) => String(r[c]) === String(v));
          case 'neq': return (c: string, v: unknown) => filt(`${c}!=${String(v)}`, (r) => String(r[c]) !== String(v));
          case 'in': return (c: string, v: unknown[]) => filt(`${c} in`, (r) => v.map(String).includes(String(r[c])));
          case 'is': return (c: string, v: unknown) => filt(`${c} is ${String(v)}`, (r) => (v === null ? r[c] == null : r[c] === v));
          case 'not': return (c: string, o: string, v: unknown) => filt(`not ${c}`, (r) => {
            if (o === 'is' && v === null) return r[c] != null;
            if (o === 'in') return !String(v).replace(/[()"]/g, '').split(',').includes(String(r[c]));
            return String(r[c]) !== String(v);
          });
          case 'gt': return (c: string, v: unknown) => filt(`${c}>`, (r) => r[c] != null && cmp(r[c], v) > 0);
          case 'gte': return (c: string, v: unknown) => filt(`${c}>=`, (r) => r[c] != null && cmp(r[c], v) >= 0);
          case 'lt': return (c: string, v: unknown) => filt(`${c}<`, (r) => r[c] != null && cmp(r[c], v) < 0);
          case 'lte': return (c: string, v: unknown) => filt(`${c}<=`, (r) => r[c] != null && cmp(r[c], v) <= 0);
          case 'order': return (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => { sorts.push({ col: c, asc: o?.ascending ?? true, nullsFirst: o?.nullsFirst ?? false }); return proxy; };
          case 'range': return (f: number, t: number) => { win = [f, t]; return proxy; };
          case 'limit': return (n: number) => { lim = n; return proxy; };
          case 'single': case 'maybeSingle': return () => { single = true; return proxy; };
          case 'insert': case 'upsert': return (p: Row | Row[]) => { op = prop; payload = Array.isArray(p) ? p : [p]; return proxy; };
          case 'update': return (p: Row) => { op = 'update'; patch = p; return proxy; };
          case 'delete': return () => { op = 'delete'; return proxy; };
          default: return () => proxy;
        }
      },
    });
    return proxy;
  };
  return {
    tables,
    from: (t: string) => mk(t),
    rpc: () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'no rpc in this harness' } }),
  };
}

/* ── harness ─────────────────────────────────────────────────────────────── */
let current = fakeSb(world(), []);
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => current }));

const CALLER = {
  id: '7', email: 'ops@houzs.test', app_metadata: {},
  user_metadata: { name: 'Ops' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { deliveryOrdersMfg, soDeliverableRemaining } = await import('./delivery-orders-mfg');

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const writes: Write[] = [];
  current = fakeSb(world(), writes);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', current as unknown as Variables['supabase']);
    await next();
  });
  app.route('/', deliveryOrdersMfg);
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, {} as Env);
  return { status: res.status, body: await res.json(), writes };
}

/* Strip the per-run noise (dates minted from today) so the snapshot holds the
   decisions, not the clock. */
const stable = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, val) =>
  (['do_date', 'created_at', 'updated_at', 'confirmed_at'].includes(k) && typeof val === 'string' ? '<date>' : val)));

describe('soDeliverableRemaining — pinned', () => {
  it('answers the same descriptor for every line of the requested orders', async () => {
    const out = await soDeliverableRemaining(fakeSb(world(), []), ['SO-A', 'SO-B', 'SO-C', 'SO-NONE']);
    expect([...out.entries()]).toMatchSnapshot();
  });

  it('a refused embedded read falls back to the two-step read and answers the same', async () => {
    const plain = await soDeliverableRemaining(fakeSb(world(), []), ['SO-A', 'SO-B', 'SO-C']);
    const fallback = await soDeliverableRemaining(fakeSb(world(), [], { failEmbed: true }), ['SO-A', 'SO-B', 'SO-C']);
    expect([...fallback.entries()]).toEqual([...plain.entries()]);
  });

  /* Big enough that the return-line read would take more than one wave of
     chunked requests, so the whole-table keyset read is chosen. Every way that
     read can be in doubt must land on the chunked read with the same answer. */
  it('many shipped lines: the whole-table return read answers what the chunked read answers', async () => {
    const big = (): Record<string, Row[]> => {
      const t = world();
      for (let i = 0; i < 600; i++) {
        const id = `big-${String(i).padStart(4, '0')}`;
        t.mfg_sales_order_items!.push({ ...t.mfg_sales_order_items![0]!, id, doc_no: 'SO-A', line_no: 100 + i, qty: 3 });
        t.delivery_order_items!.push({ id: `bdl-${id}`, delivery_order_id: i % 7 === 0 ? 'do-2' : 'do-1', so_item_id: id, item_code: 'PIL-1', qty: 2, company_id: 1 });
        if (i % 3 === 0) t.delivery_return_items!.push({ id: `bri-${id}`, do_item_id: `bdl-${id}`, qty_returned: 1, delivery_return_id: i % 2 ? 'dr-1' : 'dr-2', company_id: 1 });
      }
      return t;
    };
    const run = async (opts: FakeOpts) => {
      const calls: string[] = [];
      const out = await soDeliverableRemaining(fakeSb(big(), [], { ...opts, calls }), ['SO-A', 'SO-B']);
      return { out: [...out.entries()].sort(([a], [b]) => a.localeCompare(b)), returnReads: calls.filter((c) => c.startsWith('delivery_return_items')).length };
    };
    const scan = await run({});
    const chunked = await run({ failCount: true });
    const capped = await run({ capReturns: 100 });
    expect(scan.out).toEqual(chunked.out);
    expect(capped.out).toEqual(chunked.out);
    expect(scan.returnReads).toBe(2);           // the count + one keyset page
    expect(chunked.returnReads).toBeGreaterThan(6);
    // The fixture really exercises returns: some lines re-opened, cancelled returns ignored.
    expect(scan.out.filter(([, l]) => l.returned > 0).length).toBeGreaterThan(50);
  });

  it('an empty request reads nothing and answers empty', async () => {
    expect((await soDeliverableRemaining(fakeSb(world(), []), [])).size).toBe(0);
  });
});

describe('GET /deliverable-so-lines — pinned', () => {
  it('without ?docNos (the whole active company)', async () => {
    const r = await call('GET', '/deliverable-so-lines');
    expect(r.status).toBe(200);
    expect(r.body).toMatchSnapshot();
  });

  it('with ?docNos=', async () => {
    const r = await call('GET', '/deliverable-so-lines?docNos=SO-B,SO-A,SO-B');
    expect(r.status).toBe(200);
    expect(r.body).toMatchSnapshot();
  });
});

describe('POST /from-sos — pinned', () => {
  const cases: Array<[string, unknown]> = [
    ['draft success over two lines of one order', { picks: [{ soItemId: 'a4', qty: 1 }, { soItemId: 'a2', qty: 1 }], asDraft: true, confirmShortStock: true, confirmNotReady: true }],
    ['over remaining', { picks: [{ soItemId: 'a1', qty: 1 }], asDraft: true, confirmShortStock: true, confirmNotReady: true }],
    ['mixed customers', { picks: [{ soItemId: 'a2', qty: 1 }, { soItemId: 'b2', qty: 1 }], asDraft: true, confirmShortStock: true, confirmNotReady: true }],
    ['undeliverable (draft) order', { picks: [{ soItemId: 'c1', qty: 1 }], asDraft: true, confirmShortStock: true, confirmNotReady: true }],
    ['unknown line', { picks: [{ soItemId: 'nope', qty: 1 }], asDraft: true }],
    ['short stock without confirmation', { picks: [{ soItemId: 'b2', qty: 1 }], asDraft: true, confirmNotReady: true }],
    ['not-ready without confirmation', { picks: [{ soItemId: 'b2', qty: 1 }], asDraft: true, confirmShortStock: true }],
  ];
  it.each(cases)('%s', async (_name, body) => {
    const r = await call('POST', '/from-sos', body);
    expect(stable({ status: r.status, body: r.body, writes: r.writes })).toMatchSnapshot();
  });
});

describe('POST / (create DO) — pinned', () => {
  const base = { debtorName: 'ALICE', debtorCode: 'D1', soDocNo: 'SO-A', asDraft: true };
  const line = (soItemId: string | null, itemCode: string, qty: number) => ({ soItemId, itemCode, qty, description: itemCode, unitPriceSen: 10000 });
  const cases: Array<[string, unknown]> = [
    ['draft success', { ...base, confirmShortStock: true, confirmNotReady: true, items: [line('a2', 'PIL-1', 1), line('a4', 'SVC-1', 1)] }],
    ['over remaining', { ...base, confirmShortStock: true, confirmNotReady: true, items: [line('a2', 'PIL-1', 3)] }],
    ['unlinked line of an item the order already has', { ...base, confirmShortStock: true, confirmNotReady: true, items: [line(null, 'MAT-1', 1)] }],
    ['undeliverable order via a line link', { ...base, soDocNo: null, confirmShortStock: true, confirmNotReady: true, items: [line('c1', 'PIL-1', 1)] }],
    ['cross-company order', { ...base, soDocNo: 'SO-X', confirmShortStock: true, confirmNotReady: true, items: [line('x1', 'PIL-1', 1)] }],
    ['unknown item code', { ...base, confirmShortStock: true, confirmNotReady: true, items: [line(null, 'NOPE-9', 1)] }],
    ['wrong item on a line link', { ...base, confirmShortStock: true, confirmNotReady: true, items: [line('a2', 'MAT-1', 1)] }],
    ['short stock without confirmation', { ...base, confirmNotReady: true, items: [line('a2', 'PIL-1', 1)] }],
    ['not-ready without confirmation', { ...base, confirmShortStock: true, items: [line('a2', 'PIL-1', 1)] }],
    ['no debtor', { items: [] }],
  ];
  it.each(cases)('%s', async (_name, body) => {
    const r = await call('POST', '/', body);
    expect(stable({ status: r.status, body: r.body, writes: r.writes })).toMatchSnapshot();
  });
});
