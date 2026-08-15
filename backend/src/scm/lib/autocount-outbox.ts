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
import { splitSofaCode } from '../../services/autocount-sofa-collapse';
import { SO_PROCESSING_DATE_COLUMN } from '../shared/so-processing-date';
import {
  callAcService,
  LOCATION_MAP,
  BRANDING_MAP,
  VENUE_MAP,
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
  composeSoToPo,
  acUdfDate,
  acUdfMoney,
  acServiceConfig,
  Desc2TooLongError,
  ItemCodeError,
  KeylessLineError,
  MissingAgentError,
  MissingCreditorError,
  MissingLocationError,
  MissingSalesLocationError,
  SofaCollapseError,
  type AcDocType,
  type AcOp,
  type AcCreatedLine,
  type AcRetiredLine,
  type ErpLine,
} from '../../services/autocount-writeback';

/* Re-exported so a route can name the shape it passes to enqueueEdit without
   also importing the composer module. */
export type { AcRetiredLine } from '../../services/autocount-writeback';

import { mastersOf } from './autocount-masters';
/* The reads, and what a FAILED read means. Split out 2026-08-15 for the same
   reason mastersOf was: this file is at the 2,000-line cap. */
import {
  AcReadError, readOrThrow, readSoOutstandingCenti, readPoEnqueueShape,
} from './autocount-read';

type Sb = SupabaseClient<any, any, any>;

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
   customer_po / customer_so_no are the other two columns that have held the
   customer's own reference — PR #140 left `customer_so_no` as the only one any
   surface still writes, so reading po_doc_no alone sent ToPONo nowhere
   (soCustomerRef). */
/* emergency_contact_phone is AutoCount's DeliverPhone1 and `phone` is its
   Phone1 — two contacts, two columns (owner 2026-08-15). The cutover decided
   the pairing in this direction already: import-ac-outstanding-so.mjs:302 takes
   DeliverPhone1 when it differs from Phone1 and inserts it as
   emergency_contact_phone (:390/:412). Reading `phone` for both would put the
   customer's number in front of the driver.
   total_revenue_centi + deposit_centi are two of the three inputs to the
   outstanding balance the BALANCE UDF carries; the third is the payments ledger
   (readSoOutstandingCenti). NOT balance_centi — recomputeTotals rewrites that to
   the gross total on every edit, and it is the column the cutover's UDF_BALANCE
   landed in, which is exactly what makes it look like the right one. */
const SO_HEADER_COLS =
  'doc_no, so_date, debtor_name, agent, salesperson_id, sales_location, branding, venue, address1, address2, address3, address4, city, postcode, customer_state, phone, emergency_contact_phone, ref, po_doc_no, customer_po, customer_so_no, processing_date, total_revenue_centi, deposit_centi, linked_ac_docno';
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
  'id, item_code, item_group, branding, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, cancelled, warehouse_id, line_delivery_date';
/* scm.purchase_orders is SUPPLIER-keyed. It has no creditor_code, creditor_name,
   agent or ref: the creditor is scm.suppliers.code / .name behind supplier_id,
   and the other two do not exist at all on the ERP side. */
const PO_HEADER_COLS = 'id, company_id, po_number, po_date, supplier_id, notes, linked_ac_docno';
/* description2 is NOT optional here. The PO importer wrote the AutoCount sofa
   Desc2 verbatim onto every compartment row, and that stored text is what the
   D9 collapse echoes back. Leaving the column out of this list is what made the
   PO side fall back to a variants blob and throw the original build away. */
const PO_ITEM_COLS =
  'id, material_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, warehouse_id, delivery_date';

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
/* Declared HERE rather than beside the other enqueue helpers: DOWNSTREAM below
   is a module-level const that references it during module evaluation, so a
   later `const soLine` would be in its temporal dead zone and every import of
   this module would throw. */
const soLine = (r: Record<string, unknown>): ErpLine => ({
  id: r.id == null ? null : String(r.id),
  item_code: String(r.item_code ?? r.material_code ?? ''),
  item_group: (r.item_group as string) ?? null,
  /* undefined on the five tables that do not select it, which soBranding reads
     as "this line has no brand" — the same convention `cancelled` runs under. */
  branding: (r.branding as string) ?? null,
  description: (r.description as string) ?? null,
  description2: (r.description2 as string) ?? null,
  qty: Number(r.qty ?? 0),
  unit_price_centi: Number(r.unit_price_centi ?? 0),
  variants: (r.variants as Record<string, unknown> | null) ?? null,
  linked_ac_dtlkey: (r.linked_ac_dtlkey as number | null) ?? null,
  /* `line_delivery_date` on a sales-order line, `delivery_date` on a purchase
     one — the same fact under two column names. Null on the four DOWNSTREAM
     tables, whose column lists select neither, and that costs them nothing:
     those documents only ever reach `/edit`, where composeEdit drops a null
     DeliveryDate rather than blanking the date the conversion gave the book.
     Same reasoning DOWNSTREAM's header already records for DocDate. */
  delivery_date: (r.line_delivery_date as string | null) ?? (r.delivery_date as string | null) ?? null,
  /* undefined on the five tables that have no such column, which composeEdit
     reads as "live" — the same answer the column's own default gives. */
  cancelled: r.cancelled === true,
  /* Filled in by withLocations below. The raw column is a warehouse UUID and
     AutoCount wants the short code, so the line cannot carry it on its own. */
  location: null,
});

