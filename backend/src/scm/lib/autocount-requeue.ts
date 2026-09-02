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
  /**
   * APPLY, on a TRANSFER recorded as PARENTLESS: the document was re-read, its
   * lines DO name a parent, and a real conversion was composed and queued.
   *
   * A third code because it is a third promise. `requeued-as-recorded` re-sends
   * a stored instruction; this one had no instruction to store — the row was
   * "there is no earlier document to carry across" — so the parent was resolved
   * afresh from the child's lines and the conversion built from that. The
   * operator is being told his receipt is going across AS a conversion of a
   * purchase order, which is a different claim from "we tried again".
   */
  | 'requeued-with-parent'
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
  /* ── SEND NOW ────────────────────────────────────────────────────────────
     The owner asked for a manual push on a row that is still WAITING
     (「自动的 可是我要可以manual push」). It is a different act from a re-queue
     and its outcomes are its own: a re-queue INSERTS a fresh row for the next
     sweep, while a send-now dispatches THE ROW IN FRONT OF YOU, right now, and
     therefore has AutoCount's own answer to report rather than a promise about
     a sweep five minutes away. Sharing `requeued`'s codes would have made
     "queued" and "the account book has taken it" the same word. */
  /** SEND NOW: AutoCount took the document, there and then. */
  | 'sent-now'
  /** SEND NOW: it went, and AutoCount refused it. `detail` is the book's words. */
  | 'send-now-refused'
  /** SEND NOW: the host could not be reached. Still queued, still retrying. */
  | 'send-now-retrying'
  /** SEND NOW: it is waiting on a parent document that is not in the book yet. */
  | 'send-now-waiting'
  /** SEND NOW asked of a row that is not waiting, so there is nothing to push. */
  | 'not-waiting'
  /** SEND NOW lost the race: a sweep, or another operator, is sending it. */
  | 'already-in-flight'
  /** SEND NOW on a row that has spent every attempt and no sweep will take. */
  | 'attempts-spent'
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
  /* IT MUST NOT SAY "could not be reached", and it said exactly that until a
     test caught it. `callAcService` treats a 500 as RETRYABLE, and
     AcSyncService turns EVERY exception into a 500 — so this outcome covers two
     different events that the return value cannot tell apart: the host being
     unreachable, and the host being reached and AutoCount throwing. Production
     is in the second one right now (`Primary Key Error`, retrying), and telling
     that operator the account book could not be reached would send him to check
     a tunnel that is working. So the sentence says only what is true of both,
     and the account book's own words are shown underneath. */
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
  /* SENT NOW IS STRONGER THAN QUEUED, not weaker: the other two mean the sweep
     will take it, this one means the account book already has it. It belongs
     here because every reader of this list is asking "is the document on its
     way", and "it has arrived" is a yes.

     The other send-now outcomes are deliberately NOT here. `send-now-refused`
     and `send-now-retrying` both leave a document that is in the ERP and not in
     the book, which is the divergence the whole mechanism exists to report;
     counting a refusal as acceptance is how the page would tell an operator
     everything was fine while a document sat outside the accounts. */
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
  /* Asked with an EMPTY opts on purpose: this rung is about the document TYPE.
     `rebuildBlocked` is derived inside the composer from the live document, not
     from anything this row remembers, and it is answered a few lines below when
     the probe runs. */
  if (!rebuildAllowed({}, docType)) {
    return {
      outcome: 'not-recoverable',
      detail: `a ${docType} is built by conversion, and its lines are where AutoCount records what it `
        + 'was converted FROM. A rebuild clears exactly those lines, and the host cannot catch it - its '
        + 'guard reads TransferedQty, which is the ONWARD direction. Only a sales order or a purchase '
        + 'order may be re-sent this way (docs/bugs/0611).',
    };
  }

  const editOpts = {
    companyId,
    docType: docType as AcDocType,
    ...(docType === 'SO' ? { docNo: raw.doc_no } : { docId: raw.doc_id ?? raw.doc_no }),
    rebuild: true,
  };
  /* Composed against a THROWAWAY client first, exactly as the create path does:
     the composer is the only thing that knows whether this document can be sent
     today, and asking it must not write a row on a dry run. */
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
/** Where a re-resolved conversion writes its AutoCount number back. */
const RESOLVED_TARGET: Record<string, { table: 'grns' | 'purchase_invoices' }> = {
  po_to_gr: { table: 'grns' },
  gr_to_pi: { table: 'purchase_invoices' },
};

/**
 * A row recorded as parentless whose document turns out to HAVE a parent:
 * compose the conversion the create should have composed and queue it.
 *
 * Returns null when the claim was true after all — the caller then gives the
 * refusal it always gave, which is the right answer for a document genuinely
 * keyed in by hand. Every guard the failed-row path applies is applied here
 * too, in the same order and for the same reasons: a document already in the
 * book must not be transferred twice, and a live row for the same operation
 * must not be doubled.
 */
