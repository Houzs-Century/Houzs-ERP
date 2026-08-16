// ----------------------------------------------------------------------------
// autocount-outbox-status — the VOCABULARY of scm.autocount_outbox, in one
// place, so a screen and a workflow log cannot describe the same row
// differently.
//
// WHY THIS FILE EXISTS. The taxonomy below was written and proven inside
// backend/scripts/check-autocount-outbox-health.mjs, which until now was the
// only thing that could read the queue. Giving the owner a page meant a second
// reader, and a second reader with its own copy of the taxonomy is how the two
// drift — the health check has already been wrong about this once, matching the
// shared prefix `refused, nothing sent` and so reporting all four refusal
// classes as a DtlKey problem (#2094). An operator holding a
// MissingLocationError was sent to backfill line keys.
//
// So: this module is the source, the script's copy is
// backend/scripts/lib/autocount-skip-kinds.mjs (plain ESM, because that script
// runs under plain node against postgres.js and cannot import TypeScript), and
// autocountOutboxStatus.canonical.test.ts imports BOTH and refuses to pass if
// they differ. A copy with no referee is a rule with two homes and no
// authority; that is this repo's stated position on mirrored rules
// (check-shared-mirrors.mjs).
//
// PURE. No imports, no client, no env. It is called from a route handler, from
// a test, and — through the mirror — from an ops script.
// ----------------------------------------------------------------------------

/** The four values 0277's CHECK constraint admits on `status`. */
export const AC_OUTBOX_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type AcOutboxStatus = (typeof AC_OUTBOX_STATUSES)[number];

/**
 * The state a READER should be shown, which is the four statuses plus one.
 *
 * `requeued` is not a database status and must not become one — 0277's CHECK
 * admits four and each of the others would be a lie about a re-queued row (it
 * was never sent, never failed, and `pending` would hand the drain a row with an
 * empty body). It is a skip that has already been asked again, and the whole
 * reason it needs its own name is that the table is append-only: without the
 * distinction the original refusal sits in the report forever, sending an
 * operator to fix something that is already fixed and already queued.
 */
export const AC_OUTBOX_STATES = ['pending', 'sent', 'failed', 'skipped', 'requeued'] as const;
export type AcOutboxState = (typeof AC_OUTBOX_STATES)[number];

/**
 * What a re-queued row's ORIGINAL skip is rewritten to start with.
 *
 * Written by annotateRequeued in autocount-requeue.ts, which imports it from
 * here so there is one definition rather than a constant and a comment asking
 * the next reader to keep two in step.
 */
export const REQUEUE_NOTE_PREFIX = '[re-queued';

/** Past this an operation is surfaced as FAILED instead of retrying forever. */
export const AC_MAX_ATTEMPTS = 6;

/**
 * What each state MEANS to someone who did not write the queue.
 *
 * The owner's question is "is anything stuck", and a status word alone does not
 * answer it: `skipped` reads like a shrug and is often the most serious row on
 * the page, while `pending` reads like a problem and is usually the system
 * working. Each sentence therefore says what is true of the DOCUMENT, not what
 * is true of the row.
 */
export const AC_STATE_MEANING: Record<AcOutboxState, string> = {
  pending:
    'Queued. The 5-minute cron will send it. Not an error by itself — only if the age keeps climbing.',
  sent: 'In the AutoCount account book, under the document number shown.',
  failed:
    'AutoCount refused it, or it ran out of attempts. The document is in the ERP and NOT in the account book.',
  skipped:
    'The ERP decided not to send it, on purpose. The reason names the remedy.',
  requeued:
    'A refusal that has already been asked again. Its document is queued or sent under a newer row — this is the record, not an open item.',
};

/**
 * The reason strings the ERP writes when it declines to send, and what to do
 * about each. Ported verbatim from check-autocount-outbox-health.mjs.
 *
 * MATCH ON THE ERROR CLASS NAME, NOT ON "refused, nothing sent". noteReadFailure
 * (autocount-outbox.ts) writes `refused, nothing sent (${e.name}): ${message}`
 * for several different classes, and each has a different remedy — backfill a
 * DtlKey, fix a sofa build, map an item code, set a stock location. Every class
 * sets this.name in its constructor, so the parenthesised name is reliable.
 *
 * `kind` is a STABLE key, safe to put in a URL and to filter on. The needle is
 * the ERP's own wording and would change if a message were reworded; the key
 * must not.
 */
