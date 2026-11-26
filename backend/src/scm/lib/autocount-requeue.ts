import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import type { AcDocType, AcOp } from '../../services/autocount-writeback';
import {
  dispatchOne, enqueueAcOp, enqueueConvert, enqueueEdit, enqueuePoCreate, enqueueSoCreate,
  MAX_ATTEMPTS,
  type AcDocRef, type AcOutboxPayload, type AcOutboxRow,
} from './autocount-outbox';
import { rebuildAllowed } from '../../services/ac-line-gone';
import { claimOutboxRow } from './autocount-claim';
import { reresolveConvertSource } from './convert-parent';
import { AC_TRANSFER_OPS, REQUEUE_NOTE_PREFIX } from './autocount-outbox-status';
import { isWritebackEnabled } from './autocount-writeback-flag';

type Sb = SupabaseClient<any, any, any>;

/**
 * The document types a sweep may be narrowed to.
 *
 * SO and PO are the two that have an AutoCount CREATE. The other four have no
 * create at all — they are built by transferring a parent's lines — and they are
 * in this list because a FAILED transfer is re-sendable (see the header), so a
 * scope that could not name them would make the batch tool unable to work the
 * one backlog the button was given for.
 */
export const REQUEUE_DOC_TYPES = ['SO', 'PO', 'DO', 'GR', 'IV', 'PI'] as const;
export type RequeueDocType = (typeof REQUEUE_DOC_TYPES)[number];

/**
 * What a re-queued row's ORIGINAL skip is rewritten to start with.
 *
 * Re-exported, not declared: it is now read by three things — this writer, the
 * health script (through its plain-node mirror) and the ERP's own outbox page —
 * so the definition lives in the one module all three can reach, with a
 * canonical test refereeing the mirror. Kept exported from here because callers
 * and tests already import it by this path.
 */
export { REQUEUE_NOTE_PREFIX };

export type RequeueOutcome =
  | 'would-requeue'
  | 'requeued'
  | 'requeued-as-recorded'
  | 'requeued-with-parent'
  | 'still-refused'
  | 'not-recoverable'
  | 'already-in-autocount'
  | 'already-queued'
  | 'already-requeued'
  | 'document-gone'
  | 'switch-off'
  | 'declined'
  | 'already-sent'
  | 'row-pending'
  /* ── SEND NOW ────────────────────────────────────────────────────────────
     The owner asked for a manual push on a row that is still WAITING
     (「自动的 可是我要可以manual push」). It is a different act from a re-queue
     and its outcomes are its own: a re-queue INSERTS a fresh row for the next
     sweep, while a send-now dispatches THE ROW IN FRONT OF YOU, right now, and
     therefore has AutoCount's own answer to report rather than a promise about
     a sweep five minutes away. Sharing `requeued`'s codes would have made
     "queued" and "the account book has taken it" the same word. */
  | 'sent-now'
  | 'send-now-refused'
  | 'send-now-retrying'
  | 'send-now-waiting'
  | 'not-waiting'
  | 'already-in-flight'
  | 'attempts-spent'
  | 'row-not-found'
  | 'read-failed';

/**
 * The outcomes that mean THIS DOCUMENT IS NOW ON ITS WAY — it has been queued,
 * or a dry run has said it would be.
 *
 * Named as a set rather than written as an `||` chain in the sweep's loop
 * because forgetting one of them is silent: a document put on its way under an
 * outcome missing from here is simply re-queued a second time, which is the
 * defect this exists to stop. `requeued-with-parent` is the one that would be
 * forgotten — it queues TWO documents and reads like a special case.
 *
 * `sent-now` is deliberately NOT here. It belongs to the per-row button, which
 * dispatches one row and never loops, so a set it can never be consulted for
 * would only invite a reader to think the sweep can produce it.
 */
export const REQUEUE_PUTS_IT_ON_ITS_WAY: ReadonlySet<RequeueOutcome> = new Set<RequeueOutcome>([
  'would-requeue',
  'requeued',
  'requeued-as-recorded',
  'requeued-with-parent',
]);

/**
 * Every outcome in ONE plain-English sentence, for a reader who did not write
 * the queue.
 *
 * THE PAGE CARRIES NO CODE JARGON — the owner's standing instruction for the
 * AutoCount Sync screen. So the sentence a person reads is defined here, beside
 * the code that produces the outcome, and the UI does nothing but look it up.
 * A dictionary in the frontend would be a second set of words for the same
 * event, and the first time an outcome was added it would render as a bare
 * hyphenated key on the screen the owner reads.
 *
 * `docs/autocount-sync-reasons.md` documents these codes and must use the same
 * keys; a test in autocount-requeue.test.ts pins the two together.
 */