async function parentedAfterAll(
  sb: Sb,
  raw: SkippedRow,
  apply: boolean,
): Promise<Verdict | null> {
  const spec = RESOLVED_TARGET[raw.op];
  if (!spec) return null;

  const src = await reresolveConvertSource(sb, raw.op, raw.doc_id);
  if (!src) return null;

  /* THE DUPLICATE GUARD, on the same column the drain writes on success — read
     straight from the target table, because a parentless row stores no
     writeback descriptor for readTransferTarget to follow. */
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

  /* enqueueConvert, NOT enqueueAcOp with a stored payload — there is no stored
     payload, and going through the create path's own composer is what keeps one
     definition of a conversion rather than a second one written here. */
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
  /* FACT ONE. Only dispatchOne writes `failed`, and only a `pending` row reaches
     it — which for a transfer op is only ever enqueueConvert's success path. So
     `failed` means the service answered, and anything else means it never saw
     the document. All three unrecoverable shapes land the other side of this
     line, because recordConvertSkipped hard-codes `status: 'skipped'`. */
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

  if (raw.op !== 'create_so' && raw.op !== 'create_po' && raw.op !== 'edit' && !isTransfer) {
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

  if (raw.op === 'edit') {
    const v = await editRebuildVerdict(sb, raw, companyId, opts.apply);
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

  const { queued } = await enqueue(sb);
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
  /** Injected by the tests, exactly as `dispatchOne` and the drain take it. */
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
      /* The DRAIN's columns, not the ladder's: `dispatchOne` needs the payload,
         and REQUEUE_ROW_COLS deliberately omits it. */
      .select('id, company_id, op, doc_type, doc_no, doc_id, payload, status, attempts, dedupe_key, last_error')
      /* Both predicates on one statement, exactly as requeueOutboxRow does —
         the service-role client bypasses RLS and this is the tenant boundary. */
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

  /* ONLY A WAITING ROW. `sent` is in the book, `failed` has given up and wants
     Send again (which re-composes and starts a fresh attempt budget), `skipped`
     never left the building. Each of those already has a correct answer on the
     re-queue path and this button must not become a second, weaker door to it. */
  if (status !== 'pending') {
    return {
      ...base,
      outcome: 'not-waiting',
      detail: `this row is ${status}, and only a pending row is waiting to go out. `
        + 'Send again is the action for a refused or held-back document; it re-composes '
        + 'the document and starts a fresh set of attempts, which this deliberately does not.',
    };
  }

  /* A PENDING ROW WITH NO BUDGET LEFT IS STRANDED, and pushing it would spend an
     attempt on a row that the sweep itself will never select (the drain filters
     `attempts < MAX_ATTEMPTS`). Naming that state is more useful than a send
     that cannot help. */
  if (attempts >= MAX_ATTEMPTS) {
    return {
      ...base,
      outcome: 'attempts-spent',
      detail: `this row has used all ${MAX_ATTEMPTS} attempts and is not selected by the sweep any more.`,
    };
  }

  /* THE SWITCH, before anything is claimed. Sending while the write-back is off
     would be the one caller in the system that ignores it. */
  if (!(await isWritebackEnabled(sb, base.companyId))) {
    return { ...base, outcome: 'switch-off', detail: 'scm.autocount_writeback is off for this company.' };
  }

  /* THE CLAIM. Everything above is a read and could be stale by now; this is the
     first and only step that makes the decision exclusive. */
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
    /* dispatchOne marks the row on every outcome it RETURNS, so the claim is
       released there; a throw skips that and the lease (AC_CLAIM_LEASE_MS) is
       what frees the row. Reported as a refusal rather than a 500 because
       something may well have reached the host, and "nothing happened" would be
       a claim this code cannot make. */
    return {
      ...base,
      outcome: 'send-now-retrying',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  /* THE ROW'S OWN WORDS, read back AFTER the dispatch. dispatchOne returns a
     verdict and writes the reason; the reason is what the operator needs, and
     re-reading one row is cheaper than threading it out of every branch. */
  let said = '';
  try {
    const { data, error } = await sb.from('autocount_outbox')
      .select('last_error').eq('id', base.rowId).eq('company_id', base.companyId).maybeSingle();
    /* BIND THE ERROR AND SAY SO. supabase-js does not throw, so an unbound
       `error` here would make a failed read indistinguishable from a row whose
       reason is genuinely blank — and this string IS the diagnosis the operator
       gets back. Silently empty would land him on a refusal that explains
       nothing, which is the failure class this repo names by name. */
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
