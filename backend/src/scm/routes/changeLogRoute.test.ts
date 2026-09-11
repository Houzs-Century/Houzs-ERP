// GET /api/scm/change-log — the page the owner opens after letting staff in.
//
// Harness follows autocountOutboxRoute.test.ts: a bare Hono app whose middleware
// injects the fake PostgREST client and a company context, mounting the EXPORTED
// handler rather than the router (the supabaseAuth bridge cannot run here).
//
// WHAT IS ASSERTED is the owner's requirement, not the shape of the JSON:
//
//   1. The system's own changes are NEVER counted as a person's, and the two
//      numbers are BOTH reported whichever filter is on. This is the entire
//      product — the check that preceded it reported "50 staff actions on
//      migrated orders" and all fifty were the stock-allocation cron (#3177).
//   2. Both audit tables answer as ONE list. A sales order lives in
//      mfg_so_audit_log; a delivery order, purchase order and goods receipt live
//      in entity_audit_log (mig 0139).
//   3. Company scope holds, and the paired same-company request still works — a
//      scope assertion that only checks the negative half passes just as
//      happily when the endpoint returns nothing at all.
//   4. A truncated read says so.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { changeLogHandler } from './change-log';

type Row = Record<string, unknown>;

const soRow = (over: Row = {}): Row => ({
  id: `so-${Math.random().toString(36).slice(2, 9)}`,
  company_id: 1,
  so_doc_no: 'HC-SO-013361',
  action: 'UPDATE_DETAILS',
  actor_id: '00000000-0000-4000-8000-000000000001',
  actor_name_snapshot: 'Wei Siang',
  field_changes: [{ field: 'delivery_address', from: '12 Jalan Lama', to: '88 Jalan Baru' }],
  status_snapshot: null,
  source: 'web',
  created_at: new Date().toISOString(),
  ...over,
});

/** The allocation cron, exactly as so-stock-allocation.ts:998 writes it. */
const cronRow = (over: Row = {}): Row => soRow({
  actor_id: null,
  actor_name_snapshot: 'system (auto-allocate)',
  action: 'UPDATE_LINE',
  source: 'auto-allocation',
  field_changes: [{ field: 'stockStatus', from: 'auto', to: '2 line(s) -> READY' }],
  ...over,
});

const entityRow = (over: Row = {}): Row => ({
  id: `e-${Math.random().toString(36).slice(2, 9)}`,
  company_id: 1,
  entity_type: 'DELIVERY_ORDER',
  entity_id: 'uuid-1',
  entity_doc_no: 'HC-DO-000912',
  action: 'UPDATE',
  actor_id: null,
  actor_name_snapshot: 'Ah Meng',
  field_changes: [{ field: 'status', from: 'DRAFT', to: 'LOADED' }],
  status_snapshot: 'LOADED',
  source: 'web',
  created_at: new Date().toISOString(),
  ...over,
});

function harness(opts: {
  so?: Row[];
  entity?: Row[];
  companyId?: number | undefined;
  perms?: string[];
  /* PostgREST's own response ceiling. Left off, the fake has none — which is
     the state every other case here wants. The truncation suite passes one,
     because a ceiling is the ONLY thing that makes a short read happen. */
  maxRows?: number;
}) {
  const sb = fakeSb({
    mfg_so_audit_log: opts.so ?? [],
    entity_audit_log: opts.entity ?? [],
  }, {}, [], [], opts.maxRows ?? null);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', opts.companyId as Variables['companyId']);
    c.set('user', { id: 'u1' } as unknown as Variables['user']);
    c.set('houzsUser', {
      id: 9,
      name: 'Tester',
      permissions_set: new Set(opts.perms ?? ['scm.changelog.read']),
    } as unknown as Variables['houzsUser']);
    await next();
  });
  app.get('/change-log', changeLogHandler);
  return app;
}

interface Body {
  error?: string;
  message?: string;
  window?: { since: string; until: string; hours: number };
  filters?: { author: string; docTypes: string[] };
  totals?: {
    changesByPerson: number;
    changesBySystem: number;
    documents: number;
    documentsShown: number;
    people: number;
    truncated: boolean;
  };
  documents?: Array<{
    docType: string;
    docNo: string;
    changeCount: number;
    people: string[];
    changes: Array<{ author: string; who: string | null; fields: Array<{ field: string }> }>;
  }>;
}