export const AC_REQUEUE_MEANING: Record<RequeueOutcome, string> = {
  requeued:
    'Sent back to the queue. It goes to AutoCount on the next five-minute sweep.',
  'requeued-as-recorded':
    'Sent back to the queue exactly as it was first recorded. This one is built by transferring the '
    + 'lines of the document above it, so there is nothing to rebuild — and anything changed on it '
    + 'since is not included. It goes on the next five-minute sweep.',
  'would-requeue':
    'This document is ready to go. Nothing was written, because this was a rehearsal.',
  'still-refused':
    'The ERP still will not send it. The reason shown is the one blocking it NOW, which may not be the one you just fixed.',
  'not-recoverable':
    'This one cannot be sent again from here. The reason shown says what to do instead.',
  'already-in-autocount':
    'This document is already in AutoCount. Sending it again would put a second copy in the account book.',
  'requeued-with-parent':
    'This one was recorded as having no earlier document, and that was wrong \u2014 its lines do come from one. It has been sent across as a proper conversion, and the earlier document went first if it was not already in the book.',
  'already-queued':
    'There is already a live attempt for this document. Nothing to add.',
  'already-requeued':
    'This was already sent back to the queue once. It is a record of what happened, not something still waiting.',
  'already-sent':
    'AutoCount already accepted this one. Sending it again would put a SECOND copy of the document in the account book, and an accepted document cannot simply be deleted there.',
  'row-pending':
    'This is already waiting in the queue. The next five-minute sweep will send it.',
  'sent-now':
    'Sent, and AutoCount took it. It is in the account book now — you did not have to wait for the five-minute sweep.',
  'send-now-refused':
    'It went to AutoCount just now and AutoCount would not take it. What the account book said is shown below.',
  'send-now-retrying':
    'It went out just now and did not get through. Nothing reached the account book, the document is still queued, and the five-minute sweep will keep trying. What came back is shown below.',
  'send-now-waiting':
    'Nothing was sent: this document is built from an earlier one that is not in AutoCount yet. It goes across on its own once that one has.',
  'not-waiting':
    'This one is not waiting to go out, so there is nothing to push. Only a document still queued can be sent early.',
  'already-in-flight':
    'It is going out right now — either the five-minute sweep picked it up, or somebody else pressed this a moment ago. Nothing was sent twice.',
  'attempts-spent':
    'This one has used all its tries and no sweep will pick it up again. Fix what AutoCount objected to, then use Send again rather than this.',
  'row-not-found':
    'That line is not in this company\'s queue. Refresh the page and try again.',
  'document-gone':
    'The document behind this line no longer exists in the ERP, so there is nothing to send.',
  'switch-off':
    'Sending to AutoCount is switched OFF, so nothing can be queued. Turn it on first, then try again.',
  declined:
    'The ERP did not send it and did not say why. Try once more; if it happens again someone needs to look.',
  'read-failed':
    'The queue could not be read just now, so nothing was tried. Try again in a moment.',
};

/**
 * The outcomes that mean the document is NOW ON ITS WAY.
 *
 * A list rather than `outcome === 'requeued'` at each reader, because
 * `would-requeue` is the dry run's success and is emphatically NOT one of
 * these: reading it as accepted would tell an operator a document had been
 * queued when nothing was written.
 */
export const AC_REQUEUE_ACCEPTED: readonly RequeueOutcome[] = [
  'requeued', 'requeued-as-recorded', 'requeued-with-parent',
  'sent-now',
];

/** Did this outcome put the document on its way? */
export function acRequeueAccepted(outcome: RequeueOutcome): boolean {
  return AC_REQUEUE_ACCEPTED.includes(outcome);
}

export interface RequeueResult {
  rowId: string;
  companyId: number;
  op: string;
  docType: string;
  docNo: string;
  docId: string | null;
  outcome: RequeueOutcome;
  detail: string;
  originalReason: string;
  newRowId: string | null;
}

export interface RequeueOptions {
  docNo?: string | null;
  docType?: RequeueDocType | 'ALL' | null;
  apply?: boolean;
  limit?: number;
  includeFailed?: boolean;
}

interface SkippedRow {
  id: string;
  company_id: number;
  status?: string;
  op: string;
  doc_type: string;
  doc_no: string;
  doc_id: string | null;
  last_error: string | null;
  dedupe_key?: string | null;
}

interface CapturedWrite {
  table: string;
  kind: 'insert' | 'update' | 'upsert' | 'delete';
  values: Record<string, unknown> | null;
}

/**
 * The SAME client for reads, and a recorder for writes.
 *
 * This is what makes the dry run trustworthy rather than a second opinion. The
 * alternative — predicting the composer's verdict here — would be a copy of the
 * composer's rules, and a copy that said "this will go through" while the real
 * one refused is worse than no dry run at all. So the dry run executes the REAL
 * enqueue, against the REAL document, and simply does not let it write: an
 * insert of a `pending` row means it would have queued, an insert of a `skipped`
 * row means noteReadFailure refused it and the row carries the current reason.
 *
 * APPLY then runs the same enqueue again, for real, only for the documents the
 * probe accepted. Two consequences worth stating:
 *
 *   • APPLY never lands a duplicate `skipped` row for a document that is still
 *     refused — the probe already knows, and the refusal is reported instead of
 *     being appended to the backlog a second time.
 *   • The document is read twice and could change in between. The real enqueue
 *     re-reads and re-refuses safely if it does, so the worst case is a report
 *     that is one refresh stale, not a wrong write.
 */
export function captureWrites(sb: Sb): { sb: Sb; writes: CapturedWrite[] } {
  const writes: CapturedWrite[] = [];
  const swallow = (): any => {
    const b: any = {
      eq: () => b, neq: () => b, in: () => b, is: () => b, match: () => b,
      select: () => b, order: () => b, limit: () => b,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, count: null }).then(resolve, reject),
    };
    return b;
  };
  const record = (table: string, kind: CapturedWrite['kind']) => (values?: unknown) => {
    writes.push({ table, kind, values: (values ?? null) as Record<string, unknown> | null });
    return swallow();
  };
  const from = (table: string) => {
    const real = (sb as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'insert' || prop === 'upsert' || prop === 'update') {
          return record(table, prop as CapturedWrite['kind']);
        }
        if (prop === 'delete') return record(table, 'delete');
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  return { sb: { from } as unknown as Sb, writes };
}

function outboxInsert(writes: CapturedWrite[]): Record<string, unknown> | null {
  const w = writes.find((x) => x.table === 'autocount_outbox' && x.kind === 'insert');
  return w?.values ?? null;
}

/* NO `edit` BRANCH ANY MORE. It said an edit is never re-queued here, and since
   docs/bugs/0614 it is - as a REBUILD, which is the one shape that does not need
   the unrecoverable retire list. editRebuildVerdict answers for it, so a sentence
   here would be dead text describing a rule that no longer exists. */
