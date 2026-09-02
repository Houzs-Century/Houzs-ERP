// ----------------------------------------------------------------------------
// autocount-outbox — enqueue side and drain side of the ERP -> AutoCount
// write-back (table: scm.autocount_outbox, migration 0277).
//
// THE ONE RULE THIS MODULE EXISTS TO KEEP: a write to AutoCount can never fail
// a user's save. Every enqueue function here swallows its own errors and
// returns void. The AutoCount host is a Windows box on the shop floor behind a
// tunnel; a salesperson pressing Save must not care whether it is up.
//
// SHAPE follows amendment-command.ts (the repo's other command outbox): a DB
// flag, an enqueue with a dedupe key, a dispatchOne that owns the terminal
// states, and a cron sweep. Deliberately the same shape rather than a third
// pattern.
//
// TWO THINGS ARE RESOLVED LATE, at drain rather than at enqueue, and only two:
//
//   1. The AutoCount document number of the PARENT (a conversion's FromDocNo)
//      and of the SUBJECT (a cancel/edit's DocNo). Neither exists until the
//      create that makes it has drained. This is a foreign-key resolution, not
//      a recomposition — the ERP facts in the payload stay exactly as the
//      user's save produced them.
//   2. The flag. A switch turned off after rows were queued must stop the push,
//      and those rows stay PENDING rather than failing: off is not a failure.
//
// A row whose parent is not resolved yet is left pending WITHOUT burning an
// attempt. Sweeps drain oldest-first, so the parent's create is ahead of it in
// the same batch and usually resolves on the very same sweep.
//
// A QUEUED PAYLOAD SPEAKS AUTOCOUNT, NOT ERP — checked 2026-08-13, because it
// decides whether renaming an ERP column strands rows already in the queue.
// `payload.body` is the composed AcSyncService document (DebtorName, DocDate,
// UDF.{BRANDING,VENUE,ToPONo,PDate}, Details[]); the only ERP identifiers that
// survive into it are `writeback` / `lineWriteback` / `fromDoc` / `selfDoc`,
// which name a TABLE and `doc_no` or `id`. No ERP column name for a business
// field is frozen in there, so an ERP column rename cannot strand a queued row
// and no payload migration is needed. `mastersOf` reads the payload's UDF block
// for BRANDING and VENUE only — PDate is a date, not a dropdown master.
//
// What a rename CAN break here is the compose side, and silently: SO_HEADER_COLS
// is a string select list, `soEditHeader` reads its header out of a bare
// Record, and `composeCreateSo` is handed `header as never`. All three are keyed
// on shared/so-processing-date.ts for exactly that reason.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { isWritebackEnabled } from './autocount-writeback-flag';
import { inAcLineOrder } from './ac-line-order';
import { poRaisedFromSo } from './so-po-raised';
import { claimOutboxRow, releaseExpiredClaims } from './autocount-claim';
import { splitSofaCode } from '../../services/autocount-sofa-collapse';
import { SO_PROCESSING_DATE_COLUMN } from '../shared/so-processing-date';
import {
  callAcService,
  LOCATION_MAP,
  BRANDING_MAP,
  VENUE_MAP,
  AC_DEBTOR_CODE,
  AC_PURCHASE_AGENT,
  bookSpelling,
  bookSpellingOrOwn,
  resolveAcAgent,
  soBranding,
  soCustomerRef,
  soInvoiceAddress,
  composeCreatePo,
  composeCreateSo,
  composeDescription2,
  composeDetails,
  composeEdit,
  clearedAcKeys,
  composePaymentUdf,
  composeSoToPo,
  acUdfDate,
  acUdfMoney,
  acServiceConfig,
  Desc2TooLongError,
  ItemCodeError,
  KeylessLineError,
  MissingAgentError,
  MissingCreditorError,
  AcSoToPoAlignmentError,
  MissingLocationError,
  MissingSalesLocationError,
  SofaCollapseError,
  type AcDocType,
  type AcOp,
  type AcCreatedLine,
  type AcRetiredLine,
  type ErpLine,
  type ErpPaymentRef,
} from '../../services/autocount-writeback';

/* Re-exported so a route can name the shape it passes to enqueueEdit without
   also importing the composer module. */
export type { AcRetiredLine } from '../../services/autocount-writeback';

import { mastersOf } from './autocount-masters';
import { soEditHeader } from './so-edit-header';
/* The reads, and what a FAILED read means. Split out 2026-08-15 for the same
   reason mastersOf was: this file is at the 2,000-line cap. */
import {
  AcReadError, readOrThrow, readSoOutstandingSen, readSoPaymentRefs, readPoEnqueueShape,
  readWarehouseCode,
  withLocations,
} from './autocount-read';
import { backfillSoToPoKeys, poBodyForShape } from './autocount-so-to-po-keys';
/* The reason a parentless create records, kept beside the needle that
   classifies it and pinned by a test — see acParentlessCreateReason. */
import { acParentlessCreateReason, acNotCarriedReason } from './autocount-outbox-status';
/* Line identity, split out 2026-08-17 for the same cap reason as the two
   imports above. Same function, same call site in dispatchOne. */
import { persistLineKeys, persistNewLineKeys, newLineTargetOf } from './autocount-line-keys';
import { readMfgProductBindings } from './supplier-bindings';
import {
  soLine,
  present,
  DOWNSTREAM,
  CONVERT_TARGET,
  readConvertSourceKeys,
  readConvertTargetLines,
  readConvertHeaderFacts,
  /* Moved into that module 2026-08-20: all four are derived from or ask about
     CONVERT_TARGET, which lives there, and this file was at its cap again. */
  SALES_CONVERSION,
  PURCHASE_CONVERSION,
  readConvertCreditor,
  downstreamEditHeader,
  downstreamTransferHeader,
  downstreamNotCarried,
  type AcDownstreamSpec,
  type AcHeaderCtx,
} from './autocount-convert-lines';

/* The operator's half of a refusal. The skipped row this file writes is the
   engineer's half and has not changed — see lib/ac-preflight.ts for why there
   are two and why only ONE module is allowed to write either sentence. */
import { acNotSentProblems, acNotCarriedProblems, type AcDocKind } from './ac-preflight';
import type { SaveProblem } from '../shared/so-save-problems';

type Sb = SupabaseClient<any, any, any>;

/** What to call each document in a sentence an operator reads. */
const AC_DOC_NOUN: Record<AcDocType, AcDocKind> = {
  SO: 'sales order', PO: 'purchase order', DO: 'document',
  GR: 'document', IV: 'document', PI: 'document',
};

/**
 * What an enqueue did, and — when it refused — what to TELL the operator.
 *
 * `queued` is the old boolean, unchanged. `problems` is the answer the composer
 * has always computed inside the caller's own request and thrown away: every
 * refusal below is raised, caught and filed while the route still holds the
 * response it is about to return. Empty for every ordinary outcome (queued, the
 * flag off, no company, a cutover-imported document, a dedupe collision) — a
 * warning nobody needed is how an operator learns to stop reading them.
 */
export type AcEnqueueOutcome = { queued: boolean; problems: SaveProblem[] };

const AC_ENQUEUE_SILENT: AcEnqueueOutcome = { queued: false, problems: [] };

/** Past this an operation is surfaced as FAILED instead of retrying forever. */
export const MAX_ATTEMPTS = 6;
const DRAIN_BATCH = 20;

/** The ERP tables that can carry an AutoCount counterpart number. */
export type AcLinkTable =
  | 'mfg_sales_orders'
  | 'purchase_orders'
  | 'delivery_orders'
  | 'grns'
  | 'sales_invoices'
  | 'purchase_invoices';

/** The ERP line tables that can carry an AutoCount DtlKey (0273 + 0280). */
export type AcLineTable =
  | 'mfg_sales_order_items'
  | 'purchase_order_items'
  | 'delivery_order_items'
  | 'grn_items'
  | 'sales_invoice_items'
  | 'purchase_invoice_items';

export interface AcDocRef {
  table: AcLinkTable;
  /** 'doc_no' for SOs (which are keyed by their number), 'id' for the rest. */
  keyCol: 'doc_no' | 'id';
  key: string;
}

/** What one outbox row carries. `body` is the AcSyncService payload. */
export interface AcOutboxPayload {
  body: Record<string, unknown>;
  /** Set body.FromDocNo from this ERP document's linked_ac_docno. */
  fromDoc?: AcDocRef;
  /**
   * SEVERAL sources into ONE target — set body.FromDocNos from their
   * linked_ac_docno, in the order the ERP named them.
   *
   * A MERGED conversion (two sales orders shipped on one delivery order, four
   * purchase orders received on one GRN) used to be recorded `skipped` with
   * "AutoCount transfers from ONE source document". That sentence stopped being
   * true on 2026-08-16: `PlanTransfer` (AcSyncService.cs) reads `FromDocNos`,
   * the documented `FullTransfer` takes an ARRAY of document numbers, and the
   * by-line shape groups the keys by the document they belong to and invokes
   * the primitive once per group. The service was ready and the ERP kept
   * refusing — four routes, one `docNos.length === 1`.
   *
   * SEPARATE FROM `fromDoc`, not a replacement for it. The drain REPLAYS a
   * stored payload and never recomposes, so every row queued before this field
   * existed still carries `fromDoc` and must keep working exactly as it did.
   */
  fromDocs?: AcDocRef[];
  /**
   * The line PHOTOGRAPHS this edit should carry, named by the AutoCount line
   * they belong to.
   *
   * KEYS, NOT BYTES, AND THAT IS THE WHOLE DESIGN DECISION. A cutover photo is
   * a few KB and a document can hold five, so the base64 of one edit is tens of
   * KB — in an APPEND-ONLY audit table, written again on every save of every
   * photographed order. The payload records what the user's save MEANT (these
   * pictures, on this line); `dispatchOne` materialises the bytes out of R2 in
   * the moment it sends, exactly as `fromDoc` names a document and the drain
   * resolves it to a number. The snapshot stays a snapshot and stays small.
   *
   * EDIT ONLY, because that is the only route the service takes them on
   * (`AcSyncService.Edit()` reads `Photos` per line; `CreateSo` does not), and
   * the only shape proven against the live book — scratch order `ERP-FDPROBE-1`,
   * 2026-08-15: rendered on the entry screen AND in the printed preview, read
   * back `truncated=False`, our own bytes kept unchanged. A newly created order
   * carries its photographs on its first edit, not on the create.
   */
  photos?: Array<{ dtlKey: number; keys: string[] }>;
  /** Set body.DocNo from this ERP document's linked_ac_docno (cancel / edit). */
  selfDoc?: AcDocRef;
  /** Write the AutoCount document number the call returns back onto this row. */
  writeback?: AcDocRef;
  /**
   * Store the DtlKeys the call returns onto these ERP line rows.
   *
   * `ids[n]` are the ERP line row ids behind the Nth detail in the payload, so
   * the Nth returned key belongs to all of them. It is a LIST because the
   * mapping is not 1:1: a sofa build is one AutoCount line and several ERP
   * compartment rows, and every compartment must carry the same DtlKey or the
   * build has no line identity at all (composeEdit then refuses, loudly).
   * `codes` is the list of AutoCount ItemCodes actually sent, kept so the zip
   * can be CHECKED rather than trusted — see persistLineKeys.
   */
  lineWriteback?: {
    table: AcLineTable;
    ids: Array<string | string[]>;
    codes: string[];
    /**
     * The Desc2 each line was sent with, positionally aligned to `ids`.
     *
     * ItemCode alone does not identify a line: a sofa order carries several
     * lines of the SAME code differing only in their build text, and the
     * conversion routes do not send a line list at all — AutoCount picks the
     * source lines itself — so the two orderings are only presumed to agree.
     * Desc2 is what tells two same-code lines apart, and persistLineKeys uses
     * it to REFUSE rather than store a confidently wrong line identity.
     */
    desc2?: Array<string | null>;
  };
  /** Header facts this operation did NOT carry, one operator sentence each,
   *  from `downstreamNotCarried` (two different silences — see it). Never goes
   *  on the wire: `dispatchOne` POSTs `payload.body` and this is its sibling.
   *  The DURABLE half of the report; `last_error` is the half seen at save time
   *  and the drain clears that on success while the blank in the book stays. */
  notCarried?: string[];
}

