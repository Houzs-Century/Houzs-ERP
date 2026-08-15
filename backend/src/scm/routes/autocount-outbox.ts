// ----------------------------------------------------------------------------
// /autocount-outbox — the READ side of scm.autocount_outbox (migration 0277).
//
// WHY THIS EXISTS. The queue records everything the ERP ever told AutoCount, and
// until now the only way to see it was to dispatch a GitHub Action and read the
// log (backend/scripts/check-autocount-outbox-health.mjs). The owner cannot do
// that, and asked for exactly this, in these words: "如果它是在排队、skip、
// planning 还是 fail 等等，fail 的话是什么原因？everything 都要呈现出来，要不然
// 我就不知道." A `failed` row means a document is in the ERP and NOT in the
// account book — the precise divergence the write-back exists to prevent — and
// a divergence nobody can see is indistinguishable from one that does not exist.
//
// READ-ONLY, AND THAT IS A DECISION, NOT AN OMISSION. There is no re-queue here.
// Re-sending is requeue-autocount-skipped.yml, which carries a deliberate
// `includeFailed` opt-in with a warning attached (#2189), because a `failed` row
// WAS sent and the C# create has no duplicate guard. Putting that behind a
// button is a separate decision the owner has not made.
//
// THE TAXONOMY IS NOT DEFINED HERE. It is lib/autocount-outbox-status.ts, which
// is also what the health script reads (through its plain-node mirror), so the
// page and the workflow log cannot describe the same row differently. Matching
// the shared `refused, nothing sent` prefix instead of the error CLASS is a
// mistake this system has already shipped once (#2094), and re-deriving the
// classification here would be the way to ship it again.
//
// COMPANY-SCOPED, on every one of the seven statements below. The SCM client is
// service-role and bypasses RLS, so the predicate is the entire tenant boundary
// — and an unscoped AutoCount report has already cost this project most of a day
// (#2201: the field-alignment audit's row counts were inflated about fiftyfold;
// scoped to Houzs the whole picture was two orders).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { readWritebackScope, WRITEBACK_KEY } from '../lib/autocount-writeback-flag';
import {
  AC_MAX_ATTEMPTS,
  AC_SKIP_KINDS,
  AC_STATE_MEANING,
  REQUEUE_NOTE_PREFIX,
  acNeedsAttention,
  acOutboxState,
  classifyAcSkip,
} from '../lib/autocount-outbox-status';

export const autocountOutbox = new Hono<{ Bindings: Env; Variables: Variables }>();
autocountOutbox.use('*', supabaseAuth);

/**
 * The narrow key this page is FOR, and the broad one that already owns this
 * subject.
 *
 * Two accepted keys rather than one, for the reason payment-audit-log.ts spells
 * out in its own gate comment: shipping a key nobody has been granted is an
 * endpoint nobody can call. `settings.manage` is catalogued as "Edit connection
 * and sync configuration" — whoever may CHANGE the AutoCount connection may
 * certainly read the queue it feeds, and that grant exists today. The narrow key
 * is what lets the owner hand this page to someone without also handing them the
 * connection settings.
 *
 * Owner and IT Admin hold `*`, which hasPermission passes, so this page works
 * for them on day one with no grant migration.
 */
const READ_KEYS = ['scm.autocount.read', 'settings.manage'] as const;

/** Columns to show. `payload` is a whole document snapshot and is NEVER
 *  selected: it is the audit record, not list content, and a page that pulled
 *  it would move megabytes to render a table of document numbers. */
const SELECT =
  'id, company_id, op, doc_type, doc_no, doc_id, status, attempts, last_error, ' +
  'ac_doc_no, created_at, updated_at, sent_at';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** The filters the page offers. `attention` is the owner's actual question. */
const STATES = ['all', 'attention', 'pending', 'sent', 'failed', 'skipped', 'requeued'] as const;
type StateFilter = (typeof STATES)[number];

const DOC_TYPES = ['SO', 'PO', 'DO', 'IV', 'GR', 'PI'] as const;

