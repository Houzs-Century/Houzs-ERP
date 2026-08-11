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
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { isWritebackEnabled } from './autocount-writeback-flag';
import {
  callAcService,
  composeCreatePo,
  composeCreateSo,
  composeDescription2,
  composeEdit,
  acServiceConfig,
  KeylessLineError,
  type AcDocType,
  type AcOp,
  type AcCreatedLine,
  type ErpLine,
} from '../../services/autocount-writeback';

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
   * `ids` are the ERP line row ids IN THE ORDER their details were put into the
   * payload, so the Nth returned key belongs to the Nth id. `codes` is the same
   * list of AutoCount ItemCodes, kept so the zip can be CHECKED rather than
   * trusted — see persistLineKeys.
   */
  lineWriteback?: {
    table: AcLineTable;
    ids: string[];
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
const SO_HEADER_COLS =
  'doc_no, so_date, debtor_name, agent, sales_location, branding, venue, address1, address2, address3, address4, phone, ref, po_doc_no, linked_ac_docno';
const SO_ITEM_COLS =
  'id, item_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey';
/* scm.purchase_orders is SUPPLIER-keyed. It has no creditor_code, creditor_name,
   agent or ref: the creditor is scm.suppliers.code / .name behind supplier_id,
   and the other two do not exist at all on the ERP side. */
const PO_HEADER_COLS = 'id, po_number, po_date, supplier_id, notes, linked_ac_docno';
const PO_ITEM_COLS =
  'id, material_code, item_group, description, qty, unit_price_centi, variants, linked_ac_dtlkey';

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
  item_code: String(r.item_code ?? r.material_code ?? ''),
  item_group: (r.item_group as string) ?? null,
  description: (r.description as string) ?? null,
  description2: (r.description2 as string) ?? null,
  qty: Number(r.qty ?? 0),
  unit_price_centi: Number(r.unit_price_centi ?? 0),
  variants: (r.variants as Record<string, unknown> | null) ?? null,
  linked_ac_dtlkey: (r.linked_ac_dtlkey as number | null) ?? null,
});

