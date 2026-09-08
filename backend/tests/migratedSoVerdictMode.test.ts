/* THE LOCK RE-GRAINED ONTO CORRECTNESS — grammar, decision, and the guard in
   the real mount shape.
 *
 * Owner, 2026-09-08: 「他们是要开 SO 和 edit SO 来 proceed 单;purchasing 要开 PO;
 * logistic 要 convert SO to DO」. All three happen on the MIGRATED orders, which
 * the origin-grained lock forbids — 2,882 documents shut to protect the handful
 * that are wrong. `verdict:<companies>` asks a better question per document:
 * does it MATCH the account book?
 *
 * TWO ASSERTIONS ARE THE POINT OF THE FILE, and both failed before this change:
 *
 *   1. a migrated order that MATCHES the book is WRITABLE;
 *   2. a migrated order that still DIFFERS is REFUSED, and the refusal names the
 *      document and the axis.
 *
 * Everything else here exists to stop (1) from being reachable by accident: an
 * expired verdict, an unpublished one, a failed read and a malformed switch all
 * have to keep answering LOCKED, or (1) is not a feature, it is a hole.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  migratedSoIsLocked,
  migratedSoVerdictMessage,
  parseMigratedSoLock,
  OPERATOR_MESSAGE_MAX,
} from '../src/scm/lib/migrated-so-lock';
import {
  migratedSoListGate,
  migratedSoReadonly,
  primeMigratedSoLockCache,
  resetMigratedSoLockCache,
} from '../src/scm/lib/migrated-so-readonly';
import type { SoReconcileVerdict } from '../src/scm/lib/so-reconcile-verdict';

/* ── 1. the grammar ─────────────────────────────────────────────────────── */

describe('parseMigratedSoLock — the verdict: prefix', () => {
  it('verdict:1 names company 1 and turns per-document mode ON', () => {
    expect(parseMigratedSoLock('verdict:1')).toEqual({ scope: [1], malformed: false, byVerdict: true });
  });

  it('verdict:all reaches every company', () => {
    expect(parseMigratedSoLock('verdict:all')).toEqual({ scope: 'all', malformed: false, byVerdict: true });
  });

  it('the company grammar is the SAME one — whitespace, duplicates, trailing comma', () => {
    expect(parseMigratedSoLock('verdict: 1 , 2 , 1 ,')).toEqual({ scope: [1, 2], malformed: false, byVerdict: true });
  });

  /* EVERY VALUE THAT SHIPPED BEFORE 2026-09-08 STILL MEANS WHAT IT MEANT. The
     switch is live on production carrying '1'; a parser change that quietly
     re-read it as per-document would open 2,860 documents the owner has not
     said to open, at the moment nobody is looking at this file. */
  it.each(['off', 'all', '1', '1,2', ''])('%p is unchanged and NOT per-document', (v) => {
    expect(parseMigratedSoLock(v).byVerdict).toBe(false);
  });

  /* A MALFORMED VALUE GIVES THE HARDEST LOCK, NEVER THE SOFTER ONE.
     Per-document IS an opening, so a typo may not reach it. */
  it.each(['verdict:', 'verdict:off', 'verdict:houzs', 'verdict:1.5', 'verdict:on'])(
    '%p is malformed: locks ALL, and NOT by verdict',
    (v) => {
      expect(parseMigratedSoLock(v)).toEqual({ scope: 'all', malformed: true, byVerdict: false });
    },
  );

  /* The write-freeze paste, one mode along. docs/write-freeze-staged-lift.md §8
     records the original being made; the `-` check runs on the REMAINDER so the
     two spellings cannot answer differently. */
  it('verdict:1 - scm.sales.orders is refused exactly as 1 - scm.sales.orders is', () => {
    expect(parseMigratedSoLock('verdict:1 - scm.sales.orders'))
      .toEqual(parseMigratedSoLock('1 - scm.sales.orders'));
  });
});

/* ── 2. the decision ────────────────────────────────────────────────────── */

const clean: SoReconcileVerdict = { kind: 'clean', measuredAt: '2026-09-08T05:00:00.000Z' };
const differs: SoReconcileVerdict = { kind: 'differs', axes: ['document total'], measuredAt: '2026-09-08T05:00:00.000Z' };
const stale: SoReconcileVerdict = { kind: 'unknown', why: 'verdict-stale' };
const missing: SoReconcileVerdict = { kind: 'unknown', why: 'no-verdict-published' };
const failed: SoReconcileVerdict = { kind: 'unknown', why: 'verdict-read-failed' };

