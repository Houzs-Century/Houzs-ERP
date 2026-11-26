import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { beforeEach, describe, expect, it } from 'vitest';

import { fakeSb } from '../lib/fake-postgrest';
import { REQUEUE_NOTE_PREFIX } from '../lib/autocount-outbox-status';
import { AC_REQUEUE_MEANING } from '../lib/autocount-requeue';
import { resetWritebackFlagCache } from '../lib/autocount-writeback-flag';
import {
  AC_DOC_SCAN_MAX,
  listAutocountOutboxHandler,
  requeueAutocountOutboxHandler,
  archiveAutocountOutboxHandler,
  restoreAutocountOutboxHandler,
  REQUEUED_LIKE,
} from './autocount-outbox';

beforeEach(() => resetWritebackFlagCache());

type Row = Record<string, unknown>;

const row = (over: Row = {}): Row => ({
  id: `ob-${Math.random().toString(36).slice(2, 9)}`,
  company_id: 1,
  op: 'create_so',
  doc_type: 'SO',
  doc_no: 'HC-SO-2608-001',
  doc_id: null,
  status: 'pending',
  attempts: 0,
  last_error: null,
  ac_doc_no: null,
  created_at: '2026-08-15T00:00:00.000Z',
  updated_at: '2026-08-15T00:00:00.000Z',
  sent_at: null,
  ...over,
});

function harness(opts: {
  outbox?: Row[];
  flag?: string | null;
  companyId?: number | undefined;
  perms?: string[];
  missingAppConfigValue?: boolean;
}) {
  const sb = fakeSb(
    {
      autocount_outbox: opts.outbox ?? [],
      app_config:
        opts.flag === undefined || opts.flag === null
          ? []
          : [{ key: 'scm.autocount_writeback', value: opts.flag }],
    },
    opts.missingAppConfigValue ? { app_config: ['value'] } : {},
  );
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', opts.companyId as Variables['companyId']);
    c.set('user', { id: 'u1' } as unknown as Variables['user']);
    c.set('houzsUser', {
      id: 9,
      name: 'Tester',
      permissions_set: new Set(opts.perms ?? ['scm.autocount.read']),
    } as unknown as Variables['houzsUser']);
    await next();
  });
  app.get('/autocount-outbox', listAutocountOutboxHandler);
  app.post('/autocount-outbox/archive', archiveAutocountOutboxHandler);
  app.post('/autocount-outbox/restore', restoreAutocountOutboxHandler);
  return Object.assign(app, { sb });
}

interface Body {
  error?: string;
  reason?: string;
  message?: string;
  allowed?: readonly string[];
  writeback?: { value: string | null; on: boolean; scope: string };
  counts?: Record<string, number>;
  counts_complete?: boolean;
  oldest_pending?: { doc_type: string; doc_no: string; op: string; attempts: number } | null;
  rows?: Array<Record<string, unknown>>;
  truncated?: boolean;
  meta?: {
    max_attempts: number;
    state_meaning: Record<string, string>;
    skip_kinds: Array<{ kind: string; remedy: string }>;
  };
}

const get = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/autocount-outbox${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};

const rowsOf = (body: Body): Array<Record<string, unknown>> => {
  if (!body.rows) throw new Error('the response carried no rows array');
  return body.rows;
};
const idsOf = (body: Body): string[] => rowsOf(body).map((r) => String(r.id));
const countsOf = (body: Body): Record<string, number> => {
  if (!body.counts) throw new Error('the response carried no counts');
  return body.counts;
};

describe('GET /autocount-outbox — permission gate', () => {
  it('refuses a caller holding neither key, and names what is needed', async () => {
    const app = harness({ outbox: [row()], perms: ['scm.access'] });
    const { status, body } = await get(app);
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.message).toContain('scm.autocount.read');
    expect(body.rows).toBeUndefined();
    expect(body.counts).toBeUndefined();
  });

  it('admits the narrow key', async () => {
    const { status, body } = await get(harness({ outbox: [row()], perms: ['scm.autocount.read'] }));
    expect(status).toBe(200);
    expect(rowsOf(body)).toHaveLength(1);
  });

  it('admits settings.manage', async () => {
    const { status } = await get(harness({ outbox: [row()], perms: ['settings.manage'] }));
    expect(status).toBe(200);
  });

  it('admits the wildcard the owner and IT Admin hold', async () => {
    const { status } = await get(harness({ outbox: [row()], perms: ['*'] }));
    expect(status).toBe(200);
  });
});