export interface AcOutboxRow {
  id: string;
  company_id: number;
  op: AcOp;
  doc_type: string;
  doc_no: string;
  doc_id: string | null;
  payload: AcOutboxPayload;
  status: string;
  attempts: number;
  dedupe_key: string | null;
}

export interface EnqueueInput {
  companyId: number | null | undefined;
  op: AcOp;
  docType: AcDocType;
  docNo: string;
  docId?: string | null;
  payload: AcOutboxPayload;
  /** NULL means "always enqueue" — see 0277. */
  dedupeKey?: string | null;
  createdBy?: number | null;
  /**
   * 'skipped' records an operation the ERP consciously will NOT send, with the
   * reason in last_error. Used where the ERP can express something AutoCount's
   * SDK cannot (see recordConvertSkipped). Writing the row is the point:
   * a divergence that is written down can be found, and one that is silently
   * dropped cannot.
   */
  status?: 'pending' | 'skipped';
  reason?: string | null;
}

/**
 * Queue one operation. Returns true when a row was written.
 *
 * NEVER THROWS. Every failure path — flag off, no company, a dead DB, a dedupe
 * collision — returns false. The caller is a route handler that has already
 * committed the user's document.
 */
export async function enqueueAcOp(sb: Sb, input: EnqueueInput): Promise<boolean> {
  try {
    if (input.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, input.companyId))) return false;
    const { error } = await sb.from('autocount_outbox').insert({
      company_id: input.companyId,
      op: input.op,
      doc_type: input.docType,
      doc_no: input.docNo,
      doc_id: input.docId ?? null,
      payload: input.payload,
      dedupe_key: input.status === 'skipped' ? null : (input.dedupeKey ?? null),
      created_by: input.createdBy ?? null,
      status: input.status ?? 'pending',
      last_error: input.reason ?? null,
    });
    // 23505 on the pending-dedupe index: the same intent is already queued.
    return !error;
  } catch {
    return false;
  }
}

// ── reads ───────────────────────────────────────────────────────────────────

/* Column lists, named once. A select that asks PostgREST for a column the table
   does not have fails the WHOLE query with 42703 — it does not drop the column
   and carry on — so these are the single place a phantom column can enter. */
/* processing_date is the SO's "Processing date" — the ONE storage behind that
   UI label, under the ONE name since mig 0284 (0189 had already dropped the
   dead legacy column of this name; 0284 then renamed the live
   internal_expected_dd onto it). It leaves as the PDate UDF. */
/* salesperson_id is the ERP's REAL salesperson identity (a scm.staff uuid);
   `agent` is the legacy free text beside it. Both are read because the write-
   back needs the second only when the first is empty — see readSalespersonName
   and resolveAcAgent. */
/* city / postcode / customer_state are the town, postcode and state of an
   ERP-created order: address3 and address4 were written ONLY by the cutover
   import, so without these three the AutoCount document carried the street
   lines and nothing else (soInvoiceAddress packs the five into four).
   customer_so_no is the customer's own reference; po_doc_no / customer_po were
   the other two columns that once held it, both 0%-filled and DROPPED from
   scm.mfg_sales_orders by migration 0310 — `customer_so_no` is the only one any
   surface still writes, and it is what ToPONo reads (soCustomerRef). */
/* emergency_contact_phone is AutoCount's DeliverPhone1 and `phone` is its
   Phone1 — two contacts, two columns (owner 2026-08-15). The cutover decided
   the pairing in this direction already: import-ac-outstanding-so.mjs:302 takes
   DeliverPhone1 when it differs from Phone1 and inserts it as
   emergency_contact_phone (:390/:412). Reading `phone` for both would put the
   customer's number in front of the driver.
   total_revenue_sen + deposit_sen are two of the three inputs to the
   outstanding balance the BALANCE UDF carries; the third is the payments ledger
   (readSoOutstandingSen). NOT balance_sen — recomputeTotals rewrites that to
   the gross total on every edit, and it is the column the cutover's UDF_BALANCE
   landed in, which is exactly what makes it look like the right one. */
const SO_HEADER_COLS =
  'doc_no, so_date, debtor_name, agent, salesperson_id, sales_location, branding, venue, address1, address2, address3, address4, city, postcode, customer_state, phone, emergency_contact_phone, ref, customer_so_no, processing_date, customer_delivery_date, total_revenue_sen, deposit_sen, linked_ac_docno';
/* `cancelled` and `branding` are on THIS list and on no other, because only
   scm.mfg_sales_order_items has them (the other five line tables are
   still to get `cancelled` — docs/autocount-line-retirement-plan.md). Asking
   PostgREST for a column a table does not have fails the whole query with
   42703. `branding` is where an ERP-created order actually keeps its brand —
   the header column is NULL on every one of them (soBranding). */
/* line_delivery_date is AutoCount's SODTL.DeliveryDate. Unselected, `soLine`
   left it undefined and composeDetails omitted the key, so the account book
   filled in its own default — the document date — on every ERP-created line
   (owner 2026-08-15). It also holds the BLANK the book itself carries on 11,886
   of its 60,939 lines. */
const SO_ITEM_COLS =
  'id, item_code, item_group, branding, description, description2, qty, unit_price_sen, variants, linked_ac_dtlkey, cancelled, warehouse_id, line_delivery_date, photo_urls';
/* scm.purchase_orders is SUPPLIER-keyed. It has no creditor_code, creditor_name,
   agent or ref: the creditor is scm.suppliers.code / .name behind supplier_id,
   and the other two do not exist at all on the ERP side. */
/* purchase_location_id is the PO's OWN ship-to warehouse (PR #77); AutoCount has
   the same header field and the ERP had never sent one, so the book defaulted it
   on every purchase order it has written. Guide §7c3b-ii. */
const PO_HEADER_COLS =
  'id, company_id, po_number, po_date, supplier_id, notes, purchase_location_id, linked_ac_docno';
/* description2 is NOT optional here. The PO importer wrote the AutoCount sofa
   Desc2 verbatim onto every compartment row, and that stored text is what the
   D9 collapse echoes back. Leaving the column out of this list is what made the
   PO side fall back to a variants blob and throw the original build away. */
const PO_ITEM_COLS =
  'id, item_code, item_group, description, description2, qty, unit_price_sen, variants, linked_ac_dtlkey, warehouse_id, delivery_date, photo_urls';

/**
 * The four DOWNSTREAM document types, described once.
 *
 * AcSyncService can edit all six (AcSyncService.cs:441-446) and cancel all six
 * (:421-426); until now the ERP could only reach SO and PO, because enqueueEdit
 * was typed to those two. These four differ from SO/PO in one structural way and
 * it shapes everything below: THEY HAVE NO CREATE. AutoCount builds a DO, GRN,
 * Invoice or Purchase Invoice only by transferring source lines
 * (AddPartialTransferDetail is the SDK's one primitive), so the operation that
 * brings one into the account book is its CONVERSION, and its line identity is
 * whatever AutoCount assigned during that conversion.
 *
 * WHAT IS DELIBERATELY ABSENT FROM EVERY `header` BELOW:
 *
 *   DocDate — the conversion set it, and the ERP's date column is not the same
 *     quantity. A GRN's is `received_at`, a timestamp; the DO's `do_date` and
 *     the shipment date are different facts. /edit applies only the keys it is
 *     GIVEN (AcSyncService.cs:460 `h.ContainsKey`), so omitting it leaves the
 *     book's own posting date alone. A wrong posting date is worse than none.
 *   Addresses — the DO and SI carry address1/2 + city/state/postcode, which is
 *     five ERP fields against AutoCount's four numbered lines. Any packing rule
 *     would be invented here rather than derived, so the keys are omitted and
 *     AutoCount keeps what the transfer gave it.
 *   Agent / SalesLocation — mapped through AGENT_MAP / LOCATION_MAP on the SO,
 *     where a miss yields null. Sending that null would BLANK a real agent on a
 *     document the ERP is not the authority for.
 */


/**
 * The salesperson's NAME, for the AutoCount Sales Agent.
 *
 * Exactly the division `withLocations` draws one level down: the ERP column is
 * a foreign key (`salesperson_id` -> `scm.staff`) and AutoCount wants the
 * string, so the id is resolved HERE, beside the other header reads, and the
 * composer stays pure. `staff.name` is the same field the SO PDF prints and the
 * SO list resolves through `useStaffLookup`, so the account book learns a rep
 * under the spelling the rest of the ERP already shows.
 *
 * A FAILED READ THROWS rather than degrading to null. Null means "this order
 * has no salesperson", which on a create is a refusal naming a remedy the
 * operator can act on ("assign a salesperson"); an unreadable `scm.staff` would
 * send them after an order that already has one. AcReadError says what actually
 * happened.
 */
async function readSalespersonName(sb: Sb, salespersonId: unknown): Promise<string | null> {
  const id = typeof salespersonId === 'string' ? salespersonId.trim() : '';
  if (!id) return null;
  const row = await readOrThrow('staff',
    sb.from('staff').select('name').eq('id', id).maybeSingle());
  const name = ((row as { name?: string | null } | null)?.name ?? '').trim();
  return name || null;
}

/**
 * Write a failed compose down instead of dropping it.
 *
 * Same rule as recordConvertSkipped: an operation the ERP will not send is
 * recorded with its reason, because a divergence that is written down can be
 * found and one that is silently dropped cannot. Best-effort and never throws —
 * the caller is a route handler that has already committed the user's document.
 *
 * TWO kinds of refusal reach here and they are not the same thing:
 *
 *   AcReadError       — the ERP could not read its own document. The operation
 *                       was never composed. Transient, or a schema bug.
 *   KeylessLineError  — the ERP read the document perfectly well and DECLINED to
 *                       send it, because a line has no AutoCount DtlKey and
 *                       sending it would append duplicates into the live account
 *                       book. A data gap with a known remedy: backfill the line
 *                       keys for that document.
 *   SofaCollapseError — a sofa build cannot be folded into AutoCount's one-line
 *                       shape without inventing Desc2 text (D9).
 *   ItemCodeError     — a line has no single AutoCount ItemCode (D10): either
 *                       the cutover map has never heard of it, or it maps to
 *                       several items and the document names no supplier.
 *   Desc2TooLongError — the line's Further Description is over nvarchar(100).
 *                       SQL Server refuses the Save and takes the document with
 *                       it, and truncating a specification is a wrong
 *                       instruction rather than a short one (7q).
 *   MissingAgentError — the order names no salesperson AutoCount can be given,
 *                       and a blank one is refused by FK_SO_SalesAgent (the
 *                       2026-08-13 go-live failure). MissingLocationError's
 *                       twin, one level up.
 *   MissingSalesLocationError
 *                     — the SO names no stock location and has no live line to
 *                       take one from. FK_SO_SalesLocation.
 *   MissingCreditorError
 *                     — the PO's supplier has no `scm.suppliers.code`, and
 *                       CreatePo assigns CreditorCode DIRECTLY. FK_PO_Creditor.
 *
 * All of them must land in the outbox. A refusal nobody can see is
 * indistinguishable from a write-back that quietly stopped working.
 */
