/* ------------------------------------------------------------------------- *
 * mobile-add-line — "Add line" on a document's phone detail: who is offered it,
 * and the request each document's item endpoint takes.
 *
 * Owner ruling 2026-09-12: 「电脑版本有的，手机版本都要有」. The desktop offers
 * `ADD_LINE_LABEL` on the purchase order, goods receipt, purchase invoice and
 * sales invoice (vendor/scm/lib/add-line-handoff.ts); the phone offered it on
 * none — `grep ADD_LINE_LABEL frontend/src/mobile` was empty.
 *
 * NO RULE LIVES HERE. Each gate is two shared answers ANDed:
 *   - may this person write the document at all — the auth/salesAccess operate
 *     helper the rest of the phone uses for that document (the server's
 *     area-guard `edit` rule), and
 *   - is the document still open for a new line — vendor/scm/lib/line-add-lock,
 *     the SAME module the desktop editors now decide with.
 * The request bodies copy what the desktop add rows send, field for field, so a
 * line added on either surface is the same row.
 *
 * The server stays the authority: every item endpoint re-checks, and its refusal
 * is shown to the operator in words.
 * ------------------------------------------------------------------------- */

import {
  canOperateGoodsReceipts,
  canOperatePurchaseInvoices,
  canOperatePurchaseOrders,
  canOperateSalesInvoices,
} from "../auth/salesAccess";
import {
  goodsReceiptLinesLocked,
  purchaseInvoiceLinesLocked,
  purchaseOrderLinesLocked,
  salesInvoiceLinesOpen,
} from "../vendor/scm/lib/line-add-lock";
import type { AccessLevel, AuthUser } from "../types";

export type AddLineDoc = "po" | "grn" | "pi" | "si";

/** The phone detail modules that carry "Add line". Keyed by the
 *  MobileModuleList config key. Delivery orders are absent on purpose: the
 *  desktop has no manual add on a delivery order either. */
export const MODULE_TO_ADD_LINE_DOC: Readonly<Partial<Record<string, AddLineDoc>>> = {
  "mfg-purchase-orders": "po",
  grns: "grn",
  "purchase-invoices": "pi",
  "sales-invoices": "si",
};

export type AddLineAccess = {
  user: AuthUser | null;
  can: (perm: string) => boolean;
  pageAccess: (page: string) => AccessLevel;
};

/** The header as `GET /<doc>/:id` returns it. Read loosely because the phone
 *  detail keeps it as a plain record; each field is narrowed before use. */
export type AddLineHeader = Record<string, unknown> | null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Is "Add line" offered on this document, to this person? No default arm: a
 * fifth document that forgets its gate does not compile.
 *
 * A header with no status has not loaded, and answers FALSE before any rule is
 * asked. Not left to the lock rules: the PO / GRN / SI rules happen to read a
 * missing status as closed, but the purchase invoice's (CANCELLED or paid) reads
 * it as OPEN — the desktop editors never meet that case because they only ask
 * once the document exists (`pi ? … : true`). Caught by the test, not by reading.
 */
export function mayAddLine(doc: AddLineDoc, header: AddLineHeader, access: AddLineAccess): boolean {
  const h = header ?? {};
  const status = str(h.status);
  if (!status) return false;
  switch (doc) {
    case "po":
      return canOperatePurchaseOrders(access.can, access.pageAccess)
        && !purchaseOrderLinesLocked({ status, has_children: bool(h.has_children) });
    case "grn":
      return canOperateGoodsReceipts(access.can, access.pageAccess)
        && !goodsReceiptLinesLocked({ status, has_children: bool(h.has_children) });
    case "pi":
      return canOperatePurchaseInvoices(access.can, access.pageAccess)
        && !purchaseInvoiceLinesLocked({ status, paid_sen: num(h.paid_sen) });
    case "si":
      return canOperateSalesInvoices(access.user, access.can, access.pageAccess)
        && salesInvoiceLinesOpen({ status });
    default: {
      const unreachable: never = doc;
      return unreachable;
    }
  }
}

export type AddLineDraft = {
  itemCode: string;
  name: string;
  itemGroup: string;
  qty: number;
  /** Typed by the operator; null until they do. Never the catalog SELLING
   *  price the SKU picker carries (on a purchase line that would be booked as
   *  cost), and never a "0.00" box that silently drops keystrokes landing
   *  before its select-on-focus (docs/bugs, the phone direct-create entry). */
  unitPriceSen: number | null;
};

/** Why "Add" is disabled, in the operator's words. Empty = enabled. Both mirror
 *  refusals the item endpoints already make (a code is required; qty > 0). */
export function addLineBlockers(draft: AddLineDraft): string[] {
  const out: string[] = [];
  if (!draft.itemCode.trim()) out.push("Pick an item.");
  if (!(draft.qty > 0)) out.push("Quantity must be more than zero.");
  return out;
}

/**
 * The body for each document's item endpoint, copied from the desktop add row.
 * `receivedOn` is the goods receipt's own date (desktop sends it as the line's
 * delivery date); pass null for the other documents.
 */
export function addLinePayload(
  doc: AddLineDoc,
  docId: string,
  draft: AddLineDraft,
  receivedOn: string | null,
): Record<string, unknown> {
  const itemCode = draft.itemCode.trim();
  const materialName = draft.name.trim() || itemCode;
  const unitPriceSen = draft.unitPriceSen ?? 0;
  const itemGroup = draft.itemGroup || undefined;
  switch (doc) {
    case "po":
      /* PurchaseOrderDetail's new-line insert. */
      return { poId: docId, materialKind: "mfg_product", itemCode, materialName, qty: draft.qty, unitPriceSen, itemGroup, soItemId: null };
    case "grn":
      /* GoodsReceivedDetail's manual add — `qty`, not qtyReceived, and no PO
         item behind it. */
      return { grnId: docId, purchaseOrderItemId: null, materialKind: "mfg_product", itemCode, materialName, itemGroup, qty: draft.qty, unitPriceSen, deliveryDate: receivedOn ?? undefined };
    case "pi":
      /* PurchaseInvoiceDetail's free-entry line (grnItemId null). */
      return { id: docId, materialKind: "mfg_product", itemCode, materialName, qty: draft.qty, unitPriceSen, discountSen: 0, itemGroup };
    case "si":
      /* SalesInvoiceAddLine's submit. */
      return { id: docId, itemCode, description: draft.name.trim() || null, qty: draft.qty, unitPriceSen, discountSen: 0, uom: "UNIT" };
    default: {
      const unreachable: never = doc;
      return unreachable;
    }
  }
}
