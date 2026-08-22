/* ----------------------------------------------------------------------------
   printChain — which documents a LIST ROW can print, derived from the row it
   already has.

   THE OWNER'S ASK (2026-08-22), looking at the Sales Order list beside the
   detail page's "Print PDF" button:

     「简单来说，正常我们 print PDF 都是点进去 print 的吧。那我要在这边 right
       click，可以点 print SalesOrder、print DO，这样的意思其实就是 print PDF」

   and, asked whether he wanted it on more than the Sales Order:

     「要的啊，我是要全部的 Transaction Flow 都要」

   So: STAY ON THE LIST, and print any document in that row's chain. What
   shipped on 2026-08-21 was the opposite — `goPrint` navigated to
   `/scm/sales-orders/:docNo?print=1`, which is a shortcut for "click into it",
   the exact thing he is asking to avoid, and it could only ever reach the row's
   OWN document.

   ── THE ONE HARD CONSTRAINT: A PDF NEEDS AN ADDRESS, NOT A NUMBER ──────────

   Every generator is fed by a detail read, and every detail read is keyed:

       GET /mfg-sales-orders/:docNo        the Sales Order, keyed by NUMBER
       GET /delivery-orders-mfg/:id        every other document, keyed by UUID

   `delivery-orders-mfg.ts`'s handler is `.eq('id', id)`, so a document NUMBER
   handed to it returns 404. That is why a `PrintTarget` carries `key` beside
   `docNo`: `docNo` is what the operator READS in the menu, `key` is what the
   fetch ADDRESSES. For a Sales Order they are the same string; for the other
   seven they are not, and conflating them is a 404 the operator reads as "the
   print is broken".

   ── AND THE RULE THAT FOLLOWS FROM IT ─────────────────────────────────────

   AN ENTRY IS BUILT ONLY WHERE THE ROW ALREADY CARRIES AN ADDRESS. Not "built
   and disabled" — `buildRowMenu` drops empty groups, so an entry that cannot
   work simply is not there. And never by fetching: a menu that costs a round
   trip per row is worse than the navigation it replaces, and these lists page
   50 rows at a time.

   Several rows carry a related document's NUMBER and no id — the Sales Order's
   `do_nos`, the Delivery Order's `invoiced_si_nos` / `return_nos`, the
   Purchase Order's `delivered_dos`. A number is enough to KNOW the document
   exists and enough to LABEL it, and not enough to fetch it. Where the number
   arrives without an id, no entry is built and
   `docs/modules/document-conversion.md` §8b records the gap by name.

   Two of those were closed at the source rather than worked around, because the
   query that would carry the id is ALREADY RUNNING: the Sales Order list
   already reads `delivery_orders` and `sales_invoices` by `so_doc_no`, and the
   Delivery Order list already reads `sales_invoices` and `delivery_returns` by
   `delivery_order_id`. Adding `id` to a select that is already in flight costs
   no round trip at all. `do_refs` / `si_refs` / `dr_refs` are those selects
   with one more column.

   ── MRP GUESSES ARE NOT LINKS ─────────────────────────────────────────────

   `assigned_sos` on the purchase-side rows can be a LIVE MRP ALLOCATION rather
   than anything stored (`OriginAssignment.source === 'mrp'`), and the 2026-07-29
   incident is what reading one as a binding costs. Only `'linked'` and
   `'delivered'` become entries here, and a row from an older backend — where
   `source` is absent entirely — becomes none, which is the stricter direction.
   ---------------------------------------------------------------------------- */

import { TRANSFER_DOC, type TransferDoc } from "../vendor/shared/transfer-vocabulary";

/** One printable document: what the operator reads, and what the fetch uses. */
export type PrintTarget = {
  doc: TransferDoc;
  /** The human document number. Shown in the menu and in the print preview. */
  docNo: string;
  /** What the detail endpoint is addressed by — `docNo` for a Sales Order, the
   *  row UUID for every other document. */
  key: string;
};

/** A related document as a list payload carries it: an address and a number. */
export type DocRef = { id: string; docNo: string };

/* A list payload is JSON off the wire, so an ELEMENT can be null even where the
   array is not — and the guards below have to be allowed to say so. Writing it
   into the type is the honest form; guarding a value the compiler has been told
   is non-nullish is what `no-unnecessary-condition` is for. */
type Wire<T> = ReadonlyArray<T | null | undefined> | null | undefined;