async function noteReadFailure(
  sb: Sb,
  e: unknown,
  ctx: { companyId: number; op: AcOp; docType: EnqueueInput['docType']; docNo: string; docId?: string | null },
): Promise<SaveProblem[]> {
  const refused = e instanceof KeylessLineError
    || e instanceof SofaCollapseError
    || e instanceof ItemCodeError
    || e instanceof Desc2TooLongError
    || e instanceof MissingLocationError
    || e instanceof MissingAgentError
    || e instanceof MissingSalesLocationError
    || e instanceof MissingCreditorError
    /* THE LIST IS THE WHOLE MECHANISM: an error missing from it is SWALLOWED by
       the early return below — no row, no log line, nothing to read. Pinned
       against acNotSentProblems' twin chain in ac-preflight.test.ts. */
    || e instanceof AcSoToPoAlignmentError;
  if (!refused && !(e instanceof AcReadError)) return [];
  const message = (e as Error).message;
  // eslint-disable-next-line no-console
  console.error(
    refused
      ? `[autocount-outbox] ${ctx.op} REFUSED, nothing queued for AutoCount (${(e as Error).name}):`
      : `[autocount-outbox] ${ctx.op} compose read failed — NOTHING queued for AutoCount:`,
    ctx.docNo,
    message,
  );
  try {
    await enqueueAcOp(sb, {
      companyId: ctx.companyId,
      op: ctx.op,
      docType: ctx.docType,
      docNo: ctx.docNo,
      docId: ctx.docId ?? null,
      payload: { body: {} },
      status: 'skipped',
      /* The class name goes into the DURABLE row, not just the log line. Three
         different refusals reach here and they have three different remedies —
         backfill a DtlKey, fix a sofa build, map an item code. The console.error
         above is gone the moment the Worker is recycled; this row is what an
         operator actually reads. */
      reason: refused
        ? `refused, nothing sent (${(e as Error).name}): ${message}`
        : `compose failed, nothing sent: ${message}`,
    });
  } catch { /* the note is best-effort; the log above is the floor */ }
  /* AND THE OPERATOR IS TOLD. The skipped row is what an ENGINEER reads; it is
     durable and it names the foreign key. It is not what the person holding the
     document reads, and until now nothing was — the create returned 201 and the
     refusal lived only in a queue with its own permission key
     (index.ts:433, `scm.autocount.read`). Same facts, addressed to the operator:
     lib/ac-preflight.ts owns the sentence, this only carries it back out. */
  return acNotSentProblems(e, AC_DOC_NOUN[ctx.docType] ?? 'document');
}

// ── enqueue helpers, one per flow ───────────────────────────────────────────

/** SO create. Composes from the row the handler has just committed. */
export async function enqueueSoCreate(
  sb: Sb,
  opts: { companyId: number | null | undefined; docNo: string; createdBy?: number | null },
): Promise<AcEnqueueOutcome> {
  try {
    if (opts.companyId == null) return AC_ENQUEUE_SILENT;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return AC_ENQUEUE_SILENT;
    const header = await readOrThrow('mfg_sales_orders header',
      sb.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', opts.docNo).maybeSingle());
    if (!header) return AC_ENQUEUE_SILENT;
    /* A cutover-imported SO ALREADY exists in AutoCount (mig 0271). Creating it
       again would duplicate the order in the live book. */
    if ((header as { linked_ac_docno?: string | null }).linked_ac_docno) return AC_ENQUEUE_SILENT;
    const items = await readOrThrow('mfg_sales_order_items',
      inAcLineOrder(sb.from('mfg_sales_order_items').select(SO_ITEM_COLS).eq('doc_no', opts.docNo)));
    const rows = (items ?? []) as Record<string, unknown>[];
    const lines = await withLocations(sb, rows, rows.map(soLine));
    /* Composed TWICE on purpose: once to learn which ERP rows produced which
       AutoCount detail (a sofa build is several rows and one detail), once for
       the payload itself. Both calls are pure and the document is already
       committed; sharing state between them would be the only way to get them
       out of step. */
    const bindings = await bindingsFor(sb, opts.companyId, lines.map((l) => l.item_code));
    const { collapsed, details } = composeDetails(lines, { bindings });
    /* The salesperson is resolved for EVERY create, not only when `agent` is
       blank: the composer decides which of the two sources the account book
       gets, and it can only choose between values it has been given. */
    const salespersonName = await readSalespersonName(
      sb, (header as Record<string, unknown>).salesperson_id);
    const outstandingSen = await readSoOutstandingSen(sb, header as Record<string, unknown>);
    const paymentRefs = await readSoPaymentRefs(sb, opts.docNo);
    const body = composeCreateSo(
      header as never, lines, salespersonName, outstandingSen, paymentRefs, { bindings });
    return { queued: await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'create_so',
      docType: 'SO',
      docNo: opts.docNo,
      payload: {
        body: body as unknown as Record<string, unknown>,
        writeback: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: opts.docNo },
        /* The Nth detail in the payload comes from the Nth collapsed line, and
           that line names the ERP rows it was folded from. persistLineKeys
           re-checks the zip against the AutoCount ItemCodes we actually sent. */
        lineWriteback: {
          table: 'mfg_sales_order_items',
          ids: collapsed.map((c) => c.sourceIndexes.map((i) => String(rows[i].id))),
          codes: details.map((d) => d.ItemCode),
        },
      },
      dedupeKey: `create_so:${opts.docNo}`,
      createdBy: opts.createdBy ?? null,
    }), problems: [] };
  } catch (e) {
    const problems = await noteReadFailure(sb, e, { companyId: opts.companyId as number, op: 'create_so', docType: 'SO', docNo: opts.docNo });
    return { queued: false, problems };
  }
}

/**
 * Read a purchase order in the shape composeCreatePo wants.
 *
 * The creditor comes from scm.suppliers through supplier_id — the PO table
 * carries the foreign key, not the code or the name.
 *
 * `agent` is the CONSTANT AC_PURCHASE_AGENT, not null. The ERP has no
 * purchase-agent field and never will have one without an owner decision, but
 * "the ERP has no value" and "send nothing" are not the same thing here:
 * `CreatePo` assigns `po.Agent` unconditionally and `Str` turns both an absent
 * key and a present-null into `""`, so a null was `FK_PO_PurchaseAgent` on
 * every one of the 60 unpushed purchase orders (measured 2026-08-14). `Ref`
 * stays null because the PO's Ref is applied through `Set(() => po.Ref = ...)`
 * on a document that has nothing there yet, and there is no foreign key on it.
 */
async function readPoHeader(sb: Sb, poId: string) {
  const header = await readOrThrow('purchase_orders header',
    sb.from('purchase_orders').select(PO_HEADER_COLS).eq('id', poId).maybeSingle());
  if (!header) return null;
  const h = header as Record<string, unknown>;
  const supplier = h.supplier_id
    ? await readOrThrow('suppliers',
      sb.from('suppliers').select('code, name').eq('id', String(h.supplier_id)).maybeSingle())
    : null;
  const s = supplier as { code?: string | null; name?: string | null } | null;
  /* The same id -> code hop withLocations does for the lines, one row not a set. */
  const purchaseLocation = await readWarehouseCode(sb, h.purchase_location_id);
  return {
    id: String(h.id ?? poId),
    /* Carried for the binding lookup, which narrows by the PO's OWN supplier:
       one internal code can be bound to several, and the one this order buys
       from beats the main one. */
    company_id: (h.company_id as number | null) ?? null,
    supplier_id: h.supplier_id == null ? null : String(h.supplier_id),
    po_number: String(h.po_number ?? ''),
    po_date: (h.po_date as string | null) ?? null,
    creditor_code: s?.code ?? null,
    creditor_name: s?.name ?? null,
    agent: AC_PURCHASE_AGENT,
    ref: null,
    notes: (h.notes as string | null) ?? null,
    purchase_location: purchaseLocation,
    linked_ac_docno: (h.linked_ac_docno as string | null) ?? null,
  };
}

/** PO create. */
export async function enqueuePoCreate(
  sb: Sb,
  opts: { companyId: number | null | undefined; poId: string; createdBy?: number | null },
): Promise<AcEnqueueOutcome> {
  /* Falls back to the id: a header read that FAILED has no number to name the
     note row by, and the id is what every PO route addresses anyway. */
  let poNumber = opts.poId;
  try {
    if (opts.companyId == null) return AC_ENQUEUE_SILENT;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return AC_ENQUEUE_SILENT;
    const header = await readPoHeader(sb, opts.poId);
    if (!header) return AC_ENQUEUE_SILENT;
    poNumber = header.po_number || opts.poId;
    if (header.linked_ac_docno) return AC_ENQUEUE_SILENT;
    const items = await readOrThrow('purchase_order_items',
      inAcLineOrder(sb.from('purchase_order_items').select(PO_ITEM_COLS).eq('purchase_order_id', opts.poId)));
    const rows = (items ?? []) as Record<string, unknown>[];
    const lines = await withLocations(sb, rows, rows.map(soLine));
    const bindings = await bindingsFor(sb, opts.companyId, lines.map((l) => l.item_code), header.supplier_id);

    /* TRANSFER OR CREATE — po-transfer-shape.ts falls back on ANY doubt. READ
       BEFORE COMPOSING: the shape decides whether an ItemCode is even sent
       (docs/bugs/0541). */
    const { shape, sourceRef } = await readPoEnqueueShape(sb, opts.poId);
    const forTransfer = shape.kind === 'transfer';
    const { collapsed, details } = composeDetails(lines, { supplierCode: header.creditor_code, bindings, forTransfer });
    const body = composeCreatePo(header, lines, { bindings, forTransfer });
    if (sourceRef) (body as unknown as Record<string, unknown>).Ref = sourceRef;

    return { queued: await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: shape.kind === 'create' ? 'create_po' : 'so_to_po',   // `wait` is a transfer whose keys are not issued yet
      docType: 'PO',
      docNo: header.po_number,
      docId: opts.poId,
      payload: {
        /* ONE MASTER, TWO SHAPES. FromDocNo resolves at DRAIN; everything else
           a transfer sends is `body`, the object composeCreatePo built two lines
           up, because composeSoToPo takes it and spreads it. That is the fix and
           the reason it is not a third field: this branch used to build its own
           master, and twice a field the create had was missing from it — the
           creditor (host 2026-08-17 09:15, reported as FK_PO_DisplayTerm) and
           the number (10:15, `PO-009968` for `HC-PO-2608-001`, divergence D5).
           Both were patched one at a time and FIVE were still missing after.
           Guide §7c3a, §7c3b, §7c3b-i. */
        body: poBodyForShape(shape, body as never, details),
        /* THE PARENT MUST EXIST FIRST — dispatchOne holds this as `waiting`,
           without burning an attempt, until the sales order has its number. */
        ...(shape.kind === 'transfer' || shape.kind === 'wait'
          ? { fromDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: shape.fromSoDocNo } as AcDocRef }
          : {}),
        writeback: { table: 'purchase_orders', keyCol: 'id', key: opts.poId },
        lineWriteback: {
          table: 'purchase_order_items',
          ids: collapsed.map((c) => c.sourceIndexes.map((i) => String(rows[i].id))),
          codes: details.map((d) => d.ItemCode),
        },
      },
      dedupeKey: `create_po:${opts.poId}`,
      createdBy: opts.createdBy ?? null,
    }), problems: [] };
  } catch (e) {
    const problems = await noteReadFailure(sb, e, {
      companyId: opts.companyId as number, op: 'create_po', docType: 'PO', docNo: poNumber, docId: opts.poId,
    });
    return { queued: false, problems };
  }
}

/** The four conversions. FromDocNo is resolved at drain from the parent's
 *  linked_ac_docno, because it does not exist until the parent's create runs. */
