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
  composeEdit,
  acServiceConfig,
  type AcOp,
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
  docType: 'SO' | 'PO' | 'DO' | 'IV' | 'GR' | 'PI';
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
  'item_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey';
/* scm.purchase_orders is SUPPLIER-keyed. It has no creditor_code, creditor_name,
   agent or ref: the creditor is scm.suppliers.code / .name behind supplier_id,
   and the other two do not exist at all on the ERP side. */
const PO_HEADER_COLS = 'id, po_number, po_date, supplier_id, notes, linked_ac_docno';
const PO_ITEM_COLS =
  'material_code, item_group, description, qty, unit_price_centi, variants, linked_ac_dtlkey';

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
 */
async function noteReadFailure(
  sb: Sb,
  e: unknown,
  ctx: { companyId: number; op: AcOp; docType: EnqueueInput['docType']; docNo: string; docId?: string | null },
): Promise<void> {
  if (!(e instanceof AcReadError)) return;
  // eslint-disable-next-line no-console
  console.error(
    `[autocount-outbox] ${ctx.op} compose read failed — NOTHING queued for AutoCount:`,
    ctx.docNo,
    e.message,
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
      reason: `compose failed, nothing sent: ${e.message}`,
    });
  } catch { /* the note is best-effort; the log above is the floor */ }
}

// ── enqueue helpers, one per flow ───────────────────────────────────────────

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
    const body = composeCreateSo(header as never, ((items ?? []) as Record<string, unknown>[]).map(soLine));
    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'create_so',
      docType: 'SO',
      docNo: opts.docNo,
      payload: {
        body: body as unknown as Record<string, unknown>,
        writeback: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: opts.docNo },
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
    const body = composeCreatePo(header, ((items ?? []) as Record<string, unknown>[]).map(soLine));
    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'create_po',
      docType: 'PO',
      docNo: header.po_number,
      docId: opts.poId,
      payload: {
        body: body as unknown as Record<string, unknown>,
        writeback: { table: 'purchase_orders', keyCol: 'id', key: opts.poId },
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
    },
    dedupeKey: `${opts.op}:${opts.docId ?? opts.docNo}`,
    createdBy: opts.createdBy ?? null,
  });
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
    docType: 'SO' | 'PO' | 'DO' | 'IV' | 'GR' | 'PI';
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
    docType: 'SO' | 'PO';
    /** An SO is keyed by its number; a PO by its id. Pass what the route has. */
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
      : await composePoState(sb, String(opts.docId ?? opts.docNo));
    if (!composed) return false;
    /* A PO route knows its id, not its number; the outbox row is keyed by the
       human document number so it lines up with the create row. */
    const docNo = composed.docNo;

    const pending = await findPendingOriginatingOp(sb, opts.companyId, opts.docType, docNo, opts.docId ?? null);
    if (pending) {
      const { error } = await sb.from('autocount_outbox')
        .update({
          payload: { ...(pending.payload ?? {}), body: composed.create },
          updated_at: new Date().toISOString(),
        })
        .eq('id', pending.id);
      return !error;
    }

    if (!composed.linkedAcDocNo) return false;

    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'edit',
      docType: opts.docType,
      docNo,
      docId: opts.docId ?? null,
      payload: {
        body: composed.edit as unknown as Record<string, unknown>,
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
    edit: composeEdit('SO', String(h.linked_ac_docno ?? docNo), {
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
    edit: composeEdit('PO', String(header.linked_ac_docno ?? header.po_number), {
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