export interface AcSkipKind {
  /** Stable identifier — URL filters and tests use this, never the needle. */
  kind: string;
  /** Substring of `last_error` that identifies this class. */
  needle: string;
  /** What an operator has to do about it. */
  remedy: string;
}

export const AC_SKIP_KINDS: readonly AcSkipKind[] = [
  {
    kind: 'keyless-line',
    needle: 'refused, nothing sent (KeylessLineError)',
    remedy: 'line identity missing — backfill linked_ac_dtlkey, then save again',
  },
  {
    kind: 'sofa-collapse',
    needle: 'refused, nothing sent (SofaCollapseError)',
    remedy:
      "sofa build cannot be folded into AutoCount's one line without inventing Desc2 text",
  },
  {
    kind: 'item-code',
    needle: 'refused, nothing sent (ItemCodeError)',
    remedy:
      'an ERP item resolves to no single AutoCount ItemCode — fix the cutover map (scm.autocount_item_bindings)',
  },
  {
    kind: 'desc2-too-long',
    needle: 'refused, nothing sent (Desc2TooLongError)',
    remedy:
      "a line's Further Description is over AutoCount's nvarchar(100) — shorten the special order or "
      + 'the colour text on that line, then save again',
  },
  {
    kind: 'missing-location',
    needle: 'refused, nothing sent (MissingLocationError)',
    remedy:
      'a line carries no stock location — set the warehouse on the line, or the sales location on the document',
  },
  /* THREE REFUSAL CLASSES THIS TABLE DID NOT KNOW, ADDED 2026-08-16.
     noteReadFailure has written all three since the write-back went live, and
     none of them had a needle here — so every one of them reached the page as
     `unrecognised` with a NULL remedy, on rows whose remedy is one field on one
     form. MissingAgentError is not hypothetical: it is what AED_HOUZS answered
     to HC-SO-2608-001 and -002 on 2026-08-13 (FK_SO_SalesAgent), the first day
     documents were pushed. The classifier that could not name it is the one
     that produced this table's own cautionary tale (#2094). */
  {
    kind: 'missing-agent',
    needle: 'refused, nothing sent (MissingAgentError)',
    remedy:
      'the sales order names no salesperson AutoCount knows — assign a salesperson on the order, then send it again',
  },
  {
    kind: 'missing-sales-location',
    needle: 'refused, nothing sent (MissingSalesLocationError)',
    remedy:
      'the sales order itself carries no stock location and has no live line to take one from — set the sales location, or add a line with a warehouse',
  },
  {
    kind: 'missing-creditor',
    needle: 'refused, nothing sent (MissingCreditorError)',
    remedy:
      "the purchase order's supplier has no AutoCount creditor code — fill in scm.suppliers.code for that supplier, then send it again",
  },
  {
    kind: 'compose-failed',
    needle: 'compose failed, nothing sent',
    remedy:
      'the ERP could not read its own document while composing — a read fault, not a refusal',
  },
  {
    kind: 'masters-not-opened',
    needle: 'masters not opened',
    remedy: 'an item or salesperson could not be opened in AutoCount',
  },
  {
    kind: 'no-source-document',
    needle: 'no source document to transfer from',
    remedy: 'raised with no parent — cannot exist in AutoCount at all',
  },
  {
    /* THE NEEDLE WAS WRONG AND MATCHED NOTHING, corrected 2026-08-16. It read
       'AutoCount has no shape', which is a phrase from recordConvertSkipped's
       own DOC COMMENT — no code path has ever written it into last_error. The
       five places that record a merged conversion (delivery-orders-mfg.ts,
       grns.ts twice, sales-invoices.ts, purchase-invoices.ts) all write
       "AutoCount transfers from ONE source document", so every merged
       conversion in the queue has been classified `unrecognised` since the
       feature shipped. A needle taken from the comment beside the writer
       instead of from the writer is the same mistake in a different key as
       matching a shared prefix. */
    kind: 'no-autocount-shape',
    needle: 'AutoCount transfers from ONE source document',
    remedy: 'merged conversion (several sources -> one document) — must be worked by hand in AutoCount',
  },
  {
    /* ADDED 2026-08-17 with the fix to POST /sales-invoices. The ERP lets an
       invoice carry a standalone line beside its delivered ones; AutoCount
       builds the invoice by transferring the delivery order's lines, so the
       standalone half would simply not be there — an invoice in the book worth
       less than the one the customer holds. Its own class because its remedy is
       its own: split the document, which is nothing like backfilling a key. */
    kind: 'mixed-source-lines',
    needle: 'came from no source document',
    remedy:
      'part of this document was not delivered on the source — raise the delivered lines from the Delivery Order and the rest as a separate invoice',
  },
  {
    kind: 'dtlkey-subset',
    needle: 'carry no AutoCount DtlKey',
    remedy:
      'a PART of the parent was transferred and the ERP cannot name which lines — backfill linked_ac_dtlkey on the SOURCE document, then raise this document again',
  },
  {
    kind: 'cancelled-before-send',
    needle: 'cancelled in the ERP before it was written to AutoCount',
    remedy:
      'nothing to do — the document was cancelled while its create was still queued, so neither ever reached the account book',
  },
  {
    kind: 'edit-before-counterpart',
    needle: 'edited before its AutoCount counterpart existed',
    remedy:
      'the conversion that creates this document is still queued and will transfer the source lines, not this edit — save the document again once it has drained',
  },
  {
    kind: 'grn-mislinked',
    needle: 'not of this goods receipt',
    remedy:
      "the goods receipt's AutoCount number is its purchase order's, a cutover convention — the real receipt numbers are on the PO (linked_ac_grn_docnos), and nothing can be sent for this GRN until one is chosen",
  },
] as const;