export async function enqueueConvert(
  sb: Sb,
  opts: {
    companyId: number | null | undefined;
    op: Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>;
    /**
     * The source document, or ALL of them when the target merges several.
     *
     * An array is not a special case to be talked out of: merging is the daily
     * shape on the delivery board and the GRN picker, and it used to be written
     * down as `skipped` on the strength of a service limitation that no longer
     * exists (see `AcOutboxPayload.fromDocs`). Pass every source the target
     * actually drew from — the order is kept, and one parent without an
     * AutoCount counterpart makes the whole conversion wait rather than sending
     * a partial merge.
     */
    from: AcDocRef | AcDocRef[];
    to: AcDocRef;
    docType: 'DO' | 'IV' | 'GR' | 'PI';
    docNo: string;
    docId?: string | null;
    docDate?: string | null;
    ref?: string | null;
    createdBy?: number | null;
  },
  /* RETURNS THE OPERATOR'S SENTENCES, the shape the two create routes return
     (#2499) — but the OTHER verdict: the document IS in the accounts and some
     of its fields are not, so `AC_SENT_INCOMPLETE`, and never a block. */
): Promise<AcEnqueueOutcome> {
  /* WHICH SOURCE LINES THIS CONVERSION ACTUALLY TOOK.
     Resolved BEFORE the enqueue so a refusal is recorded instead of a wrong
     transfer being queued. */
  const source = await readConvertSourceKeys(sb, opts.op, opts.docId ?? null);
  if (source.refuse) {
    /* No problems: the skip is written where the operator looks and carries its
       own sentence there (classifyAcSkip). */
    await recordConvertSkipped(sb, {
      companyId: opts.companyId,
      op: opts.op,
      docType: opts.docType,
      docNo: opts.docNo,
      docId: opts.docId ?? null,
      reason: source.refuse,
      createdBy: opts.createdBy ?? null,
    });
    return AC_ENQUEUE_SILENT;
  }
  /* THE SUPPLIER, for the two conversions whose target is a purchase document.
     Resolved here rather than inline below so a null is one branch and not a
     silent empty spread buried in an object literal. */
  const froms = Array.isArray(opts.from) ? opts.from : [opts.from];
  /* A caller that names no source at all is a caller that has lost its parent;
     it belongs in recordParentlessCreate, not here, and enqueueing a transfer
     with nothing to transfer FROM would fail on the host with a message about
     the payload rather than about the document. */
  if (!froms.length) return AC_ENQUEUE_SILENT;
  const creditor = PURCHASE_CONVERSION.has(opts.op)
    ? await readConvertCreditor(sb, froms[0])
    : null;
  /* THE DOCUMENT'S OWN HEADER, resolved before the enqueue for the same reason
     the source keys are: what goes in the payload is decided once, here, where
     an omission can still be written down. */
  const own = await readConvertHeaderFacts(sb, opts.docType, opts.docId ?? null);
  const queued = await enqueueAcOp(sb, {
    companyId: opts.companyId,
    op: opts.op,
    docType: opts.docType,
    docNo: opts.docNo,
    docId: opts.docId ?? null,
    payload: {
      /* DtlKeys NAMES THE SUBSET. Omitting it makes AcSyncService fall through
         to DtlKeys() and transfer EVERY still-outstanding line on the parent
         (AcSyncService.cs:382-411) — so a delivery order shipping 2 of a sales
         order's 5 lines produced an AutoCount DO of all 5, moving stock in the
         account book that never moved here. Partial shipment is the daily case,
         not an edge one, so the ERP has to say which lines it took.
         readConvertSourceKeys returns the keys only when it can name EVERY
         source line; otherwise it either refuses (above) or leaves the field
         off for a whole-document transfer, where "all outstanding" is the same
         answer and AutoCount's own book is the better authority on it. */
      body: {
        /* THE ERP NUMBERS ITS OWN DOCUMENTS, on every type.
           A create already sent its DocNo and AutoCount took it; a conversion
           sent none, so AutoCount auto-numbered the DO, the GRN, the invoice
           and the purchase invoice — four of the six types carrying a number
           nobody in this building would recognise, and every reconciliation
           having to go through linked_ac_docno instead of the number on the
           paperwork. The service was always ready for it: SalesHeader and
           PurchaseHeader both apply DocNo when the payload carries one.
           Supplying our own does NOT advance AutoCount's counter, so anything
           raised in its own UI keeps its own series in parallel — which is
           what tells the two apart. */
        DocNo: opts.docNo ?? null,
        /* ── THE DOCUMENT'S OWN HEADER, AND IT IS NOT A LIST OF FIELDS ───────
           `AcDownstreamSpec.facts` projected onto the keys this route's header
           applier actually applies. A fact added to a spec reaches this payload
           with no edit here; one no route can carry fails the build by name.
           Why, and what the four conversions used to drop: the composer's own
           notes in autocount-convert-lines.ts, and guide §7c5.
           THE CALLER STILL WINS — `opts` is spread AFTER, and the `if` stays
           because a present-null is how you blank a live book. Neither key has
           ever been passed by a caller (all eight verified, §7c5). */
        ...own.header,
        ...(opts.docDate ? { DocDate: opts.docDate } : {}),
        ...(opts.ref ? { Ref: opts.ref } : {}),
        /* THE CUSTOMER, AND THE TRANSFER DOES NOT HAPPEN WITHOUT ONE.
           PROVEN on the AutoCount host 2026-08-17 00:55: a conversion whose
           target carries no DebtorCode when the transfer runs is refused —
           `AppException: Debtor Code is empty.` from FullTransfer, and the
           contentless `Invalid transfer item.` from AddPartialTransferDetail,
           which is what kept HC-DO-2608-001, HC-DO-2608-002 and HC-SI-2608-001
           out of the book for a week. `cmd.AddNew()` creates the target empty
           and `SalesHeader` never set one.

           #2340 made the service fall back to reading the account off the
           SOURCE document in the book, and that fallback has to stay — it is
           the only thing that drains an outbox row composed before this line
           existed. But it is a lookup the ERP should not be making the service
           do: we know the customer, and a payload that states it cannot be
           wrong about which source row the service happened to read.

           BOTH SIDES NOW, AND D15 IS CLOSED. This used to read "SALES SIDE ONLY",
           on two grounds that were both wrong by 2026-08-17. The first — that a
           creditor needs a `grn -> purchase_order -> supplier` join because those
           tables have no supplier column — is refuted by the schema: `grns` and
           `purchase_invoices` each carry `supplier_id uuid NOT NULL`, so it is
           one hop (see SUPPLIER_BEARING_SOURCE). The second — that `po_to_gr` has
           never succeeded anyway — stopped being true at 23:09 that night, when
           HC-GR-2608-001 and then HC-PI-2608-001 entered the book. The creditor
           was supplied by hand for that run; this is the line that stops it
           having to be.

           The service still reads the payload FIRST and the source document in
           the book second, and that book fallback must stay: it is the only thing
           that drains a row composed before this line existed. `dispatchOne`
           carries a drain-time backfill for the same rows, the way #2345 did for
           `so_to_po` — the drain REPLAYS a stored payload and never recomposes,
           so fixing the enqueue alone strands everything already queued. */
        ...(SALES_CONVERSION.has(opts.op) ? { DebtorCode: AC_DEBTOR_CODE } : {}),
        ...(creditor ?? {}),
        ...(source.keys ? { DtlKeys: source.keys } : {}),
        /* PARTIAL BY QUANTITY, and only then. readConvertSourceKeys returns
           this exclusively when some source line is being taken in PART —
           "3 of 5" — because a quantity on the payload routes AcSyncService
           onto the documented PartialTransfer overloads, which it refuses to
           fall back from. Without it the service moves each named line's WHOLE
           outstanding quantity: a delivery of 2 out of 5 booked 5 in a licensed
           account book and answered ok. */
        ...(source.details ? { Details: source.details } : {}),
      },
      /* ONE source keeps the field it has always used, so a payload composed
         today is byte-identical to one composed last week and the contract test
         over AcSyncService.cs still reads FromDocNo where it expects it. */
      ...(froms.length === 1 ? { fromDoc: froms[0] } : { fromDocs: froms }),
      writeback: opts.to,
      /* The conversion routes report the lines they created exactly as the
         create routes do (AcSyncService.cs:163-166 pick the detail table, :171
         returns CreatedLines). Capturing them here is what makes a later EDIT of
         this document expressible at all — without a stored DtlKey composeEdit
         refuses, because a wrong key silently rewrites a different line in a
         live book while a missing one only refuses. Best-effort: a read failure
         degrades to "no keys stored", which costs a refused edit later and is
         visible, and must never cost the conversion itself. */
      lineWriteback: await readConvertTargetLines(sb, opts.op, opts.docId ?? null),
      /* WHAT THIS DOCUMENT IS GOING WITHOUT, kept here as well as in the row's
         reason: the drain clears last_error on success and the blank in the
         book does not go with it. */
      ...(own.notCarried.length ? { notCarried: own.notCarried } : {}),
    },
    dedupeKey: `${opts.op}:${opts.docId ?? opts.docNo}`,
    /* `acNeedsAttention` branches on STATUS, so a note on a `pending` row
       reports without crying wolf. */
    reason: acNotCarriedReason(own.notCarried),
    createdBy: opts.createdBy ?? null,
  });
  /* NOTHING QUEUED, NOTHING TO SAY: flag off, no company, or already queued —
     none of those left a field behind, and a warning about something that did
     not happen is how people learn to click through warnings. */
  return { queued, problems: queued ? acNotCarriedProblems(own.notCarried, AC_DOC_KIND[opts.docType]) : [] };
}

/** The noun each transferred document is called in a sentence to an operator. */
const AC_DOC_KIND: Record<'DO' | 'IV' | 'GR' | 'PI', AcDocKind> = {
  DO: 'delivery order', IV: 'invoice', GR: 'goods receipt', PI: 'purchase invoice',
};

/** The ItemCode column each line table spells its product in. */
const LINE_CODE_COL: Record<AcLineTable, string> = {
  mfg_sales_order_items: 'item_code',
  purchase_order_items: 'item_code',
  delivery_order_items: 'item_code',
  grn_items: 'item_code',
  sales_invoice_items: 'item_code',
  purchase_invoice_items: 'item_code',
};

/**
 * Read a line's AutoCount identity BEFORE the route destroys the row, so the
 * removal can be pushed as a RETIREMENT rather than vanishing.
 *
 * This is the whole reason line removal reaches AutoCount at all. `/edit`
 * applies only the lines it is GIVEN (AcSyncService.cs:490-540): a deleted row
 * is simply absent from the recomposed payload, and the account book keeps the
 * line live, outstanding, and transferable into a later DO or GRN. The ERP has
 * to name it and say "retire this one".
 *
 * Returns [] when the row carries no DtlKey — AutoCount never knew about the
 * line, so there is nothing there to retire and nothing to refuse over. Never
 * throws: it runs on the delete path, where an AutoCount concern must not cost
 * the user their save.
 */
export async function retiredLineOf(
  sb: Sb,
  table: AcLineTable,
  itemId: string,
): Promise<AcRetiredLine[]> {
  try {
    const codeCol = LINE_CODE_COL[table];
    const { data, error } = await sb.from(table)
      .select(`${codeCol}, description2, linked_ac_dtlkey`).eq('id', itemId).maybeSingle();
    if (error || !data) return [];
    const r = data as unknown as Record<string, unknown>;
    const n = r.linked_ac_dtlkey == null ? NaN : Number(r.linked_ac_dtlkey);
    if (!Number.isFinite(n) || n <= 0) return [];
    const desc2 = r.description2 == null ? undefined : String(r.description2);
    return [{ DtlKey: n, ItemCode: String(r[codeCol] ?? ''), ...(desc2 ? { Desc2: desc2 } : {}), Gone: 'deleted' as const }];
  } catch {
    return [];
  }
}

