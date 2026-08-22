/* ----------------------------------------------------------------------------
   row-menus — the right-click menu for each of the five main document lists,
   side by side, so they cannot quietly become five different menus.

   THE OWNER'S ASK (2026-08-21): 「我要做成 right click 的功能，就是可以 convert
   等等。那一些 button 要做成 right click 的」. He had right-clicked a Sales Order
   and got Chrome's own menu, because `DataTable` takes `contextMenu` as an
   OPT-IN and only four pages had opted in — none of them the five he uses most.

   NOTHING NEW HAPPENS HERE. Every entry calls a handler the page already had;
   this file decides only WHAT IS OFFERED and IN WHAT ORDER. That is deliberate:
   a menu that also invented behaviour would be a menu nobody could review
   against the buttons it duplicates.

   THE DESTINATIONS ARE GUARANTEED, not promised. He asked whether a right-click
   convert lands where the button lands. Every transfer entry calls a handler
   built on `convertToLink(pair, keys)`, and `convertScope.test.tsx` walks the
   whole tree and FAILS on any site that hand-writes a query onto a convert path.
   A menu entry structurally cannot go somewhere the button would not.

   WHY THEY LIVE TOGETHER. `MfgSalesOrdersListV2.tsx` had ONE line of headroom
   under its size ceiling and the delivery-order list had eleven, so the menus
   could not go inline in the two lists that need them most. Putting all five in
   one file is the better answer anyway: the shape is supposed to be identical
   across documents, and identical is a thing you can only check by looking at
   them at once.

   THE SHAPE, enforced by `buildRowMenu` rather than by remembering it:

       open / edit / print     what you do WITH this document
       transfer to …           what you make FROM it
       status changes          what you do TO it
       cancel                  destructive, alone, last, red
   ---------------------------------------------------------------------------- */

import { buildRowMenu, dangerItem, type RowMenuItem } from "../../lib/rowMenu";
import { transferToLabel } from "../../lib/convertScope";
import { soCanRaiseDo } from "../../vendor/shared/so-deliverable-states";
import { DO_STOCK_OUT_STATES } from "../../vendor/shared/do-shipped-states";

/** What every menu needs from a row: something to identify it and a status. */
type StatusRow = { status?: string | null };

const norm = (s: string | null | undefined) => String(s ?? "").toUpperCase();

/* ── Sales Order ────────────────────────────────────────────────────────────
   NOBODY HAND-WRITES A LIFECYCLE STATUS. Only three moves are offered anywhere
   in this file — CONFIRM a draft, HOLD, CANCEL — and every other status is
   written by the system that knows the fact behind it.

   THE OWNER'S RULING (2026-08-22), which is why the three "Mark ..." entries
   that shipped the day before are gone:

     「它不应该能转到 Mark in Production、Mark Shipped 和 Mark Invoiced ...
       按理说不应该允许这样手动去转，否则我们的 transaction workflow 就全乱了」

   and the reason, in his words:

     「如果它已经有 processing date 了，我又把它换成别的状态的话，那不是代表我的
       状态全部都 wrong 完了、是错完了吗？」

   He is describing a REAL failure, not a preference. Each of the three had a
   machine already writing it from a fact:

     IN_PRODUCTION  a processing date exists — so-processing-date.ts
     SHIPPED        a delivery order was raised — so-delivery-sync.ts
     INVOICED       a sales invoice covers the lines

   A hand-set status does not change the fact, so the next sweep overwrites it
   and the ONLY lasting effect is a window in which the list lies. That was
   already the argument for leaving READY_TO_SHIP and DELIVERED out on
   2026-08-21; the ruling above simply extends it to the rest, and the earlier
   version of this comment is the evidence that drawing the line anywhere short
   of "all of them" does not hold.

   WHY HOLD AND CANCEL ARE THE EXCEPTIONS. Neither is a step in the document's
   life — no machine derives them from anything, because they are DECISIONS a
   person makes about a document, and there is nowhere else for them to come
   from. The owner drew the same line: 「除了 On Hold 和 Cancel 这两个状态，基本上
   我们都应该可以直接右键移过去」. CONFIRM joins them for the same reason: a draft
   becomes real when a human says so.

   This is also the mainstream ERP shape. SAP derives an order's overall status
   from its item processing status and offers a person a BLOCK and a rejection;
   NetSuite computes Partially Fulfilled / Pending Billing and offers Close and
   Cancel. The list of buttons a human gets is short everywhere, and it is short
   for this reason. */