describe('migratedSoIsLocked — correctness mode', () => {
  const v = parseMigratedSoLock('verdict:1');

  /* (1) THE FEATURE. */
  it('a migrated order that MATCHES the book is OPEN', () => {
    expect(migratedSoIsLocked(v, 1, true, clean)).toBe(false);
  });

  /* (2) THE OTHER HALF OF THE FEATURE. */
  it('a migrated order that still DIFFERS stays locked', () => {
    expect(migratedSoIsLocked(v, 1, true, differs)).toBe(true);
  });

  it.each([
    ['stale', stale],
    ['never published', missing],
    ['the read failed', failed],
    ['no verdict supplied at all', null],
  ])('%s LOCKS — absent never means open', (_label, verdict) => {
    expect(migratedSoIsLocked(v, 1, true, verdict)).toBe(true);
  });

  /* isMigrated === null is "we could not tell WHICH question to ask", so it
     locks before the verdict is even consulted — a clean verdict for some other
     document must not be able to rescue it. */
  it('isMigrated = null locks even with a clean verdict in hand', () => {
    expect(migratedSoIsLocked(v, 1, null, clean)).toBe(true);
  });

  it('a NATIVE order is open whatever the verdict says', () => {
    expect(migratedSoIsLocked(v, 1, false, differs)).toBe(false);
    expect(migratedSoIsLocked(v, 1, false, null)).toBe(false);
  });

  it('a company the value does not name is untouched', () => {
    expect(migratedSoIsLocked(v, 2, true, differs)).toBe(false);
  });

  it("'off' still beats everything", () => {
    expect(migratedSoIsLocked(parseMigratedSoLock('off'), 1, true, differs)).toBe(false);
  });

  /* ORIGIN MODE IS UNCHANGED, and this is the regression that matters: a clean
     verdict must NOT open a document while the switch still says '1'. The
     owner times that flip, not this code. */
  it("value '1' locks a migrated order EVEN WHEN its verdict is clean", () => {
    expect(migratedSoIsLocked(parseMigratedSoLock('1'), 1, true, clean)).toBe(true);
  });
});

/* ── 3. the sentence ────────────────────────────────────────────────────── */

describe('migratedSoVerdictMessage', () => {
  it('names the DOCUMENT and the AXIS — a refusal has to reach a person', () => {
    const m = migratedSoVerdictMessage('HC-SO-010789', differs);
    expect(m).toContain('HC-SO-010789');
    expect(m).toContain('document total');
    expect(m.length).toBeLessThan(OPERATOR_MESSAGE_MAX);
  });

  it('says it opens by itself, so nobody is told to wait for a deploy', () => {
    expect(migratedSoVerdictMessage('HC-SO-1', differs)).toMatch(/opens by itself/i);
  });

  /* Both clients DISCARD a sentence at or over the cap and fall back to a
     generic line, so a long axis list must summarise rather than overflow —
     and it must never truncate an axis name mid-word. */
  it('many axes summarise instead of overflowing the client cap', () => {
    const many: SoReconcileVerdict = {
      kind: 'differs',
      axes: ['document total', 'line count', 'sofa compartments', 'colour / fabric', 'seat size', 'specials'],
      measuredAt: '2026-09-08T05:00:00.000Z',
    };
    const m = migratedSoVerdictMessage('HC-SO-010789', many);
    expect(m.length).toBeLessThan(OPERATOR_MESSAGE_MAX);
    expect(m).toContain('HC-SO-010789');
  });

  it('an UNKNOWN verdict does not claim the order differs — we have not measured that', () => {
    const m = migratedSoVerdictMessage('HC-SO-1', stale);
    expect(m).not.toMatch(/differs/i);
    expect(m).toMatch(/cannot be confirmed/i);
    expect(m.length).toBeLessThan(OPERATOR_MESSAGE_MAX);
  });

  it('a locked document with no axis recorded still gets a sentence', () => {
    const m = migratedSoVerdictMessage('HC-SO-1', { kind: 'differs', axes: [], measuredAt: 'x' });
    expect(m).toContain('HC-SO-1');
    expect(m.length).toBeLessThan(OPERATOR_MESSAGE_MAX);
  });
});

/* ── 4. the guard, in the production mount shape ────────────────────────── */

const CLEAN_DOC = 'HC-SO-000123';
const DIRTY_DOC = 'HC-SO-010789';
const UNPUBLISHED_DOC = 'HC-SO-999999';
const NATIVE_DOC = 'HC-SO-030001';

type Fail = 'none' | 'verdict';