/**
 * Hang the AutoCount stock location on each line.
 *
 * `warehouse_id` is a `scm.warehouses` UUID; AutoCount's `dbo.Location` is
 * keyed by the short code (KL, PG, HQ...), so one lookup per document turns
 * the ids into codes. Lines share warehouses, so this is one `in` query, not
 * one per line.
 *
 * A line with no warehouse keeps `location: null` and the caller decides:
 * a create refuses it (MissingLocationError), an edit simply omits the key so
 * the account book keeps its own value.
 */
async function withLocations(
  sb: Sb,
  rows: Record<string, unknown>[],
  lines: ErpLine[],
): Promise<ErpLine[]> {
  const ids = [...new Set(rows.map((r) => r.warehouse_id).filter((v): v is string => typeof v === 'string' && v !== ''))];
  if (!ids.length) return lines;
  const wh = await readOrThrow('warehouses',
    sb.from('warehouses').select('id, code, name').in('id', ids));
  const byId = new Map<string, string>();
  for (const w of (wh ?? []) as Array<Record<string, unknown>>) {
    const code = (w.code as string | null) ?? (w.name as string | null);
    if (w.id && code) byId.set(String(w.id), code);
  }
  return lines.map((l, i) => {
    const id = rows[i]?.warehouse_id;
    const code = typeof id === 'string' ? byId.get(id) ?? null : null;
    return code ? { ...l, location: code } : l;
  });
}

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

interface AcDownstreamSpec {
  table: AcLinkTable;
  itemTable: AcLineTable;
  /** The column on the item table that points back at the header. */
  itemFk: string;
  /** The line table this document's lines were transferred FROM. */
  sourceItemTable: AcLineTable;
  /** The column on the item table naming the SOURCE line it came from. NULL
   *  there means an ad-hoc line with no counterpart to transfer. */
  sourceFk: string;
  headerCols: string;
  itemCols: string;
  /** The human document number, for the outbox row's doc_no. */
  docNoOf: (h: Record<string, unknown>) => string;
  line: (r: Record<string, unknown>) => ErpLine;
  /** NEVER `string | null`: a present-null key BLANKS the book. See `present`. */
  header: (h: Record<string, unknown>) => Record<string, string>;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * A header with every BLANK KEY REMOVED. The one rule /edit runs under.
 *
 * `AcSyncService.Edit()` is `ContainsKey`-gated and `Str` turns a present-null
 * into `""`, so `{Ref: null}` does not mean "unchanged" — it means "blank the
 * reference the account book holds". Every one of these builders emitted
 * `x ?? null` unconditionally, so an edit blanked whatever the ERP's column did
 * not answer for; on the SO that was `ref`, `address3` and `address4` on
 * essentially every ERP-created order (audit 2026-08-14, finding 10).
 *
 * Applied at the ONE place a header is built rather than per key, so the next
 * field added to one of these cannot reintroduce it.
 */
const present = (o: Record<string, string | null>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    const s = (v ?? '').trim();
    if (s) out[k] = s;
  }
  return out;
};

const DOWNSTREAM: Record<'DO' | 'GR' | 'IV' | 'PI', AcDownstreamSpec> = {
  DO: {
    table: 'delivery_orders',
    itemTable: 'delivery_order_items',
    itemFk: 'delivery_order_id',
    sourceItemTable: 'mfg_sales_order_items',
    sourceFk: 'so_item_id',
    headerCols: 'id, do_number, debtor_name, ref, phone, note, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.do_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => present({
      DebtorName: str(h.debtor_name),
      Attention: str(h.debtor_name),
      Ref: str(h.ref),
      Phone1: str(h.phone),
      Note: str(h.note),
    }),
  },
  GR: {
    table: 'grns',
    itemTable: 'grn_items',
    itemFk: 'grn_id',
    sourceItemTable: 'purchase_order_items',
    sourceFk: 'purchase_order_item_id',
    headerCols: 'id, grn_number, delivery_note_ref, notes, linked_ac_docno',
    itemCols: 'id, material_code, item_group, description, description2, qty_accepted, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.grn_number ?? h.id ?? ''),
    /* qty_ACCEPTED, not qty_received. AutoCount's GR line quantity is what
       entered stock, and qty_accepted is the number this ERP posts to stock and
       rolls up onto the PO. The received/rejected split has no AutoCount
       counterpart at all, so sending qty_received would make AutoCount's PO
       outstanding disagree with the ERP's by exactly the rejected quantity. */
    line: (r) => soLine({ ...r, qty: r.qty_accepted }),
    header: (h) => present({
      Ref: str(h.delivery_note_ref),
      Description: str(h.notes),
    }),
  },
  IV: {
    table: 'sales_invoices',
    itemTable: 'sales_invoice_items',
    itemFk: 'sales_invoice_id',
    sourceItemTable: 'delivery_order_items',
    sourceFk: 'do_item_id',
    headerCols: 'id, invoice_number, debtor_name, ref, phone, note, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.invoice_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => present({
      DebtorName: str(h.debtor_name),
      Attention: str(h.debtor_name),
      Ref: str(h.ref),
      Phone1: str(h.phone),
      Note: str(h.note),
    }),
  },
  PI: {
    table: 'purchase_invoices',
    itemTable: 'purchase_invoice_items',
    itemFk: 'purchase_invoice_id',
    sourceItemTable: 'grn_items',
    sourceFk: 'grn_item_id',
    headerCols: 'id, invoice_number, supplier_invoice_ref, notes, linked_ac_docno',
    itemCols: 'id, material_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.invoice_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => present({
      Ref: str(h.supplier_invoice_ref),
      Description: str(h.notes),
    }),
  },
};

