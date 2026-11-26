import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { isWritebackEnabled } from './autocount-writeback-flag';
import { inAcLineOrder } from './ac-line-order'; import { poRaisedFromSo } from './so-po-raised';
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

export type { AcRetiredLine } from '../../services/autocount-writeback';
import { poEditHeader } from '../../services/autocount-po-supplier-dates';

import { mastersOf } from './autocount-masters';
import { soEditHeader } from './so-edit-header';
import {
  AcReadError, readOrThrow, readSoOutstandingSen, readSoPaymentRefs, readPoEnqueueShape,
  readWarehouseCode,
  withLocations,
} from './autocount-read';
import { backfillSoToPoKeys, poBodyForShape } from './autocount-so-to-po-keys';
import { acParentlessCreateReason, acNotCarriedReason } from './autocount-outbox-status';
import { lineIdentityGap, persistNewLineKeys, newLineTargetOf } from './autocount-line-keys';
import { attachPhotos } from './autocount-photo-attach';
import { erpOwnsPaymentText } from './ac-payement-owner';
import { readPoSourceSo } from './autocount-po-source-so';
import { resendHeldEdits } from './autocount-held-edit-resend';
import { isStaleKeyRefusal, recomposeStaleKeyedEdit, liveLineKeys, staleKeyReplacedNote } from './autocount-stale-key-recompose';
import { queueSoPoDocNos } from './autocount-so-po-doc-no';
import { readMfgProductBindings } from './supplier-bindings';
import {
  soLine,
  DOWNSTREAM,
  CONVERT_TARGET,
  readConvertSourceKeys,
  readConvertTargetLines,
  readConvertHeaderFacts,
  SALES_CONVERSION,
  PURCHASE_CONVERSION,
  readConvertCreditor,
  downstreamEditHeader,
  downstreamTransferHeader,
  downstreamNotCarried,
  type AcDownstreamSpec,
  type AcHeaderCtx,
} from './autocount-convert-lines';

import { acNotSentProblems, acNotCarriedProblems, type AcDocKind } from './ac-preflight';
import type { SaveProblem } from '../shared/so-save-problems';

type Sb = SupabaseClient<any, any, any>;

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
  keyCol: 'doc_no' | 'id';
  key: string;
}

/** What one outbox row carries. `body` is the AcSyncService payload. */
export interface AcOutboxPayload {
  body: Record<string, unknown>;
  fromDoc?: AcDocRef;
  fromDocs?: AcDocRef[];
  photos?: Array<{ dtlKey: number; keys: string[] }>;
  selfDoc?: AcDocRef;
  writeback?: AcDocRef;
  lineWriteback?: {
    table: AcLineTable;
    ids: Array<string | string[]>;
    codes: string[];
    desc2?: Array<string | null>;
  };
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
  dedupeKey?: string | null;
  createdBy?: number | null;
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
    return !error;
  } catch {
    return false;
  }
}


/* city / postcode / customer_state are the town, postcode and state of an
   ERP-created order: address3 and address4 were written ONLY by the cutover
   import, so without these three the AutoCount document carried the street
   lines and nothing else (soInvoiceAddress packs the five into four).
   customer_so_no is the customer's own reference; po_doc_no / customer_po were
   the other two columns that once held it, both 0%-filled and DROPPED from
   scm.mfg_sales_orders by migration 0310 — `customer_so_no` is the only one any
   surface still writes, and it is what Ref reads (soReference, docs/bugs/0926). */
/* emergency_contact_phone is AutoCount's DeliverPhone1 and `phone` is its
   Phone1 — two contacts, two columns (owner 2026-08-15). The cutover decided
   the pairing in this direction already: import-ac-outstanding-so.mjs:302 takes
   DeliverPhone1 when it differs from Phone1 and inserts it as
   emergency_contact_phone (:390/:412). Reading `phone` for both would put the
   customer's number in front of the driver.
   total_revenue_sen (or local_total_sen when it is 0 — a migrated order) +
   deposit_sen feed the BALANCE UDF; the third input is the payments ledger.
   readSoOutstandingSen takes the local_total_sen fallback since 2026-09-12, so
   it MUST stay in this select (omit it and a migrated order's UDF_BALANCE is
   dropped). NOT balance_sen — recomputeTotals rewrites that to the gross total. */
const SO_HEADER_COLS =
  'doc_no, so_date, debtor_name, agent, salesperson_id, sales_location, branding, venue, address1, address2, address3, address4, city, postcode, customer_state, phone, emergency_contact_phone, ref, customer_so_no, processing_date, customer_delivery_date, total_revenue_sen, local_total_sen, deposit_sen, linked_ac_docno';
