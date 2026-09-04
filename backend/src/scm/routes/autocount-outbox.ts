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
import { activeCompanyId, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { readWritebackScope, WRITEBACK_KEY } from '../lib/autocount-writeback-flag';
import {
  AC_MAX_ATTEMPTS,
  AC_SKIP_KINDS,
  AC_STATE_MEANING,
  REQUEUE_NOTE_PREFIX,
  acNeedsAttention,
  acOutboxState,
  acRowCanSendNow,
  acRowIsRequeueable,
  classifyAcSkip,
} from '../lib/autocount-outbox-status';
import { callAcRead } from '../../services/autocount-host-read';
import { autocountRelinkLinesHandler } from './autocount-relink';
import { autocountLineSweepHandler } from './autocount-line-sweep';
import {
  AC_REQUEUE_MEANING,
  REQUEUE_DOC_TYPES,
  acRequeueAccepted,
  requeueOutboxRow,
  sendOutboxRowNow,
} from '../lib/autocount-requeue';
import { ancestorsNeedingSend, sendNowPeek } from '../lib/autocount-cascade';

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

/**
 * WHAT IDENTIFIES A DOCUMENT: its TYPE and its NUMBER, together.
 *
 * Not `doc_no` alone — 0277's CHECK admits six types and the same number can
 * legitimately belong to two of them. Not `doc_id` — it is nullable and
 * deliberately untyped ("ERP row id as text ... an outbox row must survive its
 * document being reworked"), so it cannot be the key of anything. The pair is
 * the table's OWN answer: `autocount_outbox_doc_idx` is
 * `(company_id, doc_type, doc_no)`, created by 0277 to answer "has this document
 * been written to AutoCount, and as what". `company_id` is not in the key here
 * because every statement in this handler already carries it as a predicate.
 *
 * The separator is a NUL, which a Postgres `text` value cannot contain, so no
 * pair of real values can collide on the joined string.
 */
export const acDocKey = (docType: unknown, docNo: unknown): string =>
  `${String(docType ?? '')}\u0000${String(docNo ?? '')}`;

/**
 * How far the count scan will read before it stops claiming to be complete.
 *
 * PAGE is a PostgREST page: Supabase caps a single read at its own `db-max-rows`
 * (unset here as far as this code can tell, and a cap it cannot see is exactly
 * the kind of silent truncation that turns a count into a lie), so the scan
 * pages explicitly rather than asking for everything and trusting the answer.
 * MAX is where it gives up and SAYS so — `counts_complete: false` — instead of
 * reporting an undercount as a fact. The queue held 17 rows on 2026-08-16, four
 * days after the write-back went live; MAX is the point at which this needs to
 * become a `count(distinct …)` in SQL rather than a scan.
 */
const AC_DOC_SCAN_PAGE = 1000;
export const AC_DOC_SCAN_MAX = 20_000;

interface ScanResult {
  rows: Row[];
  /** False when MAX was reached, so the rows are a prefix and not the set. */
  complete: boolean;
  error: { message?: string } | null;
}

/** Just enough of the PostgREST builder for the two scans below. */
interface ScanBuilder extends PromiseLike<{ data: unknown; error: { message?: string } | null }> {
  like(col: string, pattern: string): ScanBuilder;
  range(from: number, to: number): ScanBuilder;
}

/**
 * One company-scoped scan that answers WHICH DOCUMENTS, not how many rows.
 *
 * This replaced six `count: 'exact', head: true` queries on 2026-08-17, and the
 * reason is the defect the owner reported: `HC-SO-2608-002` occupied four of the
 * six rows under *In AutoCount → Sales orders* while the account book holds
 * exactly one of it. Every number on that screen was a count of SENDS printed
 * under the word "documents". A row count cannot be turned into a document count
 * after the fact, and PostgREST has no `count(distinct …)`, so the identity has
 * to come back with the rows.
 *
 * It costs TWO reads where the counts used to cost six, because it no longer
 * asks a separate question per state: the state is derived from the row, by
 * `acOutboxState`, the same function the list and the health check already use.
 */
async function scanDocs(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  columns: string,
  narrow: (q: ScanBuilder) => ScanBuilder,
): Promise<ScanResult> {
  const sb = c.get('supabase');
  const out: Row[] = [];
  for (let from = 0; from < AC_DOC_SCAN_MAX; from += AC_DOC_SCAN_PAGE) {
    const base = sb.from('autocount_outbox').select(columns);
    /* The company predicate goes on BEFORE the caller's narrowing, so no caller
       can forget it — there is no un-scoped builder to hand out. */
    const scoped = scopeToCompany(base, c) as unknown as ScanBuilder;
    const { data, error } = await narrow(scoped).range(from, from + AC_DOC_SCAN_PAGE - 1);
    if (error) return { rows: [], complete: false, error };
    /* A null body is PostgREST's answer to a read that produced nothing AND to
       one that failed; `error` above already separated those, so this is the
       empty case. */
    const page = (data as Row[] | null) ?? [];
    out.push(...page);
    if (page.length < AC_DOC_SCAN_PAGE) return { rows: out, complete: true, error: null };
  }
  return { rows: out, complete: false, error: null };
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
    /* The WAITING row's own control, decided in the same place and for the same
       reason. Disjoint from can_requeue by construction — one is true only of a
       stopped row, the other only of a waiting one — so a row never offers two
       buttons that would both mean "send it". */
    can_send_now: acRowCanSendNow(status, lastError, Number(raw.attempts ?? 0)),
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
     "off".

     THE SWITCH IS A COMPANY ALLOW-LIST, AND THIS LINE USED TO FORGET THAT.
     `scm.autocount_writeback` takes 'off' / 'all' / a comma-separated list of
     company ids, and every one of the eight enqueue gates asks the question the
     right way — `isWritebackEnabled(sb, companyId)`. This report was the ONLY
     caller in the backend that read the scope bare and then published
     `on: scope !== 'off'`, i.e. "is it on for ANYBODY". With the live value set
     to one company, the OTHER organisation's operator was told, on this page,
     that sending was switched on FOR HIS COMPANY and that saving a document
     would queue it. Neither was true: his queue is company-scoped (see
     scopeToCompany below), so it is permanently empty, and nothing errors. The
     comment above already said this page "must not make the reader guess" which
     side of the switch an empty queue is on — for one of the two organisations
     it was answering with the wrong side.

     Two facts now, because they are two different questions and the page needs
     both: `scope` still reports what the switch SAYS (unchanged — an admin has
     to be able to see the whole allow-list), and `on` reports whether it covers
     THIS company, which is what governs whether this reader's next save queues
     anything. The sibling flag built on the same parser never had the bug —
     write-freeze-status.ts prints "company 1, 3" rather than "this company". */
  const scope = await readWritebackScope(sb);
  const writebackCompanyId = activeCompanyId(c);
  /* Mirrors isWritebackEnabled's own arithmetic (lib/autocount-writeback-flag.ts).
     Not a call to it, because a REPORT and an ENQUEUE want opposite answers when
     the company is unresolved: the enqueue must refuse (never write into a live
     account book on a guess), while this page must not claim the switch is off
     on the strength of a company it could not resolve. Unresolved is carried as
     null and rendered as its own sentence. */
  const writebackOn: boolean | null =
    scope === 'off' ? false
    : scope === 'all' ? true
    : writebackCompanyId == null ? null
    : scope.includes(Number(writebackCompanyId));
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

  /* THE NUMBERS ARE DOCUMENTS, NOT SENDS — since 2026-08-17, and this is the
     defect the owner reported: `HC-SO-2608-002` took four of the six rows under
     *In AutoCount → Sales orders* while `AED_HOUZS` holds exactly one of it.
     The queue is append-only and one document accumulates a send per operation,
     so "17 documents" was 17 SENDS over fewer documents, and the page said
     "documents".

     A re-queued row is HISTORY, not backlog — and that is true of a FAILED row
     as well as a skipped one. The table is append-only and neither is ever
     deleted, so without this split the original refusal sits on the page
     forever, sending someone to fix what is already fixed and already queued.
     BOTH terminal states, since #2189 gave the re-queue tool an includeFailed
     opt-in: #2220 taught acOutboxState that rule but these counts kept their
     own, so the tiles went on reporting two re-queued FAILED rows as
     "2 documents need attention" while the rows underneath rendered Re-queued
     — the same self-contradiction #2220 fixed, one component further up. That
     rule is no longer restated here: the state comes from `acOutboxState`, the
     one function the list, the health check and this block now share. */
  const [allRows, requeuedRows] = await Promise.all([
    scanDocs(c, 'id, doc_type, doc_no, status', (q) => q),
    /* `last_error` is NEVER downloaded. All this needs from it is whether the
       re-queue marker is on the front, and the LIKE answers that in Postgres —
       the notes are up to several hundred characters of the account book's own
       per-line dump, and a count has no use for one of them. */
    scanDocs(c, 'id', (q) => q.like('last_error', REQUEUED_LIKE)),
  ]);

  const scanError = [allRows, requeuedRows].find((r) => r.error);
  if (scanError) {
    return c.json({ error: 'load_failed', reason: scanError.error?.message ?? 'count failed' }, 500);
  }

  const requeuedIds = new Set(requeuedRows.rows.map((r) => String(r.id ?? '')));
  /* One entry per DOCUMENT, holding the states its sends are in. A document is
     counted under a chip when at least one of its sends is in that state, which
     is exactly what the list under that chip would show it for — the list is
     filtered by status and then grouped by document on the page. Two chips can
     legitimately count the same document: one that arrived and was later edited
     into a refusal IS in the account book AND does need attention. */
  const statesPerDoc = new Map<string, Set<string>>();
  for (const r of allRows.rows) {
    const key = acDocKey(r.doc_type, r.doc_no);
    /* The marker itself stands in for the note it prefixes. The LIKE above is
       what matched, so `isRequeuedNote` is true of this row by construction, and
       passing the prefix asks the shared classifier rather than restating it. */
    const state = acOutboxState(
      String(r.status ?? ''),
      requeuedIds.has(String(r.id ?? '')) ? REQUEUE_NOTE_PREFIX : null,
    );
    const seen = statesPerDoc.get(key);
    if (seen) seen.add(state);
    else statesPerDoc.set(key, new Set([state]));
  }

  const docsIn = (...states: string[]): number => {
    let n = 0;
    for (const seen of statesPerDoc.values()) {
      if (states.some((s) => seen.has(s))) n += 1;
    }
    return n;
  };

  const nPending = docsIn('pending');
  const nSent = docsIn('sent');
  const nFailed = docsIn('failed');
  const nSkipped = docsIn('skipped');
  const nRequeued = docsIn('requeued');
  const nAttention = docsIn('failed', 'skipped');
  const nTotal = statesPerDoc.size;
  /* A COUNT THAT DID NOT SEE EVERY ROW MUST NOT READ AS A FACT. The scan stops
     at AC_DOC_SCAN_MAX and says so rather than reporting the prefix it managed
     to read as the whole company — the shape CLAUDE.md calls a verdict computed
     over nothing. The page prints one extra sentence when this is false. */
  const countsComplete = allRows.complete && requeuedRows.complete;

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
      /* ON FOR THIS COMPANY — not "on for anybody". See the derivation above. */
      on: writebackOn,
      scope: scope === 'off' ? 'off' : scope === 'all' ? 'all' : scope.join(','),
    },
    /* EVERY ONE OF THESE IS A COUNT OF DOCUMENTS. They no longer sum to the
       total and must not be made to: a document with an arrival and a later
       refusal is counted by `sent` and by `failed`, because both are true of it
       and both chips would list it. `total` is the number of distinct documents,
       which is what the "N of M documents" line under the strips reads. */
    counts: {
      pending: nPending,
      sent: nSent,
      failed: nFailed,
      /* OUTSTANDING skips only — the ones that still need somebody. */
      skipped: nSkipped,
      requeued: nRequeued,
      /* The owner's question, as one number. */
      attention: nAttention,
      total: nTotal,
    },
    counts_complete: countsComplete,
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

/**
 * GET /host-log — the last N lines of AcSyncService's own log, from the host.
 *
 * WHY IT IS HERE AND NOT IN A SCRIPT. When a conversion fails with
 * `Invalid transfer item.` the ERP records eleven words that name nothing. The
 * sentence that settles it — `target debtor before transfer = [...]` — is
 * written by the service into the host's own log file, and until 2026-08-25 the
 * only way to read it was TeamViewer, Notepad, and a scrollbar through a 377 KB
 * file. The service has served that file over HTTP since it was written;
 * nothing in this ERP ever asked.
 *
 * READ-ONLY IN BOTH DIRECTIONS: it writes nothing on the host (the route opens
 * no SDK session) and nothing here — no outbox row, no attempt, no retry. A
 * failure is reported and dropped.
 *
 * THE SAME KEYS AS SEND AGAIN, deliberately. This log carries document numbers,
 * account codes and the account book's own refusals; it is not more public than
 * the button that writes to the book, and giving it a laxer gate would make the
 * quiet way in the one that reads.
 */
export const autocountHostLogHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  if (!REQUEUE_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json(
      {
        error: 'forbidden',
        message: 'The AutoCount host log carries document numbers and account codes, '
          + `so it is limited to ${REQUEUE_KEYS.join(' or ')}.`,
      },
      403,
    );
  }
  /* A CAP, and it is the host's own. AcSyncService clamps to its MaxLogLines
     and defaults to 60; asking for more than it will give is not an error
     there, so the only job here is to refuse a value that is not a number. */
  const raw = (c.req.query('lines') ?? '').trim();
  const lines = raw ? Number(raw) : 200;
  if (!Number.isFinite(lines) || lines <= 0) {
    return c.json({ error: 'invalid_lines', message: '`lines` must be a positive number.' }, 400);
  }
  const onlyErrors = c.req.query('onlyErrors') === '1';

  const r = await callAcRead(c.env, 'last_errors', { Lines: lines, OnlyErrors: onlyErrors });
  if (!r.ok) return c.json({ ok: false, error: r.error, status: r.status }, 502);
  return c.json({
    ok: true,
    path: r.body?.path ?? null,
    exists: r.body?.exists ?? null,
    lines: r.body?.lines ?? [],
  });
};