function reasonFor(op: string): string {
  if (op === 'cancel') {
    return 'a cancel refusal is not re-queued here: either the document was withdrawn before it ever '
      + 'reached AutoCount, in which case there is nothing to cancel there, or the ERP is holding the '
      + 'wrong AutoCount number for it and re-sending would name the wrong document in a live book.';
  }
  return 'a conversion refusal is not re-queued here: a parentless DO / GR / IV / PI can never exist '
    + 'in AutoCount at all, a merged conversion has no AutoCount shape, and a DtlKey-subset refusal '
    + 'is fixed by the line-key backfill and then re-raising the document.';
}

async function readCreateTarget(
  sb: Sb,
  row: SkippedRow,
): Promise<{ ok: true; linked: string | null; poId?: string } | { ok: false }> {
  if (row.op === 'create_so') {
    const { data, error } = await sb.from('mfg_sales_orders')
      .select('doc_no, linked_ac_docno').eq('doc_no', row.doc_no).maybeSingle();
    if (error || !data) return { ok: false };
    return { ok: true, linked: (data as { linked_ac_docno: string | null }).linked_ac_docno ?? null };
  }
  const q = row.doc_id
    ? sb.from('purchase_orders').select('id, linked_ac_docno').eq('id', row.doc_id)
    : sb.from('purchase_orders').select('id, linked_ac_docno').eq('po_number', row.doc_no);
  const { data, error } = await q.maybeSingle();
  if (error || !data) return { ok: false };
  const po = data as { id: string; linked_ac_docno: string | null };
  return { ok: true, linked: po.linked_ac_docno ?? null, poId: String(po.id) };
}

async function liveRowOtherThan(
  sb: Sb,
  row: SkippedRow,
): Promise<{ status: string } | null> {
  const { data, error } = await sb.from('autocount_outbox')
    .select('id, status')
    .eq('company_id', row.company_id)
    .eq('op', row.op)
    .eq('doc_no', row.doc_no)
    .in('status', ['pending', 'sent'])
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { status: String((data as { status?: unknown }).status ?? '') };
}

/**
 * Is a row for THIS DOCUMENT already waiting to be sent?
 *
 * The create path has asked this since it was written (`existingCreateRow`),
 * and the edit path never did. That asymmetry is what
 * `docs/bugs/0771-a-sweep-queued-twenty-one-rebuilds-of-one-document.md` is
 * about: `HC-SO-012312` carries 21 refused edits, one per save, and a sweep
 * climbed the ladder 21 times and would have queued 21 REBUILDS of one order —
 * twenty-one InternalSaves against a live licensed book, each destroying and
 * reissuing every DtlKey on it.
 *
 * A rebuild does not accumulate: it lays down the ERP's lines AS THEY ARE NOW,
 * so the first one already carries every later save's content, and the other
 * twenty are the same instruction sent again. That is why collapsing them is
 * not a shortcut — the second one has nothing left to say.
 *
 * PENDING ONLY, and never `sent`. A document that has been edited a hundred
 * times legitimately has a hundred `sent` edit rows behind it; vetoing on those
 * would refuse every document the write-back has ever succeeded on. The rung
 * this mirrors is `row-pending`, whose reasoning is already written above: a
 * pending row is going out on the next five-minute sweep, so "send it again"
 * gains nothing and can only duplicate work.
 *
 * ANY OP, not just this one. A create that is still queued means the document
 * is not in the book yet, and an edit rebuild of a document AutoCount has never
 * seen is not a thing to queue behind it.
 */
async function pendingRowForDocument(
  sb: Sb,
  row: SkippedRow,
): Promise<{ op: string } | null> {
  const { data, error } = await sb.from('autocount_outbox')
    .select('id, op')
    .eq('company_id', row.company_id)
    .eq('doc_type', row.doc_type)
    .eq('doc_no', row.doc_no)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { op: String((data as { op?: unknown }).op ?? '') };
}
async function existingCreateRow(
  sb: Sb,
  row: SkippedRow,
): Promise<{ status: string } | null> {
  const { data, error } = await sb.from('autocount_outbox')
    .select('id, status')
    .eq('company_id', row.company_id)
    .eq('op', row.op)
    .eq('doc_no', row.doc_no)
    .neq('status', 'skipped')
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as { status: string };
}

async function readRowPayload(sb: Sb, rowId: string): Promise<AcOutboxPayload | null> {
  const { data, error } = await sb.from('autocount_outbox')
    .select('payload').eq('id', rowId).maybeSingle();
  if (error || !data) return null;
  const p: unknown = (data as { payload?: unknown }).payload;
  if (!p || typeof p !== 'object') return null;
  const body: unknown = (p as { body?: unknown }).body;
  if (!body || typeof body !== 'object' || !Object.keys(body).length) return null;
  return p as AcOutboxPayload;
}

async function readTransferTarget(
  sb: Sb,
  ref: AcDocRef,
): Promise<{ ok: true; linked: string | null } | { ok: false }> {
  const { data, error } = await sb.from(ref.table)
    .select(`${ref.keyCol}, linked_ac_docno`).eq(ref.keyCol, ref.key).maybeSingle();
  if (error || !data) return { ok: false };
  return { ok: true, linked: (data as { linked_ac_docno?: string | null }).linked_ac_docno ?? null };
}

interface Verdict {
  outcome: RequeueOutcome;
  detail: string;
  newRowId?: string | null;
}

