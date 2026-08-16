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
// IT WAS READ-ONLY UNTIL 2026-08-16, and the paragraph here said so: "Putting
// that behind a button is a separate decision the owner has not made." He has
// made it. `POST /:id/requeue` is that button's backend, and every safety
// property the workflow bought is kept rather than re-argued — it climbs the
// SAME ladder (requeueOneRow in lib/autocount-requeue.ts) the batch sweep does,
// so there is one answer in this system to "may this document be sent again"
// and not two.
//
// What the button adds over the workflow is a refusal the workflow never needed:
// a `sent` row is refused OUTRIGHT. The C# create has no duplicate guard on the
// ERP document number, so re-sending a document the account book has already
// accepted writes a SECOND one into a live licensed book, where a sales order
// cannot simply be deleted. The workflow could not reach that case (it selects
// `skipped`, and `failed` only behind an explicit opt-in); a button pointed at a
// row id can, so it is the first thing the handler checks.
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
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { readWritebackScope, WRITEBACK_KEY } from '../lib/autocount-writeback-flag';
import {
  AC_MAX_ATTEMPTS,
  AC_SKIP_KINDS,
  AC_STATE_MEANING,
  REQUEUE_NOTE_PREFIX,
  acNeedsAttention,
  acOutboxState,
  acRowIsRequeueable,
  classifyAcSkip,
} from '../lib/autocount-outbox-status';
import {
  AC_REQUEUE_MEANING,
  acRequeueAccepted,
  requeueOutboxRow,
} from '../lib/autocount-requeue';

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

/**
 * The keys that may SEND A DOCUMENT AGAIN — strictly narrower than READ_KEYS,
 * because this one writes into a live licensed account book.
 *
 * `scm.autocount.read` is deliberately NOT here. It is catalogued as the key you
 * hand somebody so they can WATCH the queue without also getting the connection
 * settings, and a viewer who can push documents into the book is not a viewer.
 * The second key is the same argument the read gate makes for accepting
 * `settings.manage`, one step up: whoever may change the AutoCount connection
 * may certainly re-send one document through it, and that grant exists today —
 * a key nobody holds is a button nobody can press. Owner and IT Admin hold `*`.
 */
const REQUEUE_KEYS = ['scm.autocount.requeue', 'settings.manage'] as const;

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
    /* Whether to OFFER the per-row button, decided here rather than in the
       page. The frontend layer behind this screen holds no policy on purpose
       (frontend/src/lib/autocountOutbox.ts's own header), and a button whose
       visibility rule lived there would be a second opinion about the same row
       — the drift that made the health check tell an operator to backfill
       DtlKeys for an item-map problem (#2094). This is a HINT and not the gate:
       POST /:id/requeue re-reads the row and can still refuse. */
    can_requeue: acRowIsRequeueable(String(raw.op ?? ''), status, lastError),
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
  const { data: flagRow, error: flagErr } = await sb
    .from('app_config').select('value').eq('key', WRITEBACK_KEY).maybeSingle();
  /* THE ERROR IS BOUND AND BRANCHED ON, not discarded. supabase-js does not
     throw, so `const { data }` alone cannot tell "the row is absent" from "the
     query failed" — and those two render as opposite claims here: ROW ABSENT
     says the switch was never configured, which reads as a definite fact about
     a live account book. readWritebackScope's own fallback ("last known state,
     else off") is right for an enqueue that must never be harmed and wrong for
     a REPORT, which would then print OFF on the strength of a read that did not
     happen. Refusing the whole response is the only answer that cannot mislead:
     the page already has a banner for it. */
  if (flagErr) {
    return c.json(
      { error: 'load_failed', reason: `the write-back switch could not be read: ${flagErr.message}` },
      500,
    );
  }
  const flagValue = ((flagRow as { value?: string } | null)?.value ?? null);

  /* A re-queued row is HISTORY, not backlog — and that is true of a FAILED row
     as well as a skipped one. The table is append-only and neither is ever
     deleted, so without this split the original refusal sits on the page
     forever, sending someone to fix what is already fixed and already queued.
     BOTH terminal states, since #2189 gave the re-queue tool an includeFailed
     opt-in: #2220 taught acOutboxState that rule but these counts kept their
     own, so the tiles went on reporting two re-queued FAILED rows as
     "2 documents need attention" while the rows underneath rendered Re-queued
     — the same self-contradiction #2220 fixed, one component further up. */
  const [pending, sent, failedTotal, skippedTotal, requeuedFailed, requeuedSkipped] = await Promise.all([
    countRows(c, (q) => q.eq('status', 'pending')),
    countRows(c, (q) => q.eq('status', 'sent')),
    countRows(c, (q) => q.eq('status', 'failed')),
    countRows(c, (q) => q.eq('status', 'skipped')),
    countRows(c, (q) => q.eq('status', 'failed').like('last_error', REQUEUED_LIKE)),
    countRows(c, (q) => q.eq('status', 'skipped').like('last_error', REQUEUED_LIKE)),
  ]);

  const firstError = [pending, sent, failedTotal, skippedTotal, requeuedFailed, requeuedSkipped]
    .find((r) => r.error);
  if (firstError) {
    return c.json({ error: 'load_failed', reason: firstError.error?.message ?? 'count failed' }, 500);
  }
  /* A count that came back NULL is NOT zero. PostgREST answers a failed count
     with a null, and rendering that as 0 would tell the owner "nothing is stuck"
     on the strength of a query that did not run — the exact shape CLAUDE.md
     calls a verdict computed over nothing. */
  const missing = [pending, sent, failedTotal, skippedTotal, requeuedFailed, requeuedSkipped]
    .some((r) => r.count === null);
  if (missing) {
    return c.json({ error: 'load_failed', reason: 'the queue counts could not be read' }, 500);
  }

  const nPending = pending.count as number;
  const nSent = sent.count as number;
  const nFailedTotal = failedTotal.count as number;
  const nSkippedTotal = skippedTotal.count as number;
  /* OUTSTANDING = terminal minus already-asked-again, per state. `Math.max`
     because the two counts are separate statements against a live table: a row
     re-queued between them would otherwise produce a negative tile. */
  const nRequeued = (requeuedFailed.count as number) + (requeuedSkipped.count as number);
  const nFailed = Math.max(0, nFailedTotal - (requeuedFailed.count as number));
  const nSkipped = Math.max(0, nSkippedTotal - (requeuedSkipped.count as number));

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
    /* BOTH terminal states: since #2189's includeFailed opt-in a re-queued row
       can be a failed one, and asking only for skips made the Re-queued filter
       answer "nothing" on a page whose rows were rendering Re-queued. */
    requeued: ['skipped', 'failed'],
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
  /* `failed` narrows the same way `skipped` does, and for the same reason: a
     re-queued failed row is history and belongs under Re-queued, not under the
     filter an operator opens to see what is still broken. */
  else if (stateParam === 'failed') presented = presented.filter((r) => r.state === 'failed');
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
      /* TOTAL is every row ever written, so it takes the TERMINAL counts, not
         the outstanding ones — otherwise re-queued rows vanish from the total
         while still being listed underneath it. */
      total: nPending + nSent + nFailedTotal + nSkippedTotal,
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