const get = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/change-log${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};

const docs = (b: Body) => b.documents ?? [];

describe('the split between a person and the system', () => {
  it('counts the cron as the system and reports BOTH numbers, on the person view', async () => {
    const app = harness({ so: [soRow(), cronRow(), cronRow(), cronRow()] });
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(body.totals?.changesByPerson).toBe(1);
    expect(body.totals?.changesBySystem).toBe(3);
    /* The person view shows ONE document, and the system's three are not in it —
       but the reader is still told there were three. */
    expect(docs(body)).toHaveLength(1);
    expect(docs(body)[0].people).toEqual(['Wei Siang']);
  });

  it('reports the same two numbers on the SYSTEM view — the denominator does not move with the filter', async () => {
    const app = harness({ so: [soRow(), cronRow(), cronRow(), cronRow()] });
    const { body } = await get(app, '?author=machine');
    expect(body.totals?.changesByPerson).toBe(1);
    expect(body.totals?.changesBySystem).toBe(3);
    expect(docs(body)).toHaveLength(1);
    /* A machine-only document credits nobody, so the page can say so rather than
       showing a blank name. */
    expect(docs(body)[0].people).toEqual([]);
    expect(docs(body)[0].changes[0].author).toBe('machine');
  });

  it("a salesperson's edit is a PERSON even though actor_id is the pinned system uuid", async () => {
    /* The whole of docs/bugs/0704 in one assertion, at the endpoint. */
    const app = harness({ so: [soRow()] });
    const { body } = await get(app);
    expect(body.totals?.changesByPerson).toBe(1);
    expect(docs(body)[0].changes[0].author).toBe('person');
    expect(docs(body)[0].changes[0].who).toBe('Wei Siang');
  });

  it('an unattributed row counts as a PERSON, so it surfaces rather than hiding', async () => {
    const app = harness({ so: [soRow({ actor_id: null, actor_name_snapshot: null })] });
    const { body } = await get(app);
    expect(body.totals?.changesByPerson).toBe(1);
    expect(body.totals?.changesBySystem).toBe(0);
    expect(docs(body)[0].changes[0].who).toBeNull();
  });
});

describe('two tables, one answer', () => {
  it('merges the sales-order trail and the entity trail into one list', async () => {
    const app = harness({
      so: [soRow()],
      entity: [
        entityRow(),
        entityRow({ entity_type: 'PURCHASE_ORDER', entity_doc_no: 'HC-PO-000441' }),
        entityRow({ entity_type: 'GRN', entity_doc_no: 'HC-GR-00077' }),
      ],
    });
    const { body } = await get(app, '?author=all');
    expect(docs(body).map((d) => d.docType).sort()).toEqual(['DO', 'GRN', 'PO', 'SO']);
    expect(body.totals?.documents).toBe(4);
  });

  it('narrows to one document type when asked, and the type it returns is the one asked for', async () => {
    const app = harness({ so: [soRow()], entity: [entityRow()] });
    const { body } = await get(app, '?docType=DO');
    expect(docs(body)).toHaveLength(1);
    expect(docs(body)[0].docType).toBe('DO');
    expect(docs(body)[0].docNo).toBe('HC-DO-000912');
  });

  it('an UNRECOGNISED docType returns everything, never an empty list that reads as "nothing happened"', async () => {
    const app = harness({ so: [soRow()], entity: [entityRow()] });
    const { body } = await get(app, '?docType=BANANA');
    expect(docs(body).length).toBe(2);
  });

  it('folds a document with several changes into ONE row carrying all of them', async () => {
    const app = harness({ so: [soRow(), soRow({ actor_name_snapshot: 'Ah Meng' }), soRow()] });
    const { body } = await get(app);
    expect(docs(body)).toHaveLength(1);
    expect(docs(body)[0].changeCount).toBe(3);
    expect(docs(body)[0].people.sort()).toEqual(['Ah Meng', 'Wei Siang']);
    expect(body.totals?.people).toBe(2);
  });

  it('keeps a row whose document number has not been minted yet, keyed by its uuid', async () => {
    const app = harness({ entity: [entityRow({ entity_doc_no: null, action: 'CREATE' })] });
    const { body } = await get(app);
    expect(docs(body)).toHaveLength(1);
    expect(docs(body)[0].docNo).toBe('uuid-1');
  });
});

