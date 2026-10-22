import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { documentFlow } from '../src/scm/routes/document-flow';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { makeFakePostgrest, type Row } from './fakePostgrest';

const CO = 1;

function harness(tables: Record<string, Row[]>) {
  const db = makeFakePostgrest(tables, []);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, db as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'T', permissions_set: [] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.route('/document-flow', documentFlow);
  return app;
}

type Flow = { nodes: Array<{ key: string; label: string }>; edges: Array<{ from: string; to: string; kind: string }>; degraded: string[] };
const flow = async (app: Hono, p: string) => (await app.request(p)).json() as Promise<Flow>;
const hasEdge = (f: Flow, from: string, to: string) => f.edges.some((e) => e.from === from && e.to === to);

/* HC-0139: HC-PO-010114 was received on two GRNs, then returned from the PO's
   Raise Return — lines drawn from both receipts, header grn_id NULL. */
function family(headerGrnId: string | null) {
  return {
    mfg_sales_orders: [{ doc_no: 'SO-1', company_id: CO, status: 'CONFIRMED' }],
    mfg_sales_order_items: [{ id: 'soi-1', doc_no: 'SO-1', company_id: CO, qty: 2 }],
    purchase_orders: [{ id: 'po-1', company_id: CO, po_number: 'HC-PO-010114', status: 'RECEIVED', notes: null }],
    purchase_order_items: [{ id: 'poi-1', company_id: CO, purchase_order_id: 'po-1', so_item_id: 'soi-1', qty: 2 }],
    grns: [
      { id: 'grn-1', company_id: CO, grn_number: 'HC-GRN-2609-098', status: 'POSTED', purchase_order_id: 'po-1' },
      { id: 'grn-2', company_id: CO, grn_number: 'HC-GRN-2609-155', status: 'POSTED', purchase_order_id: 'po-1' },
    ],
    grn_items: [
      { id: 'gi-1', company_id: CO, grn_id: 'grn-1', purchase_order_item_id: 'poi-1', qty: 1 },
      { id: 'gi-2', company_id: CO, grn_id: 'grn-2', purchase_order_item_id: 'poi-1', qty: 1 },
    ],
    purchase_returns: [
      { id: 'pr-1', company_id: CO, return_number: 'HC-PRT-2610-001', status: 'POSTED', grn_id: headerGrnId, purchase_order_id: 'po-1' },
    ],
    purchase_return_items: [
      { id: 'pri-1', company_id: CO, purchase_return_id: 'pr-1', grn_item_id: 'gi-1', qty_returned: 1 },
      { id: 'pri-2', company_id: CO, purchase_return_id: 'pr-1', grn_item_id: 'gi-2', qty_returned: 1 },
    ],
  } as Record<string, Row[]>;
}

describe('purchase return found by its LINE link, not only the header grn_id', () => {
  test('PO-raised return (header grn_id NULL) hangs off every GRN its lines came from', async () => {
    const f = await flow(harness(family(null)), '/document-flow/po/po-1');
    expect(f.nodes.map((n) => n.label)).toContain('HC-PRT-2610-001');
    expect(hasEdge(f, 'grn:grn-1', 'pr:pr-1')).toBe(true);
    expect(hasEdge(f, 'grn:grn-2', 'pr:pr-1')).toBe(true);
    expect(f.degraded).toEqual([]);
  });

  test('opened from the return itself, the map reaches its PO and GRNs', async () => {
    const f = await flow(harness(family(null)), '/document-flow/pr/pr-1');
    const keys = f.nodes.map((n) => n.key);
    expect(keys).toEqual(expect.arrayContaining(['po:po-1', 'grn:grn-1', 'grn:grn-2', 'pr:pr-1']));
    expect(hasEdge(f, 'grn:grn-2', 'pr:pr-1')).toBe(true);
  });

  test('a GRN-raised return (header set) is still found once, no duplicate node', async () => {
    const f = await flow(harness(family('grn-1')), '/document-flow/po/po-1');
    expect(f.nodes.filter((n) => n.key === 'pr:pr-1')).toHaveLength(1);
    expect(hasEdge(f, 'grn:grn-1', 'pr:pr-1')).toBe(true);
  });

  test('a header-only return with no line links keeps its header edge', async () => {
    const t = family('grn-2');
    t.purchase_return_items = [];
    const f = await flow(harness(t), '/document-flow/po/po-1');
    expect(hasEdge(f, 'grn:grn-2', 'pr:pr-1')).toBe(true);
  });
});
