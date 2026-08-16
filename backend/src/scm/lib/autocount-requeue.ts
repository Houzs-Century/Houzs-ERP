// ----------------------------------------------------------------------------
// autocount-requeue — re-attempt a document the write-back REFUSED, once the
// reason for the refusal has been fixed.
//
// THE GAP THIS CLOSES. A document the composer declines to send is written as a
// `skipped` outbox row carrying the reason (noteReadFailure, autocount-outbox.ts).
// That row is TERMINAL, and fixing its cause does not bring the document back:
//
//   • enqueueSoCreate / enqueuePoCreate are called from exactly two places each
//     — the create, and the DRAFT -> live transition. An ordinary edit is
//     neither, so re-saving the order does not re-attempt the create.
//   • enqueueEdit bails on `if (!composed.linkedAcDocNo) return false;` — a
//     document that never reached AutoCount has no counterpart to edit, so
//     editing it silently does nothing.
//
// Measured on production 2026-08-13: HC-SO-2608-001 (ItemCodeError) and
// HC-SO-2608-002 (MissingLocationError) had been sitting `skipped` since their
// save, with the queue holding no other rows at all. The second one's cause was
// already fixed — the order now carries a sales_location — and it still was not
// going anywhere. Nothing in the ERP could re-ask the question.
//
// WHAT THIS IS NOT: a second composer. It does not read the old payload and it
// does not build a new one. It calls the SAME enqueueSoCreate / enqueuePoCreate
// the route calls, against the document AS IT IS NOW, and reports what they
// answered. If the composer has learned a new refusal since, this tool learns it
// on the same day, because there is only one of them.
//
// SCOPE — creates only, and the reason is not laziness:
//
//   create_so / create_po  RECOVERABLE HERE, and nowhere else. No route path
//                          re-attempts a create for a document that already
//                          exists, so without this the row is a dead end.
//   edit                   NOT here. The document IS in AutoCount (an edit is
//                          only composed when linked_ac_docno is set), so the
//                          documented remedy — fix the cause, save the document
//                          again — genuinely re-queues it. Re-queueing it from
//                          here would be strictly WORSE: the original edit may
//                          have carried `retire` entries for lines the save
//                          hard-deleted (§7a), that list is not recoverable from
//                          a skipped row whose payload is `{}`, and an edit
//                          missing them leaves those lines live and transferable
//                          in the account book.
//   transfers              SPLIT BY WHO REFUSED, since 2026-08-16. See below.
//
// Those rows are still REPORTED, with why they are not re-queueable, because a
// tool that silently ignores two thirds of the backlog teaches the operator the
// backlog is smaller than it is.
//
// WHO REFUSED IT — the one question that decides a transfer (2026-08-16)
// ---------------------------------------------------------------------
// A transfer op (so_to_do, po_to_gr, do_to_iv, gr_to_pi, so_to_po) used to be
// refused here unconditionally, on this reasoning: a parentless DO/GR/IV/PI can
// never exist in AutoCount at all, a merged conversion has no AutoCount shape,
// and a DtlKey-subset refusal is fixed by the line-key backfill and then
// re-raising the document.
//
// All three of those are true and all three are still refused. What the blanket
// rule missed is that they are the same KIND of refusal as each other and a
// different kind from the one that actually filled the queue: they are
// properties of the DOCUMENT, and a document does not change because somebody
// rebuilt a Windows box. A refusal by the SERVICE does — it stops being true the
// moment the service is replaced, and rebuilding the shop-floor host is routine
// here. Under the blanket rule every host fix needed hand-surgery on the outbox.
//
// THE DISCRIMINATOR IS RECORDED, not asserted. It is the row's own `status`,
// corroborated by its own `payload`, and the two are independent by
// construction:
//
//   skipped + payload {body:{}}   ALL THREE unrecoverable shapes, and nothing
//                                 else. Every one of them is written by
//                                 recordConvertSkipped (directly for a merged
//                                 conversion, through recordParentlessCreate for
//                                 a parentless one, and from
//                                 readConvertSourceKeys's `refuse` for the
//                                 DtlKey subset), which hard-codes
//                                 `status: 'skipped'` and `payload: {body: {}}`.
//                                 The row never reached the drain, so the
//                                 service has never seen this document and
//                                 cannot be what refused it. REFUSED.
//   failed  + a composed payload  Only dispatchOne writes `failed`, and it is
//                                 reached only from a `pending` row, which for a
//                                 transfer op is only ever written by
//                                 enqueueConvert's success path. So the ERP
//                                 composed it, the queue sent it, and the
//                                 SERVICE answered. RE-SENDABLE.
//
// Both conditions are required, and requiring both is what makes this safe
// against a path nobody has written yet: a `failed` row with an empty payload
// has nothing to send, and a `skipped` row with a real payload was still never
// dispatched. Nothing here is a human ticking a box to say "trust me".
//
// AND IT RE-SENDS THE RECORDED PAYLOAD, which is why no route logic is copied
// in here. 0277's own header: the payload is a SNAPSHOT of what the user's save
// produced, never recomposed at drain. A transfer's snapshot is the complete
// instruction — DocNo, DtlKeys, fromDoc, writeback, lineWriteback — so sending
// it again is a RETRY, in the plainest sense, and enqueueConvert's call-site
// arguments never have to be rebuilt. That is also the reason an empty payload
// is a second, independent refusal rather than a detail: with `{body:{}}` there
// is literally nothing to retry.
//
// WHAT THIS DOES NOT CLAIM. `failed` means the service ANSWERED; it does not
// prove the account book was left untouched. If a document landed and only the
// reply was lost, a re-send writes a second one — the identical residual risk
// the create path already carries and documents (see includeFailed below, and
// docs/autocount-sync-reasons.md §3). The message is the diagnosis: a refusal
// naming a shape AutoCount would not accept wrote nothing, an ambiguous
// transport failure might have. When it is ambiguous, look in the book first.
//
// TWO CALLERS, ONE LADDER. requeueSkipped is the workflow's batch sweep;
// requeueOutboxRow is the AutoCount Sync page's per-row button. Both go through
// requeueOneRow, which is the single implementation of "may this document be
// sent again". The button adds three answers a by-id call can produce and a
// backlog sweep cannot — already-sent, row-pending, row-not-found — and the
// first of those is the only guard between a button press and a duplicate
// document in a live licensed account book.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AcDocType, AcOp } from '../../services/autocount-writeback';
import {
  enqueueAcOp, enqueuePoCreate, enqueueSoCreate,
  type AcDocRef, type AcOutboxPayload,
} from './autocount-outbox';
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
  /** DRY RUN: the composer accepted it. APPLY would queue it. */
  | 'would-requeue'
  /** APPLY: a pending row was written and the old skip was annotated. */
  | 'requeued'
  /**
   * APPLY, on a TRANSFER: the recorded instruction was queued again as it was.
   *
   * A separate code from `requeued` because it is a different promise about what
   * will reach the account book. `requeued` re-COMPOSES from the ERP document as
   * it stands now, so a correction made since the refusal is in it. A transfer
   * has no create to compose — the payload IS the instruction — so this re-sends
   * the snapshot, and a change made to the document since is NOT in it. An
   * operator who has just edited the document is entitled to know which of those
   * two happened.
   */
  | 'requeued-as-recorded'
  /** The composer refuses it again. `detail` is the reason AS IT STANDS NOW. */
  | 'still-refused'
  /** A skip this tool deliberately does not re-attempt (edit, conversion). */
  | 'not-recoverable'
  /** linked_ac_docno is set: the document is already in the account book. */
  | 'already-in-autocount'
  /** A non-skipped outbox row for the same create already exists. */
  | 'already-queued'
  /** This exact skip was already re-queued by an earlier run. */
  | 'already-requeued'
  /** The ERP document behind the row is gone. */
  | 'document-gone'
  /** scm.autocount_writeback is off for this company, so nothing can queue. */
  | 'switch-off'
  /** The enqueue declined for a reason it did not write down. */
  | 'declined'
  /**
   * THIS row is `sent`: AutoCount accepted the document and it is in the
   * account book. The hardest refusal in this file — see requeueOutboxRow.
   */
  | 'already-sent'
  /** THIS row is `pending`: the drain is already going to send it. */
  | 'row-pending'
  /** No outbox row with that id in the caller's company. */
  | 'row-not-found'
  /** The queue itself could not be read, so no verdict was reached. */
  | 'read-failed';

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
  'already-queued':
    'There is already a live attempt for this document. Nothing to add.',
  'already-requeued':
    'This was already sent back to the queue once. It is a record of what happened, not something still waiting.',
  'already-sent':
    'AutoCount already accepted this one. Sending it again would put a SECOND copy of the document in the account book, and an accepted document cannot simply be deleted there.',
  'row-pending':
    'This is already waiting in the queue. The next five-minute sweep will send it.',
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
export const AC_REQUEUE_ACCEPTED: readonly RequeueOutcome[] = ['requeued', 'requeued-as-recorded'];

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
  /** Why this outcome, in the operator's vocabulary. */
  detail: string;
  /** What the ORIGINAL skip said, so the report shows the cause being fixed. */
  originalReason: string;
  /**
   * The `pending` row this re-queue created, when it created one.
   *
   * Non-optional so every path through the ladder has to state it. The button
   * reports it back so an operator can find the live attempt on the same page,
   * and `annotate` writes it into the old row's note for the same reason.
   */
  newRowId: string | null;
}