/** The line table each conversion's TARGET lines live in, for key capture. */
const CONVERT_TARGET: Record<'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi', 'DO' | 'GR' | 'IV' | 'PI'> = {
  so_to_do: 'DO', po_to_gr: 'GR', do_to_iv: 'IV', gr_to_pi: 'PI',
};

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
): Promise<void> {
  const refused = e instanceof KeylessLineError
    || e instanceof SofaCollapseError
    || e instanceof ItemCodeError
    || e instanceof Desc2TooLongError
    || e instanceof MissingLocationError
    || e instanceof MissingAgentError
    || e instanceof MissingSalesLocationError
    || e instanceof MissingCreditorError;
  if (!refused && !(e instanceof AcReadError)) return;
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
}

// ── enqueue helpers, one per flow ───────────────────────────────────────────

/** SO create. Composes from the row the handler has just committed. */
export async function enqueueSoCreate(
  sb: Sb,
  opts: { companyId: number | null | undefined; docNo: string; createdBy?: number | null },
): Promise<boolean> {
  try {
    if (opts.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return false;
    const header = await readOrThrow('mfg_sales_orders header',
      sb.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', opts.docNo).maybeSingle());
    if (!header) return false;
    /* A cutover-imported SO ALREADY exists in AutoCount (mig 0271). Creating it
       again would duplicate the order in the live book. */
    if ((header as { linked_ac_docno?: string | null }).linked_ac_docno) return false;
    const items = await readOrThrow('mfg_sales_order_items',
      sb.from('mfg_sales_order_items').select(SO_ITEM_COLS).eq('doc_no', opts.docNo));
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
    const outstandingCenti = await readSoOutstandingCenti(sb, header as Record<string, unknown>);
    const body = composeCreateSo(header as never, lines, salespersonName, outstandingCenti, { bindings });
    return await enqueueAcOp(sb, {
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
    });
  } catch (e) {
    await noteReadFailure(sb, e, { companyId: opts.companyId as number, op: 'create_so', docType: 'SO', docNo: opts.docNo });
    return false;
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
    linked_ac_docno: (h.linked_ac_docno as string | null) ?? null,
  };
}

/** PO create. */
export async function enqueuePoCreate(
  sb: Sb,
  opts: { companyId: number | null | undefined; poId: string; createdBy?: number | null },
): Promise<boolean> {
  /* Falls back to the id: a header read that FAILED has no number to name the
     note row by, and the id is what every PO route addresses anyway. */
  let poNumber = opts.poId;
  try {
    if (opts.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return false;
    const header = await readPoHeader(sb, opts.poId);
    if (!header) return false;
    poNumber = header.po_number || opts.poId;
    if (header.linked_ac_docno) return false;
    const items = await readOrThrow('purchase_order_items',
      sb.from('purchase_order_items').select(PO_ITEM_COLS).eq('purchase_order_id', opts.poId));
    const rows = (items ?? []) as Record<string, unknown>[];
    const lines = await withLocations(sb, rows, rows.map(soLine));
    const bindings = await bindingsFor(sb, opts.companyId, lines.map((l) => l.item_code), header.supplier_id);
    const { collapsed, details } = composeDetails(lines, { supplierCode: header.creditor_code, bindings });

    /* TRANSFER OR CREATE — the rule is scm/shared/po-transfer-shape.ts, and it
       falls back to a create on ANY doubt because a create is what happens
       today and cannot be wrong. Houzs buys in a shape a transfer often cannot
       express: one PO line serving several customers plus stock (mig 0235). */
    const { shape, sourceRef } = await readPoEnqueueShape(sb, opts.poId);

    const body = composeCreatePo(header, lines, { bindings });
    if (sourceRef) (body as unknown as Record<string, unknown>).Ref = sourceRef;

    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: shape.kind === 'transfer' ? 'so_to_po' : 'create_po',
      docType: 'PO',
      docNo: header.po_number,
      docId: opts.poId,
      payload: {
        /* FromDocNo is resolved at DRAIN, like the four conversions. DtlKeys
           names the lines this order buys and is REQUIRED; the per-line values
           are the ERP's agreed COST, which replaces the sales price the
           transfer carries over. */
        body: (shape.kind === 'transfer'
          ? composeSoToPo(shape.dtlKeys, details)
          : body) as unknown as Record<string, unknown>,
        /* THE PARENT MUST EXIST FIRST. dispatchOne holds a row whose fromDoc has
           no AutoCount number yet as `waiting` — without burning an attempt —
           which is exactly right here: a purchase order raised the same minute
           as its sales order would otherwise fail on a document the book has
           not been told about. */
        ...(shape.kind === 'transfer'
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
    });
  } catch (e) {
    await noteReadFailure(sb, e, {
      companyId: opts.companyId as number, op: 'create_po', docType: 'PO', docNo: poNumber, docId: opts.poId,
    });
    return false;
  }
}

/** The four conversions. FromDocNo is resolved at drain from the parent's
 *  linked_ac_docno, because it does not exist until the parent's create runs. */
export async function enqueueConvert(
  sb: Sb,
  opts: {
    companyId: number | null | undefined;
    op: Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>;
    from: AcDocRef;
    to: AcDocRef;
    docType: 'DO' | 'IV' | 'GR' | 'PI';
    docNo: string;
    docId?: string | null;
    docDate?: string | null;
    ref?: string | null;
    createdBy?: number | null;
  },
): Promise<boolean> {
  /* WHICH SOURCE LINES THIS CONVERSION ACTUALLY TOOK.
     Resolved BEFORE the enqueue so a refusal is recorded instead of a wrong
     transfer being queued. */
  const source = await readConvertSourceKeys(sb, opts.op, opts.docId ?? null);
  if (source.refuse) {
    return recordConvertSkipped(sb, {
      companyId: opts.companyId,
      op: opts.op,
      docType: opts.docType,
      docNo: opts.docNo,
      docId: opts.docId ?? null,
      reason: source.refuse,
      createdBy: opts.createdBy ?? null,
    });
  }
  return enqueueAcOp(sb, {
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
        /* OMITTED WHEN THE ERP HAS NONE, not sent as null. `SalesHeader` /
           `PurchaseHeader` apply `Set(() => doc.Ref = Str(p, "Ref"))`
           unconditionally, and `Str` turns a present-null into "" — so every
           conversion was writing an empty Ref over whatever the transfer had
           put there. No caller passes `ref` yet (audit finding 13); until they
           do, saying nothing is the only answer that cannot destroy a value.
           `DocDate` was already correct and is written the same way for the
           same reason: the target keeps the transfer's own posting date. */
        ...(opts.docDate ? { DocDate: opts.docDate } : {}),
        ...(opts.ref ? { Ref: opts.ref } : {}),
        ...(source.keys ? { DtlKeys: source.keys } : {}),
      },
      fromDoc: opts.from,
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
    },
    dedupeKey: `${opts.op}:${opts.docId ?? opts.docNo}`,
    createdBy: opts.createdBy ?? null,
  });
}

/**
 * WHICH LINES OF THE PARENT THIS CONVERSION TOOK, as AutoCount DtlKeys.
 *
 * Three outcomes, and the difference between them is the whole safety argument:
 *
 *   { keys }   — every line of this document names a source line, and every one
 *                of those source lines carries an AutoCount DtlKey. The subset
 *                is expressible exactly, so send it.
 *   { refuse } — the ERP took a STRICT SUBSET of the parent's lines and cannot
 *                name it, because some source line has no DtlKey stored. Sending
 *                no DtlKeys here is the defect: AutoCount would transfer every
 *                outstanding line, shipping or receiving goods in a live book
 *                that did not move in the ERP. A visible skipped row is the
 *                correct outcome; the remedy is the line-key backfill.
 *   {}         — this document covers EVERY line of the parent, so "all
 *                outstanding" and "the lines we took" are the same set and the
 *                account book is the better authority on which are still
 *                untransferred. Also the answer when the ERP cannot read its own
 *                links at all: falling back is exactly the old behaviour, and a
 *                conversion must never be lost to a diagnostic read.
 *
 * NOT COVERED, and deliberately so: partial QUANTITY on a line. The SDK's only
 * primitive is AddPartialTransferDetail(fromType, dtlKeys, bool) — it takes line
 * keys, not quantities, so a DO shipping 2 of a 5-unit line still produces an
 * AutoCount DO of 5 on that line. Naming the right lines does not fix the wrong
 * number on them. See docs/modules/autocount-writeback.md.
 */
async function readConvertSourceKeys(
  sb: Sb,
  op: Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>,
  docId: string | null,
): Promise<{ keys?: number[]; refuse?: string }> {
  if (!docId) return {};
  try {
    const spec = DOWNSTREAM[CONVERT_TARGET[op]];
    const { data, error } = await sb.from(spec.itemTable)
      .select(`id, ${spec.sourceFk}`).eq(spec.itemFk, docId);
    if (error || !data) return {};
    const rows = data as unknown as Record<string, unknown>[];
    if (!rows.length) return {};

    const sourceIds = [...new Set(
      rows.map((r) => r[spec.sourceFk]).filter((v): v is string => typeof v === 'string' && !!v),
    )];
    /* Not one line came from a source document. Nothing to name, and the
       parentless / ad-hoc shape is already recorded by its own route. */
    if (!sourceIds.length) return {};

    const { data: src, error: sErr } = await sb.from(spec.sourceItemTable)
      .select('id, linked_ac_dtlkey').in('id', sourceIds);
    if (sErr || !src) return {};
    const srcRows = src as unknown as Array<{ id: string; linked_ac_dtlkey: number | null }>;

    const keys: number[] = [];
    const missing: string[] = [];
    for (const id of sourceIds) {
      const k = srcRows.find((r) => r.id === id)?.linked_ac_dtlkey;
      const n = k == null ? NaN : Number(k);
      if (Number.isFinite(n) && n > 0) keys.push(n); else missing.push(id);
    }
    if (!missing.length) return { keys };

    /* Some source line has no key. Whether that is fatal depends on ONE thing:
       is this a partial transfer? A whole-document transfer degrades safely to
       the old behaviour; a partial one cannot. */
    const partial = await conversionIsPartial(sb, spec, sourceIds);
    if (!partial) return {};
    return {
      refuse:
        `this ${op.replace('_to_', ' -> ').toUpperCase()} transfers only ${sourceIds.length} of the `
        + `source document's lines, and ${missing.length} of them carry no AutoCount DtlKey, so the `
        + 'ERP cannot name the subset. Sending the conversion without DtlKeys would make AutoCount '
        + 'transfer EVERY outstanding line on the source — goods moving in the account book that did '
        + `not move here. Backfill scm.${spec.sourceItemTable}.linked_ac_dtlkey for the source `
        + 'document, then re-raise this document.',
    };
  } catch {
    return {};
  }
}

/**
 * Does this conversion leave any of the parent's lines behind?
 *
 * Answered against the ERP's own parent, not AutoCount's — this decides only
 * whether the FALLBACK ("transfer everything outstanding") is a safe
 * approximation, and the ERP's line set is what the fallback would be wrong
 * about. On any doubt the answer is "partial", because that is the branch that
 * refuses: a wrong "no, it is whole" would let the defect through.
 */
async function conversionIsPartial(
  sb: Sb,
  spec: AcDownstreamSpec,
  takenSourceIds: string[],
): Promise<boolean> {
  const parentFk: Record<AcLineTable, string | null> = {
    mfg_sales_order_items: 'doc_no',
    purchase_order_items: 'purchase_order_id',
    delivery_order_items: 'delivery_order_id',
    grn_items: 'grn_id',
    sales_invoice_items: null,
    purchase_invoice_items: null,
  };
  const fk = parentFk[spec.sourceItemTable];
  if (!fk) return true;
  try {
    const { data: one, error: oErr } = await sb.from(spec.sourceItemTable)
      .select(`id, ${fk}`).eq('id', takenSourceIds[0]).maybeSingle();
    if (oErr || !one) return true;
    const parentKey = (one as unknown as Record<string, unknown>)[fk];
    if (parentKey == null) return true;
    let q = sb.from(spec.sourceItemTable)
      .select('id', { count: 'exact', head: true }).eq(fk, parentKey as string);
    /* A retired parent line is not one this conversion "left behind" — it is
       one nobody will ever transfer. Only mfg_sales_order_items has the column
       (42703 on the others), so the filter is applied only there. */
    if (spec.sourceItemTable === 'mfg_sales_order_items') q = q.eq('cancelled', false);
    const { count, error: cErr } = await q;
    if (cErr || count == null) return true;
    return count > takenSourceIds.length;
  } catch {
    return true;
  }
}

/**
 * The ERP lines of a freshly-created downstream document, positionally ordered,
 * so the DtlKeys AutoCount reports can be zipped onto them.
 *
 * Returns undefined on ANY doubt — no id, an unreadable table, or no lines.
 * Undefined means "do not attempt to store line identity", which is the safe
 * outcome: the document still syncs, and only a later edit is refused.
 */
async function readConvertTargetLines(
  sb: Sb,
  op: Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>,
  docId: string | null,
): Promise<AcOutboxPayload['lineWriteback']> {
  if (!docId) return undefined;
  try {
    const spec = DOWNSTREAM[CONVERT_TARGET[op]];
    const { data, error } = await sb.from(spec.itemTable).select(spec.itemCols)
      .eq(spec.itemFk, docId)
      .order('created_at', { ascending: true }).order('id', { ascending: true });
    if (error || !data) return undefined;
    const rows = data as unknown as Record<string, unknown>[];
    if (!rows.length) return undefined;
    const lines = rows.map(spec.line);
    return {
      table: spec.itemTable,
      ids: rows.map((r) => String(r.id)),
      codes: lines.map((l) => l.item_code),
      desc2: lines.map((l) => composeDescription2(l)),
    };
  } catch {
    return undefined;
  }
}

/** The ItemCode column each line table spells its product in. */
const LINE_CODE_COL: Record<AcLineTable, string> = {
  mfg_sales_order_items: 'item_code',
  purchase_order_items: 'material_code',
  delivery_order_items: 'item_code',
  grn_items: 'material_code',
  sales_invoice_items: 'item_code',
  purchase_invoice_items: 'material_code',
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
    return [{ DtlKey: n, ItemCode: String(r[codeCol] ?? ''), ...(desc2 ? { Desc2: desc2 } : {}) }];
  } catch {
    return [];
  }
}

