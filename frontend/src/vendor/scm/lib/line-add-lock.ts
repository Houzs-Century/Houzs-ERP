/* When may a line be ADDED to a document — ONE answer per document, for both
 * surfaces.
 *
 * Owner ruling 2026-09-12: 「电脑版本有的，手机版本都要有」 and 「电话跟电脑版本的权限等等
 * 全部都是要统一的」. Until 2026-09-13 each of these rules existed exactly once, as
 * an inline `const isLocked = ...` inside a desktop EDITOR page
 * (PurchaseOrderDetail / GoodsReceivedDetail / PurchaseInvoiceDetail) and inside
 * the sales invoice's add-line hook. The phone could not add a line at all, so
 * nothing read them twice — and the moment it could, a second copy in
 * `frontend/src/mobile` would have been the drift this repo keeps paying for,
 * and one `check-shared-mirrors` cannot see (it compares same-named modules).
 *
 * So the rules live here and BOTH surfaces import them. The desktop editors'
 * expressions were moved as written, with one widening: status is compared
 * upper-cased (the server writes upper-case, and the sales invoice's copy
 * already upper-cased). `lineAddLock.test.ts` pins the truth tables and scans
 * the desktop editors to prove they call these rather than a re-grown inline copy.
 *
 * THE SERVER IS STILL THE AUTHORITY. These decide whether the control is
 * OFFERED. Every item endpoint re-checks and refuses on its own; a refusal must
 * still reach the operator in words.
 *
 * Inputs are the document HEADER as `GET /<doc>/:id` returns it — the same read
 * the desktop editor and the mobile detail both make. `has_children` and
 * `paid_sen` are stamped on that header by the backend (e.g. the PO detail
 * handler's downstream-lock stamp).
 */

/** Minimal header shapes. Fields are required-but-nullable on purpose: a
 *  missing `has_children` must be a decision the caller writes (`null`), not a
 *  silent `undefined` that reads as "no children" and unlocks the document. */
export type PoLockHeader = { status: string | null; has_children: boolean | null };
export type GrnLockHeader = { status: string | null; has_children: boolean | null };
export type PiLockHeader = { status: string | null; paid_sen: number | null };
export type SiLockHeader = { status: string | null };

const up = (s: string | null): string => (s ?? '').toUpperCase();

/**
 * PURCHASE ORDER. Editable while DRAFT, SUBMITTED or PARTIALLY_RECEIVED; locked
 * once a goods receipt exists (`has_children`) — a DRAFT never has one.
 * RECEIVED / CANCELLED stay locked. (Moved from PurchaseOrderDetail.tsx.)
 */
export function purchaseOrderLinesLocked(po: PoLockHeader): boolean {
  const s = up(po.status);
  const isEditableStatus = s === 'DRAFT' || s === 'SUBMITTED' || s === 'PARTIALLY_RECEIVED';
  return !isEditableStatus || Boolean(po.has_children);
}

/**
 * GOODS RECEIPT. DRAFT is editable (the line endpoints write a draft without
 * moving stock); POSTED is editable until a purchase invoice or return hangs off
 * it; CANCELLED / CLOSED lock. (Moved from GoodsReceivedDetail.tsx.)
 */
export function goodsReceiptLinesLocked(grn: GrnLockHeader): boolean {
  const s = up(grn.status);
  return !(s === 'DRAFT' || (s === 'POSTED' && !grn.has_children));
}

/**
 * PURCHASE INVOICE. Locked once CANCELLED, or once any payment is recorded
 * (migration 0106). A DRAFT and a POSTED ("Confirmed") invoice with nothing paid
 * are editable. (Moved from PurchaseInvoiceDetail.tsx.)
 */
export function purchaseInvoiceLinesLocked(pi: PiLockHeader): boolean {
  return up(pi.status) === 'CANCELLED' || (pi.paid_sen ?? 0) > 0;
}

/**
 * SALES INVOICE. Lines open on a DRAFT only. Once issued, adding a line raises
 * what the customer owes and void+reposts the GL while the PDF in their hand
 * does not change; CANCELLED is refused too. Mirrors `POST /sales-invoices/:id/items`.
 * (Moved from SalesInvoiceDetailV2.tsx's `siIsDraft`.)
 */
export function salesInvoiceLinesOpen(si: SiLockHeader): boolean {
  return up(si.status) === 'DRAFT';
}