export function salesOrderRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  confirm: (r: R) => void;
  transferToDo: (r: R) => void;
  setStatus: (r: R, status: string) => void;
  cancel: (r: R) => void;
  reopen: (r: R) => void;
  canDeliver: boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => {
    const s = norm(r.status);
    const isDraft = s === "DRAFT";
    const isCancelled = s === "CANCELLED";
    const live = !isDraft && !isCancelled;
    return buildRowMenu(
      [
        { label: "Open", onClick: () => h.open(r) },
        { label: "Edit", onClick: () => h.edit(r) },
        { label: "Print", onClick: () => h.print(r) },
      ],
      [
        h.canDeliver && soCanRaiseDo(r.status) && !isDraft &&
          { label: transferToLabel("do"), onClick: () => h.transferToDo(r) },
      ],
      [
        isDraft && { label: "Confirm", onClick: () => h.confirm(r) },
        live && s !== "ON_HOLD" && { label: "Put On Hold", onClick: () => h.setStatus(r, "ON_HOLD") },
        s === "ON_HOLD" && { label: "Take Off Hold", onClick: () => h.setStatus(r, "CONFIRMED") },
        isCancelled && { label: "Reopen", onClick: () => h.reopen(r) },
      ],
      [!isCancelled && dangerItem("Cancel Sales Order", () => h.cancel(r))],
    );
  };
}

/* ── Delivery Order ─────────────────────────────────────────────────────────
   THREE MANUAL STATUS MOVES LIVE HERE, AND THEY ARE A NAMED EXCEPTION to the
   rule the Sales Order menu above states — a status a MACHINE derives is never
   offered to a person (docs/modules/document-status-vocabulary.md §1b). Read
   that section before touching this block: the exception is dated and recorded
   there too, with what retires each entry.

   WHY IT IS CONSISTENT WITH THE RULE RATHER THAN A HOLE IN IT. §1b decides
   membership by asking whether a MACHINE derives the status from a fact. For
   these three, TODAY, none does:

     Shipped     (DISPATCHED)  the storekeeper QR scan that will write it does
                               not exist. The DO print's existing QR lands on
                               DoLoadScan, which writes LOADED (Confirmed).
     In transit  (IN_TRANSIT)  the driver trip flow (MobileDeliveryPlanning) is
                               its only writer and has never written a row — zero
                               delivery orders have ever held this status.
     Delivered   (DELIVERED)   the driver's Proof-of-Delivery screen (MobilePOD)
                               DOES write it — the one machine of the three — but
                               asked directly whether drivers use that app, the
                               owner answered 「没有」. So the manual entry is the
                               stopgap for a machine that exists and is unused.

   A status no machine writes is a decision a person makes, which is the same
   test that keeps Hold and Cancel on the Sales Order menu. Each entry retires
   itself the day its machine goes into use.

   AND THEY CANNOT MOVE STOCK, which is what makes a right-click acceptable on
   the one document where a status move normally can. The inventory OUT fires on
   the FIRST entry into a shipped state, and since 2026-08-22 that is Confirm
   (LOADED). Every status these entries can reach is already past Confirm, so
   deductInventoryForDo finds this DO's own OUT rows and returns without writing.

   That is also why they are withheld from a DRAFT: on a draft they WOULD be the
   hop that deducts, and that belongs behind the Confirm control with its own
   words, not two pixels from "Open". They are withheld from a CANCELLED delivery
   order because the server refuses every transition out of it
   (`do_cancelled_final`), so the entry could only ever produce a 409. */
