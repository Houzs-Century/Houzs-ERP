import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { documentFlow } from '../src/scm/routes/document-flow';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { chunkSizeForUrl, PAGE } from '../src/scm/lib/paginate-all';
import { makeFakePostgrest, type Row } from './fakePostgrest';

const CO = 1;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MAX_IN = chunkSizeForUrl([uuid(0)]); // 76: the largest .in() list chunkIn will ever send

/* Production behaviours the plain fake does not have, added at the boundary:
   (1) an .in() list longer than chunkIn's own budget is REFUSED  -> { data:null, error }
   (2) a read with no .range() is cut at PostgREST's 1000-row cap, silently. */
function guard(b: any, st = { big: false, ranged: false }): any {
  return new Proxy(b, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (p === 'then') {
        return (res: any, rej: any) => Promise.resolve(v.call(t)).then((r: any) => {
          if (st.big) return { data: null, error: { message: 'Bad Request' } };
          if (!st.ranged && Array.isArray(r?.data)) return { ...r, data: r.data.slice(0, PAGE) };
          return r;
        }).then(res, rej);
      }
      if (typeof v !== 'function') return v;
      return (...a: any[]) => {
        if (p === 'in' && Array.isArray(a[1]) && a[1].length > MAX_IN) st.big = true;
        if (p === 'range') st.ranged = true;
        const r = v.apply(t, a);
        return r === t ? guard(b, st) : r;
      };
    },
  });
}

/* `failCalls` fails the Nth (1-based) from(table) request, so one batch of a
   multi-batch read can fail while its siblings succeed. */