/**
 * GET /book-doc — one document as the ACCOUNT BOOK holds it, not as we sent it.
 *
 * WHY. Every other route here answers "what did the ERP send" or "what did the
 * host say back". Neither can answer the questions that actually cost days:
 *
 *   did my edit reach AutoCount              (owner 2026-08-26)
 *   is the convert-from link really there    (owner 2026-08-24)
 *   which warehouse does the line carry      (#0549)
 *
 * All three are questions about what the BOOK holds, and no amount of reading
 * our own payload answers one of them. `Set()` on the host SWALLOWS a refused
 * assignment and still reports success, so "sent" has never meant "landed" —
 * #0549 is eight days of a purchase order silently carrying no warehouse while
 * the queue, the page and the log all showed green.
 *
 * AcSyncService has served `/doc-read` since 2026-08-15. Nothing in this ERP
 * ever called it. That is the same gap `/host-log` closed for the log file.
 *
 * READ-ONLY IN BOTH DIRECTIONS: two SELECTs on the host, no SDK session, no
 * outbox row, no attempt, no retry. A failure is reported and dropped.
 *
 * THE SAME KEYS AS SEND AGAIN, for the same reason `/host-log` uses them: this
 * returns debtor codes, prices and addresses out of a licensed account book.
 */
export const autocountBookDocHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  if (!REQUEUE_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json(
      {
        error: 'forbidden',
        message: 'Reading a document out of the account book returns account codes and '
          + `prices, so it is limited to ${REQUEUE_KEYS.join(' or ')}.`,
      },
      403,
    );
  }

  const docType = (c.req.query('docType') ?? '').trim().toUpperCase();
  const docNo = (c.req.query('docNo') ?? '').trim();
  /* VALIDATED HERE AS WELL AS ON THE HOST. The host builds its table name from
     this value, and it guards itself — but a route that forwards whatever it is
     given makes the host's guard the only one, and a caller then learns the
     rule from a 500.

     `REQUEUE_DOC_TYPES`, NOT A LIST OF ITS OWN. The first draft declared
     `BOOK_DOC_TYPES` beside `AC_READ_ROUTE` — one business question ("which six
     documents does this ERP sync with AutoCount") acquiring a fifth home, which
     `audit:duplicated-decisions` refused, correctly. The set is the same set and
     `autocountHostRead.test.ts` now pins THIS list against the host's own
     `DocTypes`, so the shared answer is the one proven to match the book. */
  if (!(REQUEUE_DOC_TYPES as readonly string[]).includes(docType)) {
    return c.json({
      error: 'invalid_doc_type',
      message: `docType must be one of ${REQUEUE_DOC_TYPES.join(', ')}.`,
    }, 400);
  }
  if (!docNo) {
    return c.json({ error: 'invalid_doc_no', message: '`docNo` is required.' }, 400);
  }

  const r = await callAcRead(c.env, 'doc_read', { DocType: docType, DocNo: docNo });
  if (!r.ok) return c.json({ ok: false, error: r.error, status: r.status }, 502);
  return c.json({
    ok: true,
    docType: r.body?.docType ?? docType,
    header: r.body?.header ?? null,
    lines: r.body?.lines ?? [],
    /* PASSED THROUGH, not dropped. The host reports a wanted column the book
       does not have, and "AutoCount has no such field" is itself the answer to
       several of the questions this route exists for. */
    missingColumns: r.body?.missingColumns ?? [],
  });
};

