// The bulk list enrichments (PO / GRN / PI / SO lists) read the stored list
// snapshot instead of running live MRP (lib/list-mrp-source.ts, owner
// 2026-11-10). Pinned here:
//   1. PARITY - the snapshot answer, after its jsonb round trip, has the same
//      fields and shape as a live run on the same data, and so the same per-line
//      coverage (SO list) and the same reverse coverage (PO / GRN / PI lists).
//   2. STALE FALLBACK - missing or older than 30 min computes live and says so.
//   3. REFRESH - one live run, stored, rate-limited to one per 60 s.
//   4. COMPANY SCOPE - only the active company's snapshot is read or written.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/agents/procurement-learning', () => ({
  loadLeadBuffers: async () => ({ supplierBufferDays: {}, seasonBufferDays: {} }),
}));

import { computeMrp, mrpLineCoverage, mrpReverseCoverage } from '../src/scm/routes/mrp';
import { NO_BUFFERS } from '../src/scm/lib/lead-time';
import { parsePgrestInList } from '../src/scm/lib/pgrest-in-list';
import { forgetLiveMrp } from '../src/scm/lib/live-mrp-memo';
import { refreshListMrpSnapshot, refreshMrpSnapshot } from '../src/scm/lib/mrp-snapshot';
import {
  LIST_MRP_MAX_AGE_MS, LIST_MRP_REFRESH_MIN_MS, decideListMrp, resolveListMrp,
} from '../src/scm/lib/list-mrp-source';

type Row = Record<string, unknown>;

/* Minimal fake PostgREST (the mrp.test.ts shape) plus the two snapshot tables,
   stored the way jsonb stores them: JSON in, JSON out. */