export interface RequeueOptions {
  /** One document, by its ERP number. Overrides docType. */
  docNo?: string | null;
  /** Every skipped row of this type, or all of them. */
  docType?: RequeueDocType | 'ALL' | null;
  /** Nothing is written unless this is true. */
  apply?: boolean;
  /** Cap on rows examined, so a pathological backlog cannot run forever. */
  limit?: number;
  /**
   * ALSO re-send documents that FAILED, not only ones the ERP refused.
   *
   * Off by design, and the default must stay off. A `skipped` row never left
   * the ERP, so re-composing it is free. A `failed` row WAS sent and AutoCount
   * refused it — and "refused" is not the same as "changed nothing". The C#
   * create has no guard against a duplicate ERP document number, so if a
   * document landed and only the reply was lost, re-sending writes a SECOND one
   * into a licensed account book, where a sales order cannot simply be deleted.
   *
   * Turn it on only when the failure is known to have changed nothing on the
   * AutoCount side. A foreign key is the clear case: it rejects before the
   * insert, so nothing was written — that is what `FK_SO_SalesAgent` did to
   * HC-SO-2608-001 and -002 on 2026-08-13, six attempts each, and the whole
   * reason this option exists. An ambiguous 500 carrying AutoCount's own words
   * is NOT that case; look in the book first.
   */
  includeFailed?: boolean;
}