/**
 * MAY THIS EDIT BE SENT AGAIN - as a REBUILD, and only ever as one.
 *
 * THE REFUSAL THIS REPLACES WAS RIGHT ABOUT ITS FACTS AND WRONG IN ITS
 * CONCLUSION. A skipped edit's payload is `{}`, so the `retire` entries the
 * original save carried - the lines it hard-DELETED - cannot be recovered from
 * the row, and a re-composed KEYED edit would leave those lines live and
 * transferable in the account book. Every word of that is still true.
 *
 * A REBUILD DOES NOT NEED THAT LIST. It clears the document's details and lays
 * the ERP's current lines down, so the two sides finish identical - which is
 * what the retire entries were approximating in the first place, and it is the
 * owner's rule in his own words: the AutoCount lines are to match the ERP's.
 * The one thing the old refusal protected against is the one thing a rebuild
 * cannot do.
 *
 * IT IS NEVER AUTOMATIC. `docs/bugs/0613` retracted the version that rebuilt any
 * unmatchable document on save: a rebuild destroys and reissues every DtlKey,
 * and an ordinary edit must not pay that to avoid backfilling one key. This runs
 * only when an operator re-sends a document that is ALREADY held back - a
 * deliberate act on a document that is otherwise going nowhere.
 *
 * TWO REFUSALS SURVIVE AND NEITHER IS RE-IMPLEMENTED HERE. `rebuildAllowed`
 * refuses a document built by conversion and one whose keys a purchase order
 * holds (`docs/bugs/0611`, `docs/bugs/0609`); the HOST refuses a document its
 * own tables say was transferred. This function asks the question - those two
 * answer it, and a refusal comes back as `still-refused` carrying their words.
 */
async function editRebuildVerdict(
  sb: Sb,
  raw: SkippedRow,
  companyId: number,
  apply: boolean,
): Promise<Verdict> {
  const docType = String(raw.doc_type).toUpperCase();
  if (!rebuildAllowed({}, docType)) {
    return {
      outcome: 'not-recoverable',
      detail: `a ${docType} is built by conversion, and its lines are where AutoCount records what it `
        + 'was converted FROM. A rebuild clears exactly those lines, and the host cannot catch it - its '
        + 'guard reads TransferedQty, which is the ONWARD direction. Only a sales order or a purchase '
        + 'order may be re-sent this way (docs/bugs/0611).',
    };
  }

  const queued = await pendingRowForDocument(sb, raw);
  if (queued) {
    return {
      outcome: 'already-queued',
      detail: `a ${queued.op} row for this document is already queued and the five-minute sweep will `
        + "send it. A rebuild lays down the ERP's lines as they stand now, so that row already carries "
        + 'everything this one would have said.',
    };
  }

  const editOpts = {
    companyId,
    docType: docType as AcDocType,
    ...(docType === 'SO' ? { docNo: raw.doc_no } : { docId: raw.doc_id ?? raw.doc_no }),
    rebuild: true,
  };
  const probe = captureWrites(sb);
  await enqueueEdit(probe.sb, editOpts);
  const attempted = outboxInsert(probe.writes);
  if (!attempted) {
    return {
      outcome: 'declined',
      detail: 'the enqueue composed nothing and wrote no note. The commonest cause is that the document '
        + 'carries no linked_ac_docno - it never reached AutoCount, so there is nothing there to rebuild.',
    };
  }
  if ((attempted.status ?? 'pending') === 'skipped') {
    return { outcome: 'still-refused', detail: String(attempted.last_error ?? 'refused, no reason recorded') };
  }
  if (!apply) {
    return {
      outcome: 'would-requeue',
      detail: 'the composer accepts it as a REBUILD. APPLY would queue an edit that REPLACES this '
        + "document's lines in the account book with the ERP's. Every AutoCount line key on it is "
        + 'reissued, which is safe here and is why nothing does this on an ordinary save.',
    };
  }
  if (!(await enqueueEdit(sb, editOpts))) {
    return {
      outcome: 'declined',
      detail: 'the probe accepted this document and the real enqueue declined it. Either another run '
        + 'queued it first, or the document changed in between and the composer refused it - re-run '
        + 'this to see which.',
    };
  }
  const newRowId = await findQueuedRowId(sb, raw);
  await annotate(sb, raw, newRowId);
  return {
    outcome: 'requeued',
    detail: `queued as a REBUILD${newRowId ? ` (outbox ${newRowId})` : ''}. The 5-minute cron sends it, `
      + "and the account book finishes holding exactly the ERP's lines, in the ERP's order.",
    newRowId,
  };
}

const RESOLVED_TARGET: Record<string, { table: 'grns' | 'purchase_invoices' }> = {
  po_to_gr: { table: 'grns' },
  gr_to_pi: { table: 'purchase_invoices' },
};

async function parentedAfterAll(
  sb: Sb,
  raw: SkippedRow,
  apply: boolean,
): Promise<Verdict | null> {
  const spec = RESOLVED_TARGET[raw.op];
  if (!spec) return null;

  const src = await reresolveConvertSource(sb, raw.op, raw.doc_id);
  if (!src) return null;

  const { data: tgt, error } = await sb.from(spec.table)
    .select('id, linked_ac_docno').eq('id', String(raw.doc_id)).maybeSingle();
  if (error || !tgt) {
    return { outcome: 'document-gone', detail: 'the ERP document this row is about could not be read. Nothing to re-queue.' };
  }
  const linked = (tgt as { linked_ac_docno: string | null }).linked_ac_docno ?? null;
  if (linked) {
    return {
      outcome: 'already-in-autocount',
      detail: `it already carries linked_ac_docno ${linked}. Transferring it again would `
        + 'duplicate the document in the live account book.',
    };
  }

  const live = await liveRowOtherThan(sb, raw);
  if (live) {
    return {
      outcome: 'already-queued',
      detail: `a ${live.status} ${raw.op} row for this document already exists. Nothing to add.`,
    };
  }

  if (!apply) {
    return {
      outcome: 'would-requeue',
      detail: `APPLY would compose a real ${raw.op} from ${src.ids.length} source `
        + `${src.table} row(s) and queue it. The row's "no earlier document" is wrong.`,
    };
  }

  const queued = await enqueueConvert(sb, {
    companyId: Number(raw.company_id),
    op: raw.op as 'po_to_gr' | 'gr_to_pi',
    docType: raw.doc_type as 'GR' | 'PI',
    docNo: raw.doc_no,
    docId: raw.doc_id,
    from: src.ids.map((id) => ({ table: src.table, keyCol: 'id' as const, key: id })),
    to: { table: spec.table, keyCol: 'id', key: String(raw.doc_id) },
  });
  if (!queued) {
    return {
      outcome: 'declined',
      detail: 'the conversion composed but the queue refused the row. Either another run queued this '
        + 'document first, or the write-back switch went off in between.',
    };
  }
  const newRowId = await findQueuedRowId(sb, raw);
  await annotate(sb, raw, newRowId);
  return {
    outcome: 'requeued-with-parent',
    detail: `composed a real ${raw.op} from ${src.ids.length} source ${src.table} row(s) and queued it`
      + `${newRowId ? ` (outbox ${newRowId})` : ''}. The recorded "no earlier document" was wrong.`,
    newRowId,
  };
}

