// ----------------------------------------------------------------------------
// so-line-purchase-gap — "this line was sold and NOTHING was ever ordered for
// it", decided once on the server so the desktop and the phone cannot disagree.
//
// WHY IT EXISTS. HC-SO-012949 sells a CODY single bedframe. No purchase order
// anywhere on company 1 carries that code, and AutoCount's own export has no
// purchase order for it either — the gap is in the ACCOUNT BOOK, not in our
// copy of it. Minting a purchase order to make the line look right would put a
// document in the ERP that the book does not have, and because a bedframe is
// hard-bound the line would then read READY the moment anything arrived against
// that invented document. So the answer is not a document. It is a FLAG, on the
// surfaces a buyer actually opens.
//
// THE LINE IS NOT MERELY UNCOVERED — IT IS UNREACHABLE. On company 1 a
// bedframe / sofa / (SP)-mattress line lights ONLY through its own dedicated
// purchase order's received quantity (`isHardBoundLine` +
// `HARD_BOUND_COMPANY_ID`, so-stock-allocation.ts; the owner has ruled it three
// times). With no purchase order at all there is no path to READY, however much
// of that item stands in the warehouse. That is what makes this worth its own
// mark rather than leaving it to the PENDING pill, which looks the same as an
// ordinary "not arrived yet".
//
// ─── WHAT IT DELIBERATELY DOES NOT FLAG ─────────────────────────────────────
//
//   A POOLED LINE. A mattress or an accessory is bought against stock and
//   routinely has no purchase order of its own. Flagging those would bury the
//   finding in hundreds of correct rows, which is the same as not flagging it.
//
//   AN UNPROCEEDED ORDER. The Processing Date IS the release for purchasing to
//   order (owner 2026-08-18). Before it, having no purchase order is the normal
//   state of a perfectly good order — and the owner's standing rule is that
//   blank is legitimate until an order is proceeded.
//
//   A FINISHED ORDER. Cancelled / closed / shipped / delivered / invoiced /
//   draft — `SO_TERMINAL_STATES`. Nobody is waiting for those goods.
//
//   A PARTIAL ORDER. `po_qty_picked` between 1 and `qty` means somebody DID
//   raise a purchase order and it covers less than the line. That is a
//   different sentence for a buyer ("order the rest") and it is not what this
//   flag claims, so it stays out rather than being folded in and softened.
//
// `po_qty_picked` is maintained by `recomputeSoPicked`
// (routes/mfg-purchase-orders.ts): the summed quantity of the purchase lines
// dedicated to this sales line, excluding MRP suggestion lines and purchase
// orders that are DRAFT or CANCELLED. Zero therefore means "no live purchase
// line names this sales line", which is exactly the claim being made.
// ----------------------------------------------------------------------------

import { SO_TERMINAL_STATES } from '../shared/so-terminal-states';
import { HARD_BOUND_COMPANY_ID, isHardBoundLine } from './so-stock-allocation';

const TERMINAL = new Set<string>(SO_TERMINAL_STATES);

/**
 * Was this line sold, released for purchasing, and never ordered at all?
 *
 * Every parameter is REQUIRED and nullable rather than optional, because each
 * one DECIDES the answer: an omitted `companyId` or a forgotten
 * `orderProcessed` would silently return the permissive value at a call site
 * nobody re-reads (CLAUDE.md, BUG CLASS optional-param-noop).
 */
export function soLinePurchaseGap(input: {
  /** The company the order belongs to. Only company 1 is exclusively PO-bound. */
  companyId: number | null;
  /** The order's status — a terminal one is not waiting for goods. */
  orderStatus: string | null;
  /** Does the order carry a Processing Date? That date is the release to buy. */
  orderProcessed: boolean;
  itemGroup: string | null;
  itemCode: string | null;
  cancelled: boolean;
  qty: number | null;
  /** `mfg_sales_order_items.po_qty_picked`. */
  poQtyPicked: number | null;
}): boolean {
  if (input.companyId !== HARD_BOUND_COMPANY_ID) return false;
  if (input.cancelled) return false;
  if (!input.orderProcessed) return false;
  if (TERMINAL.has(String(input.orderStatus ?? '').trim().toUpperCase())) return false;
  if (!isHardBoundLine(input.itemGroup, input.itemCode)) return false;
  if (Number(input.qty ?? 0) <= 0) return false;
  return Number(input.poQtyPicked ?? 0) <= 0;
}