/**
 * Record a conversion the ERP will NOT send, and why.
 *
 * THE MERGED CONVERSION IS NO LONGER ONE OF THESE. This comment used to say
 * that AutoCount has no shape for several Sales Orders on one Delivery Order,
 * and that was true of the primitive: `AddPartialTransferDetail` refuses a key
 * array drawn from more than one source document — measured on the live book
 * 2026-08-16, `InvalidTransferItemException`. It was never true of the TARGET.
 * `PlanTransfer` now takes `FromDocNos`, the documented `FullTransfer` takes an
 * array of document numbers, and the by-line shape groups the keys per source
 * and invokes the primitive once per group. So a merge is enqueued like any
 * other conversion (`enqueueConvert` with an array) and no longer skipped.
 *
 * What still reaches this function: a conversion whose source lines cannot be
 * NAMED — `readConvertSourceKeys` refusing a partial transfer whose source
 * lines carry no DtlKey — and, through `recordParentlessCreate`, a document
 * with no source document at all. Both are still real, and both are still
 * written down rather than dropped: a shipment that exists in one system and
 * not the other must have something to find it by.
 */
export async function recordConvertSkipped(
  sb: Sb,
  opts: {
    companyId: number | null | undefined;
    op: Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>;
    docType: 'DO' | 'IV' | 'GR' | 'PI';
    docNo: string;
    docId?: string | null;
    reason: string;
    createdBy?: number | null;
  },
): Promise<boolean> {
  return enqueueAcOp(sb, {
    companyId: opts.companyId,
    op: opts.op,
    docType: opts.docType,
    docNo: opts.docNo,
    docId: opts.docId ?? null,
    payload: { body: {} },
    status: 'skipped',
    reason: opts.reason,
    createdBy: opts.createdBy ?? null,
  });
}

/**
 * Record a document the ERP created that AUTOCOUNT CANNOT HOLD AT ALL, and why.
 *
 * The ERP can create a Delivery Order with no Sales Order behind it, a GRN with
 * no Purchase Order (owner decision 2026-05-29, stated in grns.ts), and a Sales
 * or Purchase Invoice with no delivery / receipt behind it. AutoCount cannot:
 * the 2.2 SDK's ONLY construction primitive for these four is
 * AddPartialTransferDetail(fromDocType, dtlKeys) — you build a DO/GRN/Invoice by
 * transferring a SOURCE document's lines — so AcSyncService has /create-so and
 * /create-po and no third create, and could not sensibly be given one.
 *
 * This is therefore not a bug to fix later; it is a permanent SHAPE MISMATCH
 * between the two systems. What WAS a bug is that it happened in silence. Every
 * one of these documents exists in the ERP and will never exist in the account
 * book, which is exactly the kind of divergence the owner's outstanding rule
 * trips over — and until now nothing recorded it, so nothing could find it.
 *
 * Recorded under the CONVERSION op that would have produced the document
 * (so_to_do for a parentless DO, and so on), because that is the operation that
 * did not happen, and because 0277's CHECK constraint admits exactly the eight
 * operations AcSyncService serves — inventing a ninth would need a migration to
 * describe an operation that can never run.
 */
export async function recordParentlessCreate(
  sb: Sb,
  opts: {
    companyId: number | null | undefined;
    docType: 'DO' | 'IV' | 'GR' | 'PI';
    docNo: string;
    docId?: string | null;
    /** What the ERP document is missing, in the operator's vocabulary. */
    missing: string;
    createdBy?: number | null;
  },
): Promise<boolean> {
  const OP: Record<'DO' | 'IV' | 'GR' | 'PI', Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>> = {
    DO: 'so_to_do', GR: 'po_to_gr', IV: 'do_to_iv', PI: 'gr_to_pi',
  };
  return recordConvertSkipped(sb, {
    companyId: opts.companyId,
    op: OP[opts.docType],
    docType: opts.docType,
    docNo: opts.docNo,
    docId: opts.docId ?? null,
    /* THE SENTENCE LIVES IN autocount-outbox-status.ts, beside the needle that
       classifies it. It used to be written out here and it carried
       "(AddPartialTransferDetail is the SDK's only primitive)" — which the owner
       read off the live AutoCount Sync page on 2026-08-16, hours after having
       that exact identifier removed from the page's own copy. It came back
       through the SERVER. A reason is read by the owner, so what it says is now
       pinned by a test the way the codes already were. */
    reason: acParentlessCreateReason(opts.missing),
    createdBy: opts.createdBy ?? null,
  });
}

/**
 * REFUSE a GRN whose linked_ac_docno is its source PO's number, not its own.
 *
 * MEASURED ON PRODUCTION, 2026-08-11: all 291 linked GRNs in company 1 point at
 * a PO. `HC-GRN-000001 -> PO-000136`, and PO-000136 is in the book's PO table
 * and in no GR table. This is not corruption — it is a deliberate cutover
 * convention that check-truth-scope.mjs:161 already documents and that
 * contradicts 0276's own COMMENT: the creating script wrote the PO's AutoCount
 * number into the GRN's column, and the real AutoCount GR numbers live on the
 * PO in `linked_ac_grn_docnos`.
 *
 * WHY THIS MUST BE A REFUSAL AND NOT A REPAIR HERE. The drain resolves a
 * cancel's and an edit's `DocNo` from `selfDoc.linked_ac_docno`, so without this
 * guard a GRN cancel asks a LIVE ACCOUNT BOOK to cancel `GR PO-000136`. In
 * practice AcSyncService would fail loudly — `GoodsReceivedNoteCommand` looks a
 * GRN up by its own number and finds none — but "it happens to fail" is not a
 * safety property, and it would burn six attempts and land a confusing row in
 * 'failed' every time. A wrong value is worse than a blank: the ERP refuses to
 * send it, writes down which document and why, and a later lane can decide what
 * the GRN's real AutoCount number is. Picking one from
 * `linked_ac_grn_docnos` would be a guess — a PO received in several deliveries
 * has SEVERAL, and none of them is "this ERP GRN".
 */
async function grnLinkIsReallyAPo(sb: Sb, grnId: string): Promise<string | null> {
  try {
    const { data: g, error: gErr } = await sb.from('grns')
      .select('grn_number, linked_ac_docno').eq('id', grnId).maybeSingle();
    if (gErr || !g) return null;
    const link = (g as { linked_ac_docno: string | null }).linked_ac_docno;
    if (!link) return null;
    /* EXACT, not a prefix heuristic. AutoCount's own numbering is not reliably
       type-prefixed in this book (its invoices are 'I-...', and there are live
       stragglers like 'GGR-', 'DR-' and one 'SEAMPIFY TESTING #1'), so the test
       is membership: does a PURCHASE ORDER claim this same AutoCount number? */
    const { data: po, error: pErr } = await sb.from('purchase_orders')
      .select('po_number').eq('linked_ac_docno', link).limit(1).maybeSingle();
    if (pErr || !po) return null;
    return `its linked_ac_docno is "${link}", which is the AutoCount number of purchase order `
      + `${(po as { po_number: string }).po_number}, not of this goods receipt. The cutover wrote the `
      + 'PO\'s number here (see scm.purchase_orders.linked_ac_grn_docnos for the real GR numbers), '
      + 'so sending it would name the wrong document in a live account book.';
  } catch {
    return null;
  }
}

/**
 * Cancel.
 *
 * If the operation that would BRING this document into AutoCount is still
 * sitting in the outbox, the right answer is not to create-then-cancel in a
 * live account book: mark that row 'skipped' and queue nothing. For an SO or PO
 * that operation is its create; for a DO or GRN it is the conversion that
 * produces it, since neither has a create of its own.
 */
export async function enqueueCancel(
  sb: Sb,
  opts: {
    companyId: number | null | undefined;
    docType: AcDocType;
    docNo: string;
    self: AcDocRef;
    docId?: string | null;
    createdBy?: number | null;
  },
): Promise<boolean> {
  try {
    if (opts.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return false;
    const pending = await findPendingOriginatingOp(sb, opts.companyId, opts.docType, opts.docNo, opts.docId ?? null);
    if (pending) {
      await sb.from('autocount_outbox')
        .update({
          status: 'skipped',
          last_error: 'cancelled in the ERP before it was written to AutoCount',
          updated_at: new Date().toISOString(),
        })
        .eq('id', pending.id);
      return false;
    }
    const mislinked = opts.docType === 'GR' && opts.docId
      ? await grnLinkIsReallyAPo(sb, opts.docId)
      : null;
    if (mislinked) {
      await enqueueAcOp(sb, {
        companyId: opts.companyId,
        op: 'cancel',
        docType: opts.docType,
        docNo: opts.docNo,
        docId: opts.docId ?? null,
        payload: { body: {} },
        status: 'skipped',
        reason: `refused to cancel in AutoCount: ${mislinked}`,
        createdBy: opts.createdBy ?? null,
      });
      return false;
    }
    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'cancel',
      docType: opts.docType,
      docNo: opts.docNo,
      docId: opts.docId ?? null,
      payload: { body: { DocType: opts.docType }, selfDoc: opts.self },
      dedupeKey: `cancel:${opts.docType}:${opts.docNo}`,
      createdBy: opts.createdBy ?? null,
    });
  } catch {
    return false;
  }
}

/**
 * Edit (header, lines, and variant/SKU changes — they are all line fields).
 *
 * Composed from the document AS IT IS NOW, immediately after the save
 * committed. Two cases the naive version gets wrong:
 *
 *   • the create is still queued -> REPLACE its payload with the new state.
 *     Queueing an edit behind a stale create would push the pre-edit order into
 *     AutoCount and then correct it, which is visible in the live book.
 *   • no AutoCount counterpart and no pending create -> nothing to edit.
 *     Silently correct: the write-back was off when the document was made.
 */