describe('the boundary', () => {
  it('refuses a caller holding neither key, and says which keys it wants', async () => {
    const app = harness({ so: [soRow()], perms: ['scm.access'] });
    const { status, body } = await get(app);
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.message).toContain('scm.changelog.read');
  });

  it('admits settings.manage, the other key the route accepts', async () => {
    const app = harness({ so: [soRow()], perms: ['settings.manage'] });
    expect((await get(app)).status).toBe(200);
  });

  it('does not serve another company\'s rows', async () => {
    const app = harness({ so: [soRow({ company_id: 2 })], companyId: 1 });
    const { body } = await get(app);
    expect(docs(body)).toHaveLength(0);
    expect(body.totals?.changesByPerson).toBe(0);
  });

  it('DOES serve its own company\'s rows — the paired half of the scope test', async () => {
    const app = harness({ so: [soRow({ company_id: 1 })], companyId: 1 });
    expect(docs(await (await get(app)).body)).toHaveLength(1);
  });
});

describe('the window', () => {
  it('defaults to seven days and caps a silly one rather than reading the whole trail', async () => {
    const app = harness({ so: [soRow()] });
    expect((await get(app)).body.window?.hours).toBe(168);
    expect((await get(app, '?hours=999999')).body.window?.hours).toBe(2880);
    expect((await get(app, '?hours=-3')).body.window?.hours).toBe(168);
    expect((await get(app, '?hours=nonsense')).body.window?.hours).toBe(168);
  });

  it('leaves out a change older than the window', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    const app = harness({ so: [soRow({ created_at: old })] });
    expect(docs((await get(app, '?hours=24')).body)).toHaveLength(0);
    expect(docs((await get(app, '?hours=2880')).body)).toHaveLength(1);
  });

  it('does not report a truncated read on an ordinary one', async () => {
    const app = harness({ so: [soRow()] });
    expect((await get(app)).body.totals?.truncated).toBe(false);
  });
});

/* THE WARNING THAT MUST NEVER BE SILENT — frontend/src/lib/changeLog.ts's own
   words for `clTruncationNote`, the banner telling the owner every count above
   is a floor. It was silent, always: `truncated` was `rows.length >= ROW_CAP`
   with ROW_CAP 4,000, and `rows` is the SUM of two reads that PostgREST caps
   at `db-max-rows` each. At the 1,000 this repo assumes the sum tops out at
   2,000, so the comparison could not be true however much the window held.

   Only the POSITIVE case was ever missing. The suite above already asserted
   the negative, which is why nothing went red for it. */
describe('a read that stopped early SAYS so', () => {
  const many = (n: number, make: (i: number) => Row) =>
    Array.from({ length: n }, (_, i) => make(i));

  it('reports truncated when the SO window holds more than one read returns', async () => {
    const app = harness({
      so: many(1_200, (i) => soRow({ so_doc_no: `HC-SO-${String(i).padStart(6, '0')}` })),
      maxRows: 1_000,
    });
    const { body } = await get(app);
    expect(body.totals?.truncated).toBe(true);
  });

  it('reports truncated when it is the OTHER table that came back short', async () => {
    const app = harness({
      so: [soRow()],
      entity: many(1_200, (i) => entityRow({ entity_doc_no: `HC-DO-${String(i).padStart(6, '0')}` })),
      maxRows: 1_000,
    });
    expect((await get(app)).body.totals?.truncated).toBe(true);
  });

  it('stays false at exactly the ceiling with nothing behind it', async () => {
    /* The boundary the old test got wrong in the other direction. A read that
       returns every matching row is complete even when that number equals the
       ceiling — Content-Range says so, and a `>=` against a cap could not. */
    const app = harness({
      so: many(1_000, (i) => soRow({ so_doc_no: `HC-SO-${String(i).padStart(6, '0')}` })),
      maxRows: 1_000,
    });
    expect((await get(app)).body.totals?.truncated).toBe(false);
  });
});

describe('a change with no readable diff still records WHO and WHEN', () => {
  it('renders no fields rather than throwing on a field_changes that is not an array', async () => {
    const app = harness({ so: [soRow({ field_changes: 'not-an-array' })] });
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(docs(body)[0].changes[0].fields).toEqual([]);
    expect(docs(body)[0].changes[0].who).toBe('Wei Siang');
  });
});