describe('GET /autocount-outbox — company scope', () => {
  const mixed = [
    row({ id: 'mine', company_id: 1, doc_no: 'HC-SO-2608-001', status: 'failed', last_error: 'FK_SO_SalesAgent' }),
    row({ id: 'theirs', company_id: 2, doc_no: 'OTHER-SO-1', status: 'failed', last_error: 'FK_SO_SalesAgent' }),
  ];

  it('never returns another company row, and still returns its own', async () => {
    const { body } = await get(harness({ outbox: mixed, companyId: 1 }));
    expect(idsOf(body)).toEqual(['mine']);
    expect(countsOf(body).failed).toBe(1);
    expect(countsOf(body).total).toBe(1);
  });

  it('scopes the OTHER direction too — company 2 sees only its own', async () => {
    const { body } = await get(harness({ outbox: mixed, companyId: 2 }));
    expect(idsOf(body)).toEqual(['theirs']);
    expect(countsOf(body).failed).toBe(1);
  });

  it('scopes the oldest-pending probe as well', async () => {
    const { body } = await get(harness({
      outbox: [
        row({ id: 'theirs', company_id: 2, doc_no: 'OTHER-SO-1', status: 'pending', created_at: '2026-01-01T00:00:00.000Z' }),
        row({ id: 'mine', company_id: 1, doc_no: 'HC-SO-2608-009', status: 'pending', created_at: '2026-08-15T00:00:00.000Z' }),
      ],
      companyId: 1,
    }));
    expect(body.oldest_pending?.doc_no).toBe('HC-SO-2608-009');
    expect(countsOf(body).pending).toBe(1);
  });
});

describe('GET /autocount-outbox — every state renders its reason', () => {
  const requeuedNote = `${REQUEUE_NOTE_PREFIX} 2026-08-14T10:00:00.000Z -> outbox ob-new] refused, nothing sent (ItemCodeError): 9028-1S maps to two AutoCount items`;
  const all = [
    row({ id: 'p', doc_no: 'SO-P', status: 'pending', attempts: 2, last_error: 'AcSyncService threw: timeout opening the book' }),
    row({ id: 's', doc_no: 'SO-S', status: 'sent', ac_doc_no: 'SO-00123', sent_at: '2026-08-15T01:00:00.000Z' }),
    row({ id: 'f', doc_no: 'SO-F', status: 'failed', attempts: 6, last_error: 'Gave up after 6 attempts. Last error: FK_SO_SalesAgent' }),
    row({ id: 'k', doc_no: 'SO-K', status: 'skipped', last_error: 'refused, nothing sent (MissingLocationError): line 2 carries no warehouse' }),
    row({ id: 'r', doc_no: 'SO-R', status: 'skipped', last_error: requeuedNote }),
  ];

  it('gives every row a state and a reason, and never truncates the reason', async () => {
    const { body } = await get(harness({ outbox: all }));
    const by = Object.fromEntries(rowsOf(body).map((r) => [String(r.id), r]));

    expect(by.p.state).toBe('pending');
    expect(by.p.reason).toBe('AcSyncService threw: timeout opening the book');
    expect(by.p.attempts).toBe(2);

    expect(by.s.state).toBe('sent');
    expect(by.s.ac_doc_no).toBe('SO-00123');

    expect(by.f.state).toBe('failed');
    expect(by.f.reason).toContain('FK_SO_SalesAgent');
    expect(by.f.needs_attention).toBe(true);

    expect(by.k.state).toBe('skipped');
    expect(by.k.reason_kind).toBe('missing-location');
    expect(by.k.remedy).toContain('stock location');
    expect(by.k.needs_attention).toBe(true);

    expect(by.r.state).toBe('requeued');
    expect(by.r.needs_attention).toBe(false);
  });

  it('keeps a long AutoCount error whole', async () => {
    const long = `AutoCount refused it: ${'x'.repeat(900)}`;
    const { body } = await get(harness({ outbox: [row({ status: 'failed', last_error: long })] }));
    expect(rowsOf(body)[0].reason).toBe(long);
    expect(rowsOf(body)[0].reason).toHaveLength(long.length);
  });

  it('names an unrecognised skip rather than filing it under a neighbour', async () => {
    const { body } = await get(harness({
      outbox: [row({ status: 'skipped', last_error: 'a refusal class written next month' })],
    }));
    expect(rowsOf(body)[0].reason_kind).toBe('unrecognised');
    expect(rowsOf(body)[0].remedy).toBeNull();
    expect(rowsOf(body)[0].reason).toBe('a refusal class written next month');
  });

  it('ships the legend with the data so the page holds no second copy', async () => {
    const { body } = await get(harness({ outbox: [] }));
    expect(body.meta?.max_attempts).toBe(6);
    expect(body.meta?.state_meaning.failed).toContain('NOT in the account book');
    expect(body.meta?.skip_kinds.map((k) => k.kind)).toContain('keyless-line');
  });
});

