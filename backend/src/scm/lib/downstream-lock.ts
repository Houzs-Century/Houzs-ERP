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

type Sb = SupabaseClient<any, any, any>;

const liveCount = async (
  sb: Sb,
  table: string,
  col: string,
  val: string,
): Promise<number> => {
  const { count } = await sb
    .from(table)
    .select('id', { head: true, count: 'exact' })
    .eq(col, val)
    .neq('status', 'CANCELLED');
  return count ?? 0;
};

/** An SO locks on any live Delivery Order or Sales Invoice against it. */
export async function soHasDownstream(sb: Sb, soDocNo: string): Promise<DownstreamRefusal | null> {
  const [deliveryOrders, salesInvoices] = await Promise.all([
    liveCount(sb, 'delivery_orders', 'so_doc_no', soDocNo),
    liveCount(sb, 'sales_invoices', 'so_doc_no', soDocNo),
  ]);
  return downstreamVerdict('SO', { deliveryOrders, salesInvoices });
}

/** A PO locks on any live GRN against it. A Purchase Invoice cannot exist
 *  without one, because grnHasDownstream refuses to cancel an invoiced GRN. */
export async function poHasDownstream(sb: Sb, poId: string): Promise<DownstreamRefusal | null> {
  const grns = await liveCount(sb, 'grns', 'purchase_order_id', poId);
  return downstreamVerdict('PO', { grns });
}

/** A DO locks on any live Delivery Return or Sales Invoice against it. */
export async function doHasDownstream(sb: Sb, doId: string): Promise<DownstreamRefusal | null> {
  const [deliveryReturns, salesInvoices] = await Promise.all([
    liveCount(sb, 'delivery_returns', 'delivery_order_id', doId),
    liveCount(sb, 'sales_invoices', 'delivery_order_id', doId),
  ]);
  return downstreamVerdict('DO', { deliveryReturns, salesInvoices });
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
  const { data } = await sb.from('grn_items')
    .select('invoiced_qty, returned_qty').eq('grn_id', grnId);
  const drawn = ((data ?? []) as Array<{ invoiced_qty: number; returned_qty: number }>)
    .filter((r) => (r.invoiced_qty ?? 0) > 0 || (r.returned_qty ?? 0) > 0).length;
  return downstreamVerdict('GRN', { purchaseInvoices: drawn });
}