export async function enqueueEdit(
  sb: Sb,
  opts: {
    companyId: number | null | undefined;
    docType: AcDocType;
    /** An SO is keyed by its number; every other type by its id. */
    docNo?: string | null;
    docId?: string | null;
    createdBy?: number | null;
    /**
     * ERP row ids this very request INSERTED.
     *
     * A keyless line means two opposite things - just added, or never
     * backfilled - and guessing "added" appends a second copy of a line the
     * account book already holds. The ERP is therefore not allowed to infer it:
     * the route that did the adding says so, and composeEdit honours it only
     * when every keyless line on the document is one of these.
     */
    newLineIds?: string[];
    /**
     * Lines the ERP has just HARD-DELETED, named by the AutoCount key the row
     * carried. Composed from the document as it is now, so a deleted line is
     * simply absent — and /edit applies only the lines it is given, which would
     * leave the account book holding it live, outstanding and transferable. The
     * delete route has to say so explicitly, and this is how.
     */
    retire?: AcRetiredLine[];
    /** ERP columns THIS REQUEST wrote — same contract as `newLineIds`: the
     *  composer reads the SAVED row and cannot tell a clear from a blank. */
    touchedFields?: readonly string[];
  },
): Promise<boolean> {
  try {
    if (opts.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return false;

    const retired = (opts.retire ?? []).filter((r) => Number.isFinite(Number(r.DtlKey)));
    const composed = opts.docType === 'SO'
      ? await composeSoState(sb, String(opts.docNo), retired, opts.newLineIds, opts.touchedFields)
      : opts.docType === 'PO'
        ? await composePoState(sb, String(opts.docId ?? opts.docNo), retired, opts.newLineIds)
        : await composeDownstreamState(sb, opts.docType, String(opts.docId ?? opts.docNo), retired, opts.newLineIds);
    if (!composed) return false;
    /* A PO route knows its id, not its number; the outbox row is keyed by the
       human document number so it lines up with the create row. */
    const docNo = composed.docNo;

    const pending = await findPendingOriginatingOp(sb, opts.companyId, opts.docType, docNo, opts.docId ?? null);
    if (pending) {
      /* SO / PO: the create is still unsent, so fold the new state INTO it.
         Queueing an edit behind a stale create would push the pre-edit order
         into AutoCount and then correct it, which is visible in the live book. */
      if (composed.create) {
        const { error } = await sb.from('autocount_outbox')
          .update({
            payload: { ...(pending.payload ?? {}), body: composed.create() },
            updated_at: new Date().toISOString(),
          })
          .eq('id', pending.id);
        return !error;
      }
      /* DO / GRN / IV / PI: there is no create to fold into — the pending row is
         a CONVERSION, and its payload is a FromDocNo plus header overrides. The
         body must not be touched or the conversion is destroyed.

         And the edit genuinely cannot be carried: a conversion transfers the
         PARENT document's outstanding lines, so when this one drains AutoCount
         will build the document from the source, not from the state the
         operator just saved. That is a real divergence in the window between
         creating a downstream document and its conversion draining, so it is
         WRITTEN DOWN rather than dropped. */
      await enqueueAcOp(sb, {
        companyId: opts.companyId,
        op: 'edit',
        docType: opts.docType,
        docNo,
        docId: opts.docId ?? null,
        payload: { body: {} },
        status: 'skipped',
        reason:
          `edited before its AutoCount counterpart existed: the ${opts.docType} conversion is `
          + 'still queued and will transfer the source document\'s lines, not this edit. '
          + 'Re-save the document once the conversion has drained.',
        createdBy: opts.createdBy ?? null,
      });
      return false;
    }

    /* No AutoCount counterpart and no pending originating op: the document was
       made while the write-back was off. Nothing to edit, and nothing to say. */
    if (!composed.linkedAcDocNo) return false;

    /* Same refusal as the cancel path, for the same reason: the drain resolves
       an edit's DocNo from linked_ac_docno, and every linked GRN in production
       carries its PO's number there. Editing "GR PO-000136" names a document
       the account book does not have under that type. */
    const mislinked = opts.docType === 'GR' && opts.docId
      ? await grnLinkIsReallyAPo(sb, opts.docId)
      : null;
    if (mislinked) {
      await enqueueAcOp(sb, {
        companyId: opts.companyId,
        op: 'edit',
        docType: opts.docType,
        docNo,
        docId: opts.docId ?? null,
        payload: { body: {} },
        status: 'skipped',
        reason: `refused to edit in AutoCount: ${mislinked}`,
        createdBy: opts.createdBy ?? null,
      });
      return false;
    }

    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'edit',
      docType: opts.docType,
      docNo,
      docId: opts.docId ?? null,
      payload: {
        body: composed.edit() as unknown as Record<string, unknown>,
        selfDoc: composed.self,
        /* The line photographs, as KEYS. Only the sales order composes them
           today — it is the document the cutover pulled the pictures out of,
           and `Photos` is an /edit field, which is the one route the service
           takes them on. The drain fetches the bytes. */
        ...(composed.photos ? { photos: composed.photos } : {}),
      },
      /* NULL: two successive saves are two different intents and must both be
         applied, in created_at order. */
      dedupeKey: null,
      createdBy: opts.createdBy ?? null,
    });
  } catch (e) {
    await noteReadFailure(sb, e, {
      companyId: opts.companyId as number,
      op: 'edit',
      docType: opts.docType,
      docNo: String(opts.docNo ?? opts.docId ?? ''),
      docId: opts.docId ?? null,
    });
    return false;
  }
}

async function findPendingOriginatingOp(
  sb: Sb,
  companyId: number,
  docType: string,
  docNo: string,
  docId?: string | null,
): Promise<{ id: string; payload: AcOutboxPayload } | null> {
  let q = sb.from('autocount_outbox')
    .select('id, payload')
    .eq('company_id', companyId)
    .eq('doc_type', docType)
    /* The op that BRINGS this document into AutoCount. For an SO or PO that is
       its create; for a DO / invoice / GRN / purchase invoice it is the
       conversion that produces it — a DO has no create of its own. Either way,
       a still-pending one means AutoCount does not have the document yet. */
    .in('op', ['create_so', 'create_po', 'so_to_do', 'po_to_gr', 'do_to_iv', 'gr_to_pi'])
    .eq('status', 'pending');
  /* A PO is addressed by id everywhere in its router; an SO by its number.
     Match on whichever the caller actually has, or a PO edit would miss its own
     pending create and push a stale order into the live book. */
  q = docId ? q.eq('doc_id', docId) : q.eq('doc_no', docNo);
  const { data } = await q.maybeSingle();
  return (data as { id: string; payload: AcOutboxPayload } | null) ?? null;
}

/**
 * The current state of a DO / GRN / Sales Invoice / Purchase Invoice, in the
 * shape enqueueEdit wants.
 *
 * `create` is NULL and that is the point: these four have no create route on
 * AcSyncService (its Handle() switch has /create-so and /create-po and nothing
 * else — AcSyncService.cs:160-170), because the SDK's only construction
 * primitive is AddPartialTransferDetail. A parentless one cannot be expressed at
 * all, and enqueueEdit reads the null to know it must not fold this state into a
 * pending conversion.
 *
 * Lines are ordered by created_at then id so the sequence is STABLE across
 * calls. That ordering is not assumed to match AutoCount's — persistLineKeys
 * checks the correspondence and refuses rather than trusting it.
 */
async function composeDownstreamState(
  sb: Sb, docType: 'DO' | 'GR' | 'IV' | 'PI', id: string,
  retired: AcRetiredLine[] = [], newLineIds?: string[],
) {
  const spec = DOWNSTREAM[docType];
  const header = await readOrThrow(`${spec.table} header`,
    sb.from(spec.table).select(spec.headerCols).eq('id', id).maybeSingle());
  if (!header) return null;
  const h = header as unknown as Record<string, unknown>;
  const items = await readOrThrow(spec.itemTable,
    inAcLineOrder(sb.from(spec.itemTable).select(spec.itemCols).eq(spec.itemFk, id)));
  const lines = ((items ?? []) as unknown as Record<string, unknown>[]).map(spec.line);
  const docNo = spec.docNoOf(h);
  return {
    docNo,
    linkedAcDocNo: (h.linked_ac_docno as string | null) ?? null,
    /* The four downstream documents carry no photographs: the cutover pulled
       FurtherDescription out of SO and PO lines, and nothing writes photo_urls
       on a delivery, receipt or invoice line. Declared so every state builder
       has ONE shape and the caller needs no narrowing. */
    photos: undefined as AcOutboxPayload['photos'],
    self: { table: spec.table, keyCol: 'id', key: id } as AcDocRef,
    create: null as (() => Record<string, unknown>) | null,
    /* The SAME master the conversion route projects, narrowed to /edit's own
       allow-list instead — see `AcDownstreamSpec.facts`. */
    /* Add-a-line, same contract as the SO's and PO's — docs/bugs/0588-*. */
    edit: () => composeEdit(docType, String(h.linked_ac_docno ?? docNo),
      downstreamEditHeader(docType, h), lines,
      newLineIds?.length ? { newLineIds: new Set(newLineIds) } : {}, retired),
  };
}

async function composeSoState(sb: Sb, docNo: string, retired: AcRetiredLine[] = [], newLineIds?: string[], touchedFields: readonly string[] = []) {
  const header = await readOrThrow('mfg_sales_orders header',
    sb.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', docNo).maybeSingle());
  if (!header) return null;
  const items = await readOrThrow('mfg_sales_order_items',
    inAcLineOrder(sb.from('mfg_sales_order_items').select(SO_ITEM_COLS).eq('doc_no', docNo)));
  const soRows = (items ?? []) as Record<string, unknown>[];
  const lines = await withLocations(sb, soRows, soRows.map(soLine));
  const h = header as Record<string, unknown>;
  const bindings = await bindingsFor(sb, (h.company_id as number | null) ?? null, lines.map((l) => l.item_code));
  const salespersonName = await readSalespersonName(sb, h.salesperson_id);
  const outstandingSen = await readSoOutstandingSen(sb, h);
  const paymentRefs = await readSoPaymentRefs(sb, docNo);
  const poRaised = await poRaisedFromSo(sb, docNo);
  return {
    docNo,
    linkedAcDocNo: (h.linked_ac_docno as string | null) ?? null,
    /* The line photographs, named by the AutoCount line. Built here because
       this is where the rows are read; materialised at drain. */
    photos: photosOf(soRows),
    self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: docNo } as AcDocRef,
    /* LAZY. An edit builds this same state, and composing a create it will
       never send would refuse the edit for the create's reasons — a line with
       no stock location is fatal to a create and irrelevant to an edit. */
    create: () => composeCreateSo(header as never, lines, salespersonName, outstandingSen, paymentRefs, { bindings }) as unknown as Record<string, unknown>,
    /* LAZY on purpose. composeEdit REFUSES a line with no AutoCount DtlKey, and
       the caller does not always need an edit: when the create is still sitting
       unsent in the outbox it replaces that create's payload instead, and a
       document that has never reached AutoCount cannot possibly have line keys
       yet. Composing eagerly would refuse that legitimate path. */
    edit: () => composeEdit(
      'SO', String(h.linked_ac_docno ?? docNo),
      soEditHeader(h, salespersonName, lines, outstandingSen, paymentRefs, touchedFields), lines,
      {
        bindings,
        ...(newLineIds && newLineIds.length ? { newLineIds: new Set(newLineIds) } : {}),
        /* A rebuild would void PODTL.FromSODtlKey on every purchase line raised
           from this order, and downstream-lock does NOT count purchase orders —
           so this order is still editable. Refuse the MECHANISM, never the edit
           (scm/lib/so-po-raised.ts). */
        ...(poRaised ? { rebuildBlocked: 'A purchase order was raised from this sales order, so its '
          + 'line keys are held by PODTL.FromSODtlKey and cannot be reissued.' } : {}),
      },
      retired,
    ),
  };
}

async function composePoState(sb: Sb, poId: string, retired: AcRetiredLine[] = [], newLineIds?: string[]) {
  const header = await readPoHeader(sb, poId);
  if (!header) return null;
  const items = await readOrThrow('purchase_order_items',
    inAcLineOrder(sb.from('purchase_order_items').select(PO_ITEM_COLS).eq('purchase_order_id', poId)));
  const poRows = (items ?? []) as Record<string, unknown>[];
  const lines = await withLocations(sb, poRows, poRows.map(soLine));
  /* A line this request just ADDED inherits the purchase order's own warehouse
     when it has none of its own. Done HERE, on the line, rather than as an
     option on composeEdit: an EXISTING line with no location must keep omitting
     the key so the account book keeps the value it owns, and only this composer
     knows which lines are new. AutoCount refuses a detail whose Location is not
     in dbo.Location, and it saves the document in one call. */
  const newIds = new Set(newLineIds ?? []);
  if (newIds.size && header.purchase_location) {
    for (const l of lines) if (!l.location && l.id && newIds.has(l.id)) l.location = header.purchase_location;
  }
  const poBindings = await bindingsFor(sb, header.company_id ?? null, lines.map((l) => l.item_code), header.supplier_id);
  return {
    docNo: header.po_number || poId,
    linkedAcDocNo: header.linked_ac_docno,
    /* PO line photographs, as KEYS — same shape as the sales order's, opened
       2026-08-31 on the owner's word (asked whether purchase orders should send
       them too, he answered 「要」). Nothing else had to change: `photosOf` reads
       `linked_ac_dtlkey` + `photo_urls` off the raw row, the drain fetches the
       bytes for any edit that carries them, and AcSyncService's line loop is
       document-type agnostic — `Photos` becomes FurtherDescription on a purchase
       detail exactly as it does on a sales one. */
    photos: photosOf(poRows),
    self: { table: 'purchase_orders', keyCol: 'id', key: poId } as AcDocRef,
    create: () => composeCreatePo(header, lines, { bindings: poBindings }) as unknown as Record<string, unknown>,
    /* No Ref: the ERP has no such field on a purchase order, and /edit applies
       only the keys it is GIVEN (AcSyncService.cs:369 `h.ContainsKey`). Sending
       null would blank whatever the account book has there. */
    edit: () => composeEdit('PO', String(header.linked_ac_docno ?? header.po_number), present({
      CreditorName: header.creditor_name,
      Description: header.notes,
    }), lines, {
      supplierCode: header.creditor_code,
      bindings: poBindings,
      /* Add-a-line, same contract as the sales order's: the ROUTE names the row
         it just inserted, and composeEdit honours it only when every other line
         on the document already carries a key. Until this was wired, a line
         added to a purchase order already in the account book refused the whole
         document — correctly, because a keyless line is otherwise
         indistinguishable from one the backfill missed, and guessing "new"
         appends a duplicate into a live book (mfg-purchase-orders.ts, the
         convert-from-SO append, says exactly this). Their stock location is
         filled in above, on the line. */
      ...(newLineIds && newLineIds.length ? { newLineIds: new Set(newLineIds) } : {}),
    }, retired),
  };
}