/**
 * The SQL LIKE pattern that finds a re-queued skip, built from the shared
 * constant rather than typed again.
 *
 * `%` is appended and nothing is escaped, which is only safe while the prefix
 * itself contains no LIKE metacharacter. That is asserted by a test rather than
 * assumed here — a `_` sneaking into the marker would silently widen this
 * pattern and start counting open refusals as settled, which is the one error
 * this whole distinction exists to prevent.
 */
export const REQUEUED_LIKE = `${REQUEUE_NOTE_PREFIX}%`;

type Row = Record<string, unknown>;

interface CountQuery {
  count: number | null;
  error: { message?: string } | null;
}

/**
 * Just enough of the PostgREST builder for the five counts below.
 *
 * Structural rather than `any`: each count only ever NARROWS, so the shape it
 * needs is two filters and a thenable — and naming it means a builder that
 * forgets to return itself fails to compile instead of silently dropping a
 * predicate. Dropping a predicate here is a cross-company count.
 */
interface CountBuilder extends PromiseLike<CountQuery> {
  eq(col: string, val: unknown): CountBuilder;
  like(col: string, pattern: string): CountBuilder;
}

/**
 * One company-scoped exact count. `head: true` means Postgres counts and returns
 * no rows, so the five tiles at the top of the page cost five counts and not one
 * download of the whole append-only history.
 */
async function countRows(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  build: (q: CountBuilder) => CountBuilder,
): Promise<CountQuery> {
  const sb = c.get('supabase');
  const base = sb.from('autocount_outbox').select('id', { count: 'exact', head: true });
  /* The company predicate goes on BEFORE the caller's narrowing, so no caller
     can forget it — there is no un-scoped builder to hand out. */
  const scoped = scopeToCompany(base, c) as unknown as CountBuilder;
  const { count, error } = await build(scoped);
  return { count: count ?? null, error: error ?? null };
}

/** One outbox row, as the page reads it: the record plus what it MEANS. */
function present(raw: Row) {
  const status = String(raw.status ?? '');
  const lastError = (raw.last_error as string | null) ?? null;
  const state = acOutboxState(status, lastError);
  /* Classified for EVERY state, not only for skips. A re-queued row's original
     refusal is still behind the annotation and is what the reader needs to know
     it was re-queued FOR; a `failed` row's last_error is AutoCount's own words
     and matches none of the kinds, which is correct — its reason is the message
     itself, and there is no generic remedy for "the account book refused it". */
  const { kind, remedy } = status === 'skipped'
    ? classifyAcSkip(lastError)
    : { kind: null as string | null, remedy: null as string | null };
  return {
    id: String(raw.id ?? ''),
    op: String(raw.op ?? ''),
    doc_type: String(raw.doc_type ?? ''),
    doc_no: String(raw.doc_no ?? ''),
    doc_id: (raw.doc_id as string | null) ?? null,
    status,
    state,
    attempts: Number(raw.attempts ?? 0),
    /* NEVER truncated. A long AutoCount error is the diagnosis; the health check
       clips at 300-400 characters because a workflow annotation has to, and a
       page does not. The UI wraps it. */
    reason: lastError,
    reason_kind: kind,
    remedy,
    needs_attention: acNeedsAttention(status, lastError),
    ac_doc_no: (raw.ac_doc_no as string | null) ?? null,
    created_at: (raw.created_at as string | null) ?? null,
    updated_at: (raw.updated_at as string | null) ?? null,
    sent_at: (raw.sent_at as string | null) ?? null,
  };
}

export type AcOutboxListRow = ReturnType<typeof present>;

/**
 * GET /autocount-outbox — every operation this company ever asked AutoCount to
 * perform, with its state and its reason.
 *
 * Answers "is anything stuck" FIRST (the counts, which are exact and are
 * computed over the whole company regardless of the row filter) and "which
 * documents" second.
 */