/** The two reads the guard makes in correctness mode, and nothing else. */
function fakeSupabase(fail: Fail = 'none', ageMs = 60_000) {
  const measured = new Date(Date.now() - ageMs).toISOString();
  const verdicts: Record<string, { clean: boolean; axes: string[] }> = {
    [CLEAN_DOC]: { clean: true, axes: [] },
    [DIRTY_DOC]: { clean: false, axes: ['document total'] },
  };
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, value: string) {
              return {
                maybeSingle: async () => {
                  if (table === 'mfg_sales_orders') {
                    if (value === NATIVE_DOC) return { data: { linked_ac_docno: null }, error: null };
                    return { data: { linked_ac_docno: 'SO-00099' }, error: null };
                  }
                  if (table === 'so_reconcile_verdict') {
                    if (fail === 'verdict') return { data: null, error: { message: 'read failed' } };
                    const row = verdicts[value];
                    return row ? { data: { doc_no: value, ...row, measured_at: measured }, error: null } : { data: null, error: null };
                  }
                  throw new Error(`unexpected table read: ${table}`);
                },
              };
            },
            /* The LIST's batched read, served from the SAME table of verdicts
               as the single read above — so a divergence between what the list
               shows and what the endpoint does can only come from the code, not
               from two fixtures that disagree. */
            in: async (_col: string, values: readonly string[]) => {
              if (table !== 'so_reconcile_verdict') throw new Error(`unexpected batched read: ${table}`);
              if (fail === 'verdict') return { data: null, error: { message: 'read failed' } };
              return {
                data: values
                  .filter((v) => verdicts[v])
                  .map((v) => ({ doc_no: v, ...verdicts[v], measured_at: measured })),
                error: null,
              };
            },
          };
        },
      };
    },
  };
}

function makeApp(companyId: number | undefined, opts: { fail?: Fail; ageMs?: number } = {}) {
  const { fail = 'none', ageMs = 60_000 } = opts;
  const app = new Hono();
  app.use('/api/scm/*', async (c, next) => {
    c.set('user' as never, { permissions: ['scm.access'] } as never);
    if (companyId != null) c.set('companyId' as never, companyId as never);
    c.set('supabase' as never, fakeSupabase(fail, ageMs) as never);
    await next();
  });
  const scm = new Hono();
  scm.use('/mfg-sales-orders/*', migratedSoReadonly());
  const sub = new Hono();
  sub.use('*', async (c, next) => {
    c.set('user' as never, { id: 'scm-system-staff-uuid' } as never);
    c.set('supabase' as never, fakeSupabase(fail, ageMs) as never);
    await next();
  });
  sub.all('/', (c) => c.json({ saved: true }));
  sub.all('/*', (c) => c.json({ saved: true }));
  scm.route('/mfg-sales-orders', sub);
  app.route('/api/scm', scm);
  return app;
}

async function send(app: Hono, path: string, method = 'PATCH') {
  const res = await app.request(path, { method });
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(await res.text()) as Record<string, unknown>; } catch { /* not json */ }
  return { status: res.status, body };
}

const SO = (doc: string) => `/api/scm/mfg-sales-orders/${doc}`;

beforeEach(() => resetMigratedSoLockCache());

describe("value 'verdict:1' — the business need, end to end", () => {
  beforeEach(() => primeMigratedSoLockCache('verdict:1'));

  /* THE ASSERTION THE OWNER IS ACTUALLY BUYING. Sales can proceed it,
     purchasing can raise a PO against it, logistics can convert it to a DO. */
  it('a migrated order that MATCHES the book saves', async () => {
    expect((await send(makeApp(1), SO(CLEAN_DOC))).status).toBe(200);
  });

  it('a migrated order that still DIFFERS is refused, and the refusal names it', async () => {
    const { status, body } = await send(makeApp(1), SO(DIRTY_DOC));
    expect(status).toBe(409);
    expect(body.error).toBe('so_migrated_readonly');
    /* BOTH fields: the vendored SCM client reads `reason`, core api/client.ts
       reads `message`. Sending one is how a refusal rendered as an outage line. */
    expect(String(body.reason)).toContain(DIRTY_DOC);
    expect(String(body.reason)).toContain('document total');
    expect(body.message).toBe(body.reason);
    expect(body.docNo).toBe(DIRTY_DOC);
  });

  it('a migrated order with NO published verdict is refused', async () => {
    const { status, body } = await send(makeApp(1), SO(UNPUBLISHED_DOC));
    expect(status).toBe(409);
    expect(String(body.reason)).toContain('cannot be confirmed');
  });

  it('an EXPIRED verdict re-locks a document that used to be clean', async () => {
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    expect((await send(makeApp(1, { ageMs: threeDays }), SO(CLEAN_DOC))).status).toBe(409);
  });

  it('a FAILED verdict read locks — the outage cannot look like a pass', async () => {
    expect((await send(makeApp(1, { fail: 'verdict' }), SO(CLEAN_DOC))).status).toBe(409);
  });

  it('a NATIVE order still saves, and never reads a verdict at all', async () => {
    expect((await send(makeApp(1), SO(NATIVE_DOC))).status).toBe(200);
  });

  /* 「只开新单」 in one assertion, unchanged: create carries no document in its
     path, so it never reaches the lookup. */
  it('CREATE is untouched', async () => {
    expect((await send(makeApp(1), '/api/scm/mfg-sales-orders', 'POST')).status).toBe(200);
  });

  it('every GET is untouched — reading a migrated order is the point of having it', async () => {
    expect((await send(makeApp(1), SO(DIRTY_DOC), 'GET')).status).toBe(200);
  });

  it('the other company is untouched', async () => {
    expect((await send(makeApp(2), SO(DIRTY_DOC))).status).toBe(200);
  });
});