// ── drain ───────────────────────────────────────────────────────────────────

/* soEditHeader lives in ./so-edit-header — a composer, not IO, and this file
   has hit its 2,000-line cap three times in one day. */

/**
 * What AutoCount calls each of these products, from the LIVE binding.
 *
 * `scm.supplier_material_bindings` is this ERP's own record of the cross-ref:
 * `item_code` is our internal code, `supplier_sku` is AutoCount's, one row
 * per supplier. It was populated at the cutover precisely so ERP codes could be
 * pushed BACK, and it is the only one of the two sources that GROWS — the
 * compiled CSV is a snapshot of the book on 2026-08-05 and cannot know a
 * product opened since.
 *
 * That gap was not cosmetic: without this the resolver refused every
 * post-cutover SKU, a refused line refuses the whole document, and the document
 * never reached the drain — so `/ensure-masters` never ran for the very case it
 * was built for.
 *
 * `is_main_supplier` first, so a code bound to several suppliers resolves to the
 * one the business actually buys from. A PO narrows further: it knows its own
 * creditor, and that supplier's binding wins over the main one.
 *
 * THE CODES ASKED FOR MUST BE THE CODES THE RESOLVER LOOKS UP, and for a sofa
 * those are not the codes on the ERP lines. Callers pass raw line codes, but D9
 * collapses a sofa's compartments into ONE line carrying a SYNTHESISED
 * `<model>-1S` (autocount-sofa-collapse.ts:356), and that is the string
 * resolveAcItemCode checks the binding map for. Querying only the raw codes
 * fetched bindings for '9028-1A(LHF)' and friends while the resolver asked for
 * '9028-1S' — so the override could never fire for ANY sofa, and the four sofa
 * models whose ERP code maps to two AutoCount items were unresolvable by any
 * amount of data entry. Expanding the query with each line's sofa base code
 * costs nothing for a non-sofa line (splitSofaCode returns null).
 */
async function bindingsFor(
  sb: Sb,
  companyId: number | null | undefined,
  codes: string[],
  supplierId?: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const raw = codes.map((c) => (c ?? '').trim()).filter(Boolean);
  const sofaBases = raw
    .map((c) => splitSofaCode(c))
    .filter((s): s is { model: string; compartment: string } => s != null)
    .map((s) => `${s.model}-1S`);
  const wanted = [...new Set([...raw, ...sofaBases])];
  if (!wanted.length) return out;
  /* Through the SHARED reader (lib/supplier-bindings.ts): chunked, paged and
     TOTALLY ordered. `is_main_supplier` first is the rule this resolver depends
     on — "a code bound to several suppliers resolves to the one the business
     actually buys from" is decided by which row arrives first — and on its own
     it leaves every tie in planner order. `readOrThrow`'s contract is kept: a
     failed read still throws rather than resolving to a silently short map. */
  const rows = await readOrThrow('supplier_material_bindings', readMfgProductBindings<Record<string, unknown>>(sb, {
    codes: wanted,
    companyId,
    select: 'item_code, supplier_id, supplier_sku, ac_item_code, is_main_supplier',
  }));
  const bySupplier = new Map<string, string>();
  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    const code = String(r.item_code ?? '').trim().toUpperCase();
    /* `ac_item_code` FIRST, `supplier_sku` only while empty (mig 0326 — the
       column comments there say who owns which). THE FALLBACK IS NOT A SHIM:
       ac_item_code is NULL everywhere, so dropping it stops resolving the 1,874
       bindings that land today. Why the split exists: docs/bugs/0539. */
    const acCode = typeof r.ac_item_code === 'string' ? r.ac_item_code.trim() : '';
    const sku = acCode || (typeof r.supplier_sku === 'string' ? r.supplier_sku.trim() : '');
    if (!code || !sku) continue;
    if (supplierId && String(r.supplier_id ?? '') === supplierId && !bySupplier.has(code)) {
      bySupplier.set(code, sku);
    }
    if (!out.has(code)) out.set(code, sku);
  }
  /* The document's own supplier overrides the main one, per code. */
  for (const [code, sku] of bySupplier) out.set(code, sku);
  return out;
}

/* mastersOf lives in its own module since 2026-08-14 — autocount-outbox.ts
   crossed the 2,000-line cap and that function is the one PURE seam in it.
   Re-exported here because every caller and every test names it through this
   module, and moving a file should not move an import. */
export { mastersOf };

/** Read one ERP document's AutoCount counterpart number. */
async function acDocNoOf(sb: Sb, ref: AcDocRef): Promise<string | null> {
  const { data } = await sb.from(ref.table)
    .select('linked_ac_docno').eq(ref.keyCol, ref.key).maybeSingle();
  return (data as { linked_ac_docno?: string | null } | null)?.linked_ac_docno ?? null;
}

/**
 * WHICH BUILD of AcSyncService is answering, read once per drain sweep.
 *
 * Stamped onto every row the sweep dispatches (migration 0304). The point is
 * not curiosity: a feature the host does not have is indistinguishable from a
 * feature that ran and found nothing — `mismatches` is empty both when the host
 * compared the creditor names and agreed, and when the host predates the
 * comparison entirely. With the build on the row, "was this refused by a
 * service that no longer exists" is a SELECT.
 *
 * BEST-EFFORT AND NEVER FATAL. /health is a diagnostic; a document must not
 * fail to reach the account book because a diagnostic did not answer. An
 * unreadable health leaves both columns null, and null already means "not
 * known for this row" rather than "the host is fine".
 */
export interface AcHostBuild { host_built_at: string | null; host_mvid: string | null }