/**
 * How many entries one related document TYPE may contribute.
 *
 * One-to-many is real and common — a part-delivered Sales Order has several
 * Delivery Orders, which is the whole reason the DO No. column returns a list
 * (`scm/lib/so-delivery-order-nos.ts`). Every one gets its own entry, because
 * printing "the delivery order" of an order that has three is a question the
 * menu cannot answer for the operator.
 *
 * Five is where a menu stops being a menu. Past that the entries are replaced
 * by ONE that says how many are not listed and opens the document — a silent
 * truncation reads as "that's all of them", which is the failure this cap
 * exists to avoid, not the one it would create.
 */
export const PRINT_CHAIN_MAX = 5;

/** What a row can print: its own document, then the chain around it. */
export type PrintChain = {
  own: PrintTarget;
  /** Related documents this row carries an ADDRESS for. Upstream first. */
  related: PrintTarget[];
  /** Types capped by PRINT_CHAIN_MAX, with how many are NOT in `related`. */
  hidden: Array<{ doc: TransferDoc; count: number }>;
};

/** "Print Delivery Order HC-DO-2608-003" — the document's name from the one
 *  home for those words, never a thirteenth hand-written spelling. */
export const printChainLabel = (t: PrintTarget): string =>
  `Print ${TRANSFER_DOC[t.doc]} ${t.docNo}`;

/** The capped entry. Says the COUNT, because a cap the reader cannot see is a
 *  truncation. Singular noun on purpose — TRANSFER_DOC has no plural form and
 *  "Goods Receiveds" is not one worth inventing. */
export const printChainOverflowLabel = (h: { doc: TransferDoc; count: number }): string =>
  `+${h.count} more ${TRANSFER_DOC[h.doc]} — Open to print`;

const target = (doc: TransferDoc, docNo: string, key: string): PrintTarget => ({ doc, docNo, key });

/** A Sales Order is addressed by its own number, so ref and target coincide. */
const soTarget = (docNo: string | null | undefined): PrintTarget[] =>
  docNo ? [target("so", docNo, docNo)] : [];

/** One uuid-keyed related document, or nothing when the row has no address. */
const refTarget = (doc: TransferDoc, id: string | null | undefined, docNo: string | null | undefined): PrintTarget[] =>
  id && docNo ? [target(doc, docNo, id)] : [];

type Capped = { shown: PrintTarget[]; hidden: Array<{ doc: TransferDoc; count: number }> };

/** Take at most PRINT_CHAIN_MAX of one type and count what that leaves out.
 *  Refs with no id are dropped BEFORE the cap — an unaddressable number must
 *  not consume one of the five slots a printable document could have had. */
function capRefs(doc: TransferDoc, refs: Wire<DocRef>): Capped {
  const usable = (refs ?? []).filter((r): r is DocRef => !!r?.id && !!r.docNo);
  const shown = usable.slice(0, PRINT_CHAIN_MAX).map((r) => target(doc, r.docNo, r.id));
  const over = usable.length - shown.length;
  return { shown, hidden: over > 0 ? [{ doc, count: over }] : [] };
}

const merge = (own: PrintTarget, parts: Array<PrintTarget[] | Capped>): PrintChain => {
  const related: PrintTarget[] = [];
  const hidden: Array<{ doc: TransferDoc; count: number }> = [];
  for (const p of parts) {
    if (Array.isArray(p)) related.push(...p);
    else { related.push(...p.shown); hidden.push(...p.hidden); }
  }
  return { own, related, hidden };
};

/* ── The purchase side's "which Sales Order was this bought for" ────────────
   Only a STORED link or a DELIVERED fact. See the header: an `'mrp'` row is a
   live allocation that binds nothing, and a row with no `source` at all came
   from a backend that could not tell us which it was. */
type AssignedSo = { soDocNo: string; source?: "delivered" | "linked" | "mrp" };
const boundSos = (xs: Wire<AssignedSo>): PrintTarget[] => {
  const seen = new Set<string>();
  const out: PrintTarget[] = [];
  for (const a of xs ?? []) {
    if (!a?.soDocNo) continue;
    if (a.source !== "linked" && a.source !== "delivered") continue;
    if (seen.has(a.soDocNo)) continue;
    seen.add(a.soDocNo);
    out.push(target("so", a.soDocNo, a.soDocNo));
  }
  return out.slice(0, PRINT_CHAIN_MAX);
};

/* ══ The eight document lists ═══════════════════════════════════════════════
   Each row type below is STRUCTURAL — the fields this file reads, and nothing
   else — so a list's own row type satisfies it without being imported here and
   without this file growing a copy of forty columns it does not use. */

export type SoChainRow = {
  doc_no: string;
  /** `delivery_orders.id` + `do_number`, newest first. */
  do_refs?: Wire<DocRef>;
  /** `sales_invoices.id` + `invoice_number`. */
  si_refs?: Wire<DocRef>;
};