interface SkippedRow {
  id: string;
  company_id: number;
  /** 'skipped', or 'failed' when includeFailed asked for those too. */
  status?: string;
  op: string;
  doc_type: string;
  doc_no: string;
  doc_id: string | null;
  last_error: string | null;
  /** The intent key 0277's pending-dedupe index is unique on. Re-used verbatim
   *  by a transfer re-send rather than rebuilt — see transferVerdict. */
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

/** The outbox insert a probe produced, if it produced one. */
function outboxInsert(writes: CapturedWrite[]): Record<string, unknown> | null {
  const w = writes.find((x) => x.table === 'autocount_outbox' && x.kind === 'insert');
  return w?.values ?? null;
}

function reasonFor(op: string): string {
  if (op === 'edit') {
    return 'an edit refusal is not re-queued here: the document IS in AutoCount, so fixing the cause '
      + 'and saving the document again really does re-queue it. Re-composing it from a script would '
      + 'also drop any line RETIREMENTS the original save carried, which a skipped row does not record.';
  }
  if (op === 'cancel') {
    return 'a cancel refusal is not re-queued here: either the document was withdrawn before it ever '
      + 'reached AutoCount, in which case there is nothing to cancel there, or the ERP is holding the '
      + 'wrong AutoCount number for it and re-sending would name the wrong document in a live book.';
  }
  /* THE THREE SHAPES, unchanged and still refused. What is new is only that this
     sentence is now reached for a SKIPPED transfer and not for a failed one:
     each of these is a property of the DOCUMENT, and none of them stops being
     true because the shop-floor service was replaced. */
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
  /* A PO is addressed by id everywhere in its router, and that is what the
     skipped row carries. Older rows written before docId was passed fall back to
     the human number, which is unique per company. */
  const q = row.doc_id
    ? sb.from('purchase_orders').select('id, linked_ac_docno').eq('id', row.doc_id)
    : sb.from('purchase_orders').select('id, linked_ac_docno').eq('po_number', row.doc_no);
  const { data, error } = await q.maybeSingle();
  if (error || !data) return { ok: false };
  const po = data as { id: string; linked_ac_docno: string | null };
  return { ok: true, linked: po.linked_ac_docno ?? null, poId: String(po.id) };
}

/**
 * A row for this document and this OPERATION that is NOT the one we are
 * re-sending, and is not another dead one. Only `pending` and `sent` can make a
 * re-send wrong: pending means the drain is already going to do it, sent means
 * it is in the book. Another `failed` row is just more history.
 *
 * Named for the operation rather than for the create since 2026-08-16: a
 * transfer re-send climbs the same rung, and `op` is already in the predicate.
 */
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

/**
 * The COMPOSED instruction a row is carrying, or null when it is not carrying
 * one. Read only when the row is about to be re-sent.
 *
 * Fetched by id here rather than added to REQUEUE_ROW_COLS on purpose: a payload
 * is a whole document snapshot, and the batch sweep selects up to 200 rows. The
 * route's list select excludes it for the same reason (autocount-outbox.ts).
 *
 * `payload` is jsonb and its static type is a promise the database does not
 * keep, so every shape check here is a real one — `unknown` rather than the cast
 * for exactly that reason. Two things legitimately arrive: enqueueConvert's
 * composed body, and recordConvertSkipped's `{}`. Only the first is an
 * instruction, so an empty body answers null and the caller has one question to
 * ask instead of four.
 *
 * A row that cannot be RE-READ folds into the same null, and that is the safe
 * direction: the caller read this row by id a moment ago, so a failure now is a
 * transient fault, and "do not send" is the right answer to a transient fault
 * either way.
 */
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

/**
 * The ERP document a transfer would write its AutoCount number back onto.
 *
 * Read through the payload's OWN `writeback` reference — the same table, key
 * column and key the drain uses to record `linked_ac_docno` on success. Deriving
 * the target any other way would be a second opinion about which row a re-send
 * lands on, and the two only have to disagree once.
 */
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
 * MAY THIS TRANSFER BE SENT AGAIN — the rungs a conversion takes, and the ones
 * it does not share with a create.
 *
 * The whole argument is in this module's header. In one line: a transfer is
 * re-sendable exactly when the QUEUE DISPATCHED IT AND THE SERVICE REFUSED, and
 * the two recorded facts that say so — `status = 'failed'` and a composed
 * payload — must BOTH hold. Neither is a human asserting anything; both are
 * written by the code paths named below and by nothing else.
 *
 * There is no probe here and no dry-run recorder, because there is nothing to
 * compose: the payload is the instruction. `captureWrites` exists to make the
 * create path's dry run execute the real composer rather than predict it, and a
 * predicate that reads three columns has nothing to predict.
 */
async function transferVerdict(
  sb: Sb,
  raw: SkippedRow,
  status: string,
  apply: boolean,
): Promise<Verdict> {
  /* FACT ONE. Only dispatchOne writes `failed`, and only a `pending` row reaches
     it — which for a transfer op is only ever enqueueConvert's success path. So
     `failed` means the service answered, and anything else means it never saw
     the document. All three unrecoverable shapes land the other side of this
     line, because recordConvertSkipped hard-codes `status: 'skipped'`. */
  if (status !== 'failed') {
    return { outcome: 'not-recoverable', detail: reasonFor(raw.op) };
  }

  /* FACT TWO, and it is not a formality. recordConvertSkipped also hard-codes
     `payload: { body: {} }`, so the two facts are written together and agree by
     construction — which is exactly why BOTH are required. A `failed` row with
     an empty body would be a path nobody has written yet, and there would be
     nothing in it to send. */
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
  /* THE DUPLICATE GUARD, on the same column the drain writes on success. */
  if (target.linked) {
    return {
      outcome: 'already-in-autocount',
      detail: `it already carries linked_ac_docno ${target.linked}. Transferring it again would `
        + 'duplicate the document in the live account book.',
    };
  }

  /* A `failed` row IS the attempt being re-sent, so the probe must not veto on
     itself — only on a PENDING or SENT row for the same operation. */
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

  /* A NEW ROW, never a re-opening of the dead one — the same reason the create
     path gives: a failed row sits at MAX_ATTEMPTS and the drain selects
     `.lt('attempts', MAX_ATTEMPTS)`, so re-opening it would produce a pending
     row no sweep can ever pick up. The insert sets no `attempts`, and 0277's
     `NOT NULL DEFAULT 0` supplies zero.
     THE DEDUPE KEY IS THE ROW'S OWN, READ BACK — not rebuilt from the op and
     the id. Rebuilding it was wrong for exactly one op and that op is in this
     set: enqueueConvert writes `${op}:${docId ?? docNo}`, but a `so_to_po` row
     is written by enqueuePoCreate, which keys it `create_po:${poId}` (it is the
     transfer-shaped alternative to a plain create, and the two must not both be
     queued). A reconstructed `so_to_po:…` would not collide with either, so
     0277's pending-dedupe index — the backstop under the live-row check above —
     would silently stop being a backstop for that one shape. Reading the key
     the row already carries cannot drift: it is the same recorded-intent
     argument as the payload, one column over. A `failed` row still holds it,
     because the unique index covers only `status = 'pending'`. */
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

  /* RULE ONE, AND THE ONLY ONE WITH NO EXCEPTION, held by the LADDER and not
     only by its callers. requeueOutboxRow already refuses a `sent` row before
     it gets here and requeueSkipped cannot select one — so this rung is
     unreachable from both of today's entry points, and that is exactly why it
     belongs here. This function is the single answer to "may this document be
     sent again"; a third caller that forgot the check, or a `sent` row reaching
     the batch sweep through a widened select, would otherwise put a SECOND copy
     of a document into a live licensed account book. The two guards cost one
     string comparison between them. */
  if (status === 'sent') {
    return say('already-sent', 'AutoCount accepted this document and recorded it in the account book. '
      + 'Sending it again would create a SECOND copy: the AutoCount create has no duplicate guard on '
      + 'the ERP document number, and an accepted document cannot simply be deleted there.');
  }

  if (raw.op !== 'create_so' && raw.op !== 'create_po' && !isTransfer) {
    return say('not-recoverable', reasonFor(raw.op));
  }
  if ((raw.last_error ?? '').startsWith(REQUEUE_NOTE_PREFIX)) {
    return say('already-requeued', 'an earlier run of this tool already re-queued this skip; the row is '
      + 'history now, not backlog.');
  }
  /* The switch is checked HERE as well as inside the enqueue, because inside
     it is indistinguishable from every other silent false. An operator whose
     write-back is off would otherwise read "declined" and go looking for a
     composer problem that does not exist. */
  if (!(await isWritebackEnabled(sb, companyId))) {
    return say('switch-off', `scm.autocount_writeback is off for company ${companyId}, so an enqueue `
      + 'would return early and write nothing. Turn it on (AutoCount write-back (on/off) workflow) '
      + 'and run this again.');
  }

  if (isTransfer) {
    const v = await transferVerdict(sb, raw, status, opts.apply);
    return { ...base, outcome: v.outcome, detail: v.detail, newRowId: v.newRowId ?? null };
  }

  const target = await readCreateTarget(sb, raw);
  if (!target.ok) {
    return say('document-gone', 'the ERP document this row is about could not be read. Nothing to re-queue.');
  }
  /* enqueueSoCreate guards this itself and would return false; the check is
     here so the REPORT can tell an operator which of the several silent
     falses they are looking at. The guard is not defeated — it still runs. */
  if (target.linked) {
    return say('already-in-autocount', `it already carries linked_ac_docno ${target.linked}. Creating it `
      + 'again would duplicate the document in the live account book.');
  }
  /* The probe asks "is there already a live create row for this document".
     When we were asked to re-send the FAILED row itself, the row it finds is
     that very row, so vetoing on it would make the option a no-op. Skip the
     probe for the row we are re-sending; a PENDING or SENT row still vetoes,
     which is the case that actually matters. */
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

  const queued = await enqueue(sb);
  if (!queued) {
    /* The probe accepted it and the real run did not, which is two things and
       both are safe: another run queued it first and lost the race to 0277's
       pending-dedupe index (23505, nothing written twice), or the document
       changed in the seconds between the two reads and the enqueue refused it
       — in which case noteReadFailure has just written a fresh skipped row
       carrying the new reason. Naming one cause as if it were certain is what
       would send an operator the wrong way. */
    return say('declined', 'the probe accepted this document and the real enqueue declined it. Either '
      + 'another run queued it first (the pending-dedupe index refuses the second), or the document '
      + 'changed in between and the composer refused it — re-run this to see which.');
  }
  /* THE ATTEMPT COUNTER RESETS BY CONSTRUCTION, and this is the whole reason a
     re-queue is an INSERT and not an UPDATE of the dead row. A `failed` row has
     attempts = MAX_ATTEMPTS (6) and the drain selects `.lt('attempts',
     MAX_ATTEMPTS)`, so re-opening that row would produce a `pending` row no
     sweep will ever pick up — queued, visibly waiting, and dead. The row the
     enqueue writes is a NEW one and sets no `attempts` at all, so 0277's
     `attempts integer NOT NULL DEFAULT 0` gives it zero. Nothing here resets a
     counter; nothing needs to. */
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
  /* THE SHARED COLUMN LIST, which this entry point was not using — it had its
     own copy of the same string, which is precisely what the constant was
     declared to prevent. They happened to agree; the next column added to one
     of them is what the comment on REQUEUE_ROW_COLS is about. */
  let q = sb.from('autocount_outbox')
    .select(REQUEUE_ROW_COLS)
    .in('status', includeFailed ? ['skipped', 'failed'] : ['skipped'])
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 200);
  if (opts.docNo) q = q.eq('doc_no', opts.docNo);
  else if (opts.docType && opts.docType !== 'ALL') q = q.eq('doc_type', opts.docType);
  const { data, error } = await q;
  if (error) throw new Error(`could not read the outbox: ${error.code ?? ''} ${error.message ?? ''}`.trim());