/* line_delivery_date is AutoCount's SODTL.DeliveryDate. Unselected, `soLine`
   left it undefined and composeDetails omitted the key, so the account book
   filled in its own default — the document date — on every ERP-created line
   (owner 2026-08-15). It also holds the BLANK the book itself carries on 11,886
   of its 60,939 lines. */
const SO_ITEM_COLS =
  'id, item_code, item_group, branding, description, description2, qty, unit_price_sen, variants, linked_ac_dtlkey, cancelled, warehouse_id, line_delivery_date, photo_urls, line_no';
const PO_HEADER_COLS =
  'id, company_id, po_number, po_date, supplier_id, notes, purchase_location_id, linked_ac_docno, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4';
const PO_ITEM_COLS =
  'id, item_code, item_group, description, description2, qty, unit_price_sen, variants, linked_ac_dtlkey, warehouse_id, delivery_date, photo_urls, line_no';



async function readSalespersonName(sb: Sb, salespersonId: unknown): Promise<string | null> {
  const id = typeof salespersonId === 'string' ? salespersonId.trim() : '';
  if (!id) return null;
  const row = await readOrThrow('staff',
    sb.from('staff').select('name').eq('id', id).maybeSingle());
  const name = ((row as { name?: string | null } | null)?.name ?? '').trim();
  return name || null;
}

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
    || e instanceof AcSoToPoAlignmentError;
  const named = refused || e instanceof AcReadError;
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
      reason: refused
        ? `refused, nothing sent (${(e as Error).name}): ${message}`
        : `compose failed, nothing sent: ${named ? '' : `(${(e as Error).name}) `}${message}`,
    });
  } catch { }
  return acNotSentProblems(e, AC_DOC_NOUN[ctx.docType] ?? 'document');
}


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
    if ((header as { linked_ac_docno?: string | null }).linked_ac_docno) return AC_ENQUEUE_SILENT;
    const items = await readOrThrow('mfg_sales_order_items',
      inAcLineOrder(sb.from('mfg_sales_order_items').select(SO_ITEM_COLS).eq('doc_no', opts.docNo)));
    const rows = (items ?? []) as Record<string, unknown>[];
    const lines = await withLocations(sb, rows, rows.map(soLine));
    const bindings = await bindingsFor(sb, opts.companyId, lines.map((l) => l.item_code));
    const { collapsed, details } = composeDetails(lines, { bindings });
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
  const purchaseLocation = await readWarehouseCode(sb, h.purchase_location_id);
  return {
    id: String(h.id ?? poId),
    company_id: (h.company_id as number | null) ?? null,
    supplier_id: h.supplier_id == null ? null : String(h.supplier_id),
    po_number: String(h.po_number ?? ''),
    po_date: (h.po_date as string | null) ?? null,
    creditor_code: s?.code ?? null,
    creditor_name: s?.name ?? null,
    agent: AC_PURCHASE_AGENT,
    ...(await readPoSourceSo(sb, String(h.id ?? poId))),  // ref + source_so_no - docs/bugs/0926
    notes: (h.notes as string | null) ?? null,
    purchase_location: purchaseLocation,
    linked_ac_docno: (h.linked_ac_docno as string | null) ?? null,
    supplier_delivery_date_2: (h.supplier_delivery_date_2 as string | null) ?? null,
    supplier_delivery_date_3: (h.supplier_delivery_date_3 as string | null) ?? null,
    supplier_delivery_date_4: (h.supplier_delivery_date_4 as string | null) ?? null,
  };
}