export function salesOrderPrintChain(r: SoChainRow): PrintChain {
  return merge(target("so", r.doc_no, r.doc_no), [
    capRefs("do", r.do_refs),
    capRefs("si", r.si_refs),
  ]);
}

/* NO `si_refs` / `dr_refs`, and that is a RECORDED GAP rather than an oversight.
   The Delivery Order list payload carries `invoiced_si_nos` and `return_nos` —
   NUMBERS, no ids — so the row knows those documents exist and cannot fetch
   them. The fix is one column in a select that is already in flight
   (`delivery-orders-mfg.ts`, the `sales_invoices` / `delivery_returns` reads
   beside `has_children`), and it is NOT in this change because that file is
   5,625 lines against a 5,418 ceiling: `scripts/check-file-size.mjs` refuses any
   growth in it, and a ceiling may only fall. It belongs in a change that shrinks
   that router. Until then the menu offers no entry rather than one that 404s —
   docs/modules/document-conversion.md §8b names it. */
export type DoChainRow = {
  id: string;
  do_number: string;
  so_doc_no?: string | null;
};

export function deliveryOrderPrintChain(r: DoChainRow): PrintChain {
  return merge(target("do", r.do_number, r.id), [soTarget(r.so_doc_no)]);
}

export type SiChainRow = {
  id: string;
  invoice_number: string;
  so_doc_no?: string | null;
  delivery_order_id?: string | null;
  do_number?: string | null;
};

export function salesInvoicePrintChain(r: SiChainRow): PrintChain {
  return merge(target("si", r.invoice_number, r.id), [
    soTarget(r.so_doc_no),
    refTarget("do", r.delivery_order_id, r.do_number),
  ]);
}

export type DrChainRow = {
  id: string;
  return_number: string;
  so_doc_no?: string | null;
  delivery_order_id?: string | null;
  do_doc_no?: string | null;
};

export function deliveryReturnPrintChain(r: DrChainRow): PrintChain {
  return merge(target("dr", r.return_number, r.id), [
    soTarget(r.so_doc_no),
    refTarget("do", r.delivery_order_id, r.do_doc_no),
  ]);
}

export type PoChainRow = {
  id: string;
  po_number: string;
  assigned_sos?: Wire<AssignedSo>;
  /** The PO list's GRN No. column. A BARE STRING is the pre-2026-07-31 wire
   *  shape (number only) — those carry no address, so they build no entry;
   *  `suppliers-queries.ts` documents why both shapes reach a live page. */
  transfer_to_grns?: Wire<{ id: string; grnNumber: string } | string>;
};

export function purchaseOrderPrintChain(r: PoChainRow): PrintChain {
  const grnRefs: DocRef[] = [];
  for (const g of r.transfer_to_grns ?? []) {
    if (!g || typeof g === "string") continue;
    grnRefs.push({ id: g.id, docNo: g.grnNumber });
  }
  return merge(target("po", r.po_number, r.id), [
    boundSos(r.assigned_sos),
    capRefs("grn", grnRefs),
  ]);
}

/** The three purchase-side documents that hang off a PO and a GRN carry both
 *  parents as `{ id, <number> }` objects already. */
type PoParent = { id: string; po_number: string } | null;
type GrnParent = { id: string; grn_number: string } | null;

const poParent = (p: PoParent | undefined): PrintTarget[] =>
  refTarget("po", p?.id, p?.po_number);
const grnParent = (g: GrnParent | undefined): PrintTarget[] =>
  refTarget("grn", g?.id, g?.grn_number);

export type GrnChainRow = {
  id: string;
  grn_number: string;
  purchase_order?: PoParent;
  assigned_sos?: Wire<AssignedSo>;
};

export function grnPrintChain(r: GrnChainRow): PrintChain {
  return merge(target("grn", r.grn_number, r.id), [
    boundSos(r.assigned_sos),
    poParent(r.purchase_order),
  ]);
}

export type PiChainRow = {
  id: string;
  invoice_number: string;
  purchase_order?: PoParent;
  grn?: GrnParent;
  assigned_sos?: Wire<AssignedSo>;
};

export function purchaseInvoicePrintChain(r: PiChainRow): PrintChain {
  return merge(target("pi", r.invoice_number, r.id), [
    boundSos(r.assigned_sos),
    poParent(r.purchase_order),
    grnParent(r.grn),
  ]);
}

export type PrChainRow = {
  id: string;
  return_number: string;
  purchase_order?: PoParent;
  grn?: GrnParent;
};

export function purchaseReturnPrintChain(r: PrChainRow): PrintChain {
  return merge(target("pr", r.return_number, r.id), [
    poParent(r.purchase_order),
    grnParent(r.grn),
  ]);
}