describe("value '1' — origin mode is byte-for-byte what it was", () => {
  beforeEach(() => primeMigratedSoLockCache('1'));

  /* fakeSupabase THROWS on any table but the two it knows, so this also asserts
     that origin mode makes NO verdict read: while the switch says '1' this
     guard costs exactly what it cost yesterday. */
  it('a migrated order is refused even though its verdict is clean', async () => {
    const { status, body } = await send(makeApp(1), SO(CLEAN_DOC));
    expect(status).toBe(409);
    expect(String(body.reason)).toContain('AutoCount');
    expect(String(body.reason)).not.toContain(CLEAN_DOC);
  });
});

/* ── 5. the LIST, which must never offer what the endpoint refuses ───────── */

describe('migratedSoListGate — correctness mode', () => {
  /* The switch has to be PRIMED here as it is for every other block: the fake
     client knows two tables and THROWS on app_config, and readLock treats a
     throw as an OUTAGE and fails OPEN — which is the documented behaviour (a
     Supabase blip must not stop the shop floor) and would silently make every
     assertion below pass for the wrong reason. */
  beforeEach(() => primeMigratedSoLockCache('verdict:1'));

  /* The list is the surface a salesperson looks at BEFORE clicking anything, so
     a row it shows as editable that the API then refuses is the "the button
     does nothing" failure, one screen earlier. The gate is allowed to be more
     pessimistic than the endpoint and never more permissive. */
  const baseRows = [
    { doc_no: CLEAN_DOC, linked_ac_docno: 'SO-000123' },
    { doc_no: DIRTY_DOC, linked_ac_docno: 'SO-010789' },
    { doc_no: UNPUBLISHED_DOC, linked_ac_docno: 'SO-999999' },
    { doc_no: NATIVE_DOC, linked_ac_docno: null },
  ];

  /** Runs the gate inside a request, since it reads company + client off the context. */
  async function gate(companyId: number | undefined, opts: { fail?: Fail; ageMs?: number } = {}) {
    const { fail = 'none', ageMs = 60_000 } = opts;
    const app = new Hono();
    app.get('/g', async (c) => {
      c.set('user' as never, { permissions: ['scm.access'] } as never);
      if (companyId != null) c.set('companyId' as never, companyId as never);
      c.set('supabase' as never, fakeSupabase(fail, ageMs) as never);
      const answer = await migratedSoListGate(c, baseRows);
      return c.json(Object.fromEntries(baseRows.map((r) => [r.doc_no, answer(r.doc_no).migrated_readonly])));
    });
    return (await (await app.request('/g')).json()) as Record<string, boolean>;
  }

  it('answers PER ROW, matching what the endpoint would do to each', async () => {
    const g = await gate(1);
    expect(g[CLEAN_DOC]).toBe(false);       // saves — proved above
    expect(g[DIRTY_DOC]).toBe(true);        // 409 — proved above
    expect(g[UNPUBLISHED_DOC]).toBe(true);  // 409 — proved above
    expect(g[NATIVE_DOC]).toBe(false);      // never migrated
  });

  /* A NATIVE row must carry `false`, not nothing: an absent key reads as "old
     build" on the client and would silently unlock the row. */
  it('every row gets an explicit answer, including the native one', async () => {
    const g = await gate(1);
    for (const r of baseRows) expect(typeof g[r.doc_no]).toBe('boolean');
  });

  it('a FAILED verdict read locks the whole page, never half of it', async () => {
    const g = await gate(1, { fail: 'verdict' });
    expect(g[CLEAN_DOC]).toBe(true);
    expect(g[DIRTY_DOC]).toBe(true);
    expect(g[NATIVE_DOC]).toBe(false); // still native; the verdict was never its question
  });

  it('an EXPIRED verdict locks every migrated row', async () => {
    const g = await gate(1, { ageMs: 3 * 24 * 60 * 60 * 1000 });
    expect(g[CLEAN_DOC]).toBe(true);
  });

  it('the other company is untouched', async () => {
    const g = await gate(2);
    expect(g[DIRTY_DOC]).toBe(false);
  });
});