export const listAutocountOutboxHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  if (!READ_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json(
      {
        error: 'forbidden',
        message:
          'The AutoCount queue shows every document this company pushed into the account book, '
          + `so it is limited to ${READ_KEYS.join(' or ')}.`,
      },
      403,
    );
  }

  const stateParam = (c.req.query('state') ?? 'all') as StateFilter;
  if (!STATES.includes(stateParam)) {
    return c.json({ error: 'invalid_state', allowed: STATES }, 400);
  }
  const docType = c.req.query('docType');
  if (docType && !(DOC_TYPES as readonly string[]).includes(docType)) {
    return c.json({ error: 'invalid_doc_type', allowed: DOC_TYPES }, 400);
  }
  const docNo = (c.req.query('docNo') ?? '').trim();
  const rawLimit = Number(c.req.query('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  const sb = c.get('supabase');

  /* THE SWITCH ITSELF, not a sentence about it. It is the first gate every
     enqueue hits, so "nothing is in the queue" means two completely different
     things either side of it, and the page must not make the reader guess which.
     The RAW value is reported next to the verdict for the same reason the health
     check does: a typo like 'On ' is visible rather than hidden behind the word
     "off". */
  const scope = await readWritebackScope(sb);
  const { data: flagRow } = await sb
    .from('app_config').select('value').eq('key', WRITEBACK_KEY).maybeSingle();
  const flagValue = ((flagRow as { value?: string } | null)?.value ?? null);

  const [pending, sent, failed, skippedTotal, requeued] = await Promise.all([
    countRows(c, (q) => q.eq('status', 'pending')),
    countRows(c, (q) => q.eq('status', 'sent')),
    countRows(c, (q) => q.eq('status', 'failed')),
    countRows(c, (q) => q.eq('status', 'skipped')),
    /* A re-queued skip is HISTORY, not backlog. The table is append-only and a
       skipped row is never deleted, so without this split the original refusal
       sits on the page forever, sending someone to fix what is already fixed and
       already queued. */
    countRows(c, (q) => q.eq('status', 'skipped').like('last_error', REQUEUED_LIKE)),
  ]);

  const firstError = [pending, sent, failed, skippedTotal, requeued].find((r) => r.error);
  if (firstError) {
    return c.json({ error: 'load_failed', reason: firstError.error?.message ?? 'count failed' }, 500);
  }
  /* A count that came back NULL is NOT zero. PostgREST answers a failed count
     with a null, and rendering that as 0 would tell the owner "nothing is stuck"
     on the strength of a query that did not run — the exact shape CLAUDE.md
     calls a verdict computed over nothing. */
  const missing = [pending, sent, failed, skippedTotal, requeued].some((r) => r.count === null);
  if (missing) {
    return c.json({ error: 'load_failed', reason: 'the queue counts could not be read' }, 500);
  }

  const nPending = pending.count as number;
  const nSent = sent.count as number;
  const nFailed = failed.count as number;
  const nSkippedTotal = skippedTotal.count as number;
  const nRequeued = requeued.count as number;
  const nSkipped = Math.max(0, nSkippedTotal - nRequeued);

  /* The oldest pending row, because a climbing age is the early warning that the
     tunnel is down and the dead-lettering has started — MAX_ATTEMPTS on a
     5-minute cron gives a row roughly 30 minutes. */
  let oldestQ = sb.from('autocount_outbox')
    .select('doc_type, doc_no, op, attempts, last_error, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);
  oldestQ = scopeToCompany(oldestQ, c);
  const { data: oldestData, error: oldestErr } = await oldestQ;
  if (oldestErr) {
    return c.json({ error: 'load_failed', reason: oldestErr.message }, 500);
  }
  /* Cast to a NULLABLE array before defaulting: PostgREST answers a failed read
     with a null body, and a cast that promises a non-null array would make the
     `?? []` below look redundant while removing the only guard against it. */
  const oldestRows = (oldestData as unknown as Row[] | null) ?? [];
  /* `.at(0)`, not `[0]`: without noUncheckedIndexedAccess an index read is typed
     non-null, which makes the "is there a pending row" test below look redundant
     to the compiler while being the only thing standing between an empty queue
     and a crash. */
  const oldestRaw = oldestRows.at(0);

  /* THE ROWS. `attention`, `skipped` and `requeued` are all subsets of a
     STATUS filter narrowed in JS by the re-queue marker, deliberately rather
     than through a PostgREST `or(...)` string: the counts above are exact and
     separately computed, so the list only has to be an honest most-recent view,
     and a hand-written boolean expression that is subtly wrong about which rows
     are settled would be wrong in the direction of hiding an open refusal. */
  const statusesFor: Record<StateFilter, string[] | null> = {
    all: null,
    attention: ['failed', 'skipped'],
    pending: ['pending'],
    sent: ['sent'],
    failed: ['failed'],
    skipped: ['skipped'],
    requeued: ['skipped'],
  };

  let rowsQ = sb.from('autocount_outbox').select(SELECT);
  const statuses = statusesFor[stateParam];
  if (statuses) rowsQ = rowsQ.in('status', statuses);
  if (docType) rowsQ = rowsQ.eq('doc_type', docType);
  /* Case-insensitive contains. Document numbers are typed by hand from paper. */
  if (docNo) rowsQ = rowsQ.ilike('doc_no', `%${docNo}%`);
  rowsQ = scopeToCompany(rowsQ, c);
  /* limit + 1 so `truncated` is a fact rather than an inference from a full
     page. */
  rowsQ = rowsQ.order('created_at', { ascending: false }).limit(limit + 1);

  const { data: rowData, error: rowsErr } = await rowsQ;
  if (rowsErr) return c.json({ error: 'load_failed', reason: rowsErr.message }, 500);

  let presented = ((rowData as unknown as Row[] | null) ?? []).map(present);
  if (stateParam === 'attention') presented = presented.filter((r) => r.needs_attention);
  else if (stateParam === 'skipped') presented = presented.filter((r) => r.state === 'skipped');
  else if (stateParam === 'requeued') presented = presented.filter((r) => r.state === 'requeued');

  const truncated = presented.length > limit;
  if (truncated) presented = presented.slice(0, limit);

  return c.json({
    writeback: {
      /* The raw string AND what the code makes of it. The parser fails closed:
         absent, empty, 'off', or anything it cannot parse all mean nothing is
         queued and nothing is sent. */
      value: flagValue,
      on: scope !== 'off',
      scope: scope === 'off' ? 'off' : scope === 'all' ? 'all' : scope.join(','),
    },
    counts: {
      pending: nPending,
      sent: nSent,
      failed: nFailed,
      /* OUTSTANDING skips only — the ones that still need somebody. */
      skipped: nSkipped,
      requeued: nRequeued,
      /* The owner's question, as one number. */
      attention: nFailed + nSkipped,
      total: nPending + nSent + nFailed + nSkippedTotal,
    },
    oldest_pending: oldestRaw
      ? {
        doc_type: String(oldestRaw.doc_type ?? ''),
        doc_no: String(oldestRaw.doc_no ?? ''),
        op: String(oldestRaw.op ?? ''),
        attempts: Number(oldestRaw.attempts ?? 0),
        reason: (oldestRaw.last_error as string | null) ?? null,
        created_at: (oldestRaw.created_at as string | null) ?? null,
      }
      : null,
    rows: presented,
    truncated,
    /* Shipped WITH the data so the page never hard-codes a second copy of the
       vocabulary. The legend and the remedy text on screen are these. */
    meta: {
      max_attempts: AC_MAX_ATTEMPTS,
      state_meaning: AC_STATE_MEANING,
      skip_kinds: AC_SKIP_KINDS.map((k) => ({ kind: k.kind, remedy: k.remedy })),
    },
  });
};

autocountOutbox.get('/', listAutocountOutboxHandler);

export default autocountOutbox;