/* GET /table-columns — what columns a document table actually has, names only.
   It answers ONE question and it is worth naming: can an AutoCount document
   DETAIL carry a user-defined column? If it can, the ERP can stamp its OWN line
   reference into the book and stop depending on the key AutoCount hands back —
   which is what the owner asked for on 2026-08-31 (「为什么 AutoCount 要回传给我们
   呢?」). The reflected SDK dump cannot answer it (taken DeclaredOnly, so an
   inherited `UDF` member is invisible); sys.columns on the live book can. */
export const autocountTableColumnsHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  if (!REQUEUE_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json({ error: 'forbidden', message: `Limited to ${REQUEUE_KEYS.join(' or ')}.` }, 403);
  }
  const table = (c.req.query('table') ?? '').trim().toUpperCase();
  const like = (c.req.query('like') ?? '').trim();
  if (!table) return c.json({ error: 'invalid_table', message: '`table` is required.' }, 400);
  const r = await callAcRead(c.env, 'table_columns', { Table: table, Like: like });
  if (!r.ok) return c.json({ ok: false, error: r.error, status: r.status }, 502);
  return c.json({ ok: true, table: r.body?.table ?? table, columns: r.body?.columns ?? [] });
};

autocountOutbox.get('/book-doc', autocountBookDocHandler);
autocountOutbox.get('/table-columns', autocountTableColumnsHandler);
/* The WRITE half of /book-doc: match a held-back document's lines up against the
   book so it can be saved again. Its own file (this one is at the size cap), and
   its matching rules are a tested module of their own. */