export function deliveryOrderRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  transferToSi: (r: R) => void;
  setStatus: (r: R, status: string) => void;
  canInvoice: (r: R) => boolean;
  /* The caller's write permission. A read-only user gets no status entries at
     all rather than three that fail at the server — same reason `canDeliver`
     exists on the Sales Order menu above. */
  canSetStatus: boolean;
}): (r: R) => RowMenuItem[] {
  /* NO CANCEL, and it is a recorded gap rather than a decision. The delivery
     order list has no cancel handler today — cancelling one lives on the detail
     page. This menu EXPOSES what the page already does; adding the capability
     here would put a stock-reversing action behind a right-click without the
     detail page's confirmation copy. */
  return (r) => {
    const s = norm(r.status);
    /* Confirmed or later, from the SHARED set rather than a list typed here — a
       fourth hand-written copy of the delivery ladder is the exact shape
       check-duplicated-decisions hunts, and it caught this one. DO_STOCK_OUT_STATES
       is also the RIGHT question: these entries are offered precisely where the
       stock has already gone out, which is what makes them unable to move it.
       DRAFT and CANCELLED are excluded by not being members, and so is any status
       this file does not recognise — naming a step for an unknown state is the
       COMPLETED mistake, and offering nothing is the cheap answer. */
    const canMark = h.canSetStatus && (DO_STOCK_OUT_STATES as readonly string[]).includes(s);
    return buildRowMenu(
      [
        { label: "Open", onClick: () => h.open(r) },
        { label: "Edit", onClick: () => h.edit(r) },
        { label: "Print", onClick: () => h.print(r) },
      ],
      [h.canInvoice(r) && { label: transferToLabel("si"), onClick: () => h.transferToSi(r) }],
      [
        /* The status the row already carries is left out: re-writing it is a
           no-op the operator would read as a real choice. */
        canMark && s !== "DISPATCHED" && { label: "Mark Shipped", onClick: () => h.setStatus(r, "DISPATCHED") },
        canMark && s !== "IN_TRANSIT" && { label: "Mark In Transit", onClick: () => h.setStatus(r, "IN_TRANSIT") },
        canMark && s !== "DELIVERED" && { label: "Mark Delivered", onClick: () => h.setStatus(r, "DELIVERED") },
      ],
    );
  };
}

/* ── Purchase Order ─────────────────────────────────────────────────────────
   PO -> GRN is the one transfer in this system that was already complete from
   the source side (detail, row drawer AND a list bulk bar), so the menu adds
   the entry point rather than the capability. */
export function purchaseOrderRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  transferToGrn: (r: R) => void;
  cancel: (r: R) => void;
  canReceive: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canReceive(r) && { label: transferToLabel("grn"), onClick: () => h.transferToGrn(r) }],
    [h.canCancel(r) && dangerItem("Cancel Purchase Order", () => h.cancel(r))],
  );
}

/* ── Goods Received Note ────────────────────────────────────────────────────
   Two transfers out of one document — the invoice and the return — which is why
   this list's drawer already carried both and the menu simply mirrors it.
   `Post` stays here because it is the GRN's confirm step and it is what moves
   the stock IN; it reads as a status change and is grouped as one. */
export function grnRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  transferToPi: (r: R) => void;
  transferToPr: (r: R) => void;
  post: (r: R) => void;
  cancel: (r: R) => void;
  canBill: (r: R) => boolean;
  canPost: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [
      h.canBill(r) && { label: transferToLabel("pi"), onClick: () => h.transferToPi(r) },
      h.canBill(r) && { label: transferToLabel("pr"), onClick: () => h.transferToPr(r) },
    ],
    [h.canPost(r) && { label: "Confirm", onClick: () => h.post(r) }],
    [h.canCancel(r) && dangerItem("Cancel Goods Received Note", () => h.cancel(r))],
  );
}

/* ── Sales Invoice ──────────────────────────────────────────────────────────
   No transfer: a Sales Invoice is the end of the sales chain. SO -> SI does not
   exist in this system in either direction — the only converter the backend
   exposes is `from-dos`, which is why the button that once pointed at
   `/scm/sales-invoices/from-so` was REMOVED rather than repointed. */
export function salesInvoiceRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  recordPayment: (r: R) => void;
  canPay: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  /* NO CANCEL here either, same reason as the delivery order: the list has no
     cancel handler, and cancelling an issued invoice REVERSES revenue and AR.
     That belongs on the detail page with its own words around it. */
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canPay(r) && { label: "Record payment", onClick: () => h.recordPayment(r) }],
  );
}
