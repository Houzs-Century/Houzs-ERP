// ----------------------------------------------------------------------------
// downstream-lock — one document cannot be cancelled or have its lines edited
// once a downstream document has been raised from it.
//
// OWNER RULE, 2026-08-10, on the AutoCount cutover, verbatim:
//   "已经转到下游的单据, AutoCount 不许取消/改动 ... 是的 我们也是要这样"
// ("AutoCount will not let you cancel or change a document that has already
//  been transferred downstream ... yes, we want to be the same.")
//
// This is not a nicety. AutoCount's InvoicingCommonCommand.CancelDocument
// REFUSES a transferred document (AcSyncService.cs:347 turns that refusal into
// an error), and its Edit path cannot retract a line that a DO already shipped.
// If the ERP allowed what AutoCount forbids, the very first edit of a shipped
// order would leave the two systems permanently disagreeing — and the ERP would
// be the one that is wrong, because the stock has already moved.
//
// WHAT THIS MODULE IS. The rule already existed, four times, as a private
// function inside four route files (soHasDownstream / poHasDownstream /
// doHasDownstream / grnHasDownstream, each ~10 lines, each unreachable from a
// test because it lived inside a multi-thousand-line router). This is that same
// rule, in one place, with the same signatures and the same JSON so every
// existing call site keeps behaving identically — and with a pure verdict
// function underneath it that a test can actually address.
//
// WHAT IS DELIBERATELY NOT BLOCKED: raising the NEXT downstream document. An SO
// with one DO can still emit another (partial delivery); a PO with one GRN can
// still be received again. Only MUTATION and CANCEL are blocked. That matches
// AutoCount, which happily keeps transferring but refuses to rewrite history.
//
// CANCELLED CHILDREN DO NOT LOCK. A cancelled DO is not a shipment, so an SO
// whose only DO was cancelled is free again. That is why every count filters
// status <> 'CANCELLED' (the scm status vocabulary is uppercase).
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkIn } from './paginate-all';
import {
  SO_LINE_FROZEN_REFUSAL,
  soLineFreezeFrom,
  soLineFrozen,
  soOrderFullyFrozen,
  type SoFreezeDownstreamLine,
  type SoLineFreeze,
} from '../shared/so-line-freeze';
export { SO_FULLY_FROZEN_REFUSAL, SO_LINE_FROZEN_REFUSAL, soLineFrozen } from '../shared/so-line-freeze';

export type LockedDocType = 'SO' | 'PO' | 'DO' | 'GRN';

/** The refusal body. Shape is fixed by the existing call sites, which return it
 *  straight to the client with a 409. */
export interface DownstreamRefusal {
  error: string;
  message: string;
}

/** What was found downstream of a document, per child kind. */
export interface DownstreamCounts {
  deliveryOrders?: number;
  salesInvoices?: number;
  grns?: number;
  purchaseInvoices?: number;
  deliveryReturns?: number;
}

const REFUSALS: Record<LockedDocType, DownstreamRefusal> = {
  SO: {
    error: 'so_has_downstream',
    message: 'SO has a Delivery Order / Sales Invoice — delete or cancel it first to edit',
  },
  PO: {
    error: 'po_has_downstream',
    message: 'PO has a Goods Receipt — delete or cancel it first to edit',
  },
  DO: {
    error: 'do_has_downstream',
    message: 'DO has a Delivery Return / Sales Invoice — delete or cancel it first to edit',
  },
  GRN: {
    error: 'grn_has_downstream',
    message: 'GRN has a Purchase Invoice / Return — delete it first to edit',
  },
};

/**
 * The rule itself, with no database in it: ANY live downstream document locks.
 *
 * Pure so the owner's rule can be tested directly instead of through a router.
 */
export function downstreamVerdict(
  docType: LockedDocType,
  counts: DownstreamCounts,
): DownstreamRefusal | null {
  const total =
    (counts.deliveryOrders ?? 0) +
    (counts.salesInvoices ?? 0) +
    (counts.grns ?? 0) +
    (counts.purchaseInvoices ?? 0) +
    (counts.deliveryReturns ?? 0);
  return total > 0 ? REFUSALS[docType] : null;
}

/** True when this document may be cancelled or have its lines edited. */
export function isEditable(docType: LockedDocType, counts: DownstreamCounts): boolean {
  return downstreamVerdict(docType, counts) === null;
}