autocountOutbox.post('/relink-lines', autocountRelinkLinesHandler);
autocountOutbox.post('/line-order-sweep', autocountLineSweepHandler);
autocountOutbox.get('/host-log', autocountHostLogHandler);
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
/**
 * PUSH ONE WAITING DOCUMENT TO AUTOCOUNT NOW.
 *
 * A SECOND DOOR TO ONE MECHANISM, not a second mechanism. It shares this file's
 * permission keys, the strict company resolver, the response contract and the
 * outcome vocabulary with the re-queue handler beside it; what differs is the
 * lib call, because dispatching a row that is already queued and inserting a
 * fresh row for a refused one are genuinely different acts with different
 * answers (`sendOutboxRowNow`'s own doc comment argues this in full).
 *
 * ITS OWN ROUTE RATHER THAN A BRANCH INSIDE /requeue, for one reason that
 * outlives the tidiness argument: the two have different CONCURRENCY contracts.
 * A re-queue must not take an exclusive claim — it writes a new row and never
 * dispatches — while this one must, every time, or two presses put two documents
 * in a licensed account book. Folding them together would have put a rule that
 * only applies to half the traffic inside a handler that serves all of it.
 *
 * A REFUSAL IS STILL HTTP 200, exactly as the re-queue's is. The caller asked a
 * question and got an answer; only a call that could not be answered at all is a
 * non-200. The page renders both on the row that was pressed.
 */