async function transferVerdict(
  sb: Sb,
  raw: SkippedRow,
  status: string,
  apply: boolean,
): Promise<Verdict> {
  if (status !== 'failed') {
    /* THE ROW SAID PARENTLESS. ASK THE DOCUMENT. Owner 2026-08-24: 「我的 GR PO
       所有文件都要有 Send Now 的 button」. Eight production receipts and supplier
       invoices carry "there is no earlier document to carry across" and their
       lines name a purchase order anyway — the create path did not look
       (docs/bugs/0524). Replaying that answer is replaying a false statement, so
       the parent is resolved afresh from the child's own lines. Only when the
       document really has none does the old refusal stand. */
    const revived = await parentedAfterAll(sb, raw, apply);
    if (revived) return revived;
    return { outcome: 'not-recoverable', detail: reasonFor(raw.op) };
  }

  const payload = await readRowPayload(sb, String(raw.id));
  if (!payload) {
    return {
      outcome: 'not-recoverable',
      detail: 'this row records no composed document. A transfer is re-sent by queueing the '
        + 'instruction the ERP already built, and there is nothing stored here to send.',
    };
  }
  if (!payload.writeback) {
    return {
      outcome: 'not-recoverable',
      detail: 'this row names no ERP document to write the AutoCount number back onto, so a re-send '
        + 'could not be checked against the account book and could not be recorded if it landed.',
    };
  }

  const target = await readTransferTarget(sb, payload.writeback);
  if (!target.ok) {
    return {
      outcome: 'document-gone',
      detail: 'the ERP document this row is about could not be read. Nothing to re-queue.',
    };
  }
  if (target.linked) {
    return {
      outcome: 'already-in-autocount',
      detail: `it already carries linked_ac_docno ${target.linked}. Transferring it again would `
        + 'duplicate the document in the live account book.',
    };
  }

  const live = await liveRowOtherThan(sb, raw);
  if (live) {
    return {
      outcome: 'already-queued',
      detail: `a ${live.status} ${raw.op} row for this document already exists. Nothing to add.`,
    };
  }

  if (!apply) {
    return {
      outcome: 'would-requeue',
      detail: `APPLY would queue the recorded ${raw.op} instruction again, unchanged.`,
    };
  }

  const queued = await enqueueAcOp(sb, {
    companyId: Number(raw.company_id),
    op: raw.op as AcOp,
    docType: raw.doc_type as AcDocType,
    docNo: raw.doc_no,
    docId: raw.doc_id,
    payload,
    dedupeKey: raw.dedupe_key ?? null,
  });
  if (!queued) {
    return {
      outcome: 'declined',
      detail: 'the queue refused the new row. Either another run queued this document first (the '
        + 'pending-dedupe index refuses the second) or the write-back switch went off in between — '
        + 're-run this to see which.',
    };
  }
  const newRowId = await findQueuedRowId(sb, raw);
  await annotate(sb, raw, newRowId);
  return {
    outcome: 'requeued-as-recorded',
    detail: `queued the recorded ${raw.op} instruction again${newRowId ? ` (outbox ${newRowId})` : ''}. `
      + 'The 5-minute cron sends it.',
    newRowId,
  };
}

/**
 * THE REFUSAL LADDER, for ONE row. Every re-send in this system climbs it.
 *
 * Extracted from requeueSkipped's loop when the ERP grew a per-row "Send again"
 * button. It was a copy-or-share decision and the copy was never really
 * available: two ladders are two answers to "may this document be sent again",
 * and the day they disagree the looser one writes a SECOND copy of a document
 * into a licensed account book, where a sales order cannot simply be deleted.
 * So the batch tool and the button take exactly these rungs, in this order.
 *
 * `resendingThisRow` is REQUIRED rather than defaulted, because it decides
 * something: it says the row in hand IS the attempt being re-sent, so the
 * "is there already a live row for this document" probe must not veto on the
 * row it was asked to re-send. Defaulting it either way silently makes one of
 * the two callers wrong (CLAUDE.md, BUG CLASS optional-param-noop).
 *
 * EXPORTED ONLY SO A TEST CAN POINT AT THE LADDER ITSELF. Neither entry point
 * can hand it a `sent` row — requeueOutboxRow refuses one first and
 * requeueSkipped's select cannot return one — so the rung that refuses a `sent`
 * row here is unreachable through them, and an unreachable guard with no test is
 * a guard nobody knows is still there. Route code must call requeueOutboxRow;
 * this is not a third entry point.
 */