/* ── A FAILED COUNT IS NOT ZERO ─────────────────────────────────────────────
   Every function below used to drop the PostgREST `error` and read `count ?? 0`
   / `data ?? []`. A read that FAILED then arrived at downstreamVerdict as "this
   document has no children", which is exactly the absence that authorises the
   cancel or the line edit the whole module exists to refuse — one dropped error
   and a shipped SO is cancellable again, against the owner's rule at the top of
   this file. A failed read must never read as an absence when the absence is
   what authorises the write.

   So an unreadable count refuses too, with its own code. Call sites are
   unchanged: they already do `if (lock) return c.json(lock, 409)`, and a 409
   the operator can retry is the right answer to "we could not check". */
export const DOWNSTREAM_CHECK_FAILED = 'downstream_check_failed';

const checkFailedRefusal = (docType: LockedDocType, reason: string): DownstreamRefusal => ({
  error: DOWNSTREAM_CHECK_FAILED,
  message: `Could not check whether this ${docType} has downstream documents, so it is locked for safety — try again (${reason}).`,
});

type Sb = SupabaseClient<any, any, any>;

/** A live-child count, or the reason it could not be taken. Never a bare number:
 *  the caller must not be able to spend an unreadable count as a zero. */
type LiveCount = { ok: true; count: number } | { ok: false; reason: string };

const liveCount = async (
  sb: Sb,
  table: string,
  col: string,
  val: string,
): Promise<LiveCount> => {
  const { count, error } = await sb
    .from(table)
    .select('id', { head: true, count: 'exact' })
    .eq(col, val)
    .neq('status', 'CANCELLED');
  if (error) return { ok: false, reason: `${table}: ${error.message}` };
  return { ok: true, count: count ?? 0 };
};

/** Fold the reads into the verdict — but refuse outright if ANY of them failed,
 *  before a single unreadable count can be counted as zero. */
function verdictFromReads(
  docType: LockedDocType,
  reads: Array<[keyof DownstreamCounts, LiveCount]>,
): DownstreamRefusal | null {
  const failed = reads.filter(([, r]) => !r.ok) as Array<[keyof DownstreamCounts, { ok: false; reason: string }]>;
  if (failed.length > 0) return checkFailedRefusal(docType, failed.map(([, r]) => r.reason).join('; '));
  const counts: DownstreamCounts = {};
  for (const [kind, r] of reads) if (r.ok) counts[kind] = r.count;
  return downstreamVerdict(docType, counts);
}

/** The same SO question as `soHasDownstream`, asked for a whole page at once and
 *  answered from rows the caller has already read — the SO list needs the
 *  verdict for 100 orders and cannot afford 200 round-trips to get it. Pass the
 *  live (non-cancelled) DO and SI rows; a row's existence IS the lock, so only
 *  `so_doc_no` is read and rows without one are ignored. */
export function soDocNosWithDownstream(
  ...rowSets: Array<Array<{ so_doc_no: string | null }>>
): Set<string> {
  const out = new Set<string>();
  for (const rows of rowSets) for (const r of rows) if (r.so_doc_no) out.add(r.so_doc_no);
  return out;
}

/** An SO locks on any live Delivery Order or Sales Invoice against it. */
export async function soHasDownstream(sb: Sb, soDocNo: string): Promise<DownstreamRefusal | null> {
  const [deliveryOrders, salesInvoices] = await Promise.all([
    liveCount(sb, 'delivery_orders', 'so_doc_no', soDocNo),
    liveCount(sb, 'sales_invoices', 'so_doc_no', soDocNo),
  ]);
  return verdictFromReads('SO', [['deliveryOrders', deliveryOrders], ['salesInvoices', salesInvoices]]);
}

/* ── PER-LINE: which SO lines a later document already carries ─────────────
   The owner's 2026-09-15 ruling (shared/so-line-freeze.ts) narrows the SO lock
   from the whole order to the lines a live DO / SI names. soHasDownstream above
   still answers the ORDER question — cancel, and the header identity fields. */

export type SoLineFreezeRead =
  | {
      ok: true;
      freeze: SoLineFreeze;
      /** Every line of the order, cancelled included, with its sofa build key. */
      lines: Array<{ id: string; cancelled: boolean; buildKey: string | null }>;
      /** The verdict for the non-cancelled lines: nothing left to convert. */
      fullyFrozen: boolean;
    }
  | { ok: false; refusal: DownstreamRefusal };