/**
 * Record a conversion the ERP will NOT send, and why.
 *
 * The case that forces this: the SDK's only transfer primitive is
 * AddPartialTransferDetail(fromDocType, fromDocKeys) — ONE source document
 * (AcSyncService.cs:12-20). The ERP can merge several Sales Orders into one
 * Delivery Order; AutoCount has no shape for that. Splitting it into N AutoCount
 * DOs would invent documents the ERP does not have, and dropping it silently
 * would leave a shipment that exists in one system and not the other with
 * nothing to find it by. So it is written down as 'skipped' with the reason.
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
    reason:
      `created with ${opts.missing}, so there is no source document to transfer from. `
      + 'AutoCount builds a DO / GRN / Invoice only by transferring a source document\'s lines '
      + '(AddPartialTransferDetail is the SDK\'s only primitive), so this document cannot be '
      + 'created in the account book at all and will stay ERP-only.',
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
  },
): Promise<boolean> {
  try {
    if (opts.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return false;

    const retired = (opts.retire ?? []).filter((r) => Number.isFinite(Number(r.DtlKey)));
    const composed = opts.docType === 'SO'
      ? await composeSoState(sb, String(opts.docNo), retired, opts.newLineIds)
      : opts.docType === 'PO'
        ? await composePoState(sb, String(opts.docId ?? opts.docNo), retired)
        : await composeDownstreamState(sb, opts.docType, String(opts.docId ?? opts.docNo), retired);
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
  sb: Sb, docType: 'DO' | 'GR' | 'IV' | 'PI', id: string, retired: AcRetiredLine[] = [],
) {
  const spec = DOWNSTREAM[docType];
  const header = await readOrThrow(`${spec.table} header`,
    sb.from(spec.table).select(spec.headerCols).eq('id', id).maybeSingle());
  if (!header) return null;
  const h = header as unknown as Record<string, unknown>;
  const items = await readOrThrow(spec.itemTable,
    sb.from(spec.itemTable).select(spec.itemCols).eq(spec.itemFk, id)
      .order('created_at', { ascending: true }).order('id', { ascending: true }));
  const lines = ((items ?? []) as unknown as Record<string, unknown>[]).map(spec.line);
  const docNo = spec.docNoOf(h);
  return {
    docNo,
    linkedAcDocNo: (h.linked_ac_docno as string | null) ?? null,
    self: { table: spec.table, keyCol: 'id', key: id } as AcDocRef,
    create: null as (() => Record<string, unknown>) | null,
    edit: () => composeEdit(
      docType, String(h.linked_ac_docno ?? docNo), spec.header(h), lines, {}, retired,
    ),
  };
}

async function composeSoState(sb: Sb, docNo: string, retired: AcRetiredLine[] = [], newLineIds?: string[]) {
  const header = await readOrThrow('mfg_sales_orders header',
    sb.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', docNo).maybeSingle());
  if (!header) return null;
  const items = await readOrThrow('mfg_sales_order_items',
    sb.from('mfg_sales_order_items').select(SO_ITEM_COLS).eq('doc_no', docNo));
  const soRows = (items ?? []) as Record<string, unknown>[];
  const lines = await withLocations(sb, soRows, soRows.map(soLine));
  const h = header as Record<string, unknown>;
  const bindings = await bindingsFor(sb, (h.company_id as number | null) ?? null, lines.map((l) => l.item_code));
  const salespersonName = await readSalespersonName(sb, h.salesperson_id);
  const outstandingCenti = await readSoOutstandingCenti(sb, h);
  return {
    docNo,
    linkedAcDocNo: (h.linked_ac_docno as string | null) ?? null,
    self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: docNo } as AcDocRef,
    /* LAZY. An edit builds this same state, and composing a create it will
       never send would refuse the edit for the create's reasons — a line with
       no stock location is fatal to a create and irrelevant to an edit. */
    create: () => composeCreateSo(header as never, lines, salespersonName, outstandingCenti, { bindings }) as unknown as Record<string, unknown>,
    /* LAZY on purpose. composeEdit REFUSES a line with no AutoCount DtlKey, and
       the caller does not always need an edit: when the create is still sitting
       unsent in the outbox it replaces that create's payload instead, and a
       document that has never reached AutoCount cannot possibly have line keys
       yet. Composing eagerly would refuse that legitimate path. */
    edit: () => composeEdit(
      'SO', String(h.linked_ac_docno ?? docNo),
      soEditHeader(h, salespersonName, lines, outstandingCenti), lines,
      {
        bindings,
        ...(newLineIds && newLineIds.length ? { newLineIds: new Set(newLineIds) } : {}),
      },
      retired,
    ),
  };
}