/**
 * POST /autocount-outbox/:id/requeue — send ONE refused document again.
 *
 * The owner's requirement for this page is that no code jargon appears on it,
 * so the answer is a STRUCTURED OUTCOME and never an exception string:
 *
 *   accepted   did the document go back into the queue
 *   code       a stable, machine-readable outcome key. The UI branches on this
 *              and nothing else. The full catalogue, with what a human should
 *              DO about each, is docs/autocount-sync-reasons.md.
 *   message    the same outcome as one sentence a person can read, taken from
 *              AC_REQUEUE_MEANING so the words live beside the code that
 *              produces them rather than in a frontend dictionary that a new
 *              outcome would silently miss.
 *   reason     the ERP's or AutoCount's OWN words, when there are any. Only
 *              `still-refused` carries them — it is the current blocker, which
 *              is the whole signal after somebody has gone and fixed the last
 *              one — and the page already renders reasons verbatim.
 *
 * A REFUSAL IS A 200. `already-sent`, `switch-off` and the rest are legitimate
 * answers to a legitimate request, not client errors, and an HTTP error would
 * reach the page through the generic failure path that prints a status code.
 * Only the four things that are genuinely wrong with the CALL — no permission,
 * no company, no id, an unreadable queue — carry a non-200.
 */
export const requeueAutocountOutboxHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  if (!REQUEUE_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json(
      {
        error: 'forbidden',
        message:
          'Sending a document again writes into the live AutoCount account book, '
          + `so it is limited to ${REQUEUE_KEYS.join(' or ')}.`,
      },
      403,
    );
  }
  /* The STRICT company resolver, not activeCompanyId. This is a write, and the
     lenient helper degrades to "no predicate" when the company is unresolved —
     which on a write means "act on every company's rows". Refusing is the only
     safe answer (scm/lib/companyScope.ts states the rule in full). */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const rowId = (c.req.param('id') ?? '').trim();
  if (!rowId) return c.json({ error: 'invalid_row_id' }, 400);

  const sb = c.get('supabase');
  const result = await requeueOutboxRow(sb, { rowId, companyId: co.companyId });

  /* The lib's `detail` is written for an operator reading a workflow log and
     names columns and index behaviour. It does not go to the page — it goes
     here, where it is the only record of WHY once the response has been
     rendered as one sentence. */
  if (!acRequeueAccepted(result.outcome)) {
    // eslint-disable-next-line no-console
    console.warn('[autocount-outbox] re-queue refused', result.outcome, result.docNo, result.detail);
  }

  const body = {
    accepted: acRequeueAccepted(result.outcome),
    code: result.outcome,
    message: AC_REQUEUE_MEANING[result.outcome],
    row_id: result.rowId,
    doc_type: result.docType,
    doc_no: result.docNo,
    op: result.op,
    /* The live attempt this created, so the page can point at it rather than
       asking the reader to go and find a new row in a list of two hundred. */
    new_row_id: result.newRowId,
    reason: result.outcome === 'still-refused' ? result.detail : null,
  };
  if (result.outcome === 'row-not-found') return c.json(body, 404);
  if (result.outcome === 'read-failed') return c.json(body, 500);
  return c.json(body, 200);
};

autocountOutbox.post('/:id/requeue', requeueAutocountOutboxHandler);

export default autocountOutbox;