interface AcDownstreamSpec {
  table: AcLinkTable;
  itemTable: AcLineTable;
  /** The column on the item table that points back at the header. */
  itemFk: string;
  headerCols: string;
  itemCols: string;
  /** The human document number, for the outbox row's doc_no. */
  docNoOf: (h: Record<string, unknown>) => string;
  line: (r: Record<string, unknown>) => ErpLine;
  header: (h: Record<string, unknown>) => Record<string, string | null>;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

const DOWNSTREAM: Record<'DO' | 'GR' | 'IV' | 'PI', AcDownstreamSpec> = {
  DO: {
    table: 'delivery_orders',
    itemTable: 'delivery_order_items',
    itemFk: 'delivery_order_id',
    headerCols: 'id, do_number, debtor_name, ref, phone, note, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.do_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => ({
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
    headerCols: 'id, grn_number, delivery_note_ref, notes, linked_ac_docno',
    itemCols: 'id, material_code, item_group, description, description2, qty_accepted, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.grn_number ?? h.id ?? ''),
    /* qty_ACCEPTED, not qty_received. AutoCount's GR line quantity is what
       entered stock, and qty_accepted is the number this ERP posts to stock and
       rolls up onto the PO. The received/rejected split has no AutoCount
       counterpart at all, so sending qty_received would make AutoCount's PO
       outstanding disagree with the ERP's by exactly the rejected quantity. */
    line: (r) => soLine({ ...r, qty: r.qty_accepted }),
    header: (h) => ({
      Ref: str(h.delivery_note_ref),
      Description: str(h.notes),
    }),
  },
  IV: {
    table: 'sales_invoices',
    itemTable: 'sales_invoice_items',
    itemFk: 'sales_invoice_id',
    headerCols: 'id, invoice_number, debtor_name, ref, phone, note, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.invoice_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => ({
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
    headerCols: 'id, invoice_number, supplier_invoice_ref, notes, linked_ac_docno',
    itemCols: 'id, material_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.invoice_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => ({
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
 * A read that FAILED, as opposed to a read that found nothing.
 *
 * The distinction is the whole point. PostgREST answers a bad column with an
 * error and a null body; `data ?? []` then turns a failure into "this document
 * has no lines", and the write-back composes a header with an empty Details
 * array — an order pushed into a live account book with nothing on it. Every
 * read below therefore throws this instead of defaulting.
 */
class AcReadError extends Error {}

async function readOrThrow<T>(
  what: string,
  q: PromiseLike<{ data: T; error: { code?: string; message?: string } | null }>,
): Promise<T> {
  const { data, error } = await q;
  if (error) throw new AcReadError(`${what}: ${error.code ?? ''} ${error.message ?? ''}`.trim());
  return data;
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
 *   AcReadError      — the ERP could not read its own document. The operation
 *                      was never composed. Transient, or a schema bug.
 *   KeylessLineError — the ERP read the document perfectly well and DECLINED to
 *                      send it, because a line has no AutoCount DtlKey and
 *                      sending it would append duplicates into the live account
 *                      book. A data gap with a known remedy: backfill the line
 *                      keys for that document.
 *
 * Both must land in the outbox. A refusal nobody can see is indistinguishable
 * from a write-back that quietly stopped working.
 */
async function noteReadFailure(
  sb: Sb,
  e: unknown,
  ctx: { companyId: number; op: AcOp; docType: EnqueueInput['docType']; docNo: string; docId?: string | null },
): Promise<void> {
  const refused = e instanceof KeylessLineError;
  if (!refused && !(e instanceof AcReadError)) return;
  const message = (e as Error).message;
  // eslint-disable-next-line no-console
  console.error(
    refused
      ? `[autocount-outbox] ${ctx.op} REFUSED, nothing queued for AutoCount (line identity missing):`
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
        ? `refused, nothing sent: ${message}`
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
    const body = composeCreateSo(header as never, rows.map(soLine));
    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'create_so',
      docType: 'SO',
      docNo: opts.docNo,
      payload: {
        body: body as unknown as Record<string, unknown>,
        writeback: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: opts.docNo },
        /* toDetails is a strict 1:1 map over these rows, so the Nth detail in
           the payload is the Nth row here, and the Nth DtlKey AutoCount reports
           belongs to it. persistLineKeys re-checks that by ItemCode anyway. */
        lineWriteback: {
          table: 'mfg_sales_order_items',
          ids: rows.map((r) => String(r.id)),
          codes: rows.map((r) => String(r.item_code ?? '')),
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
 * carries the foreign key, not the code or the name. Agent and Ref are null
 * because the ERP has no such field on a purchase order at all; on a CREATE
 * that writes "" into a document that had nothing there anyway.
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
    po_number: String(h.po_number ?? ''),
    po_date: (h.po_date as string | null) ?? null,
    creditor_code: s?.code ?? null,
    creditor_name: s?.name ?? null,
    agent: null,
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
    const body = composeCreatePo(header, rows.map(soLine));
    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'create_po',
      docType: 'PO',
      docNo: header.po_number,
      docId: opts.poId,
      payload: {
        body: body as unknown as Record<string, unknown>,
        writeback: { table: 'purchase_orders', keyCol: 'id', key: opts.poId },
        lineWriteback: {
          table: 'purchase_order_items',
          ids: rows.map((r) => String(r.id)),
          codes: rows.map((r) => String(r.material_code ?? '')),
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
  return enqueueAcOp(sb, {
    companyId: opts.companyId,
    op: opts.op,
    docType: opts.docType,
    docNo: opts.docNo,
    docId: opts.docId ?? null,
    payload: {
      /* No DtlKeys: AcSyncService then transfers every still-outstanding line
         on the parent (AcSyncService.cs:300-329). Sending our own line list
         would require the ERP to hold AutoCount's DtlKeys for every line, and
         to be right about which are already transferred — AutoCount's own book
         is the authority on that, so let it answer. */
      body: { DocDate: opts.docDate ?? null, Ref: opts.ref ?? null },
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
  },
): Promise<boolean> {
  try {
    if (opts.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return false;

    const composed = opts.docType === 'SO'
      ? await composeSoState(sb, String(opts.docNo))
      : opts.docType === 'PO'
        ? await composePoState(sb, String(opts.docId ?? opts.docNo))
        : await composeDownstreamState(sb, opts.docType, String(opts.docId ?? opts.docNo));
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
            payload: { ...(pending.payload ?? {}), body: composed.create },
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
async function composeDownstreamState(sb: Sb, docType: 'DO' | 'GR' | 'IV' | 'PI', id: string) {
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
    create: null as Record<string, unknown> | null,
    edit: () => composeEdit(docType, String(h.linked_ac_docno ?? docNo), spec.header(h), lines),
  };
}

async function composeSoState(sb: Sb, docNo: string) {
  const header = await readOrThrow('mfg_sales_orders header',
    sb.from('mfg_sales_orders').select(SO_HEADER_COLS).eq('doc_no', docNo).maybeSingle());
  if (!header) return null;
  const items = await readOrThrow('mfg_sales_order_items',
    sb.from('mfg_sales_order_items').select(SO_ITEM_COLS).eq('doc_no', docNo));
  const lines = ((items ?? []) as Record<string, unknown>[]).map(soLine);
  const h = header as Record<string, unknown>;
  return {
    docNo,
    linkedAcDocNo: (h.linked_ac_docno as string | null) ?? null,
    self: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: docNo } as AcDocRef,
    create: composeCreateSo(header as never, lines) as unknown as Record<string, unknown>,
    /* LAZY on purpose. composeEdit REFUSES a line with no AutoCount DtlKey, and
       the caller does not always need an edit: when the create is still sitting
       unsent in the outbox it replaces that create's payload instead, and a
       document that has never reached AutoCount cannot possibly have line keys
       yet. Composing eagerly would refuse that legitimate path. */
    edit: () => composeEdit('SO', String(h.linked_ac_docno ?? docNo), {
      DebtorName: (h.debtor_name as string) ?? null,
      Attention: (h.debtor_name as string) ?? null,
      Ref: (h.ref as string) ?? null,
      Phone1: (h.phone as string) ?? null,
      InvAddr1: (h.address1 as string) ?? null,
      InvAddr2: (h.address2 as string) ?? null,
      InvAddr3: (h.address3 as string) ?? null,
      InvAddr4: (h.address4 as string) ?? null,
    }, lines),
  };
}

async function composePoState(sb: Sb, poId: string) {
  const header = await readPoHeader(sb, poId);
  if (!header) return null;
  const items = await readOrThrow('purchase_order_items',
    sb.from('purchase_order_items').select(PO_ITEM_COLS).eq('purchase_order_id', poId));
  const lines = ((items ?? []) as Record<string, unknown>[]).map(soLine);
  return {
    docNo: header.po_number || poId,
    linkedAcDocNo: header.linked_ac_docno,
    self: { table: 'purchase_orders', keyCol: 'id', key: poId } as AcDocRef,
    create: composeCreatePo(header, lines) as unknown as Record<string, unknown>,
    /* No Ref: the ERP has no such field on a purchase order, and /edit applies
       only the keys it is GIVEN (AcSyncService.cs:369 `h.ContainsKey`). Sending
       null would blank whatever the account book has there. */
    edit: () => composeEdit('PO', String(header.linked_ac_docno ?? header.po_number), {
      CreditorName: header.creditor_name,
      Description: header.notes,
    }, lines),
  };
}

// ── drain ───────────────────────────────────────────────────────────────────

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
      const { error } = await sb.from(target.table)
        .update({ linked_ac_dtlkey: ordered[i].DtlKey })
        .eq('id', target.ids[i]);
      if (error) {
        // eslint-disable-next-line no-console
        console.error(`${label}: partial — row ${target.ids[i]} failed: ${error.message}`);
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