/** The key given to a skip whose wording this module does not recognise. */
export const AC_SKIP_UNRECOGNISED = 'unrecognised';

/**
 * Is this skip's reason the annotation the re-queue tool leaves behind?
 *
 * Deliberately a prefix test and not a `includes`: the annotation is prepended
 * and the ORIGINAL reason is kept whole behind it, so a row whose own message
 * happened to quote the marker mid-string is still an open refusal.
 */
export function isRequeuedNote(lastError: string | null | undefined): boolean {
  return (lastError ?? '').startsWith(REQUEUE_NOTE_PREFIX);
}

/**
 * The state to SHOW for a row, which is its status except that a re-queued skip
 * is its own thing.
 *
 * An unknown status is returned untouched rather than coerced to one of the
 * five. 0277's CHECK makes that unreachable today; if a ninth status is ever
 * added, a reader that says the honest word is better than one that silently
 * files it under `failed`.
 */
export function acOutboxState(
  status: string,
  lastError: string | null | undefined,
): AcOutboxState | string {
  /* A re-queued row is history whether it was SKIPPED or FAILED.
     This read `status === 'skipped'` until 2026-08-15, and it was right when it
     was written: the re-queue tool only ever selected skips. #2189 gave it an
     explicit includeFailed opt-in, and the first use of that opt-in put the
     marker on two FAILED rows — whose documents then went through. The page
     kept counting them, so it told the owner "2 documents need attention — in
     the ERP and not in AutoCount" on the same screen that showed both of them
     IN AutoCount. Caught by opening the page against production; the stubbed
     harness it was built on had no re-queued failed row to show. */
  if (isRequeuedNote(lastError) && (status === 'skipped' || status === 'failed')) return 'requeued';
  return status;
}

/**
 * Which refusal class a skip belongs to, and the remedy for it.
 *
 * An unmatched reason is `AC_SKIP_UNRECOGNISED` with a null remedy rather than
 * being rolled into a nearest neighbour: a reason this module does not know is
 * a code path that grew a new refusal, and putting it in an existing bucket is
 * exactly how it stays invisible.
 */
