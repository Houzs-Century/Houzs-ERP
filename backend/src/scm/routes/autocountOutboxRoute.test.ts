// GET /api/scm/autocount-outbox — the page the owner reads.
//
// Harness follows tests/companyScopeMastersConfig.test.ts: a bare Hono app whose
// middleware injects a fake scm supabase client and a company context, mounting
// the EXPORTED handler rather than the router (the supabaseAuth bridge cannot
// run here). The client is scm/lib/fake-postgrest's fakeSb, the same PostgREST
// stand-in autocount-outbox.test.ts and autocount-requeue.test.ts already use.
//
// Each leak test is paired with a same-company test proving the legitimate
// request still works — a scope assertion that only ever checks the negative
// half passes just as happily when the endpoint returns nothing at all.
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
  REQUEUED_LIKE,
} from './autocount-outbox';

/* The flag is cached for 30 seconds by design (a toggle must be readable
   without a query per request), and the cache is module-level, so without this
   the second test in a file inherits the first one's switch. Its own test seam,
   used the way autocount-outbox.test.ts uses it. */
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
  /** Make the app_config read FAIL rather than come back empty. */
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
  /* Typed with the app's OWN Variables rather than a bare Hono plus `as never`
     casts at every c.set. The casts are what the other harnesses in this tree
     use, and they are exactly the thing that would let this file keep compiling
     after the handler started reading a context key nobody sets here. */
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
  return app;
}

/** What the route answers with — every field the assertions below read. */
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

/** The rows, non-null, so an assertion cannot silently pass on `undefined`. */
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
    /* The refusal must not leak the thing it is refusing. */
    expect(body.rows).toBeUndefined();
    expect(body.counts).toBeUndefined();
  });

  it('admits the narrow key', async () => {
    const { status, body } = await get(harness({ outbox: [row()], perms: ['scm.autocount.read'] }));
    expect(status).toBe(200);
    expect(rowsOf(body)).toHaveLength(1);
  });

  /* A key nobody has been granted is an endpoint nobody can call, so the route
     also takes the key that already owns the sync connection. */
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

  /* The counts are computed by their own statements, so they are their own
     chance to leak — a scoped list over unscoped tiles would still tell the
     owner another company's document is stuck. */
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

  /* The LIKE pattern the count is built from. A metacharacter creeping into the
     marker would widen it silently and start reporting open refusals as
     settled — the one error the whole distinction exists to prevent. */
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
    /* Still one row in the table — outstanding fell, history did not vanish. */
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

  /* THE SWITCH IS A COMPANY ALLOW-LIST, AND `on` ANSWERS FOR ONE COMPANY.
     Until 2026-08-18 this route read the scope bare and published
     `on: scope !== 'off'` — "is it on for ANYBODY" — while all eight enqueue
     gates asked `isWritebackEnabled(sb, companyId)`. With the live value set to
     one company, the OTHER organisation's operator was told on this page that
     sending was switched on FOR HIS COMPANY and that saving a document would
     queue it. His queue is company-scoped, so it stays empty and nothing
     errors: a false sentence with no symptom attached to it.

     This test used to pass NO company at all and still assert `on === true`,
     which is how the company-blind reading looked correct. Its title already
     said "for the named company"; now it names one. */
  it('reads an on flag as on, for the named company', async () => {
    const { body } = await get(harness({ outbox: [], flag: '1', companyId: 1 }));
    expect(body.writeback?.on).toBe(true);
    expect(body.writeback?.scope).toBe('1');
  });

  it('is OFF for a company the allow-list does not name, while still reporting the scope', async () => {
    const { body } = await get(harness({ outbox: [], flag: '1', companyId: 2 }));
    expect(body.writeback?.on).toBe(false);
    // The scope is still the whole truth — an admin has to be able to see the
    // allow-list — it is `on` that is answered per company.
    expect(body.writeback?.scope).toBe('1');
    expect(body.writeback?.value).toBe('1');
  });

  it("'all' is on for every company, including one not in any list", async () => {
    const { body } = await get(harness({ outbox: [], flag: 'all', companyId: 2 }));
    expect(body.writeback?.on).toBe(true);
    expect(body.writeback?.scope).toBe('all');
  });

  /* UNRESOLVED IS NOT OFF. A REPORT and an ENQUEUE want opposite answers here:
     the enqueue must refuse (never write into a live account book on a guess),
     while this page must not claim the switch is off on the strength of a
     company it could not resolve. null is its own state and the client renders
     its own sentence for it. */
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

  /* An UNREADABLE switch and an ABSENT switch render as opposite claims — "OFF"
     versus "row absent" — and supabase-js does not throw, so only the bound
     error tells them apart. Printing either one from a read that failed would be
     a definite statement about a live account book that nobody actually made. */
  it('refuses the whole response when the switch cannot be read', async () => {
    /* fakeSb's `missing` map makes the column read fail the WHOLE query with
       42703, which is what a real unreadable app_config looks like to
       supabase-js: an error and a null body. */
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
      pending: 0, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 0,
    });
    /* Zero because there is nothing, not because the scan gave up. */
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
  /** His four rows: the create, then three edits, all accepted. */
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
    /* The SENDS are all still there — the audit trail is the whole point of an
       append-only queue, and the page folds them, it does not drop them. */
    expect(rowsOf(body)).toHaveLength(4);
  });

  /* A DOCUMENT NUMBER IS NOT A DOCUMENT. 0277's CHECK admits six types and the
     same number can belong to two of them; folding those together would LOSE
     one. The key is the pair, which is autocount_outbox_doc_idx's own. */
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

  /* A document that arrived and was later edited into a refusal IS in the
     account book AND does need attention, and both chips would list it. The
     counts therefore do NOT sum to the total, on purpose. */
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

  /* A COUNT THAT DID NOT SEE EVERY ROW MUST NOT READ AS A FACT. The scan pages
     through the queue and stops at AC_DOC_SCAN_MAX; past that the numbers are a
     floor and the response says so, rather than reporting the prefix it managed
     to read as the whole company. Slow-ish by construction — it is asserting a
     boundary that only exists at scale — and the alternative is an untested
     branch that turns an undercount into a fact the day the queue outgrows the
     cap. */
  it('refuses to call a partial scan a count', async () => {
    const overCap = Array.from(
      { length: AC_DOC_SCAN_MAX + 1 },
      (_, i) => row({ id: `n${i}`, doc_no: `SO-${i}`, status: 'sent' }),
    );
    const { body } = await get(harness({ outbox: overCap }), '?limit=1');
    expect(body.counts_complete).toBe(false);
    /* Still the best answer available, and right for everything it reached. */
    expect(countsOf(body).sent).toBe(AC_DOC_SCAN_MAX);
  });

  /* The re-queue marker still decides the state, and it is still read by the
     SHARED classifier rather than restated — a document whose only send is a
     replaced refusal is Replaced, not Held back. */
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
    /* ONE document, and it is in both states: one send was replaced, the other
       is an open refusal that somebody still has to work. */
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
    /* The tiles stay whole-company: the owner's "is anything stuck" must not
       change because he narrowed the list. */
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/scm/autocount-outbox/:id/requeue — the page's per-row button.
//
// The read tests above prove the gate on a REPORT. This one writes into a live
// licensed account book, so its gate is tested harder: an unauthenticated call,
// a call by a caller who may only READ the queue, and a call for another
// company's row must each be refused, and each with nothing written.
// ─────────────────────────────────────────────────────────────────────────────