async function composePoState(sb: Sb, poId: string, retired: AcRetiredLine[] = []) {
  const header = await readPoHeader(sb, poId);
  if (!header) return null;
  const items = await readOrThrow('purchase_order_items',
    sb.from('purchase_order_items').select(PO_ITEM_COLS).eq('purchase_order_id', poId));
  const poRows = (items ?? []) as Record<string, unknown>[];
  const lines = await withLocations(sb, poRows, poRows.map(soLine));
  const poBindings = await bindingsFor(sb, header.company_id ?? null, lines.map((l) => l.item_code), header.supplier_id);
  return {
    docNo: header.po_number || poId,
    linkedAcDocNo: header.linked_ac_docno,
    self: { table: 'purchase_orders', keyCol: 'id', key: poId } as AcDocRef,
    create: () => composeCreatePo(header, lines, { bindings: poBindings }) as unknown as Record<string, unknown>,
    /* No Ref: the ERP has no such field on a purchase order, and /edit applies
       only the keys it is GIVEN (AcSyncService.cs:369 `h.ContainsKey`). Sending
       null would blank whatever the account book has there. */
    edit: () => composeEdit('PO', String(header.linked_ac_docno ?? header.po_number), present({
      CreditorName: header.creditor_name,
      Description: header.notes,
    }), lines, { supplierCode: header.creditor_code, bindings: poBindings }, retired),
  };
}