describe('GET /autocount-outbox — a re-queued skip is history, not backlog', () => {
  const requeued = row({
    id: 'r', doc_no: 'SO-R', status: 'skipped',
    last_error: `${REQUEUE_NOTE_PREFIX} 2026-08-14T10:00:00.000Z -> outbox ob-new] refused, nothing sent (ItemCodeError): x`,
  });
  const openSkip = row({
    id: 'k', doc_no: 'SO-K', status: 'skipped',
    last_error: 'refused, nothing sent (KeylessLineError): line 3 has no DtlKey',
  });

  it('does not count a re-queued skip as outstanding or as needing attention', async () => {
    const { body } = await get(harness({ outbox: [requeued, openSkip] }));
    expect(countsOf(body).skipped).toBe(1);
    expect(countsOf(body).requeued).toBe(1);
    expect(countsOf(body).attention).toBe(1);
  });

  it('state=attention returns the open refusal and not the settled one', async () => {
    const { body } = await get(harness({ outbox: [requeued, openSkip] }), '?state=attention');
    expect(idsOf(body)).toEqual(['k']);
  });

  it('state=skipped excludes it and state=requeued is where it shows', async () => {
    const app = harness({ outbox: [requeued, openSkip] });
    expect(idsOf((await get(app, '?state=skipped')).body)).toEqual(['k']);
    expect(idsOf((await get(harness({ outbox: [requeued, openSkip] }), '?state=requeued')).body)).toEqual(['r']);
  });

  it('the re-queued LIKE pattern carries no wildcard but its own trailing %', () => {
    expect(REQUEUED_LIKE).toBe(`${REQUEUE_NOTE_PREFIX}%`);
    expect(REQUEUE_NOTE_PREFIX).not.toMatch(/[%_\\]/);
  });
});

/* THE #2220 SCENARIO, ON THE COUNTS.
   #2189 gave the re-queue tool an includeFailed opt-in, so a re-queued row can
   be a FAILED one. #2220 taught acOutboxState that and the ROWS started
   rendering "Re-queued" — but these counts kept a skipped-only rule of their
   own, so the tiles and the headline went on saying "2 documents need attention
   (2 failed)" above a list where every row read Re-queued. Measured against the
   route on main 2026-08-15: counts {failed 2, requeued 0, attention 2}, rows
   [requeued, requeued], and ?state=requeued returned []. */
describe('GET /autocount-outbox — a re-queued FAILED row is history too', () => {
  const note = `${REQUEUE_NOTE_PREFIX} 2026-08-15T01:00:00.000Z -> outbox ob-new] Gave up after 6 attempts.`;
  const requeuedFailed = row({
    id: 'rf', doc_no: 'SO-RF', status: 'failed', attempts: 6, last_error: note,
  });
  const openFailure = row({
    id: 'f', doc_no: 'SO-F', status: 'failed', attempts: 6,
    last_error: 'Gave up after 6 attempts. Last error: FK_SO_SalesAgent',
  });

  it('does not count it as failed, or as needing attention', async () => {
    const { body } = await get(harness({ outbox: [requeuedFailed] }));
    expect(countsOf(body)).toMatchObject({ failed: 0, requeued: 1, attention: 0 });
    expect(countsOf(body).total).toBe(1);
  });

  it('leaves a genuine failure counted', async () => {
    const { body } = await get(harness({ outbox: [requeuedFailed, openFailure] }));
    expect(countsOf(body)).toMatchObject({ failed: 1, requeued: 1, attention: 1, total: 2 });
  });

  it('shows it under Re-queued and not under Failed', async () => {
    const both = [requeuedFailed, openFailure];
    expect(idsOf((await get(harness({ outbox: both }), '?state=requeued')).body)).toEqual(['rf']);
    expect(idsOf((await get(harness({ outbox: both }), '?state=failed')).body)).toEqual(['f']);
    expect(idsOf((await get(harness({ outbox: both }), '?state=attention')).body)).toEqual(['f']);
  });

  it('counts re-queued skips and re-queued failures together', async () => {
    const requeuedSkip = row({
      id: 'rs', doc_no: 'SO-RS', status: 'skipped',
      last_error: `${REQUEUE_NOTE_PREFIX} 2026-08-15T01:00:00.000Z -> outbox ob-2] refused, nothing sent (ItemCodeError): x`,
    });
    const { body } = await get(harness({ outbox: [requeuedFailed, requeuedSkip] }));
    expect(countsOf(body)).toMatchObject({ failed: 0, skipped: 0, requeued: 2, attention: 0, total: 2 });
  });

  /* A PENDING row carrying the marker is the LIVE attempt, not history — the
     case #2220's own fix was careful not to swallow, asserted here on the
     counts as well as on the state. */
  it('a pending row carrying the marker is still pending', async () => {
    const pendingMarked = row({ id: 'p', doc_no: 'SO-P', status: 'pending', last_error: note });
    const { body } = await get(harness({ outbox: [pendingMarked] }));
    expect(countsOf(body)).toMatchObject({ pending: 1, requeued: 0, attention: 0 });
    expect(rowsOf(body)[0].state).toBe('pending');
  });
});