/** The re-queue harness. Same shape as `harness`, plus the tables the ladder
 *  reads, and `authed: false` for the no-session case. */
function requeueHarness(opts: {
  outbox?: Row[];
  flag?: string | null;
  companyId?: number;
  /** true = the company context never resolved. Its own flag, because
   *  `companyId: undefined` is indistinguishable from "the caller said
   *  nothing", and that is the DEFAULTED case, not the unresolved one. */
  noCompany?: boolean;
  perms?: string[];
  /** false = no session at all: the global /api/* auth never ran. */
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
    /* An UNAUTHENTICATED request reaches an SCM handler with no `houzsUser` on
       the context: the global /api/* auth middleware (src/index.ts:293) is what
       populates it, and scm/middleware/auth.ts only MIRRORS what that put
       there — it is a type bridge, not the authenticator. So "no houzsUser" is
       exactly the shape an unauthenticated call has if it ever got this far,
       and every gate in lib/houzs-perms.ts is written to fail closed on it. */
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

/* The value is typed as possibly ABSENT, which it genuinely is — the fake only
   holds the tables it was seeded with. Typing it non-null would make the `?? []`
   look redundant to the compiler while being the only thing standing between an
   unseeded table and a crash inside the assertion. */
const outboxRows = (sb: { tables: Record<string, Array<Record<string, unknown>> | undefined> }) =>
  sb.tables.autocount_outbox ?? [];

describe('POST /autocount-outbox/:id/requeue — the gate', () => {
  const skipped = row({
    id: 'ob-skip',
    status: 'skipped',
    last_error: 'refused, nothing sent (MissingLocationError): line 2 carries no warehouse',
  });

  it('REFUSES AN UNAUTHENTICATED CALL, and writes nothing', async () => {
    /* No session means no houzsUser, so grantedFor() answers an empty set and
       every key check fails. Proven here rather than asserted in prose because
       a batch of scm server actions shipped with no gate at all once and it is
       on the permanent defect list. */
    const { app, sb } = requeueHarness({ outbox: [skipped], authed: false, flag: '1' });
    const before = JSON.stringify(outboxRows(sb));
    const { status, body } = await post(app, 'ob-skip');
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.accepted).toBeUndefined();
    expect(JSON.stringify(outboxRows(sb))).toBe(before);
  });

  it('refuses a caller who may only READ the queue', async () => {
    /* Reading the queue is watching; re-sending writes a document into a live
       licensed account book. scm.autocount.read must not carry the second. */
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
    /* It got PAST the gate; the switch being off is the next rung, not the gate. */
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
    /* The refusal that stops a duplicate document in a live account book. It is
       a 200: the server answered the question, and an HTTP error would reach
       the page through the generic failure path that prints a status code. */
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
    /* Not the document number, not the company: confirming somebody else's id
       exists is itself a leak. */
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
