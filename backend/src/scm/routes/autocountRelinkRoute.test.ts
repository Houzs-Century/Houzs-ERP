// POST /api/scm/autocount-outbox/relink-lines — matching a keyless document's
// lines back to the account book. This suite pins the 2026-09-10 extension to
// the four CONVERSION document types (DO/GR/IV/PI): before it, the route 400'd
// for anything but SO/PO, so a keyless delivery order could never be matched up.
//
// Harness mirrors autocountOutboxRoute.test.ts: a bare Hono app whose middleware
// injects the fake-postgrest client and a company + permission context, mounting
// the EXPORTED handler. `callAcRead` is mocked so the "book" is fixture data —
// the host is not reachable from a unit test, and the point here is the header/
// line WIRING, not the read transport.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, Variables } from '../env';
import { fakeSb } from '../lib/fake-postgrest';

/* The book read is mocked at the module boundary the route imports it from. Each
   test sets `bookLines` and the mock returns them as a successful doc-read. */
let bookLines: Array<{ DtlKey: number; ItemCode: string; Desc2?: string | null }> = [];
vi.mock('../../services/autocount-host-read', () => ({
  callAcRead: vi.fn(async () => ({ ok: true, body: { lines: bookLines } })),
}));

const { autocountRelinkLinesHandler } = await import('./autocount-relink');

type Row = Record<string, unknown>;

function harness(tables: Record<string, Row[]>, perms: string[] = ['scm.autocount.requeue']) {
  const sb = fakeSb(tables, {});
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', 1 as Variables['companyId']);
    c.set('user', { id: 'u1' } as unknown as Variables['user']);
    c.set('houzsUser', {
      id: 9, name: 'Tester', permissions_set: new Set(perms),
    } as unknown as Variables['houzsUser']);
    await next();
  });
  app.post('/autocount-outbox/relink-lines', autocountRelinkLinesHandler);
  return Object.assign(app, { sb });
}

const post = (app: Hono<{ Bindings: Env; Variables: Variables }>, body: unknown) =>
  app.request('/autocount-outbox/relink-lines', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => { bookLines = []; });

describe('relink extends to conversion documents (DO)', () => {
  it('matches a keyless delivery-order line to the book key via the outbox doc_id', async () => {
    /* The book holds this DO under HC-DO-2609-020 with a keyed line for NK-1046. */
    bookLines = [{ DtlKey: 55501, ItemCode: 'NK-1046 (Q)', Desc2: null }];

    const app = harness({
      /* The queue row: a DO whose doc_no is the header UUID (an unnumbered DO),
         so the header can only be found through doc_id — the case the extension
         exists for. */
      autocount_outbox: [{
        id: 'ob-1', company_id: 1, op: 'edit', doc_type: 'DO',
        doc_no: 'do-uuid-1', doc_id: 'do-uuid-1',
        status: 'skipped', created_at: '2026-09-10T00:00:00.000Z',
      }],
      delivery_orders: [{ id: 'do-uuid-1', company_id: 1, linked_ac_docno: 'HC-DO-2609-020' }],
      delivery_order_items: [{
        id: 'doi-1', company_id: 1, delivery_order_id: 'do-uuid-1',
        item_code: 'NK-1046 (Q)', description2: null, linked_ac_dtlkey: null,
      }],
    });

    const res = await post(app, { docType: 'DO', docNo: 'do-uuid-1' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; matched: number; couldNotMatch: string[] };
    expect(body.ok).toBe(true);
    expect(body.matched).toBe(1);
    expect(body.couldNotMatch).toEqual([]);

    /* The proof is the row, not the report: the keyless line now carries the
       book's DtlKey. */
    const after = await app.sb.from('delivery_order_items')
      .select('linked_ac_dtlkey').eq('id', 'doi-1').maybeSingle();
    expect(Number(after.data.linked_ac_dtlkey)).toBe(55501);
  });

  it('refuses the ambiguous line and names it, rather than guessing', async () => {
    /* Two book lines share the item code and neither side has a Desc2 to tell
       them apart — planLineRelink must refuse, and the row must stay keyless. */
    bookLines = [
      { DtlKey: 60001, ItemCode: 'HOK-2008(A) (K)', Desc2: null },
      { DtlKey: 60002, ItemCode: 'HOK-2008(A) (K)', Desc2: null },
    ];
    const app = harness({
      autocount_outbox: [{
        id: 'ob-2', company_id: 1, op: 'edit', doc_type: 'DO',
        doc_no: 'do-uuid-2', doc_id: 'do-uuid-2',
        status: 'skipped', created_at: '2026-09-10T00:00:00.000Z',
      }],
      delivery_orders: [{ id: 'do-uuid-2', company_id: 1, linked_ac_docno: 'HC-DO-2609-021' }],
      delivery_order_items: [{
        id: 'doi-2', company_id: 1, delivery_order_id: 'do-uuid-2',
        item_code: 'HOK-2008(A) (K)', description2: null, linked_ac_dtlkey: null,
      }],
    });

    const res = await post(app, { docType: 'DO', docNo: 'do-uuid-2' });
    const body = await res.json() as { matched: number; couldNotMatch: string[] };
    expect(body.matched).toBe(0);
    expect(body.couldNotMatch.length).toBe(1);
    const after = await app.sb.from('delivery_order_items')
      .select('linked_ac_dtlkey').eq('id', 'doi-2').maybeSingle();
    expect(after.data.linked_ac_dtlkey).toBeNull();
  });

  it('404s a conversion document with no queued row carrying a doc_id', async () => {
    const app = harness({
      autocount_outbox: [],
      delivery_orders: [{ id: 'do-uuid-3', company_id: 1, linked_ac_docno: 'HC-DO-2609-022' }],
      delivery_order_items: [],
    });
    const res = await post(app, { docType: 'DO', docNo: 'do-uuid-3' });
    expect(res.status).toBe(404);
  });
});