describe('GET /autocount-outbox — the switch and the empty queue', () => {
  it('reports the raw flag value AND the verdict, so a typo is visible', async () => {
    const { body } = await get(harness({ outbox: [], flag: 'On ' }));
    expect(body.writeback?.value).toBe('On ');
    expect(body.writeback?.on).toBe(false);
  });

  it('reads an on flag as on, for the named company', async () => {
    const { body } = await get(harness({ outbox: [], flag: '1', companyId: 1 }));
    expect(body.writeback?.on).toBe(true);
    expect(body.writeback?.scope).toBe('1');
  });

  it('is OFF for a company the allow-list does not name, while still reporting the scope', async () => {
    const { body } = await get(harness({ outbox: [], flag: '1', companyId: 2 }));
    expect(body.writeback?.on).toBe(false);
    expect(body.writeback?.scope).toBe('1');
    expect(body.writeback?.value).toBe('1');
  });

  it("'all' is on for every company, including one not in any list", async () => {
    const { body } = await get(harness({ outbox: [], flag: 'all', companyId: 2 }));
    expect(body.writeback?.on).toBe(true);
    expect(body.writeback?.scope).toBe('all');
  });

  it('answers null, not false, when the company cannot be resolved', async () => {
    const { body } = await get(harness({ outbox: [], flag: '1', companyId: undefined }));
    expect(body.writeback?.on).toBeNull();
    expect(body.writeback?.scope).toBe('1');
  });

  it('an off switch is off for everyone, resolved company or not', async () => {
    const off = await get(harness({ outbox: [], flag: 'off', companyId: 1 }));
    expect(off.body.writeback?.on).toBe(false);
    const unresolved = await get(harness({ outbox: [], flag: 'off', companyId: undefined }));
    expect(unresolved.body.writeback?.on).toBe(false);
  });

  it('refuses the whole response when the switch cannot be read', async () => {
    const app = harness({ outbox: [row()], missingAppConfigValue: true });
    const { status, body } = await get(app);
    expect(status).toBe(500);
    expect(body.error).toBe('load_failed');
    expect(body.reason).toContain('write-back switch could not be read');
    expect(body.writeback).toBeUndefined();
    expect(body.counts).toBeUndefined();
  });

  it('an absent row is off, and an empty queue is zero of everything', async () => {
    const { body } = await get(harness({ outbox: [], flag: null }));
    expect(body.writeback?.value).toBeNull();
    expect(body.writeback?.on).toBe(false);
    expect(countsOf(body)).toEqual({
      pending: 0, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, archived: 0, total: 0,
    });
    expect(body.counts_complete).toBe(true);
    expect(body.oldest_pending).toBeNull();
    expect(rowsOf(body)).toEqual([]);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   THE COUNTS ARE DOCUMENTS, NOT SENDS.

   Owner, 2026-08-16, on the live page: "为什么在 AutoCount 里面一张 Sales Order 会
   出现两次呢?" HC-SO-2608-002 took four of six rows under In AutoCount / Sales
   orders while AED_HOUZS holds exactly one of it, and the header read
   "6 of 17 documents" over a list of SENDS. scm.autocount_outbox is append-only
   and writes one row per intended operation (0277), so a document created and
   then edited three times IS four rows — the counts were the wrong unit.
   ─────────────────────────────────────────────────────────────────────────── */
describe('GET /autocount-outbox — one document counted once', () => {
  const fourSends = [
    row({ id: 's1', op: 'create_so', doc_no: 'HC-SO-2608-002', status: 'sent',
      created_at: '2026-08-14T17:25:00.000Z' }),
    row({ id: 's2', op: 'edit', doc_no: 'HC-SO-2608-002', status: 'sent',
      created_at: '2026-08-16T08:30:12.000Z' }),
    row({ id: 's3', op: 'edit', doc_no: 'HC-SO-2608-002', status: 'sent',
      created_at: '2026-08-16T08:31:05.000Z' }),
    row({ id: 's4', op: 'edit', doc_no: 'HC-SO-2608-002', status: 'sent',
      created_at: '2026-08-16T08:31:40.000Z' }),
  ];

  it('counts one sales order once, however many times it was sent', async () => {
    const { body } = await get(harness({ outbox: fourSends }));
    expect(countsOf(body).sent).toBe(1);
    expect(countsOf(body).total).toBe(1);
    expect(rowsOf(body)).toHaveLength(4);
  });

  it('keeps two types carrying one number apart', async () => {
    const { body } = await get(harness({
      outbox: [
        row({ id: 'so', doc_type: 'SO', doc_no: '2608-002', status: 'sent' }),
        row({ id: 'do', doc_type: 'DO', doc_no: '2608-002', status: 'sent' }),
      ],
    }));
    expect(countsOf(body).sent).toBe(2);
    expect(countsOf(body).total).toBe(2);
  });

  it('counts a document under every state it has a send in', async () => {
    const { body } = await get(harness({
      outbox: [
        row({ id: 'a', doc_no: 'HC-SO-2608-002', status: 'sent',
          created_at: '2026-08-14T00:00:00.000Z' }),
        row({ id: 'b', op: 'edit', doc_no: 'HC-SO-2608-002', status: 'failed', attempts: 6,
          last_error: 'Gave up after 6 attempts.', created_at: '2026-08-16T00:00:00.000Z' }),
      ],
    }));
    expect(countsOf(body)).toMatchObject({ sent: 1, failed: 1, attention: 1, total: 1 });
  });

  it('says whether it managed to scan the whole queue', async () => {
    const { body } = await get(harness({ outbox: fourSends }));
    expect(body.counts_complete).toBe(true);
  });

  it('refuses to call a partial scan a count', async () => {
    const overCap = Array.from(
      { length: AC_DOC_SCAN_MAX + 1 },
      (_, i) => row({ id: `n${i}`, doc_no: `SO-${i}`, status: 'sent' }),
    );
    const { body } = await get(harness({ outbox: overCap }), '?limit=1');
    expect(body.counts_complete).toBe(false);
    expect(countsOf(body).sent).toBe(AC_DOC_SCAN_MAX);
  });

  it('applies the re-queue marker per send, not per document', async () => {
    const marker = `${REQUEUE_NOTE_PREFIX} 2026-08-16T02:00:00.000Z -> outbox ob-new] refused, nothing sent (ItemCodeError): x`;
    const { body } = await get(harness({
      outbox: [
        row({ id: 'old', doc_no: 'HC-DO-2608-001', doc_type: 'DO', status: 'skipped',
          last_error: marker, created_at: '2026-08-16T01:00:00.000Z' }),
        row({ id: 'new', doc_no: 'HC-DO-2608-001', doc_type: 'DO', status: 'skipped',
          last_error: 'refused, nothing sent (ItemCodeError): x',
          created_at: '2026-08-16T03:00:00.000Z' }),
      ],
    }));
    expect(countsOf(body)).toMatchObject({ skipped: 1, requeued: 1, attention: 1, total: 1 });
  });
});

describe('GET /autocount-outbox — filters', () => {
  const rows = [
    row({ id: 'so', doc_type: 'SO', doc_no: 'HC-SO-2608-001', status: 'sent' }),
    row({ id: 'po', doc_type: 'PO', doc_no: 'PO-000136', status: 'failed', last_error: 'FK_PO_Creditor' }),
  ];

  it('filters by document type', async () => {
    const { body } = await get(harness({ outbox: rows }), '?docType=PO');
    expect(idsOf(body)).toEqual(['po']);
    expect(countsOf(body).total).toBe(2);
  });

  it('searches a document number case-insensitively', async () => {
    const { body } = await get(harness({ outbox: rows }), '?docNo=hc-so');
    expect(idsOf(body)).toEqual(['so']);
  });

  it('refuses an unknown state instead of silently returning everything', async () => {
    const { status, body } = await get(harness({ outbox: rows }), '?state=planning');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_state');
  });

  it('refuses an unknown document type', async () => {
    const { status, body } = await get(harness({ outbox: rows }), '?docType=XX');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_doc_type');
  });

  it('reports truncation as a fact rather than leaving it to be inferred', async () => {
    const many = Array.from({ length: 5 }, (_, i) => row({ id: `n${i}`, doc_no: `SO-${i}` }));
    const { body } = await get(harness({ outbox: many }), '?limit=2');
    expect(rowsOf(body)).toHaveLength(2);
    expect(body.truncated).toBe(true);
    expect(countsOf(body).pending).toBe(5);
  });
});


function requeueHarness(opts: {
  outbox?: Row[];
  flag?: string | null;
  companyId?: number;
  noCompany?: boolean;
  perms?: string[];
  authed?: boolean;
  salesOrders?: Row[];
}) {
  const sb = fakeSb({
    autocount_outbox: opts.outbox ?? [],
    app_config:
      opts.flag === undefined || opts.flag === null
        ? []
        : [{ key: 'scm.autocount_writeback', value: opts.flag }],
    mfg_sales_orders: opts.salesOrders ?? [],
    mfg_sales_order_items: [],
    supplier_material_bindings: [],
  });
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', (opts.noCompany ? undefined : opts.companyId ?? 1) as Variables['companyId']);
    if (opts.authed !== false) {
      c.set('user', { id: 'u1' } as unknown as Variables['user']);
      c.set('houzsUser', {
        id: 9,
        name: 'Tester',
        permissions_set: new Set(opts.perms ?? ['scm.autocount.requeue']),
      } as unknown as Variables['houzsUser']);
    }
    await next();
  });
  app.post('/autocount-outbox/:id/requeue', requeueAutocountOutboxHandler);
  return { app, sb };
}

interface RequeueBody {
  error?: string;
  message?: string;
  accepted?: boolean;
  code?: string;
  row_id?: string;
  doc_no?: string;
  new_row_id?: string | null;
  reason?: string | null;
}

const post = async (app: Hono<{ Bindings: Env; Variables: Variables }>, id: string) => {
  const res = await app.request(`/autocount-outbox/${id}/requeue`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as RequeueBody };
};

const outboxRows = (sb: { tables: Record<string, Array<Record<string, unknown>> | undefined> }) =>
  sb.tables.autocount_outbox ?? [];

describe('POST /autocount-outbox/:id/requeue — the gate', () => {
  const skipped = row({
    id: 'ob-skip',
    status: 'skipped',
    last_error: 'refused, nothing sent (MissingLocationError): line 2 carries no warehouse',
  });

  it('REFUSES AN UNAUTHENTICATED CALL, and writes nothing', async () => {
    const { app, sb } = requeueHarness({ outbox: [skipped], authed: false, flag: '1' });
    const before = JSON.stringify(outboxRows(sb));
    const { status, body } = await post(app, 'ob-skip');
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.accepted).toBeUndefined();
    expect(JSON.stringify(outboxRows(sb))).toBe(before);
  });

  it('refuses a caller who may only READ the queue', async () => {
    const { app, sb } = requeueHarness({
      outbox: [skipped], perms: ['scm.autocount.read'], flag: '1',
    });
    const before = JSON.stringify(outboxRows(sb));
    const { status, body } = await post(app, 'ob-skip');
    expect(status).toBe(403);
    expect(body.message).toContain('scm.autocount.requeue');
    expect(JSON.stringify(outboxRows(sb))).toBe(before);
  });

  it('admits settings.manage — the grant that exists today', async () => {
    const { app } = requeueHarness({
      outbox: [skipped], perms: ['settings.manage'], flag: 'off',
    });
    const { status, body } = await post(app, 'ob-skip');
    expect(status).toBe(200);
    expect(body.code).toBe('switch-off');
  });

  it('admits the wildcard the Owner and IT Admin hold', async () => {
    const { app } = requeueHarness({ outbox: [skipped], perms: ['*'], flag: 'off' });
    const { status } = await post(app, 'ob-skip');
    expect(status).toBe(200);
  });

  it('refuses when the active company cannot be resolved, rather than acting on every company', async () => {
    const { app, sb } = requeueHarness({ outbox: [skipped], noCompany: true, flag: '1' });
    const before = JSON.stringify(outboxRows(sb));
    const { status, body } = await post(app, 'ob-skip');
    expect(status).toBe(409);
    expect(body.error).toBe('company_unresolved');
    expect(JSON.stringify(outboxRows(sb))).toBe(before);
  });
});

describe('POST /autocount-outbox/:id/requeue — the answer it gives', () => {
  it('refuses a SENT row with a code and a sentence, and never a 500', async () => {
    const { app, sb } = requeueHarness({
      outbox: [row({ id: 'ob-sent', status: 'sent', ac_doc_no: 'SO-000451' })],
      flag: '1',
    });
    const before = JSON.stringify(outboxRows(sb));
    const { status, body } = await post(app, 'ob-sent');
    expect(status).toBe(200);
    expect(body.accepted).toBe(false);
    expect(body.code).toBe('already-sent');
    expect(body.message).toContain('SECOND copy');
    expect(JSON.stringify(outboxRows(sb))).toBe(before);
  });

  it('answers 404 for another company\'s row, and says nothing about it', async () => {
    const { app } = requeueHarness({
      outbox: [row({ id: 'ob-other', company_id: 2, status: 'skipped' })],
      companyId: 1,
      flag: '1',
    });
    const { status, body } = await post(app, 'ob-other');
    expect(status).toBe(404);
    expect(body.code).toBe('row-not-found');
    expect(body.doc_no).toBe('');
  });

  it('never returns a raw exception string in place of an outcome', async () => {
    const { app } = requeueHarness({
      /* A DELIVERY ORDER's edit: since docs/bugs/0614 a sales order's edit is
         re-queueable as a rebuild, and a converted document is what still
         answers not-recoverable. The property under test is unchanged - no raw
         exception string may reach the caller in place of an outcome. */
      outbox: [row({ id: 'ob-edit', op: 'edit', doc_type: 'DO', status: 'skipped' })],
      flag: '1',
    });
    const { body } = await post(app, 'ob-edit');
    expect(body.code).toBe('not-recoverable');
    expect(body.message).toBe(AC_REQUEUE_MEANING['not-recoverable']);
    expect(body.reason).toBeNull();
  });

  it('the row list tells the page which rows the button belongs on', async () => {
    const app = harness({
      outbox: [
        row({ id: 'a', op: 'create_so', status: 'skipped', last_error: 'refused, nothing sent (ItemCodeError): x' }),
        row({ id: 'b', op: 'create_so', status: 'sent' }),
        row({ id: 'c', op: 'so_to_do', doc_type: 'DO', status: 'skipped', last_error: 'no source document to transfer from' }),
      ],
      flag: '1',
      companyId: 1,
    });
    const { body } = await get(app);
    const byId = Object.fromEntries(rowsOf(body).map((r) => [String(r.id), r.can_requeue]));
    /* `c` FLIPPED TO TRUE on 2026-08-24. Owner: 「我的 GR PO 所有文件都要有 Send
       Now 的 button」. A held-back conversion is offered now, and the send
       re-reads whether the document really has no parent instead of replaying
       the create path's claim that it hasn't — which was false on eight
       production documents (docs/bugs/0524). `b` stays false and always will:
       a SENT row must never be offered, because AutoCount has no duplicate
       guard on the ERP document number. */
    expect(byId).toEqual({ a: true, b: false, c: true });
  });
});

// ── Clearing a finished document off the page ───────────────────────────────
//
// THE OWNER ASKED TWICE. On 2026-09-08 the whole AutoCount Sync page for Houzs
// Century was three documents and 32 rows — HC-SO-013361, HC-SO-013393 and
// HC-SO-013394, every one an old write-back test, every one in the account book
// — sitting under a green banner reading "Everything is in AutoCount. Nothing
// is waiting and nothing was refused."
//
// These tests pin the two properties that make this SAFE rather than merely
// convenient: nothing is deleted, and a document that still needs somebody
// cannot be cleared. The second is what stops this becoming a way to make the
// page look tidy while a document sits in the ERP and not in the book.

const postDoc = async (
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  path: 'archive' | 'restore',
  payload: unknown,
) => {
  const res = await app.request(`/autocount-outbox/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const MAY_ARCHIVE = ['scm.autocount.requeue'];
const MAY_ARCHIVE_AND_READ = ['scm.autocount.requeue', 'scm.autocount.read'];

describe('POST /autocount-outbox/archive', () => {
  it('refuses a reader who may only WATCH the queue, and names what is needed', async () => {
    const app = harness({ outbox: [row({ status: 'sent' })], companyId: 1, perms: ['scm.autocount.read'] });
    const { status, body } = await postDoc(app, 'archive', { doc_type: 'SO', doc_no: 'HC-SO-2608-001' });
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(String(body.message)).toContain('scm.autocount.requeue');
  });

  it('clears every send of a finished document — and DELETES NONE OF THEM', async () => {
    const outbox = [
      row({ id: 'a', status: 'sent', doc_no: 'HC-SO-013393' }),
      row({ id: 'b', status: 'sent', doc_no: 'HC-SO-013393' }),
      row({ id: 'c', status: 'sent', doc_no: 'HC-SO-013393' }),
    ];
    const app = harness({ outbox, companyId: 1, perms: MAY_ARCHIVE });
    const { status, body } = await postDoc(app, 'archive', { doc_type: 'SO', doc_no: 'HC-SO-013393' });
    expect(status).toBe(200);
    expect(body.archived).toBe(true);
    expect(body.rows).toBe(3);
    expect(outbox).toHaveLength(3);
    for (const r of outbox) {
      expect(r.archived_at, String(r.id)).not.toBeNull();
      expect(r.archived_by, String(r.id)).toBe(9);
      expect(r.status, String(r.id)).toBe('sent');
      expect(r.last_error, String(r.id)).toBeNull();
    }
  });

  it('will not clear a document that is still in the ERP and not in the book', async () => {
    const outbox = [
      row({ id: 'a', status: 'sent', doc_no: 'HC-SO-9' }),
      row({ id: 'b', status: 'skipped', doc_no: 'HC-SO-9', last_error: 'refused, nothing sent (KeylessLineError): line 3' }),
    ];
    const app = harness({ outbox, companyId: 1, perms: MAY_ARCHIVE });
    const { status, body } = await postDoc(app, 'archive', { doc_type: 'SO', doc_no: 'HC-SO-9' });
    expect(status).toBe(200);
    expect(body.archived).toBe(false);
    expect(body.code).toBe('needs-attention');
    expect(String(body.message).length).toBeGreaterThan(20);
    expect(body.blocked).toBe(1);
    expect(outbox.every((r) => (r.archived_at ?? null) === null)).toBe(true);
  });

  it('will not clear a document still on its way', async () => {
    const app = harness({
      outbox: [row({ id: 'a', status: 'pending', doc_no: 'HC-SO-8' })],
      companyId: 1,
      perms: MAY_ARCHIVE,
    });
    const { body } = await postDoc(app, 'archive', { doc_type: 'SO', doc_no: 'HC-SO-8' });
    expect(body.code).toBe('still-working');
    expect(body.archived).toBe(false);
  });

  it('clears a document whose refusals were all replaced by a later send', async () => {
    const outbox = [
      row({ id: 'a', status: 'sent', doc_no: 'HC-SO-013361' }),
      row({ id: 'b', status: 'failed', doc_no: 'HC-SO-013361', last_error: '[re-queued 2026-09-04T06:51:29.513Z -> outbox abc] Gave up after 6 attempts.' }),
    ];
    const app = harness({ outbox, companyId: 1, perms: MAY_ARCHIVE });
    const { body } = await postDoc(app, 'archive', { doc_type: 'SO', doc_no: 'HC-SO-013361' });
    expect(body.code).toBe('ok');
    expect(body.rows).toBe(2);
  });

  it('never touches another company row carrying the same document number', async () => {
    const mine = row({ id: 'mine', company_id: 1, status: 'sent', doc_no: 'HC-SO-7' });
    const theirs = row({ id: 'theirs', company_id: 2, status: 'sent', doc_no: 'HC-SO-7' });
    const app = harness({ outbox: [mine, theirs], companyId: 1, perms: MAY_ARCHIVE });
    const { body } = await postDoc(app, 'archive', { doc_type: 'SO', doc_no: 'HC-SO-7' });
    expect(body.rows).toBe(1);
    expect(mine.archived_at).not.toBeNull();
    expect(theirs.archived_at ?? null).toBeNull();
  });

  it('refuses when the company cannot be resolved rather than acting on every company', async () => {
    const app = harness({ outbox: [row({ status: 'sent' })], companyId: undefined, perms: MAY_ARCHIVE });
    const { status } = await postDoc(app, 'archive', { doc_type: 'SO', doc_no: 'HC-SO-2608-001' });
    expect(status).toBe(409);
  });

  it('refuses a document type the queue cannot hold', async () => {
    const app = harness({ outbox: [], companyId: 1, perms: MAY_ARCHIVE });
    const { status, body } = await postDoc(app, 'archive', { doc_type: 'XX', doc_no: 'HC-XX-1' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_document');
  });

  it('says so when there is nothing on the list for that document', async () => {
    const app = harness({ outbox: [], companyId: 1, perms: MAY_ARCHIVE });
    const { body } = await postDoc(app, 'archive', { doc_type: 'SO', doc_no: 'HC-SO-NONE' });
    expect(body.code).toBe('doc-not-found');
    expect(body.archived).toBe(false);
  });
});

describe('the cleared documents are hidden, counted apart, and reachable', () => {
  const shelf = () => [
    row({ id: 'live', status: 'sent', doc_no: 'HC-SO-LIVE', archived_at: null }),
    row({ id: 'gone', status: 'sent', doc_no: 'HC-SO-GONE', archived_at: '2026-09-08T02:00:00.000Z' }),
  ];

  it('keeps a cleared document off every ordinary list and out of every ordinary count', async () => {
    const app = harness({ outbox: shelf(), flag: '1', companyId: 1 });
    for (const qs of ['', '?state=all', '?state=sent']) {
      const { body } = await get(app, qs);
      expect(idsOf(body), qs).not.toContain('gone');
    }
    const { body } = await get(app, '?state=all');
    expect(countsOf(body).sent).toBe(1);
    expect(countsOf(body).total).toBe(1);
    expect(countsOf(body).archived).toBe(1);
  });

  it('shows it under Cleared, and only it', async () => {
    const app = harness({ outbox: shelf(), flag: '1', companyId: 1 });
    const { body } = await get(app, '?state=archived');
    expect(idsOf(body)).toEqual(['gone']);
  });

  it('counts CLEARED DOCUMENTS, not cleared sends', async () => {
    const app = harness({
      outbox: [
        row({ id: 'g1', status: 'sent', doc_no: 'HC-SO-GONE', archived_at: '2026-09-08T02:00:00.000Z' }),
        row({ id: 'g2', status: 'sent', doc_no: 'HC-SO-GONE', archived_at: '2026-09-08T02:00:00.000Z' }),
        row({ id: 'g3', status: 'sent', doc_no: 'HC-SO-GONE', archived_at: '2026-09-08T02:00:00.000Z' }),
      ],
      flag: '1',
      companyId: 1,
    });
    const { body } = await get(app, '?state=all');
    expect(countsOf(body).archived).toBe(1);
  });

  it('puts a cleared document back, and then it is on the list again', async () => {
    const outbox = shelf();
    const app = harness({ outbox, flag: '1', companyId: 1, perms: MAY_ARCHIVE_AND_READ });
    const { status, body } = await postDoc(app, 'restore', { doc_type: 'SO', doc_no: 'HC-SO-GONE' });
    expect(status).toBe(200);
    expect(body.restored).toBe(true);
    expect(body.rows).toBe(1);
    expect(outbox.find((r) => r.id === 'gone')?.archived_at).toBeNull();
    const after = await get(app, '?state=all');
    expect(idsOf(after.body)).toContain('gone');
  });

  it('putting back a document that was never cleared changes nothing and says so', async () => {
    const app = harness({ outbox: shelf(), flag: '1', companyId: 1, perms: MAY_ARCHIVE });
    const { status, body } = await postDoc(app, 'restore', { doc_type: 'SO', doc_no: 'HC-SO-LIVE' });
    expect(status).toBe(200);
    expect(body.rows).toBe(0);
  });
});