/** PO create. */
export async function enqueuePoCreate(
  sb: Sb,
  opts: { companyId: number | null | undefined; poId: string; createdBy?: number | null },
): Promise<AcEnqueueOutcome> {
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
    const { shape } = await readPoEnqueueShape(sb, opts.poId);
    const forTransfer = shape.kind === 'transfer';
    const { collapsed, details } = composeDetails(lines, { supplierCode: header.creditor_code, bindings, forTransfer });
    const body = composeCreatePo(header, lines, { bindings, forTransfer });

    return { queued: await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: shape.kind === 'create' ? 'create_po' : 'so_to_po',
      docType: 'PO',
      docNo: header.po_number,
      docId: opts.poId,
      payload: {
        body: poBodyForShape(shape, body as never, details),
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
  const source = await readConvertSourceKeys(sb, opts.op, opts.docId ?? null);
  if (source.refuse) {
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
  const froms = Array.isArray(opts.from) ? opts.from : [opts.from];
  if (!froms.length) return AC_ENQUEUE_SILENT;
  const creditor = PURCHASE_CONVERSION.has(opts.op)
    ? await readConvertCreditor(sb, froms[0])
    : null;
  const own = await readConvertHeaderFacts(sb, opts.docType, opts.docId ?? null);
  const queued = await enqueueAcOp(sb, {
    companyId: opts.companyId,
    op: opts.op,
    docType: opts.docType,
    docNo: opts.docNo,
    docId: opts.docId ?? null,
    payload: {
      body: {
        DocNo: opts.docNo ?? null,
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
        ...(source.details ? { Details: source.details } : {}),
      },
      ...(froms.length === 1 ? { fromDoc: froms[0] } : { fromDocs: froms }),
      writeback: opts.to,
      lineWriteback: await readConvertTargetLines(sb, opts.op, opts.docId ?? null),
      ...(own.notCarried.length ? { notCarried: own.notCarried } : {}),
    },
    dedupeKey: `${opts.op}:${opts.docId ?? opts.docNo}`,
    reason: acNotCarriedReason(own.notCarried),
    createdBy: opts.createdBy ?? null,
  });
  return { queued, problems: queued ? acNotCarriedProblems(own.notCarried, AC_DOC_KIND[opts.docType]) : [] };
}

const AC_DOC_KIND: Record<'DO' | 'IV' | 'GR' | 'PI', AcDocKind> = {
  DO: 'delivery order', IV: 'invoice', GR: 'goods receipt', PI: 'purchase invoice',
};

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
    reason: acParentlessCreateReason(opts.missing),
    createdBy: opts.createdBy ?? null,
  });
}

async function grnLinkIsReallyAPo(sb: Sb, grnId: string): Promise<string | null> {
  try {
    const { data: g, error: gErr } = await sb.from('grns')
      .select('grn_number, linked_ac_docno').eq('id', grnId).maybeSingle();
    if (gErr || !g) return null;
    const link = (g as { linked_ac_docno: string | null }).linked_ac_docno;
    if (!link) return null;
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
    docNo?: string | null;
    docId?: string | null;
    createdBy?: number | null;
    newLineIds?: string[];
    retire?: AcRetiredLine[];
    rebuild?: boolean;
    touchedFields?: readonly string[];
  },
): Promise<boolean> {
  let resolvedDocNo: string | null = null;  // the CATCH needs the number: a PO route passes only docId, so a refusal was filed under a UUID (docs/bugs/0774)
  try {
    if (opts.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return false;

    const retired = (opts.retire ?? []).filter((r) => Number.isFinite(Number(r.DtlKey)));
    const composed = opts.docType === 'SO'
      ? await composeSoState(sb, String(opts.docNo), retired, opts.newLineIds, opts.touchedFields, opts.rebuild ?? false)
      : opts.docType === 'PO'
        ? await composePoState(sb, String(opts.docId ?? opts.docNo), retired, opts.newLineIds, opts.rebuild ?? false)
        : await composeDownstreamState(sb, opts.docType, String(opts.docId ?? opts.docNo), retired, opts.newLineIds);
    if (!composed) return false;
    const docNo = (resolvedDocNo = composed.docNo);

    const pending = await findPendingOriginatingOp(sb, opts.companyId, opts.docType, docNo, opts.docId ?? null);
    if (pending) {
      if (composed.create) {
        const { error } = await sb.from('autocount_outbox')
          .update({
            payload: { ...(pending.payload ?? {}), body: composed.create() },
            updated_at: new Date().toISOString(),
          })
          .eq('id', pending.id);
        return !error;
      }
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

    if (!composed.linkedAcDocNo) return false;

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
        ...(composed.photos ? { photos: composed.photos } : {}),
      },
      dedupeKey: null,
      createdBy: opts.createdBy ?? null,
    });
  } catch (e) {
    await noteReadFailure(sb, e, {
      companyId: opts.companyId as number,
      op: 'edit',
      docType: opts.docType,
      docNo: String(resolvedDocNo ?? opts.docNo ?? opts.docId ?? ''),
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
    .in('op', ['create_so', 'create_po', 'so_to_do', 'po_to_gr', 'do_to_iv', 'gr_to_pi'])
    .eq('status', 'pending');
  q = docId ? q.eq('doc_id', docId) : q.eq('doc_no', docNo);
  const { data } = await q.maybeSingle();
  return (data as { id: string; payload: AcOutboxPayload } | null) ?? null;
}

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
    photos: undefined as AcOutboxPayload['photos'],
    self: { table: spec.table, keyCol: 'id', key: id } as AcDocRef,
    create: null as (() => Record<string, unknown>) | null,
    /* Add-a-line, same contract as the SO's and PO's — docs/bugs/0588-*. */
    edit: () => composeEdit(docType, String(h.linked_ac_docno ?? docNo),
      downstreamEditHeader(docType, h), lines,
      newLineIds?.length ? { newLineIds: new Set(newLineIds) } : {}, retired),
  };
}