function world(tables: Record<string, Row[]>, opts: { failMrp?: boolean } = {}) {
  const snapshots: Record<string, Map<number, { result: unknown; computed_at: string }>> = {
    mrp_snapshots: new Map(), mrp_list_snapshots: new Map(),
  };
  const reads: Array<{ table: string; companyId: unknown }> = [];
  class Q {
    rows: Row[];
    private window: [number, number] | null = null;
    constructor(rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    filter(col: string, op: string, val: string) {
      if (op !== 'in') throw new Error(`fake: filter(${op})`);
      return this.in(col, parsePgrestInList(val));
    }
    not() { return this; }
    is(col: string, val: unknown) { this.rows = this.rows.filter((r) => (r[col] ?? null) === val); return this; }
    gt(col: string, val: number) { this.rows = this.rows.filter((r) => Number(r[col] ?? 0) > val); return this; }
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    order() { return this; }
    range(from: number, to: number) { this.window = [from, to]; return this; }
    then<T>(onF: (v: { data: Row[] | null; error: unknown }) => T, onR?: (e: unknown) => T) {
      if (opts.failMrp) return Promise.resolve({ data: null, error: { message: 'db down' } }).then(onF, onR);
      const w = this.window ? this.rows.slice(this.window[0], this.window[1] + 1) : this.rows;
      return Promise.resolve({ data: w.slice(0, 1000), error: null }).then(onF, onR);
    }
  }
  const snapTable = (table: string) => {
    const store = snapshots[table]!;
    return {
      select: () => ({
        eq: (_col: string, companyId: number) => ({
          maybeSingle: async () => {
            reads.push({ table, companyId });
            const row = store.get(companyId);
            return { data: row ? JSON.parse(JSON.stringify(row)) : null, error: null };
          },
        }),
      }),
      upsert: async (row: { company_id: number; result: unknown; computed_at: string }) => {
        store.set(row.company_id, JSON.parse(JSON.stringify({ result: row.result, computed_at: row.computed_at })));
        return { error: null };
      },
    };
  };
  const sb = {
    from: (table: string) => (table in snapshots ? snapTable(table) : new Q(tables[table] ?? [])),
  };
  return { sb, snapshots, reads };
}

function ctx(companyId: number | undefined) {
  const waited: Promise<unknown>[] = [];
  const c = {
    get: (k: string) => (k === 'companyId' ? companyId : undefined),
    env: { DB: {} },
    req: { query: () => undefined },
    executionCtx: { waitUntil: (p: Promise<unknown>) => { waited.push(p); } },
  };
  return { c, waited };
}

// ── fixture: one PO for 8 against a dated line (5) and an UNDATED line (3) ──
// Company 2: company 1 plans a bedframe from its own bound PO only (mrp.test.ts),
// so the pooled PO below would cover nothing there.
const so = (dd: string | null) => ({
  debtor_name: 'Acme', status: 'CONFIRMED', so_date: '2026-07-01',
  customer_delivery_date: dd, processing_date: '2026-07-02', customer_state: null,
});
const demand = (id: string, docNo: string, qty: number, dd: string | null): Row => ({
  id, doc_no: docNo, item_code: 'BF-100', description: 'Baron Bedframe', item_group: 'bedframe',
  variants: { fabricCode: 'RED' }, qty, warehouse_id: 'W1', line_delivery_date: dd, line_no: 1,
  created_at: '2026-07-01T00:00:00Z', cancelled: false, so: so(dd),
});
const poLine = (poNumber: string, qty: number, eta: string): Row => ({
  item_code: 'BF-100', item_group: 'bedframe', variants: { fabricCode: 'RED' }, qty, received_qty: 0,
  delivery_date: eta, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  warehouse_id: 'W1', so_item_id: null,
  po: {
    po_number: poNumber, status: 'SUBMITTED', expected_at: eta,
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
    purchase_location_id: 'W1', supplier_id: null,
  },
});
function tables(companyId: number): Record<string, Row[]> {
  const t: Record<string, Row[]> = {
    mfg_sales_order_items: [demand('si-dated', 'SO-1', 5, '2026-12-01'), demand('si-undated', 'SO-2', 3, null)],
    purchase_order_items: [poLine('PO-RED', 8, '2026-11-01')],
    inventory_balances: [], mfg_products: [], warehouses: [], state_warehouse_mappings: [],
    supplier_material_bindings: [], suppliers: [], mrp_category_lead_times: [], fabric_trackings: [],
    delivery_order_items: [], delivery_return_items: [], v_inventory_lots_open: [],
  };
  for (const rows of Object.values(t)) for (const r of rows) r.company_id = companyId;
  return t;
}
const liveOpts = (companyId: number) => ({ catFilter: null, whFilter: null, includeUndated: true, companyId, leadBuffers: NO_BUFFERS });
const withoutAsOf = (r: unknown) => ({ ...(r as Record<string, unknown>), asOf: null });

const T0 = Date.parse('2026-11-10T06:00:00.000Z');

beforeEach(() => forgetLiveMrp());

describe('decideListMrp', () => {
  it('serves a snapshot up to 30 minutes old', () => {
    expect(decideListMrp(new Date(T0 - LIST_MRP_MAX_AGE_MS).toISOString(), false, T0)).toEqual({ use: 'snapshot' });
  });
  it('falls back to live when the snapshot is missing or older than 30 minutes', () => {
    expect(decideListMrp(null, false, T0)).toEqual({ use: 'live', reason: 'missing' });
    expect(decideListMrp('not-a-date', false, T0)).toEqual({ use: 'live', reason: 'missing' });
    expect(decideListMrp(new Date(T0 - LIST_MRP_MAX_AGE_MS - 1).toISOString(), false, T0)).toEqual({ use: 'live', reason: 'stale' });
  });
  it('Refresh computes live only when the snapshot is at least 60 s old', () => {
    expect(decideListMrp(new Date(T0 - LIST_MRP_REFRESH_MIN_MS + 1).toISOString(), true, T0)).toEqual({ use: 'snapshot' });
    expect(decideListMrp(new Date(T0 - LIST_MRP_REFRESH_MIN_MS).toISOString(), true, T0)).toEqual({ use: 'live', reason: 'refresh' });
  });
});

describe('list snapshot parity with live MRP', () => {
  it('the snapshot answer has the same fields and shape as a live run on the same data', async () => {
    const { sb } = world(tables(2));
    await refreshListMrpSnapshot(sb, 2, NO_BUFFERS, new Date(T0 - 60_000).toISOString());
    const { c } = ctx(2);
    const fromSnap = await resolveListMrp(sb, c, false, () => T0);
    const live = await computeMrp(sb, liveOpts(2));

    expect(fromSnap.meta).toEqual({ asOf: new Date(T0 - 60_000).toISOString(), source: 'snapshot', fallback: null, failed: false });
    expect(withoutAsOf(fromSnap.result)).toEqual(withoutAsOf(live));
    // What the lists actually read from it.
    expect(mrpLineCoverage(fromSnap.result!)).toEqual(mrpLineCoverage(live));
    expect(mrpReverseCoverage(fromSnap.result!)).toEqual(mrpReverseCoverage(live));
    expect(mrpReverseCoverage(live).get('PO-RED')).toHaveLength(2); // the comparison is not of two empty maps
  });

  it('carries undated demand, which the MRP page snapshot hides', async () => {
    const { sb, snapshots } = world(tables(2));
    await refreshListMrpSnapshot(sb, 2, NO_BUFFERS, new Date(T0).toISOString());
    await refreshMrpSnapshot(sb, 2, NO_BUFFERS, new Date(T0).toISOString());
    const listSnap = snapshots.mrp_list_snapshots.get(2)!.result as Parameters<typeof mrpReverseCoverage>[0];
    const pageSnap = snapshots.mrp_snapshots.get(2)!.result as Parameters<typeof mrpReverseCoverage>[0];
    const docsOn = (r: Parameters<typeof mrpReverseCoverage>[0]) =>
      (mrpReverseCoverage(r).get('PO-RED') ?? []).map((a) => a.soDocNo).sort();
    expect(docsOn(listSnap)).toEqual(['SO-1', 'SO-2']);
    expect(docsOn(pageSnap)).toEqual(['SO-1']);
    expect(mrpLineCoverage(listSnap).has('si-undated')).toBe(true);
  });
});

describe('stale fallback', () => {
  it('a snapshot older than 30 minutes computes live, says so, and stores the new run', async () => {
    const { sb, snapshots } = world(tables(2));
    const old = new Date(T0 - LIST_MRP_MAX_AGE_MS - 60_000).toISOString();
    snapshots.mrp_list_snapshots.set(2, { result: { skus: [], sofaSets: [], stale: true }, computed_at: old });
    const { c, waited } = ctx(2);
    const got = await resolveListMrp(sb, c, false, () => T0);
    await Promise.all(waited);

    expect(got.meta).toEqual({ asOf: new Date(T0).toISOString(), source: 'live', fallback: 'stale', failed: false });
    expect(withoutAsOf(got.result)).toEqual(withoutAsOf(await computeMrp(sb, liveOpts(2))));
    expect(snapshots.mrp_list_snapshots.get(2)!.computed_at).toBe(new Date(T0).toISOString());
  });

  it('no snapshot computes live and says "missing"', async () => {
    const { sb } = world(tables(2));
    const got = await resolveListMrp(sb, ctx(2).c, false, () => T0);
    expect(got.meta.source).toBe('live');
    expect(got.meta.fallback).toBe('missing');
    expect(got.result).not.toBeNull();
  });

  it('a failed live run never rejects: empty result, failed flag, nothing stored', async () => {
    const { sb, snapshots } = world(tables(2), { failMrp: true });
    const { c, waited } = ctx(2);
    const got = await resolveListMrp(sb, c, false, () => T0);
    expect(got).toEqual({ result: null, meta: { asOf: null, source: 'live', fallback: 'missing', failed: true } });
    expect(waited).toHaveLength(0);
    expect(snapshots.mrp_list_snapshots.size).toBe(0);
  });
});

describe('Refresh', () => {
  it('within 60 s of the last run it serves the snapshot; after, one live run that the next reader gets', async () => {
    const { sb, snapshots } = world(tables(2));
    await refreshListMrpSnapshot(sb, 2, NO_BUFFERS, new Date(T0 - 30_000).toISOString());

    const early = await resolveListMrp(sb, ctx(2).c, true, () => T0);
    expect(early.meta.source).toBe('snapshot');

    const later = T0 + 60_000;
    const { c, waited } = ctx(2);
    const refreshed = await resolveListMrp(sb, c, true, () => later);
    await Promise.all(waited);
    expect(refreshed.meta).toMatchObject({ source: 'live', fallback: 'refresh' });
    expect(snapshots.mrp_list_snapshots.get(2)!.computed_at).toBe(new Date(later).toISOString());

    const next = await resolveListMrp(sb, ctx(2).c, true, () => later + 1_000);
    expect(next.meta).toMatchObject({ source: 'snapshot', asOf: new Date(later).toISOString() });
  });
});

describe('company scope', () => {
  it('reads only the active company snapshot, and never serves another company', async () => {
    const { sb, snapshots, reads } = world(tables(2));
    snapshots.mrp_list_snapshots.set(1, { result: { skus: [], sofaSets: [], co: 1 }, computed_at: new Date(T0).toISOString() });
    const got = await resolveListMrp(sb, ctx(2).c, false, () => T0);
    expect(reads).toEqual([{ table: 'mrp_list_snapshots', companyId: 2 }]);
    expect(got.meta.fallback).toBe('missing');
    expect((got.result as unknown as { co?: number }).co).toBeUndefined();
  });

  it('no active company: no snapshot read, no write, live run', async () => {
    const { sb, snapshots, reads } = world(tables(1));
    const { c, waited } = ctx(undefined);
    const got = await resolveListMrp(sb, c, false, () => T0);
    expect(reads).toEqual([]);
    expect(waited).toHaveLength(0);
    expect(snapshots.mrp_list_snapshots.size).toBe(0);
    expect(got.meta.source).toBe('live');
  });

  it('never seeds a snapshot for a company the cron does not refresh', async () => {
    const { sb, snapshots } = world(tables(99));
    const { c, waited } = ctx(99);
    await resolveListMrp(sb, c, false, () => T0);
    expect(waited).toHaveLength(0);
    expect(snapshots.mrp_list_snapshots.size).toBe(0);
  });
});