export /* THE ANCESTORS, SENT FIRST — shared by both buttons on purpose.
   AutoCount builds a conversion only by carrying an earlier document into it,
   so a child whose parent is not in the book cannot go. Left alone the row
   WAITS, which is right for a background sweep and useless to a person: the
   parent is failed at six of six attempts, so nothing re-sends it and the child
   waits forever. Pressing either button is the moment to CAUSE the parent.
   Owner 2026-08-23: 「按 SI 就 SO → DO → SI；按 GR 就 PO → GR」.
   One helper, so "Send now" and "Send again" cannot come to differ about it. */
async function sendAncestorsFirst(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono ctx + PostgREST client, both `any` throughout this file
  c: any, sb: any, companyId: number, docType: string, docId: string | null,
): Promise<Array<{ doc_type: string; doc_no: string; code: string; reason: string }>> {
  const out: Array<{ doc_type: string; doc_no: string; code: string; reason: string }> = [];
  for (const a of await ancestorsNeedingSend(sb, companyId, docType, docId)) {
    /* THE REASON TRAVELS WITH THE OUTCOME. `missing` and `stale` are two
       different things to tell a person — "AutoCount did not have this one yet"
       against "AutoCount had an older version of this one" — and the page cannot
       tell them apart from a document number and a status. */
    const say = (code: string) => out.push({
      doc_type: a.docType, doc_no: a.docNo, code, reason: a.reason,
    });
    if (!a.rowId) { say('no-outbox-row'); continue; }

    /* A PENDING ANCESTOR IS SENT, NOT RE-QUEUED, and this is the whole of the
       2026-08-26 fix. `requeueOutboxRow` refuses a pending row — `row-pending`,
       and rightly, because the sweep is already going to take it — so a cascade
       that only ever re-queued did NOTHING for the shape it meets most: a
       chain where every document is waiting on the one above it.

       Owner 2026-08-26: 「如果顺着点完…就没问题。但如果我想走捷径，直接去点
       Sales Invoice…就不行」. Pressing SO, then DO, then SI by hand worked
       because each press sends that row's own pending row directly. Pressing
       only the invoice found three pending ancestors, asked to re-queue each,
       was told `row-pending` three times, and sent nothing — the button did
       exactly what the operator could see: nothing.

       A `stale` ancestor arrives here as an EDIT row and takes the same two
       paths for the same reasons: pending means the sweep has not reached it,
       failed means the sweep gave up. Either way the book is behind and the
       press is the moment to catch it up. */
    if (a.rowStatus === 'pending') {
      say((await sendOutboxRowNow(c.env, sb, { rowId: a.rowId, companyId })).outcome);
      continue;
    }

    const rq = await requeueOutboxRow(sb, { rowId: a.rowId, companyId });
    if (!acRequeueAccepted(rq.outcome) || !rq.newRowId) { say(rq.outcome); continue; }
    say((await sendOutboxRowNow(c.env, sb, { rowId: rq.newRowId, companyId })).outcome);
  }
  return out;
}

const sendNowAutocountOutboxHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  /* THE SAME KEYS AS SEND AGAIN, and deliberately not a new permission. Both
     buttons do the one thing the key is about — put an ERP document into the
     live account book — and inventing a second key would mean an operator could
     hold the right to send a refused document but not a waiting one, a
     distinction nobody could explain and nobody asked for. */
  if (!REQUEUE_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json(
      {
        error: 'forbidden',
        message:
          'Sending a document to AutoCount writes into the live account book, '
          + `so it is limited to ${REQUEUE_KEYS.join(' or ')}.`,
      },
      403,
    );
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const rowId = (c.req.param('id') ?? '').trim();
  if (!rowId) return c.json({ error: 'invalid_row_id' }, 400);

  const sb = c.get('supabase');
  /* Read the row's document BEFORE sending it, so the chain can go first. */
  const peek = await sendNowPeek(sb, rowId, co.companyId);
  const ancestors = peek
    ? await sendAncestorsFirst(c, sb, co.companyId, peek.docType, peek.docId)
    : [];
  const result = await sendOutboxRowNow(c.env, sb, { rowId, companyId: co.companyId });

  if (!acRequeueAccepted(result.outcome)) {
    // eslint-disable-next-line no-console
    console.warn('[autocount-outbox] send-now not accepted', result.outcome, result.docNo, result.detail);
  }

  const body = {
    accepted: acRequeueAccepted(result.outcome),
    code: result.outcome,
    message: AC_REQUEUE_MEANING[result.outcome],
    row_id: result.rowId,
    doc_type: result.docType,
    doc_no: result.docNo,
    op: result.op,
    new_row_id: null,
    /* SAME TWO FIELDS THE RE-QUEUE BUTTON RETURNS, because both buttons now do
       the same two things. `sent_now` is trivially true here — this handler IS
       the immediate send — and it is stated anyway so one page renderer serves
       both replies. */
    sent_now: { attempted: true, code: result.outcome, detail: result.detail ?? null },
    ancestors_sent: ancestors,
    /* WHAT THE ACCOUNT BOOK SAID, on the outcomes where it said something. A
       send-now that reached AutoCount and was refused carries the book's own
       words, and those are the whole diagnosis — the same standing as
       `still-refused` on the re-queue path. */
    reason:
      result.outcome === 'send-now-refused'
      || result.outcome === 'send-now-retrying'
      || result.outcome === 'send-now-waiting'
        ? (result.detail || null)
        : null,
  };
  if (result.outcome === 'row-not-found') return c.json(body, 404);
  if (result.outcome === 'read-failed') return c.json(body, 500);
  return c.json(body, 200);
};

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

  /* SEND NOW MEANS NOW. Owner 2026-08-23: 「按下去就是立刻送，不是排队」.
     re-queue writes a fresh `pending` row and used to stop there — the five-
     minute drain sent it, so pressing the button put the document into Waiting
     and the operator watched a clock. sendOutboxRowNow already dispatches
     synchronously, but it only accepts a row that is ALREADY pending, which a
     failed row never is. Both halves existed; nothing joined them.
     Best-effort on purpose: the re-queue SUCCEEDED whatever the send does, and
     reporting it as a failure would lose the row the operator can retry. What
     the send did is reported separately, in `sent_now`. */
  let sentNow: { attempted: boolean; code?: string; detail?: string | null } = { attempted: false };
  const ancestors: Array<{ doc_type: string; doc_no: string; code: string; reason: string }> = [];
  if (acRequeueAccepted(result.outcome) && result.newRowId) {
    /* THE ANCESTORS FIRST, OUTERMOST FIRST. Owner 2026-08-23: 「按 SI 就
       SO → DO → SI」. AutoCount builds a conversion only by carrying an earlier
       document into it, so a child whose parent is not in the book cannot go —
       and left alone it WAITS for a parent that nothing is re-sending. Pressing
       the button is the moment to cause the parent instead of waiting for it.
       Each ancestor goes through the SAME re-queue-then-send this row does, so
       there is one code path and one set of refusals, not two. */
    ancestors.push(...await sendAncestorsFirst(c, sb, co.companyId, result.docType ?? '', result.docId ?? null));

    /* SEND NOW MEANS NOW. Owner: 「按下去就是立刻送，不是排队」. re-queue writes
       a fresh `pending` row and used to stop there — the five-minute drain sent
       it, so the button put the document into Waiting and the operator watched a
       clock. sendOutboxRowNow already dispatches synchronously but only accepts
       a row that is ALREADY pending, which a failed row never is. Both halves
       existed; nothing joined them.
       Best-effort on purpose: the re-queue SUCCEEDED whatever the send does, and
       reporting it as a failure would lose the row the operator can retry. */
    const send = await sendOutboxRowNow(c.env, sb, { rowId: result.newRowId, companyId: co.companyId });
    sentNow = { attempted: true, code: send.outcome, detail: send.detail ?? null };
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
    /* What the immediate send did, kept apart from the re-queue's own verdict:
       a document can be queued successfully and still be refused by the account
       book one second later, and the operator needs to see both. */
    sent_now: sentNow,
    /* What the chain above it did, in the order they were sent. */
    ancestors_sent: ancestors,
    reason: result.outcome === 'still-refused' ? result.detail : null,
  };
  if (result.outcome === 'row-not-found') return c.json(body, 404);
  if (result.outcome === 'read-failed') return c.json(body, 500);
  return c.json(body, 200);
};

autocountOutbox.post('/:id/requeue', requeueAutocountOutboxHandler);
autocountOutbox.post('/:id/send-now', sendNowAutocountOutboxHandler);

export default autocountOutbox;