const statusById = async (sb: Sb, table: string, ids: string[]): Promise<{ ok: true; map: Map<string, string | null> } | { ok: false; reason: string }> => {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return { ok: true, map };
  const { data, error } = await chunkIn<{ id: string; status: string | null }>(ids, (batch, from, to) =>
    sb.from(table).select('id, status').in('id', batch).range(from, to));
  if (error) return { ok: false, reason: `${table}: ${error.message}` };
  for (const r of data) map.set(r.id, r.status ?? null);
  return { ok: true, map };
};

/** Read the per-line verdict for one Sales Order. Every read that fails refuses
 *  (downstream_check_failed) — an unreadable DO line must never read as "this
 *  line was never delivered", which is the absence that authorises the write. */
export async function readSoLineFreeze(sb: Sb, soDocNo: string): Promise<SoLineFreezeRead> {
  const fail = (reason: string): SoLineFreezeRead => ({ ok: false, refusal: checkFailedRefusal('SO', reason) });

  const [linesRes, ownDosRes, ownSisRes] = await Promise.all([
    sb.from('mfg_sales_order_items').select('id, cancelled, variants').eq('doc_no', soDocNo),
    sb.from('delivery_orders').select('id, status').eq('so_doc_no', soDocNo),
    sb.from('sales_invoices').select('id, status').eq('so_doc_no', soDocNo),
  ]);
  if (linesRes.error) return fail(`mfg_sales_order_items: ${linesRes.error.message}`);
  if (ownDosRes.error) return fail(`delivery_orders: ${ownDosRes.error.message}`);
  if (ownSisRes.error) return fail(`sales_invoices: ${ownSisRes.error.message}`);

  const lines = ((linesRes.data as unknown as Array<{ id: string; cancelled: boolean | null; variants: Record<string, unknown> | null }> | null) ?? [])
    .map((l) => ({
      id: l.id,
      cancelled: l.cancelled === true,
      buildKey: typeof l.variants?.buildKey === 'string' && l.variants.buildKey ? l.variants.buildKey : null,
    }));
  const lineIds = lines.map((l) => l.id);
  const ownDos = (ownDosRes.data as unknown as Array<{ id: string; status: string | null }> | null) ?? [];
  const ownSis = (ownSisRes.data as unknown as Array<{ id: string; status: string | null }> | null) ?? [];
  const isLive = (s: string | null) => String(s ?? '').trim().toUpperCase() !== 'CANCELLED';
  const liveDocumentCount = ownDos.filter((d) => isLive(d.status)).length + ownSis.filter((s) => isLive(s.status)).length;

  type DoLine = { so_item_id: string | null; delivery_order_id: string };
  type SiLine = { so_item_id: string | null; do_item_id: string | null; sales_invoice_id: string };
  const [doByLine, doByDoc, siByLine, siByDoc] = await Promise.all([
    chunkIn<DoLine>(lineIds, (batch, from, to) =>
      sb.from('delivery_order_items').select('so_item_id, delivery_order_id').in('so_item_id', batch).range(from, to)),
    chunkIn<DoLine>(ownDos.map((d) => d.id), (batch, from, to) =>
      sb.from('delivery_order_items').select('so_item_id, delivery_order_id').in('delivery_order_id', batch).range(from, to)),
    chunkIn<SiLine>(lineIds, (batch, from, to) =>
      sb.from('sales_invoice_items').select('so_item_id, do_item_id, sales_invoice_id').in('so_item_id', batch).range(from, to)),
    chunkIn<SiLine>(ownSis.map((s) => s.id), (batch, from, to) =>
      sb.from('sales_invoice_items').select('so_item_id, do_item_id, sales_invoice_id').in('sales_invoice_id', batch).range(from, to)),
  ]);
  for (const [label, r] of [['delivery_order_items', doByLine], ['delivery_order_items', doByDoc], ['sales_invoice_items', siByLine], ['sales_invoice_items', siByDoc]] as const) {
    if (r.error) return fail(`${label}: ${r.error.message}`);
  }
  const doLines = [...doByLine.data, ...doByDoc.data];
  const siLines = [...siByLine.data, ...siByDoc.data];

  const known = (rows: Array<{ id: string; status: string | null }>) => new Map(rows.map((r) => [r.id, r.status ?? null]));
  const doStatus = known(ownDos);
  const siStatus = known(ownSis);
  const [moreDo, moreSi] = await Promise.all([
    statusById(sb, 'delivery_orders', [...new Set(doLines.map((l) => l.delivery_order_id).filter((id) => id && !doStatus.has(id)))]),
    statusById(sb, 'sales_invoices', [...new Set(siLines.map((l) => l.sales_invoice_id).filter((id) => id && !siStatus.has(id)))]),
  ]);
  if (!moreDo.ok) return fail(moreDo.reason);
  if (!moreSi.ok) return fail(moreSi.reason);
  for (const [k, v] of moreDo.map) doStatus.set(k, v);
  for (const [k, v] of moreSi.map) siStatus.set(k, v);

  /* A line whose parent document could not be found at all is treated as LIVE:
     absence of the header is not evidence the shipment was cancelled. */
  const downstream: SoFreezeDownstreamLine[] = [
    ...doLines.map((l) => ({ kind: 'DO' as const, so_item_id: l.so_item_id, status: doStatus.get(l.delivery_order_id) ?? null })),
    ...siLines.map((l) => ({ kind: 'SI' as const, so_item_id: l.so_item_id, do_item_id: l.do_item_id, status: siStatus.get(l.sales_invoice_id) ?? null })),
  ];
  const freeze = soLineFreezeFrom(downstream, liveDocumentCount);
  const fullyFrozen = soOrderFullyFrozen(freeze, lines.filter((l) => !l.cancelled).map((l) => l.id));
  return { ok: true, freeze, lines, fullyFrozen };
}