export async function requeueOneRow(
  sb: Sb,
  raw: SkippedRow,
  opts: { apply: boolean; resendingThisRow: boolean },
): Promise<RequeueResult> {
  const companyId = Number(raw.company_id);
  const base = {
    rowId: String(raw.id),
    companyId,
    op: String(raw.op),
    docType: String(raw.doc_type),
    docNo: String(raw.doc_no),
    docId: raw.doc_id == null ? null : String(raw.doc_id),
    originalReason: raw.last_error ?? '',
    newRowId: null as string | null,
  };
  const say = (outcome: RequeueOutcome, detail: string): RequeueResult => ({ ...base, outcome, detail });

  const status = String(raw.status ?? '');
  const isTransfer = (AC_TRANSFER_OPS as readonly string[]).includes(raw.op);

  if (status === 'sent') {
    return say('already-sent', 'AutoCount accepted this document and recorded it in the account book. '
      + 'Sending it again would create a SECOND copy: the AutoCount create has no duplicate guard on '
      + 'the ERP document number, and an accepted document cannot simply be deleted there.');
  }

  if (raw.op !== 'create_so' && raw.op !== 'create_po' && raw.op !== 'edit' && !isTransfer) {
    return say('not-recoverable', reasonFor(raw.op));
  }
  if ((raw.last_error ?? '').startsWith(REQUEUE_NOTE_PREFIX)) {
    return say('already-requeued', 'an earlier run of this tool already re-queued this skip; the row is '
      + 'history now, not backlog.');
  }
  if (!(await isWritebackEnabled(sb, companyId))) {
    return say('switch-off', `scm.autocount_writeback is off for company ${companyId}, so an enqueue `
      + 'would return early and write nothing. Turn it on (AutoCount write-back (on/off) workflow) '
      + 'and run this again.');
  }

  if (isTransfer) {
    const v = await transferVerdict(sb, raw, status, opts.apply);
    return { ...base, outcome: v.outcome, detail: v.detail, newRowId: v.newRowId ?? null };
  }

  if (raw.op === 'edit') {
    const v = await editRebuildVerdict(sb, raw, companyId, opts.apply);
    return { ...base, outcome: v.outcome, detail: v.detail, newRowId: v.newRowId ?? null };
  }

  const target = await readCreateTarget(sb, raw);
  if (!target.ok) {
    return say('document-gone', 'the ERP document this row is about could not be read. Nothing to re-queue.');
  }
  if (target.linked) {
    return say('already-in-autocount', `it already carries linked_ac_docno ${target.linked}. Creating it `
      + 'again would duplicate the document in the live account book.');
  }
  const existing = opts.resendingThisRow
    ? await liveRowOtherThan(sb, raw)
    : await existingCreateRow(sb, raw);
  if (existing) {
    return say('already-queued', `a ${existing.status} ${raw.op} row for this document already exists. `
      + (existing.status === 'failed'
        ? 'A failed create was sent and refused by AutoCount — a different problem from a refusal '
          + 'that never left the ERP, and not this tool\'s call to re-send.'
        : 'Nothing to add.'));
  }

  const probe = captureWrites(sb);
  const enqueue = (client: Sb) => (raw.op === 'create_so'
    ? enqueueSoCreate(client, { companyId, docNo: raw.doc_no })
    : enqueuePoCreate(client, { companyId, poId: target.poId ?? String(raw.doc_id ?? '') }));
  await enqueue(probe.sb);
  const attempted = outboxInsert(probe.writes);
  if (!attempted) {
    return say('declined', 'the enqueue returned without composing anything and without writing a note. '
      + 'Nothing was queued and nothing is wrong with the document that this can name.');
  }
  if ((attempted.status ?? 'pending') === 'skipped') {
    return say('still-refused', String(attempted.last_error ?? 'refused, no reason recorded'));
  }
  if (!opts.apply) {
    return say('would-requeue', 'the composer accepts it now. APPLY would queue a '
      + `${raw.op} row and annotate this skip.`);
  }

  const { queued } = await enqueue(sb);
  if (!queued) {
    return say('declined', 'the probe accepted this document and the real enqueue declined it. Either '
      + 'another run queued it first (the pending-dedupe index refuses the second), or the document '
      + 'changed in between and the composer refused it — re-run this to see which.');
  }
  const newRowId = await findQueuedRowId(sb, raw);
  await annotate(sb, raw, newRowId);
  return {
    ...say('requeued', `queued as a fresh ${raw.op}${newRowId ? ` (outbox ${newRowId})` : ''}. `
      + 'The 5-minute cron sends it.'),
    newRowId,
  };
}

/**
 * Re-attempt the refusals whose cause may have been fixed — the skipped CREATES,
 * and, behind `includeFailed`, the ones AutoCount itself refused.
 *
 * Read-only unless `apply` is true. Never throws for a document-level problem —
 * every document gets an outcome, because "the tool crashed on row 3" tells an
 * operator nothing about rows 4 to 12.
 */
export async function requeueSkipped(sb: Sb, opts: RequeueOptions = {}): Promise<RequeueResult[]> {
  const apply = opts.apply === true;
  const includeFailed = opts.includeFailed === true;
  let q = sb.from('autocount_outbox')
    .select(REQUEUE_ROW_COLS)
    .in('status', includeFailed ? ['skipped', 'failed'] : ['skipped'])
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 200);
  if (opts.docNo) q = q.eq('doc_no', opts.docNo);
  else if (opts.docType && opts.docType !== 'ALL') q = q.eq('doc_type', opts.docType);
  const { data, error } = await q;
  if (error) throw new Error(`could not read the outbox: ${error.code ?? ''} ${error.message ?? ''}`.trim());

  const onTheirWay = new Set<string>();
  const docKey = (r: SkippedRow) => `${String(r.doc_type)}:${String(r.doc_no)}`;

  const results: RequeueResult[] = [];
  for (const raw of (data ?? []) as SkippedRow[]) {
    if (onTheirWay.has(docKey(raw))) {
      results.push({
        rowId: String(raw.id),
        companyId: Number(raw.company_id),
        op: String(raw.op),
        docType: String(raw.doc_type),
        docNo: String(raw.doc_no),
        docId: raw.doc_id == null ? null : String(raw.doc_id),
        outcome: 'already-queued',
        detail: 'an earlier row in this same run already put this document back on its way. Re-sending '
          + 'it again would repeat one instruction, not carry a second one.',
        originalReason: raw.last_error ?? '',
        newRowId: null,
      });
      continue;
    }
    const result = await requeueOneRow(sb, raw, {
      apply,
      resendingThisRow: includeFailed && raw.status === 'failed',
    });
    if (REQUEUE_PUTS_IT_ON_ITS_WAY.has(result.outcome)) onTheirWay.add(docKey(raw));
    results.push(result);
  }
  return results;
}