export async function readHostBuild(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<AcHostBuild | null> {
  try {
    const res = await callAcService(env, 'health', {}, fetchImpl);
    if (!res.ok) return null;
    const b = res.body as { builtAt?: unknown; mvid?: unknown } | null;
    if (!b) return null;
    const at = typeof b.builtAt === 'string' && b.builtAt ? b.builtAt : null;
    const id = typeof b.mvid === 'string' && b.mvid ? b.mvid : null;
    /* Both absent means an OLD host — one that predates /health reporting either
       — and that is worth recording as "asked and got nothing", which is what
       nulls say. Returning null here would be the same value, so say it once. */
    return { host_built_at: at, host_mvid: id };
  } catch {
    return null;
  }
}

/**
 * The photographs each KEYED line carries, for the edit payload.
 *
 * Keyed only: `Photos` is applied to a line the account book already holds, and
 * a line with no `DtlKey` is refused by composeEdit long before this matters.
 * Cancelled lines are skipped — a retired line is being zeroed, and attaching
 * pictures to it would be writing to a line the ERP is in the middle of
 * withdrawing.
 *
 * Returns undefined rather than an empty array when nothing is photographed, so
 * the key is absent from the payload entirely and no reader has to tell an empty
 * list from a missing one.
 */
function photosOf(rows: Record<string, unknown>[]): AcOutboxPayload['photos'] {
  const out: NonNullable<AcOutboxPayload['photos']> = [];
  for (const r of rows) {
    if (r.cancelled === true) continue;
    const n = r.linked_ac_dtlkey == null ? NaN : Number(r.linked_ac_dtlkey);
    if (!Number.isFinite(n) || n <= 0) continue;
    const raw = r.photo_urls;
    const keys = Array.isArray(raw)
      ? raw.filter((k): k is string => typeof k === 'string' && !!k.trim())
      : [];
    if (keys.length) out.push({ dtlKey: n, keys });
  }
  return out.length ? out : undefined;
}

/**
 * Bytes to base64, the way a Worker has to do it.
 *
 * `Buffer` does not exist here and `btoa` takes a STRING, so the bytes go
 * through String.fromCharCode in chunks — whole-array spread blows the call
 * stack on anything of photograph size, which is the entire input class.
 */
function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

async function mark(sb: Sb, id: string, patch: Record<string, unknown>): Promise<void> {
  await sb.from('autocount_outbox')
    /* THE CLAIM COMES OFF HERE, on every outcome, because this is the one place
       every outcome goes through — `dispatchOne` marks before each of its four
       returns, so releasing here cannot be forgotten by a future branch the way
       a release at each return site could. A dispatch that THROWS never reaches
       this line and leaves the claim standing; that is what the lease is for
       (AC_CLAIM_LEASE_MS), and it is the only case where a row waits. */
    .update({ ...patch, claimed_at: null, updated_at: new Date().toISOString() })
    .eq('id', id);
}

export type DispatchOutcome = 'sent' | 'failed' | 'retry' | 'waiting';

/**
 * Dispatch ONE row.
 *
 *   sent    — AutoCount accepted it; the returned document number is recorded
 *             back onto the ERP row so the map is traceable both ways.
 *   waiting — the parent has no AutoCount number yet. Stays pending, and
 *             deliberately does NOT burn an attempt.
 *   retry   — transport failure or a 5xx, under the attempt cap.
 *   failed  — a refusal, or the attempt cap reached.
 */
export async function dispatchOne(
  env: Env,
  sb: Sb,
  row: AcOutboxRow,
  fetchImpl: typeof fetch = fetch,
  /**
   * The host build this sweep is talking to (migration 0304), read once by the
   * drain and stamped on every row it touches.
   *
   * OPTIONAL, deliberately, and this is the exception CLAUDE.md's
   * required-parameter rule names rather than a hole in it: it DECIDES nothing.
   * Absent leaves both columns untouched, and NULL there already means "not
   * known for this row" — the same thing a caller who says nothing means. A
   * required parameter here would break every existing test call site to record
   * a value that has no bearing on what the dispatch does.
   */
  hostBuild: AcHostBuild | null = null,
): Promise<DispatchOutcome> {
  const payload = (row.payload ?? { body: {} }) as AcOutboxPayload;
  const body: Record<string, unknown> = { ...(payload.body ?? {}) };
  /* Spread into every terminal mark below. Not into the `waiting` ones: those
     leave the row untouched for the next sweep, and stamping a build onto a row
     nothing was sent for would say a call happened that did not. */
  const stamp = hostBuild ?? {};

  if (payload.fromDoc) {
    const from = await acDocNoOf(sb, payload.fromDoc);
    if (!from) {
      await mark(sb, row.id, { last_error: 'waiting: parent has no AutoCount document yet' });
      return 'waiting';
    }
    body.FromDocNo = from;
  }
  /* ALL OF THEM, OR NONE. A merged transfer names every source it drew from, so
     one parent still waiting for its own create means the whole conversion
     waits — sending the subset would transfer part of the document and leave
     AutoCount holding a delivery the ERP does not have. `waiting` deliberately
     does not burn an attempt, which is what lets the parents land first. */
  if (payload.fromDocs?.length) {
    const froms: string[] = [];
    for (const ref of payload.fromDocs) {
      const no = await acDocNoOf(sb, ref);
      if (!no) {
        await mark(sb, row.id, {
          last_error: `waiting: ${froms.length} of ${payload.fromDocs.length} source document(s) have an AutoCount counterpart, the rest do not yet`,
        });
        return 'waiting';
      }
      froms.push(no);
    }
    body.FromDocNos = froms;
  }
  if (payload.selfDoc) {
    const self = await acDocNoOf(sb, payload.selfDoc);
    if (!self) {
      await mark(sb, row.id, { last_error: 'waiting: this document has no AutoCount counterpart yet' });
      return 'waiting';
    }
    body.DocNo = self;
  }

  /* THE SUPPLIER, FOR A ROW COMPOSED BEFORE ANYONE KNEW IT WAS NEEDED.
     The drain REPLAYS the stored payload and never recomposes, so fixing the
     enqueue above leaves every `so_to_po` row already queued failing for ever.

     THE ACCOUNT BOOK CANNOT ANSWER THIS ONE, unlike #2340's debtor: this source
     is a SALES order, which carries a DebtorCode and no creditor, and the
     supplier exists nowhere in AutoCount until we send it. The authority is the
     ERP's own purchase order, which the row already points at. Best-effort — on
     any doubt the body goes unchanged and the service's named guard answers,
     which is a clear error and not a mystery. Guide §7c3a. */
  if (row.op === 'so_to_po' && !body.CreditorCode && payload.writeback?.table === 'purchase_orders') {
    try {
      const po = await readPoHeader(sb, String(payload.writeback.key));
      if (po?.creditor_code) {
        body.CreditorCode = po.creditor_code;
        if (po.creditor_name) body.CreditorName = po.creditor_name;
      }
    } catch (e) {
      console.error('so_to_po: creditor backfill failed:', e instanceof Error ? e.message : String(e));
    }
  }
  /* THE ERP'S OWN NUMBER, for a row composed before D5 was closed here. Same
     replay problem as the creditor above, cheaper answer: the outbox row is
     already KEYED by the ERP's number. Without it AcSyncService auto-numbers —
     how PO-009968 got a number nobody in this building would say. Guide §7c3b. */
  if (row.op === 'so_to_po' && !body.DocNo && row.doc_no) body.DocNo = row.doc_no;

  await backfillSoToPoKeys(sb, row.op, body, payload.writeback);  // `wait` shape's keys — see that module

  /* THE SUPPLIER ON A PURCHASE CONVERSION, for a row composed before D15 was
     closed. Exactly the `so_to_po` shape twelve lines up and for exactly the
     reason given there: the drain replays the stored payload and never
     recomposes, so the enqueue fix alone leaves every `po_to_gr` / `gr_to_pi`
     row already in the queue going out with no account.

     UNLIKE `so_to_po`, THE ACCOUNT BOOK CAN ALSO ANSWER THIS ONE — the source is
     a purchase document, so AutoCount holds its creditor and the service falls
     back to reading it. This is therefore belt-and-braces rather than the only
     answer, and it is still worth having: a value the ERP STATES cannot be wrong
     about which row the service happened to read. Best-effort, like its twin —
     on any doubt `readConvertCreditor` returns null, the body goes unchanged and
     the service's own fallback is what answers. Guide §7c3. */
  /* THE CUSTOMER ON A SALES CONVERSION — the replay problem a third time, and
     the one that was costing documents. HC-DO-2608-003 failed with the
     contentless "Invalid transfer item." and five invoices waited behind it;
     AcSyncService.cs:988 names the cause, a target with no DebtorCode, which
     AddPartialTransferDetail reports as an invalid ITEM and not as a missing
     account. enqueueConvert has supplied it since #2340 and the drain replays,
     so every row queued before that line still goes out bare.
     Cheapest of the three and the only one that cannot fail: the purchase twins
     read a document to learn the account, the debtor is a constant here. The
     guard leaves a row composed after #2340 exactly as it was stored. */
  if ((SALES_CONVERSION as ReadonlySet<string>).has(row.op) && !body.DebtorCode) body.DebtorCode = AC_DEBTOR_CODE;

  const creditorSource = payload.fromDoc ?? payload.fromDocs?.[0];
  if (PURCHASE_CONVERSION.has(row.op) && !body.CreditorCode && creditorSource) {
    /* THE FIRST SOURCE ANSWERS FOR A MERGE, and it is not an arbitrary pick:
       both merged purchase conversions are already grouped by supplier before
       they get here (grns.ts buckets by PO supplier, purchase-invoices.ts by
       GRN supplier), so every source in the list carries the same creditor. */
    const creditor = await readConvertCreditor(sb, creditorSource);
    if (creditor) Object.assign(body, creditor);
  }

  /* THE PHOTOGRAPHS, fetched in the moment they are sent.
     `payload.photos` names R2 keys; the bytes live in the SO_ITEM_PHOTOS
     bucket and are turned into base64 here rather than stored in the outbox —
     see the field's own note for why an append-only table must not carry them.

     BEST-EFFORT PER PICTURE, FATAL FOR NONE. A photograph is not the document:
     an unreadable object must not stop a price change reaching the account
     book. What it must not do either is lie — a line whose pictures could not
     be read sends NO `Photos` key at all, and the service leaves whatever
     `FurtherDescription` the book already holds. Sending a SHORT list would
     overwrite five pictures with three. */
  if (row.op === 'edit' && payload.photos?.length) {
    const lines = Array.isArray(body.Lines) ? (body.Lines as Array<Record<string, unknown>>) : [];
    for (const want of payload.photos) {
      const line = lines.find((l) => Number(l.DtlKey) === want.dtlKey);
      if (!line || !want.keys.length) continue;
      try {
        const jpegs: Array<{ Jpeg: string }> = [];
        for (const key of want.keys) {
          const obj = await (env as unknown as { SO_ITEM_PHOTOS?: R2Bucket }).SO_ITEM_PHOTOS?.get(key);
          if (!obj) throw new Error(`photo not in the bucket: ${key}`);
          jpegs.push({ Jpeg: b64(await obj.arrayBuffer()) });
        }
        if (jpegs.length === want.keys.length) line.Photos = jpegs;
      } catch (e) {
        console.warn(
          `photos not attached to ${row.doc_type} ${row.doc_no} line ${want.dtlKey}: `
          + (e instanceof Error ? e.message : String(e)),
        );
      }
    }
  }

  const attempts = (row.attempts ?? 0) + 1;

  /* MASTERS FIRST, and only for the two operations that can introduce one.
     A document naming an item, a salesperson or a customer the account book
     does not have fails on a FOREIGN KEY and takes the whole document with it —
     the live book proved the shape by answering FK_SODTL_Location to a create
     whose lines carried no location. A conversion cannot introduce a master
     (it transfers lines that are already there) and neither can a cancel. */
  if (row.op === 'create_so' || row.op === 'create_po' || row.op === 'edit') {
    const masters = mastersOf(body);
    if (masters) {
      const ensured = await callAcService(env, 'ensure_masters', masters, fetchImpl);
      /* THE DOCUMENT STILL GOES. A creditor code the book resolves to a DIFFERENT
         company is an accounting error, not a technical one — the ERP holds a
         trading name where the book holds the registered one on many suppliers,
         so refusing here would block legitimate purchasing every day. Reported,
         and reported BEFORE the ok check, because a payload can name several
         masters and fail on an unrelated one; the finding must not be lost with
         the call. `mismatches` is empty when the host runs a build older than
         the comparison, which is "not reported", not "compared and agreed" —
         GET /health's builtAt says which build answered. */
      for (const m of ensured.mismatches) {
        console.warn(`MISMATCH ${m.master} erp=${m.erp} book=${m.book} — ${row.doc_type} ${row.doc_no} sent anyway`);
      }
      if (!ensured.ok) {
        await mark(sb, row.id, {
          ...stamp,
          attempts,
          last_error: `masters not opened, document not sent: ${ensured.error ?? 'unknown'}`,
          ...(ensured.retryable && attempts < MAX_ATTEMPTS ? {} : { status: 'failed' }),
        });
        return ensured.retryable && attempts < MAX_ATTEMPTS ? 'retry' : 'failed';
      }
    }
  }

  const result = await callAcService(env, row.op, body, fetchImpl);

  if (result.ok) {
    await mark(sb, row.id, {
      ...stamp,
      status: 'sent',
      attempts,
      last_error: null,
      ac_doc_no: result.docNo,
      sent_at: new Date().toISOString(),
    });
    /* The write-back half of the relationship map. Recorded only on success and
       only when AutoCount actually named a document. */
    if (payload.writeback && result.docNo) {
      await sb.from(payload.writeback.table)
        .update({ linked_ac_docno: result.docNo })
        .eq(payload.writeback.keyCol, payload.writeback.key);
    }
    /* The same map one level down. Without it a document the ERP creates has
       NULL line identity forever, and its first edit is refused by composeEdit
       (or, before that refusal existed, appended duplicates into the book). */
    if (payload.lineWriteback) {
      await persistLineKeys(sb, row, payload.lineWriteback, result.lines);
    }
    /* AN EDIT THAT ADDED A LINE LEARNS THAT LINE'S KEY (docs/bugs/0583-*).
       Without it the added row stays keyless and every LATER edit is refused. */
    if (row.op === 'edit') {
      const target = newLineTargetOf(row.doc_type, payload);
      if (target) await persistNewLineKeys(sb, row, target, result.lines);
    }
    return 'sent';
  }

  const giveUp = !result.retryable || attempts >= MAX_ATTEMPTS;
  await mark(sb, row.id, {
    ...stamp,
    status: giveUp ? 'failed' : 'pending',
    attempts,
    last_error: giveUp && result.retryable
      ? `Gave up after ${attempts} attempts. Last error: ${result.error}`
      : result.error,
  });
  return giveUp ? 'failed' : 'retry';
}

export interface DrainSummary {
  skipped?: string;
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  waiting: number;
}

/**
 * The 5-minute cron sweep. No-op when the flag is off or the service is
 * unconfigured, so it is safe to wire unconditionally and it ships dark.
 */
export async function drainAutoCountOutbox(
  env: Env,
  limit = DRAIN_BATCH,
  fetchImpl: typeof fetch = fetch,
): Promise<DrainSummary> {
  const zero = { processed: 0, sent: 0, failed: 0, retried: 0, waiting: 0 };
  if (!acServiceConfig(env)) return { skipped: 'ac_service_not_configured', ...zero };

  const sb = getSupabaseService(env);
  /* BEFORE ANYTHING IS SELECTED. A row whose claimant died mid-send would
     otherwise never be picked up again — the claim outlives the process that
     took it, and nothing else in the system clears one. */
  await releaseExpiredClaims(sb);
  const { data, error } = await sb.from('autocount_outbox')
    .select('id, company_id, op, doc_type, doc_no, doc_id, payload, status, attempts, dedupe_key')
    .eq('status', 'pending')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error || !data) return { skipped: error ? 'query_failed' : undefined, ...zero };

  /* ONCE PER SWEEP, and only when there is something to send. /health opens no
     database and answers from the assembly, so it is cheap — but a heartbeat
     against the office host on every empty five-minute tick is noise, and the
     value is only meaningful beside a row it stamped. */
  const hostBuild = data.length ? await readHostBuild(env, fetchImpl) : null;

  const summary = { ...zero };
  for (const raw of data as AcOutboxRow[]) {
    /* Re-checked per row, not once per sweep: the flag is per COMPANY, and it
       may be turned off mid-sweep. Off leaves the row pending — it is not a
       failure, and the work must survive to be drained when it is on again. */
    if (!(await isWritebackEnabled(sb, raw.company_id))) continue;
    /* CLAIM IT, OR LEAVE IT ALONE. The sweep is no longer the only dispatcher —
       the AutoCount Sync page's "Send now" reaches `dispatchOne` too — so the
       row this loop selected a moment ago may already be going out. A lost claim
       is not an error and not a failure: whoever holds it is sending it, and if
       they die the lease releases it to the next sweep. It is counted nowhere
       for that reason, and logged so that a row losing every claim is visible
       rather than silently never sent. */
    if (!(await claimOutboxRow(sb, raw.id))) {
      console.warn(`[ac-writeback] ${raw.doc_type} ${raw.doc_no} already being sent — left for the holder`);
      continue;
    }
    summary.processed += 1;
    const outcome = await dispatchOne(env, sb, raw, fetchImpl, hostBuild);
    if (outcome === 'sent') summary.sent += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else if (outcome === 'waiting') summary.waiting += 1;
    else summary.retried += 1;
  }
  return summary;
}
