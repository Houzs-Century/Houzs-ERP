import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { documentFlow } from '../src/scm/routes/document-flow';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { makeFakePostgrest, type Row } from './fakePostgrest';

/* HC-0139: a purchase return raised from the PO page ("Raise Return") stores
   grn_id = null and links its lines to the GRN lines. The map read returns by
   the header grn_id only, so PO010114's map had no return node. */
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

type Flow = { nodes: Array<{ key: string; label: string }>; edges: Array<{ from: string; to: string }> };
const flow = async (app: Hono, p: string) => (await app.request(p)).json() as Promise<Flow>;
const hasEdge = (f: Flow, from: string, to: string) => f.edges.some((e) => e.from === from && e.to === to);

/* PO-1 has one line received on two GRNs (one unit each); one return sends
   both units back and names no header GRN. `soRooted:false` takes the orphan-PO branch. */
function family(soRooted: boolean): Record<string, Row[]> {
  return {
    mfg_sales_orders: soRooted ? [{ doc_no: 'SO-1', company_id: CO, status: 'CONFIRMED' }] : [],
    mfg_sales_order_items: soRooted ? [{ id: 'soi-1', doc_no: 'SO-1', company_id: CO, qty: 2 }] : [],
    purchase_orders: [{ id: 'po-1', company_id: CO, po_number: 'HC-PO-010114', status: 'RECEIVED', notes: null }],
    purchase_order_items: [{ id: 'poi-1', company_id: CO, purchase_order_id: 'po-1', so_item_id: soRooted ? 'soi-1' : null, qty: 2 }],
    grns: [
      { id: 'grn-a', company_id: CO, grn_number: 'GRN2609-098', status: 'POSTED', purchase_order_id: 'po-1' },
      { id: 'grn-b', company_id: CO, grn_number: 'GRN2609-155', status: 'POSTED', purchase_order_id: 'po-1' },
    ],
    grn_items: [
      { id: 'gi-a', company_id: CO, grn_id: 'grn-a', purchase_order_item_id: 'poi-1', qty_accepted: 1 },
      { id: 'gi-b', company_id: CO, grn_id: 'grn-b', purchase_order_item_id: 'poi-1', qty_accepted: 1 },
    ],
    purchase_returns: [{ id: 'pr-1', company_id: CO, return_number: 'PRT-2610-001', status: 'POSTED', grn_id: null, purchase_order_id: 'po-1' }],
    purchase_return_items: [
      { id: 'pri-a', company_id: CO, purchase_return_id: 'pr-1', grn_item_id: 'gi-a', qty_returned: 1 },
      { id: 'pri-b', company_id: CO, purchase_return_id: 'pr-1', grn_item_id: 'gi-b', qty_returned: 1 },
    ],
  };
}

describe('PO map: a purchase return with no header GRN is found by its line links', () => {
  for (const soRooted of [true, false]) {
    test(`${soRooted ? 'SO-rooted' : 'orphan'} PO shows the return under both GRNs`, async () => {
      const f = await flow(harness(family(soRooted)), '/document-flow/po/po-1');
      expect(f.nodes.map((n) => n.label)).toContain('PRT-2610-001');
      expect(hasEdge(f, 'grn:grn-a', 'pr:pr-1')).toBe(true);
      expect(hasEdge(f, 'grn:grn-b', 'pr:pr-1')).toBe(true);
    });
  }

  test('a header-only return (no line links) still hangs off its header GRN', async () => {
    const t = family(true);
    t.purchase_returns = [{ ...t.purchase_returns![0]!, grn_id: 'grn-a' }];
    t.purchase_return_items = [];
    const f = await flow(harness(t), '/document-flow/po/po-1');
    expect(hasEdge(f, 'grn:grn-a', 'pr:pr-1')).toBe(true);
    expect(hasEdge(f, 'grn:grn-b', 'pr:pr-1')).toBe(false);
  });
});