const REQUEUE_ROW_COLS =
  'id, company_id, op, doc_type, doc_no, doc_id, status, last_error, dedupe_key';

export interface RequeueRowOptions {
  rowId: string;
  companyId: number;
}

/**
 * SEND ONE OUTBOX ROW AGAIN — the action behind the page's per-row button.
 *
 * Everything the batch tool refuses, this refuses, by climbing the same ladder.
 * What it adds is the three answers only a by-id call can produce, and the
 * first of them is the reason this function reads the row itself instead of
 * being handed one:
 *
 *   already-sent    THE ONE THAT MATTERS. `sent` means AutoCount accepted the
 *                   document and it is IN THE ACCOUNT BOOK. The C# create has
 *                   no guard against a duplicate ERP document number, so a
 *                   second send writes a SECOND document into a live licensed
 *                   book — and an accepted sales order cannot simply be
 *                   deleted there. Refused outright, before anything is read
 *                   or composed.
 *   row-pending     REFUSED, and deliberately, though nothing would be
 *                   corrupted by allowing it. A pending row is already going to
 *                   be sent by the next five-minute sweep, so "send again"
 *                   would either be a no-op (0277's pending-dedupe index
 *                   refuses the second insert) or, if the dedupe key differed,
 *                   would put a second create for the same document in the
 *                   queue — which is the duplicate above with a five-minute
 *                   delay. Nothing is gained and one outcome is catastrophic,
 *                   so the answer is no with a sentence saying it is already
 *                   on its way.
 *   row-not-found   No such row IN THIS COMPANY. Says the same thing whether
 *                   the id is unknown or belongs to the other company's books:
 *                   confirming that somebody else's id exists is itself a leak
 *                   (companyScope.ts's NOT_THIS_COMPANY says the same).
 *
 * ALWAYS APPLIES. There is no dry run on this path — a button that rehearses is
 * a button that lies about what it did. The dry run belongs to the workflow,
 * where an operator is choosing to examine a backlog.
 *
 * NEVER THROWS. A read failure is `read-failed`, an outcome like any other,
 * because the caller is a route that must answer a person and a raw exception
 * string is not an answer anyone can act on.
 */
export async function requeueOutboxRow(sb: Sb, opts: RequeueRowOptions): Promise<RequeueResult> {
  const missing = (outcome: RequeueOutcome, detail: string): RequeueResult => ({
    rowId: opts.rowId,
    companyId: opts.companyId,
    op: '',
    docType: '',
    docNo: '',
    docId: null,
    outcome,
    detail,
    originalReason: '',
    newRowId: null,
  });

  let raw: SkippedRow;
  try {
    const { data, error } = await sb.from('autocount_outbox')
      .select(REQUEUE_ROW_COLS)
      .eq('id', opts.rowId)
      .eq('company_id', opts.companyId)
      .maybeSingle();
    if (error) {
      return missing('read-failed', `the outbox row could not be read: ${error.message}`);
    }
    if (!data) {
      return missing('row-not-found', 'no outbox row with that id in this company.');
    }
    raw = data as unknown as SkippedRow;
  } catch (e) {
    return missing('read-failed', e instanceof Error ? e.message : String(e));
  }

  const status = String(raw.status ?? '');
  const base = {
    rowId: String(raw.id),
    companyId: Number(raw.company_id),
    op: String(raw.op),
    docType: String(raw.doc_type),
    docNo: String(raw.doc_no),
    docId: raw.doc_id == null ? null : String(raw.doc_id),
    originalReason: raw.last_error ?? '',
    newRowId: null as string | null,
  };
  if (status === 'sent') {
    return {
      ...base,
      outcome: 'already-sent',
      detail: 'AutoCount accepted this document and recorded it in the account book. Sending it '
        + 'again would create a SECOND copy: the AutoCount create has no duplicate guard on the '
        + 'ERP document number, and an accepted document cannot simply be deleted there.',
    };
  }
  if (status === 'pending') {
    return {
      ...base,
      outcome: 'row-pending',
      detail: 'this row is already queued and the next 5-minute sweep will send it. Re-sending it '
        + 'could only add a second create for the same document.',
    };
  }
  return requeueOneRow(sb, raw, { apply: true, resendingThisRow: status === 'failed' });
}