// ── drain ───────────────────────────────────────────────────────────────────

/**
 * The SO header fields an EDIT carries.
 *
 * A create sends the salesperson, the sales location, the document date and the
 * three UDFs; an edit used to send none of them, so changing any one of those on
 * a live order never reached AutoCount at all (divergence D8). The account book
 * accepts every one of them on `/edit` — `AcSyncService.Edit()` has them in its
 * allow-list and calls `ApplyUdf` — so this was the ERP declining to speak, not
 * AutoCount refusing to listen.
 *
 * A NULL VALUE IS OMITTED, NEVER SENT. The service's header loop is
 * `ContainsKey`-gated and `Str` turns a present-but-null into `""`, so sending
 * `{Agent: null}` does not mean "unchanged" — it means "blank the salesperson
 * the account book has". The same rule as the line-level Location, one level up.
 *
 * THAT RULE IS NOW APPLIED TO EVERY KEY, WHICH IT WAS NOT. Eight of them —
 * `DebtorName`, `Attention`, `Ref`, `Phone1` and the four `InvAddr` lines —
 * were emitted as `x ?? null` unconditionally while the doc comment above
 * already said they were not, so every edit of a sales order blanked whatever
 * the account book held in those fields wherever the ERP's column was empty.
 * Measured on production 2026-08-14: `ref` is blank on 112 of 115 unpushed
 * orders and `address3` / `address4` on 94 of them (audit finding 10).
 *
 * AN EDIT IS NEVER REFUSED FOR A MISSING AGENT, which is where it parts company
 * with the create. On a create a blank Agent is a foreign-key failure that
 * loses the whole document; here the account book already holds a value and
 * omitting the key leaves it alone. Refusing would strand every legacy order
 * that has no salesperson on either source and gain nothing. `SalesLocation`
 * runs under the same asymmetry — the create falls back to the lines because
 * it MUST send something, the edit simply says nothing.
 */