async function composeSoState(sb: Sb, docNo: string, retired: AcRetiredLine[] = [], newLineIds?: string[], touchedFields: readonly string[] = [], rebuild = false) {
  const header = await readOrThrow('mfg_sales_orders header',
    sb.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', docNo).maybeSingle());
  if (!header) return null;
  const items = await readOrThrow('mfg_sales_order_items',
    inAcLineOrder(sb.from('mfg_sales_order_items').select(SO_ITEM_COLS).eq('doc_no', docNo)));
  const soRows = (items ?? []) as Record<string, unknown>[];
  const lines = await withLocations(sb, soRows, soRows.map(soLine));
  const h = header as Record<string, unknown>;
  const bindings = await bindingsFor(sb, (h.company_id as number | null) ?? null, lines.map((l) => l.item_code));
  const [salespersonName, outstandingSen, erpPaymentRefs, poRaised] = await Promise.all([
    readSalespersonName(sb, h.salesperson_id), readSoOutstandingSen(sb, h),
    readSoPaymentRefs(sb, docNo), poRaisedFromSo(sb, docNo)]);
  const paymentRefs = erpOwnsPaymentText(h.linked_ac_docno) ? erpPaymentRefs : [];
  return {
    docNo,
    linkedAcDocNo: (h.linked_ac_docno as string | null) ?? null,
    photos: photosOf(soRows),
    self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: docNo } as AcDocRef,
    create: () => composeCreateSo(header as never, lines, salespersonName, outstandingSen, paymentRefs, { bindings }) as unknown as Record<string, unknown>,
    edit: () => composeEdit(
      'SO', String(h.linked_ac_docno ?? docNo),
      soEditHeader(h, salespersonName, lines, outstandingSen, paymentRefs, touchedFields), lines,
      { bindings,
        ...(newLineIds?.length ? { newLineIds: new Set(newLineIds) } : {}), ...(poRaised ? { rebuildBlocked: 'A PO was raised from this SO.' } : {}), ...(rebuild ? { rebuild: true } : {}) },
      retired,
    ),
  };
}

async function composePoState(sb: Sb, poId: string, retired: AcRetiredLine[] = [], newLineIds?: string[], rebuild = false) {
  const header = await readPoHeader(sb, poId);
  if (!header) return null;
  const items = await readOrThrow('purchase_order_items',
    inAcLineOrder(sb.from('purchase_order_items').select(PO_ITEM_COLS).eq('purchase_order_id', poId)));
  const poRows = (items ?? []) as Record<string, unknown>[];
  const lines = await withLocations(sb, poRows, poRows.map(soLine));
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
    edit: () => composeEdit('PO', String(header.linked_ac_docno ?? header.po_number), poEditHeader(header), lines, {
      supplierCode: header.creditor_code,
      bindings: poBindings,
      ...(newLineIds && newLineIds.length ? { newLineIds: new Set(newLineIds) } : {}), ...(rebuild ? { rebuild: true } : {}),
    }, retired),
  };
}



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
export async function bindingsFor(
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
  for (const [code, sku] of bySupplier) out.set(code, sku);
  return out;
}

export { mastersOf };

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
    return { host_built_at: at, host_mvid: id };
  } catch {
    return null;
  }
}

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