/**
 * SEND ONE WAITING ROW NOW, instead of waiting for the five-minute sweep.
 *
 * THE OWNER'S REQUEST, and why it is not just a wider `can_requeue`. He asked
 * for the automatic sync to keep working and for a manual push beside it
 * (「自动的 可是我要可以manual push」). Today a WAITING row has no button at
 * all: `acRowIsRequeueable` refuses `pending` structurally and
 * `requeueOutboxRow` answers `row-pending`, both correctly — a RE-QUEUE inserts
 * a second row for the same document, and for a row that is already going out
 * that is either a no-op or a duplicate create. None of that reasoning applies
 * to dispatching the row that is already there, which is what this does.
 *
 * IT IS THE SAME MECHANISM, NOT A SECOND ONE. It calls `dispatchOne` — the same
 * function the cron calls, with the same payload, the same master handling, the
 * same write-back and the same attempt accounting. Nothing here composes a
 * payload, opens a socket to the host, or writes a row the drain would not have
 * written. What is manual is the TIMING and nothing else.
 *
 * IT COSTS AN ATTEMPT, AND IT MUST. `dispatchOne` increments `attempts` and
 * this path does not put it back. An attempt is a real call into a licensed
 * account book, and `attempts` is read by the page, by the health check and by
 * the dead-lettering rule as "how many times we asked AutoCount"; a manual call
 * that did not count would make every one of those readings false, on a table
 * whose own COMMENT calls it the audit trail of what the ERP told AutoCount.
 * The cost is not hidden either — the row already prints "Tried 3 times, will
 * keep trying up to 6" (acRowStatusLine) before the button is pressed, so the
 * budget is on screen next to the thing that spends it.
 *
 * WHAT STOPS IT SENDING TWICE. `claimOutboxRow`, and it is the reason migration
 * 0315 exists. Before this button the sweep was the ONLY dispatcher and could
 * not race itself; nothing in the table ever marked a row in-flight. Two
 * operators pressing, or one pressing inside a sweep, would otherwise put the
 * same document into the account book twice. The claim is a single conditional
 * UPDATE, so the loser of the race sees it and stops — and it fails CLOSED:
 * every "I could not take it" answer means do not send.
 *
 * NEVER THROWS, for the same reason `requeueOutboxRow` does not: the caller is
 * a route answering a person, and an exception string is not an answer.
 */
export async function sendOutboxRowNow(
  env: Env,
  sb: Sb,
  opts: RequeueRowOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<RequeueResult> {
  const missing = (outcome: RequeueOutcome, detail: string): RequeueResult => ({
    rowId: opts.rowId,
    companyId: opts.companyId,
    op: '',
    docType: '',
    docNo: '',
    docId: null,
    outcome,
    detail,
    originalReason: '',
    newRowId: null,
  });

  let raw: AcOutboxRow & { last_error?: string | null };
  try {
    const { data, error } = await sb.from('autocount_outbox')
      .select('id, company_id, op, doc_type, doc_no, doc_id, payload, status, attempts, dedupe_key, last_error')
      .eq('id', opts.rowId)
      .eq('company_id', opts.companyId)
      .maybeSingle();
    if (error) return missing('read-failed', `the outbox row could not be read: ${error.message}`);
    if (!data) return missing('row-not-found', 'no outbox row with that id in this company.');
    raw = data as unknown as AcOutboxRow & { last_error?: string | null };
  } catch (e) {
    return missing('read-failed', e instanceof Error ? e.message : String(e));
  }

  const base = {
    rowId: String(raw.id),
    companyId: Number(raw.company_id),
    op: String(raw.op),
    docType: String(raw.doc_type),
    docNo: String(raw.doc_no),
    docId: raw.doc_id == null ? null : String(raw.doc_id),
    originalReason: raw.last_error ?? '',
    newRowId: null as string | null,
  };
  const status = String(raw.status ?? '');
  const attempts = Number(raw.attempts ?? 0);

  if (status !== 'pending') {
    return {
      ...base,
      outcome: 'not-waiting',
      detail: `this row is ${status}, and only a pending row is waiting to go out. `
        + 'Send again is the action for a refused or held-back document; it re-composes '
        + 'the document and starts a fresh set of attempts, which this deliberately does not.',
    };
  }

  if (attempts >= MAX_ATTEMPTS) {
    return {
      ...base,
      outcome: 'attempts-spent',
      detail: `this row has used all ${MAX_ATTEMPTS} attempts and is not selected by the sweep any more.`,
    };
  }

  if (!(await isWritebackEnabled(sb, base.companyId))) {
    return { ...base, outcome: 'switch-off', detail: 'scm.autocount_writeback is off for this company.' };
  }

  if (!(await claimOutboxRow(sb, base.rowId))) {
    return {
      ...base,
      outcome: 'already-in-flight',
      detail: 'the row is claimed by another dispatcher — the five-minute sweep, or another '
        + 'operator pressing this at the same moment. Nothing was sent from here, which is the '
        + 'point: two dispatches of one row are two documents in the account book.',
    };
  }

  let outcome: Awaited<ReturnType<typeof dispatchOne>>;
  try {
    outcome = await dispatchOne(env, sb, raw as AcOutboxRow, fetchImpl);
  } catch (e) {
    return {
      ...base,
      outcome: 'send-now-retrying',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  let said = '';
  try {
    const { data, error } = await sb.from('autocount_outbox')
      .select('last_error').eq('id', base.rowId).eq('company_id', base.companyId).maybeSingle();
    if (error) said = `the row was updated but its reason could not be read back: ${error.message}`;
    else said = String((data as { last_error?: string | null } | null)?.last_error ?? '');
  } catch (e) {
    said = `the row was updated but its reason could not be read back: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (outcome === 'sent') return { ...base, outcome: 'sent-now', detail: '' };
  if (outcome === 'waiting') return { ...base, outcome: 'send-now-waiting', detail: said };
  if (outcome === 'failed') return { ...base, outcome: 'send-now-refused', detail: said };
  return { ...base, outcome: 'send-now-retrying', detail: said };
}

async function findQueuedRowId(sb: Sb, row: SkippedRow): Promise<string | null> {
  try {
    const { data, error } = await sb.from('autocount_outbox')
      .select('id')
      .eq('company_id', row.company_id)
      .eq('op', row.op)
      .eq('doc_no', row.doc_no)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return String((data as { id: string }).id);
  } catch {
    return null;
  }
}

async function annotate(sb: Sb, row: SkippedRow, newRowId: string | null): Promise<void> {
  const at = new Date().toISOString();
  const note = `${REQUEUE_NOTE_PREFIX} ${at}${newRowId ? ` -> outbox ${newRowId}` : ''}] `;
  await sb.from('autocount_outbox')
    .update({ last_error: `${note}${row.last_error ?? ''}`, updated_at: at })
    .eq('id', row.id);
}