/** The line-write gate: refuse when the read failed, or when any of `lineIds`
 *  is frozen. `null` means the write may go ahead. */
export function soLineWriteRefusal(
  read: SoLineFreezeRead,
  lineIds: ReadonlyArray<string>,
): DownstreamRefusal | null {
  if (!read.ok) return read.refusal;
  return lineIds.some((id) => soLineFrozen(read.freeze, id)) ? SO_LINE_FROZEN_REFUSAL : null;
}

/** The ids of every line in the same sofa build as `lineId` (itself included).
 *  A build is priced and swapped as ONE thing, so a build with a frozen module
 *  refuses a build-wide write. */
export function soBuildLineIds(read: SoLineFreezeRead, lineId: string): string[] {
  if (!read.ok) return [lineId];
  const self = read.lines.find((l) => l.id === lineId);
  if (!self?.buildKey) return [lineId];
  return read.lines.filter((l) => l.buildKey === self.buildKey).map((l) => l.id);
}

/** A PO locks on any live GRN against it. A Purchase Invoice cannot exist
 *  without one, because grnHasDownstream refuses to cancel an invoiced GRN. */
export async function poHasDownstream(sb: Sb, poId: string): Promise<DownstreamRefusal | null> {
  const grns = await liveCount(sb, 'grns', 'purchase_order_id', poId);
  return verdictFromReads('PO', [['grns', grns]]);
}

/** A DO locks on any live Delivery Return or Sales Invoice against it. */
export async function doHasDownstream(sb: Sb, doId: string): Promise<DownstreamRefusal | null> {
  const [deliveryReturns, salesInvoices] = await Promise.all([
    liveCount(sb, 'delivery_returns', 'delivery_order_id', doId),
    liveCount(sb, 'sales_invoices', 'delivery_order_id', doId),
  ]);
  return verdictFromReads('DO', [['deliveryReturns', deliveryReturns], ['salesInvoices', salesInvoices]]);
}

/**
 * A GRN locks once any of its lines has been invoiced or returned.
 *
 * Counted off grn_items rather than the purchase_invoices table, unchanged from
 * the original: invoiced_qty is RECOUNTED from live PI lines by
 * recomputeGrnInvoiced (purchase-invoices.ts), so it already excludes DRAFT and
 * CANCELLED invoices — which a plain row count over purchase_invoices would not.
 */
export async function grnHasDownstream(sb: Sb, grnId: string): Promise<DownstreamRefusal | null> {
  const { data, error } = await sb.from('grn_items')
    .select('invoiced_qty, returned_qty').eq('grn_id', grnId);
  if (error) return checkFailedRefusal('GRN', `grn_items: ${error.message}`);
  const drawn = ((data ?? []) as Array<{ invoiced_qty: number; returned_qty: number }>)
    .filter((r) => (r.invoiced_qty ?? 0) > 0 || (r.returned_qty ?? 0) > 0).length;
  return downstreamVerdict('GRN', { purchaseInvoices: drawn });
}