async function mark(sb: Sb, id: string, patch: Record<string, unknown>): Promise<void> {
  await sb.from('autocount_outbox')
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
  hostBuild: AcHostBuild | null = null,
): Promise<DispatchOutcome> {
  const payload = (row.payload ?? { body: {} }) as AcOutboxPayload;
  const body: Record<string, unknown> = { ...(payload.body ?? {}) };
  const stamp = hostBuild ?? {};

  if (payload.fromDoc) {
    const from = await acDocNoOf(sb, payload.fromDoc);
    if (!from) {
      await mark(sb, row.id, { last_error: 'waiting: parent has no AutoCount document yet' });
      return 'waiting';
    }
    body.FromDocNo = from;
  }
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
  if (row.op === 'so_to_po' && !body.DocNo && row.doc_no) body.DocNo = row.doc_no;

  await backfillSoToPoKeys(sb, row.op, body, payload.writeback);

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
    const creditor = await readConvertCreditor(sb, creditorSource);
    if (creditor) Object.assign(body, creditor);
  }

  /* THE PHOTOGRAPHS, fetched in the moment they are sent — keys in the payload,
     bytes from SO_ITEM_PHOTOS. Per line all or none, an unreadable picture never
     stops the document, and since docs/bugs/0899 a line whose pictures would
     take the body past the host's 2 MiB limit is sent without them and the row
     says so (autocount-photo-attach.ts). */
  const photoNote = row.op === 'edit' && payload.photos?.length
    ? await attachPhotos(env, body, payload.photos, `${row.doc_type} ${row.doc_no}`)
    : null;

  const attempts = (row.attempts ?? 0) + 1;

  if (row.op === 'create_so' || row.op === 'create_po' || row.op === 'edit') {
    const masters = mastersOf(body);
    if (masters) {
      const ensured = await callAcService(env, 'ensure_masters', masters, fetchImpl);
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
    /* Line identity is a second question and this file does not own it:
       docs/bugs/0813, and `lineIdentityGap` in autocount-line-keys.ts. Recorded
       BEFORE the mark so the two facts arrive together. */
    const identityGap = await lineIdentityGap(sb, row, payload, result.lines, body);

    await mark(sb, row.id, {
      ...stamp,
      status: 'sent',
      attempts,
      last_error: [identityGap, photoNote].filter(Boolean).join(' | ') || null,
      ac_doc_no: result.docNo,
      sent_at: new Date().toISOString(),
    });
    if (payload.writeback && result.docNo) {
      await sb.from(payload.writeback.table)
        .update({ linked_ac_docno: result.docNo })
        .eq(payload.writeback.keyCol, payload.writeback.key);
    }
    /* AN EDIT THAT ADDED A LINE LEARNS THAT LINE'S KEY (docs/bugs/0583-*).
       Without it the added row stays keyless and every LATER edit is refused. */
    if (row.op === 'edit') {
      const target = newLineTargetOf(row.doc_type, payload);
      if (target) await persistNewLineKeys(sb, row, target, result.lines);
    }
    /* An edit refused while this row was on its way goes out now (docs/bugs/0924).
       doc_type is one of the six by the table's CHECK (migration 0277). */
    await resendHeldEdits(sb, { ...row, doc_type: row.doc_type as AcDocType }, (o) => enqueueEdit(sb, o));
    await queueSoPoDocNos(sb, row, (i) => enqueueAcOp(sb, i));  // PO Doc No. of the source orders - docs/bugs/0926
    return 'sent';
  }

  /* A KEYED EDIT THE BOOK REFUSED AS LINE-NOT-FOUND never succeeds on retry: the
     drain replays the stored payload and it still names the same key. Decide it
     now instead of burning six attempts. When the ERP has RE-KEYED the line (a
     Rebuild), compose the document as it now stands, once, and fold this row as
     Replaced; when the ERP STILL carries the key, the account book lost the line
     and it is left failing for a person to see. docs/bugs/0941. */
  if (row.op === 'edit' && isStaleKeyRefusal(result.error)) {
    const outcome = await recomposeStaleKeyedEdit(
      sb,
      { id: row.id, company_id: row.company_id, doc_type: row.doc_type as AcDocType,
        doc_no: row.doc_no, doc_id: row.doc_id, op: row.op, last_error: result.error ?? null },
      (o) => enqueueEdit(sb, o),
      (docType, docNo, docId) => liveLineKeys(sb, docType, docNo, docId),
    );
    if (outcome.kind !== 'none') {
      await mark(sb, row.id, {
        ...stamp,
        attempts,
        status: 'failed',
        last_error: (outcome.kind === 'queued' ? staleKeyReplacedNote(outcome.key) : '') + (result.error ?? ''),
      });
      return 'failed';
    }
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
  await releaseExpiredClaims(sb);
  const { data, error } = await sb.from('autocount_outbox')
    .select('id, company_id, op, doc_type, doc_no, doc_id, payload, status, attempts, dedupe_key')
    .eq('status', 'pending')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error || !data) return { skipped: error ? 'query_failed' : undefined, ...zero };

  const hostBuild = data.length ? await readHostBuild(env, fetchImpl) : null;

  const summary = { ...zero };
  for (const raw of data as AcOutboxRow[]) {
    if (!(await isWritebackEnabled(sb, raw.company_id))) continue;
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