function soEditHeader(
  h: Record<string, unknown>,
  /** REQUIRED, never optional: it decides whether Agent is sent at all. */
  salespersonName: string | null,
  /** REQUIRED, never optional: it decides what BRANDING is, and the header
   *  column is NULL on every ERP-created order. See `soBranding`. */
  lines: ErpLine[],
  /** REQUIRED, never optional: it decides what the account book says a live
   *  customer still owes. `null` omits the key and keeps the book's own. */
  outstandingCenti: number | null,
): Record<string, string | null | Record<string, string>> {
  const out: Record<string, string | null | Record<string, string>> = present({
    DebtorName: (h.debtor_name as string) ?? null,
    Attention: (h.debtor_name as string) ?? null,
    Ref: (h.ref as string) ?? null,
    Phone1: (h.phone as string) ?? null,
    /* The DELIVERY contact, which is not `phone`. On a CREATE the service falls
       back to Phone when this is absent; on an EDIT nothing falls back, so a
       changed delivery number never reached the book at all until this key did.
       Blank still omits — the book keeps whatever it has. */
    DeliverPhone1: (h.emergency_contact_phone as string) ?? null,
    ...soInvoiceAddress(h),
  });
  const agent = resolveAcAgent((h.agent as string) ?? null, salespersonName);
  if (agent) out.Agent = agent;
  const loc = bookSpellingOrOwn((h.sales_location as string) ?? null, LOCATION_MAP);
  if (loc) out.SalesLocation = loc;
  if (h.so_date) out.DocDate = String(h.so_date);

  const udf: Record<string, string> = {};
  /* bookSpelling, NOT bookSpellingOrOwn: BRANDING_MAP is the one allow-list of
     the four, because the ERP column behind it holds CATEGORIES. */
  const branding = bookSpelling(soBranding((h.branding as string) ?? null, lines), BRANDING_MAP);
  if (branding) udf.BRANDING = branding;
  const venue = bookSpellingOrOwn((h.venue as string) ?? null, VENUE_MAP);
  if (venue) udf.VENUE = venue;
  const customerRef = soCustomerRef(h);
  if (customerRef) udf.ToPONo = customerRef;
  /* The SO's "Processing date" (owner: 账目日期). Owner 2026-08-12: editing it
     in the ERP must reach AutoCount. Same omit-when-absent rule as the rest of
     this function — a cleared date sends nothing rather than blanking the
     account book's value, which is the conservative half of the pair and the
     one that cannot destroy data. */
  const pdate = acUdfDate(h.processing_date as string | null | undefined);
  if (pdate) udf.PDate = pdate;
  /* The outstanding balance, and the one UDF whose ZERO must be sent: an order
     the customer has now settled has to stop showing a debt in the account
     book, and `acUdfMoney` renders that as "0.00" precisely so this `if` does
     not drop it. Only a null — the ERP has no answer — omits the key. */
  const balance = acUdfMoney(outstandingCenti);
  if (balance != null) udf.BALANCE = balance;
  if (Object.keys(udf).length) out.UDF = udf;

  return out;
}

/**
 * What AutoCount calls each of these products, from the LIVE binding.
 *
 * `scm.supplier_material_bindings` is this ERP's own record of the cross-ref:
 * `material_code` is our internal code, `supplier_sku` is AutoCount's, one row
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
  let q = sb.from('supplier_material_bindings')
    .select('material_code, supplier_id, supplier_sku, is_main_supplier')
    .in('material_code', wanted)
    .eq('material_kind', 'mfg_product')
    .order('is_main_supplier', { ascending: false });
  if (companyId != null) q = q.eq('company_id', companyId);
  const rows = await readOrThrow('supplier_material_bindings', q);
  const bySupplier = new Map<string, string>();
  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    const code = String(r.material_code ?? '').trim().toUpperCase();
    const sku = typeof r.supplier_sku === 'string' ? r.supplier_sku.trim() : '';
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

async function mark(sb: Sb, id: string, patch: Record<string, unknown>): Promise<void> {
  await sb.from('autocount_outbox')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
}

/**
 * Store the DtlKeys a create/convert returned onto the ERP line rows.
 *
 * VERIFIES BEFORE IT WRITES, and writes nothing at all if the check fails.
 *
 * The zip is by index: the Nth line AutoCount reports is the Nth detail we sent.
 * That is true because AcSyncService returns them ordered by DtlKey, which is
 * creation order, and we created them in payload order. But "true because of a
 * chain of reasoning" is not good enough for line identity — a wrong DtlKey does
 * not fail, it silently edits a DIFFERENT line in a live account book on the
 * next save. A missing key is refused loudly by composeEdit; a wrong one is not
 * refused at all. So the count must match and every ItemCode must match, or the
 * whole batch is abandoned and the document simply keeps NULL keys.
 *
 * Never throws and never changes the outcome of the dispatch: the document IS in
 * AutoCount and the row IS sent. Failing to record identity is a degradation to
 * be logged, not a reason to re-send a document that already exists.
 */