  const results: RequeueResult[] = [];
  for (const raw of (data ?? []) as SkippedRow[]) {
    results.push(await requeueOneRow(sb, raw, {
      apply,
      resendingThisRow: includeFailed && raw.status === 'failed',
    }));
  }
  return results;
}

/** The columns the ladder reads. Named once so the two entry points cannot
 *  select different ones and hand requeueOneRow a row missing a field. */
const REQUEUE_ROW_COLS =
  'id, company_id, op, doc_type, doc_no, doc_id, status, last_error, dedupe_key';

export interface RequeueRowOptions {
  /** The `scm.autocount_outbox` row to send again. */
  rowId: string;
  /**
   * The caller's ACTIVE company, and the entire tenant boundary.
   *
   * REQUIRED, with no default and no `?? `. The SCM supabase client is the
   * SERVICE ROLE and bypasses RLS, so the `.eq('company_id', …)` below is the
   * only thing standing between a row id and another company's account book —
   * and a re-queue there is a document pushed into books the caller cannot even
   * see. An optional company would mean "every company" for any caller that
   * forgot it, which is the shape this repo has pooled two companies' data over
   * twice (CLAUDE.md, scm/lib/companyScope.ts).
   */
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
      /* Both predicates, on the SAME statement. Reading by id and checking the
         company afterwards would be the scoped-read-then-open-write shape
         CLAUDE.md names, one step earlier. */
      .eq('id', opts.rowId)
      .eq('company_id', opts.companyId)
      /* maybeSingle, not single: the company predicate can legitimately match
         zero rows, and `single()` reports that honest 404 as a 500. */
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
  /* skipped or failed. `failed` means this row IS the attempt being re-sent, so
     the live-row probe must not veto on itself. */
  return requeueOneRow(sb, raw, { apply: true, resendingThisRow: status === 'failed' });
}

/** The pending row the re-queue just created, for the audit note. */
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

/**
 * Settle the old skip so it stops reading as backlog.
 *
 * THE STATUS IS DELIBERATELY UNCHANGED. 0277's CHECK admits exactly four
 * statuses, and every one of them would be a lie here: this row was never sent
 * and never failed, and flipping it to `pending` would hand the drain a row
 * whose payload is `{}`. A fifth status would need a migration to describe a
 * state nothing reads. So the row stays `skipped` — which is still true, nothing
 * was ever sent for it — and the NOTE carries what changed.
 *
 * The note goes in front of `last_error` because that is the one field the
 * health report prints, so an operator sees the settlement in the same line as
 * the original reason. The original text is kept whole: the point of an
 * append-only table is that the refusal that happened is still readable a year
 * later, next to the date somebody re-asked the question.
 */
async function annotate(sb: Sb, row: SkippedRow, newRowId: string | null): Promise<void> {
  const at = new Date().toISOString();
  const note = `${REQUEUE_NOTE_PREFIX} ${at}${newRowId ? ` -> outbox ${newRowId}` : ''}] `;
  await sb.from('autocount_outbox')
    .update({ last_error: `${note}${row.last_error ?? ''}`, updated_at: at })
    .eq('id', row.id);
}