export function classifyAcSkip(
  lastError: string | null | undefined,
): { kind: string; remedy: string | null } {
  const text = lastError ?? '';
  for (const k of AC_SKIP_KINDS) {
    if (text.includes(k.needle)) return { kind: k.kind, remedy: k.remedy };
  }
  return { kind: AC_SKIP_UNRECOGNISED, remedy: null };
}

/**
 * Does this row need somebody to do something?
 *
 * The owner's whole question. An OUTSTANDING `failed` does — the document is in
 * the ERP and not in the book. An OUTSTANDING `skipped` does — its remedy is
 * named. A re-queued row of EITHER kind does not: it was asked again, and its
 * document is queued or sent under a newer row. `pending` and `sent` do not.
 */
export function acNeedsAttention(
  status: string,
  lastError: string | null | undefined,
): boolean {
  const state = acOutboxState(status, lastError);
  return state === 'failed' || state === 'skipped';
}

/**
 * The two operations that HAVE an AutoCount create, and are therefore the only
 * ones a re-send can express. Named here because both the button-visibility
 * hint below and the re-queue ladder itself are statements about this set.
 */
export const AC_REQUEUEABLE_OPS = ['create_so', 'create_po'] as const;

/**
 * The operations that have NO create of their own — AutoCount builds their
 * document by TRANSFERRING a source document's lines, and the payload the ERP
 * composed is the whole instruction.
 *
 * They are re-sendable under a strictly narrower condition than the two creates,
 * and the condition is the subject of `acRowIsRequeueable` below: only a FAILED
 * one, never a skipped one. See requeueOneRow for the full argument — the short
 * version is that a `skipped` transfer row was refused by the DOCUMENT's shape
 * and a `failed` one was refused by the SERVICE, and only the second of those
 * stops being true when the shop-floor host is rebuilt.
 *
 * `so_to_po` is in this list for the same structural reason the four conversions
 * are: it is AddSOToPOTransferDetail, it carries a `fromDoc`, and its payload is
 * a composed transfer. It is written by enqueuePoCreate, which records its own
 * refusals under `create_po`, so no `skipped` row can ever carry this op.
 */
export const AC_TRANSFER_OPS = [
  'so_to_do', 'po_to_gr', 'do_to_iv', 'gr_to_pi', 'so_to_po',
] as const;

/**
 * Is a per-row "Send again" button worth OFFERING on this row?
 *
 * A HINT, NOT THE GATE. The gate is requeueOutboxRow (lib/autocount-requeue.ts),
 * which re-reads the row and the document and can refuse for six more reasons
 * this pure function cannot see — the document already carries a
 * linked_ac_docno, the write-back switch is off, the composer refuses it again.
 * Nothing here is trusted by the write path; this exists only so the page does
 * not put a button on a row whose answer is knowably "no" before it is pressed.
 *
 * The structural noes, and each is permanent for that row:
 *
 *   status pending / sent   there is nothing to re-ask. A pending row is
 *                           already going out and a sent row is in the book.
 *   already re-queued       the marker means somebody asked again; its document
 *                           is queued or sent under a NEWER row.
 *   an edit                 re-queued by saving the document, never from here.
 *   a SKIPPED transfer      the three shapes that produce one — a parentless
 *                           DO/GR/IV/PI, a merged conversion, a DtlKey-subset
 *                           refusal — are properties of the DOCUMENT and no
 *                           amount of re-sending touches them.
 *
 * Deliberately NOT mirrored into scripts/lib/autocount-skip-kinds.mjs: the
 * health check reports the queue and never re-queues, so a copy there would be
 * a second home for a rule with no second reader.
 */
export function acRowIsRequeueable(
  op: string,
  status: string,
  lastError: string | null | undefined,
): boolean {
  const state = acOutboxState(status, lastError);
  if ((AC_REQUEUEABLE_OPS as readonly string[]).includes(op)) {
    return state === 'failed' || state === 'skipped';
  }
  /* FAILED ONLY. A skipped transfer never left the building, so the service has
     never seen it and its refusal cannot be a service refusal. */
  if ((AC_TRANSFER_OPS as readonly string[]).includes(op)) return state === 'failed';
  return false;
}