function harness(tables: Record<string, Row[]>, failTable?: string, failCalls?: { table: string; nth: number[] }) {
  const db = makeFakePostgrest(tables, []);
  let calls = 0;
  const sb = {
    from: (t: string) => {
      const hit = failCalls?.table === t && failCalls.nth.includes(++calls);
      return guard(db.from(t) as any, { big: t === failTable || hit, ranged: false });
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never); // supabaseAuth steps aside
    c.set('houzsUser' as never, { name: 'T', permissions_set: [] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.route('/document-flow', documentFlow);
  return app;
}

type Flow = { nodes: Array<{ key: string; label: string }>; edges: Array<{ from: string; to: string; kind: string }> };
const flow = async (app: Hono, p: string) => (await app.request(p)).json() as Promise<Flow>;

/* SO-1 has one line. PO-A (header of the consolidated GRN) and PO-B (under test)
   both buy it. PO-B also carries `fill` non-SO lines. The GRN header names PO-A;
   every PO-B line is received by it. `soRooted:false` drops the SO link so the
   anchor takes the orphan-PO branch instead. */
function family(fill: number, soRooted = true, last = false) {
  const so = soRooted ? 'soi-1' : null;
  const item = (id: string, po: string, soItem: string | null) =>
    ({ id, company_id: CO, purchase_order_id: po, so_item_id: soItem, qty: 1 });
  const filler = Array.from({ length: fill }, (_, i) => item(uuid(1000 + i), 'po-B', null));
  /* b-0 is the line under test. `last` puts it AFTER the filler so a read cut at
     1000 rows (no .range) loses exactly it. */
  const bLines = last ? [...filler, item('b-0', 'po-B', so)] : [item('b-0', 'po-B', so), ...filler];
  return {
    mfg_sales_orders: soRooted ? [{ doc_no: 'SO-1', company_id: CO, status: 'CONFIRMED' }] : [],
    mfg_sales_order_items: soRooted ? [{ id: 'soi-1', doc_no: 'SO-1', company_id: CO, qty: 2 }] : [],
    purchase_orders: [
      { id: 'po-A', company_id: CO, po_number: 'HC-PO-2609-075', status: 'RECEIVED', notes: null },
      { id: 'po-B', company_id: CO, po_number: 'HC-PO-2609-127', status: 'RECEIVED', notes: null },
    ],
    purchase_order_items: [item('a-0', 'po-A', so), ...bLines],
    grns: [{ id: 'grn-1', company_id: CO, grn_number: 'HC-GRN-2610-063', status: 'RECEIVED', purchase_order_id: 'po-A' }],
    grn_items: [
      { id: 'gi-a', company_id: CO, grn_id: 'grn-1', purchase_order_item_id: 'a-0', qty: 1 },
      ...bLines.map((l, i) => ({ id: uuid(5000 + i), company_id: CO, grn_id: 'grn-1', purchase_order_item_id: l.id, qty: 1 })),
    ],
  } as Record<string, Row[]>;
}
const hasEdge = (f: Flow, from: string, to: string) => f.edges.some((e) => e.from === from && e.to === to);

describe('PO map: a consolidated GRN reaches every PO whose LINES it received', () => {
  test('SO-rooted: header names PO-A, lines are PO-B items -> po:B has the edge (section 6)', async () => {
    const f = await flow(harness(family(2)), '/document-flow/po/po-B');
    expect(hasEdge(f, 'po:po-B', 'grn:grn-1')).toBe(true);
    expect(f.nodes.map((n) => n.label)).toContain('HC-GRN-2610-063');
  });

  test('healthy read reports nothing degraded', async () => {
    const f = await flow(harness(family(2)), '/document-flow/po/po-B');
    expect((f as any).degraded).toEqual([]);
  });

  test('SO-rooted, many ids: PO-B with 3x the URL budget of lines still gets its edge (section 6)', async () => {
    const f = await flow(harness(family(MAX_IN * 3)), '/document-flow/po/po-B');
    expect(hasEdge(f, 'po:po-B', 'grn:grn-1')).toBe(true);
  });

  test('SO-rooted, >1000 rows: purchase_order_items read must page, not truncate', async () => {
    // 2 po ids -> 1 batch, so only the row cap (not the URL budget) can drop the line.
    const f = await flow(harness(family(PAGE + 200, true, true)), '/document-flow/po/po-B');
    expect(hasEdge(f, 'po:po-B', 'grn:grn-1')).toBe(true);
  });

  test('a failed read is surfaced in `degraded` (and the map still renders)', async () => {
    const f = await flow(harness(family(2), 'grn_items'), '/document-flow/po/po-B');
    expect(f.nodes.map((n) => n.key)).toContain('po:po-B');
    expect((f as any).degraded).toContain('grn_items');
  });

  test('orphan PO (no SO link), many ids: edge still appears (orphan branch)', async () => {
    const f = await flow(harness(family(MAX_IN * 3, false)), '/document-flow/po/po-B');
    expect(hasEdge(f, 'po:po-B', 'grn:grn-1')).toBe(true);
  });

  test('anchor resolution chunks: PO-B with > MAX_IN distinct so_item_ids still resolves the SO root and the GRN', async () => {
    const t = family(0);
    const n = MAX_IN * 2 + 5;
    t.mfg_sales_order_items = [
      ...t.mfg_sales_order_items!,
      ...Array.from({ length: n }, (_, i) => ({ id: uuid(9000 + i), doc_no: 'SO-1', company_id: CO, qty: 1 })),
    ];
    // PO-B carries only the many SO lines; its sole lead to SO-1 is this big IN list.
    t.purchase_order_items = [
      t.purchase_order_items![0]!,
      ...Array.from({ length: n }, (_, i) => ({ id: uuid(8000 + i), company_id: CO, purchase_order_id: 'po-B', so_item_id: uuid(9000 + i), qty: 1 })),
    ];
    t.grn_items = [{ id: 'gi-b', company_id: CO, grn_id: 'grn-1', purchase_order_item_id: uuid(8000), qty: 1 }];
    const f = await flow(harness(t), '/document-flow/po/po-B');
    expect(hasEdge(f, 'po:po-B', 'grn:grn-1')).toBe(true);
    expect((f as any).rootSos).toEqual(['SO-1']);
    expect((f as any).degraded).toEqual([]);
  });

  test('a failed fk-over-note read keeps the note edge and reports degraded', async () => {
    const t = family(2, false);
    t.mfg_sales_orders = [{ doc_no: 'SO-1', company_id: CO, status: 'CONFIRMED' }];
    t.mfg_sales_order_items = [{ id: 'soi-1', doc_no: 'SO-1', company_id: CO, qty: 2 }];
    t.purchase_orders = t.purchase_orders!.map((p) => (p.id === 'po-A' ? { ...p, notes: 'From SOs: SO-1' } : p));
    const f = await flow(harness(t, 'purchase_order_items'), '/document-flow/so/SO-1');
    expect((f as any).degraded).toContain('purchase_order_items(fk-over-note)');
    expect(hasEdge(f, 'so:SO-1', 'po:po-A')).toBe(true);
  });

  test('consignment response carries degraded: [] like every other family', async () => {
    const res = await harness({}).request('/document-flow/cso/NONE');
    expect(((await res.json()) as any).degraded).toEqual([]);
  });

  test('batch 2 of 4 fails (and its retry): degraded, and no coverage is derived from the partial rows', async () => {
    // 232 PO lines -> 4 batches of 76; calls 1-4 are the read, 5-8 its retry.
    const f = await flow(harness(family(MAX_IN * 3), undefined, { table: 'grn_items', nth: [2, 6] }), '/document-flow/po/po-B');
    expect((f as any).degraded).toContain('grn_items');
    expect(hasEdge(f, 'po:po-A', 'grn:grn-1')).toBe(true); // header-FK fallback, not a partial "coverage"
    expect(hasEdge(f, 'po:po-B', 'grn:grn-1')).toBe(false);
  });

  test('a transient batch failure is retried and not reported', async () => {
    const f = await flow(harness(family(MAX_IN * 3), undefined, { table: 'grn_items', nth: [2] }), '/document-flow/po/po-B');
    expect((f as any).degraded).toEqual([]);
    expect(hasEdge(f, 'po:po-B', 'grn:grn-1')).toBe(true);
  });

  test('orphan branch: a failed grn_items read is surfaced in degraded', async () => {
    const f = await flow(harness(family(2, false), 'grn_items'), '/document-flow/po/po-B');
    expect(f.nodes.map((n) => n.key)).toContain('po:po-B');
    expect((f as any).degraded).toContain('orphan grn_items');
  });

  test('a failed purchase_orders notes scan is surfaced in degraded', async () => {
    const t = family(2);
    const f = await flow(harness(t, 'purchase_orders'), '/document-flow/so/SO-1');
    expect((f as any).degraded).toContain('purchase_orders(notes)');
  });
});