async function persistLineKeys(
  sb: Sb,
  row: AcOutboxRow,
  target: NonNullable<AcOutboxPayload['lineWriteback']>,
  lines: AcCreatedLine[],
): Promise<void> {
  const label = `[autocount-outbox] ${row.op} ${row.doc_no} line keys`;
  try {
    /* Not an error. An AcSyncService built before 2026-08-11 returns no lines,
       and the service also degrades to an empty array rather than losing the
       DocNo when its own read-back fails. */
    if (!lines.length) return;

    if (lines.length !== target.ids.length) {
      // eslint-disable-next-line no-console
      console.error(
        `${label}: NOT STORED — AutoCount reported ${lines.length} line(s), the ERP sent `
        + `${target.ids.length}. Storing them by position would attach a key to the wrong line.`,
      );
      return;
    }

    const ordered = [...lines].sort((a, b) => a.Seq - b.Seq);
    const groups = target.ids.map((g) => (Array.isArray(g) ? g : [g]));
    const norm = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();
    for (let i = 0; i < ordered.length; i += 1) {
      const got = norm(ordered[i].ItemCode);
      const want = norm(target.codes[i]);
      /* An older service may omit ItemCode; only a PRESENT and DIFFERENT code
         is evidence the zip is wrong. */
      if (got && want && got !== want) {
        // eslint-disable-next-line no-console
        console.error(
          `${label}: NOT STORED — position ${i + 1} is '${ordered[i].ItemCode}' in AutoCount but `
          + `'${target.codes[i]}' in the ERP. The two line lists do not correspond.`,
        );
        return;
      }
    }

    /* ItemCode alone stops being an identity check the moment a code repeats,
       and on a CONVERSION that is the normal case, not an edge one: the ERP
       never sends a line list for a conversion — AutoCount chooses the source
       lines itself (AcSyncService.cs:382-411) — so the two orderings are only
       PRESUMED to line up. A sofa document is the concrete failure: several
       lines share one code and differ only in the build written into Desc2, so
       an all-codes-match check passes while the keys land on the wrong lines,
       and the next edit rewrites somebody else's line in a live book.
       Desc2 is what tells those lines apart, so where it is available on both
       sides it must agree too, and a repeated code with no Desc2 to separate it
       is refused outright rather than guessed. */
    const dupes = new Set(
      target.codes.map(norm).filter((c, i, a) => c && a.indexOf(c) !== i),
    );
    for (let i = 0; i < ordered.length; i += 1) {
      const gotD = norm(ordered[i].Desc2);
      const wantD = norm(target.desc2?.[i]);
      /* PREFIX-TOLERANT, because AutoCount's own column truncates. SODTL.Desc2
         is nvarchar(100) and live sofa builds already sit at exactly 100 — the
         account book cut them itself, before the ERP ever saw them. An equality
         test would refuse those legitimately-matching lines. A prefix test keeps
         all the discriminating power that matters here: two different builds of
         the same model diverge in the first few tokens, not after character
         100. */
      const differs = gotD && wantD && !gotD.startsWith(wantD) && !wantD.startsWith(gotD);
      if (differs) {
        // eslint-disable-next-line no-console
        console.error(
          `${label}: NOT STORED — position ${i + 1} carries Desc2 '${ordered[i].Desc2}' in `
          + `AutoCount but '${target.desc2?.[i]}' in the ERP. Same ItemCode, different line.`,
        );
        return;
      }
      if (dupes.has(norm(target.codes[i])) && !(gotD && wantD)) {
        // eslint-disable-next-line no-console
        console.error(
          `${label}: NOT STORED — ItemCode '${target.codes[i]}' appears on more than one line and `
          + 'position ' + (i + 1) + ' has no Desc2 on both sides to tell them apart. '
          + 'Storing by position here would be a guess.',
        );
        return;
      }
    }

    for (let i = 0; i < ordered.length; i += 1) {
      /* Every ERP row behind this AutoCount line gets the SAME key. For a sofa
         that is the build's compartments; composeEdit later accepts the build
         only when all of them still agree on it. */
      for (const id of groups[i]) {
        const { error } = await sb.from(target.table)
          .update({ linked_ac_dtlkey: ordered[i].DtlKey })
          .eq('id', id);
        if (error) {
          // eslint-disable-next-line no-console
          console.error(`${label}: partial — row ${id} failed: ${error.message}`);
        }
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`${label}: not stored:`, e instanceof Error ? e.message : String(e));
  }
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
): Promise<DispatchOutcome> {
  const payload = (row.payload ?? { body: {} }) as AcOutboxPayload;
  const body: Record<string, unknown> = { ...(payload.body ?? {}) };

  if (payload.fromDoc) {
    const from = await acDocNoOf(sb, payload.fromDoc);
    if (!from) {
      await mark(sb, row.id, { last_error: 'waiting: parent has no AutoCount document yet' });
      return 'waiting';
    }
    body.FromDocNo = from;
  }
  if (payload.selfDoc) {
    const self = await acDocNoOf(sb, payload.selfDoc);
    if (!self) {
      await mark(sb, row.id, { last_error: 'waiting: this document has no AutoCount counterpart yet' });
      return 'waiting';
    }
    body.DocNo = self;
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
      if (!ensured.ok) {
        await mark(sb, row.id, {
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
    return 'sent';
  }

  const giveUp = !result.retryable || attempts >= MAX_ATTEMPTS;
  await mark(sb, row.id, {
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
  const { data, error } = await sb.from('autocount_outbox')
    .select('id, company_id, op, doc_type, doc_no, doc_id, payload, status, attempts, dedupe_key')
    .eq('status', 'pending')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error || !data) return { skipped: error ? 'query_failed' : undefined, ...zero };

  const summary = { ...zero };
  for (const raw of data as AcOutboxRow[]) {
    /* Re-checked per row, not once per sweep: the flag is per COMPANY, and it
       may be turned off mid-sweep. Off leaves the row pending — it is not a
       failure, and the work must survive to be drained when it is on again. */
    if (!(await isWritebackEnabled(sb, raw.company_id))) continue;
    summary.processed += 1;
    const outcome = await dispatchOne(env, sb, raw, fetchImpl);
    if (outcome === 'sent') summary.sent += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else if (outcome === 'waiting') summary.waiting += 1;
    else summary.retried += 1;
  }
  return summary;
}
