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

/** What every menu needs from a row: something to identify it and a status. */
type StatusRow = { status?: string | null };

const norm = (s: string | null | undefined) => String(s ?? "").toUpperCase();

/* ── Sales Order ────────────────────────────────────────────────────────────
   The four statuses under "status changes" are the ones the owner asked to be
   reachable on 2026-08-21: 「照你的流程做，只删 Closed」 — his lifecycle is
   Draft, Confirm, In Production, Ready to Ship, Shipped, Delivered, Invoice,
   On Hold, Cancel, and IN_PRODUCTION / SHIPPED / INVOICED / ON_HOLD had no
   caller anywhere in the app. The route accepted them; no screen sent them.

   READY_TO_SHIP AND DELIVERED ARE DELIBERATELY ABSENT, and that is the whole
   judgement in this block. Both are written by the MACHINE —
   recomputeSoStockAllocation advances to READY_TO_SHIP when the stock lands,
   so-delivery-sync advances to DELIVERED when every line is covered — and
   offering a human the same two would let someone claim an order is ready when
   no stock is allocated, or delivered when no delivery order exists. The
   system would then correct him, silently, on the next sweep. A button whose
   effect is undone by a background job is worse than no button. */
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
        live && s !== "IN_PRODUCTION" && { label: "Mark In Production", onClick: () => h.setStatus(r, "IN_PRODUCTION") },
        live && s !== "SHIPPED" && { label: "Mark Shipped", onClick: () => h.setStatus(r, "SHIPPED") },
        live && s !== "INVOICED" && { label: "Mark Invoiced", onClick: () => h.setStatus(r, "INVOICED") },
        live && s !== "ON_HOLD" && { label: "Put On Hold", onClick: () => h.setStatus(r, "ON_HOLD") },
        s === "ON_HOLD" && { label: "Take Off Hold", onClick: () => h.setStatus(r, "CONFIRMED") },
        isCancelled && { label: "Reopen", onClick: () => h.reopen(r) },
      ],
      [!isCancelled && dangerItem("Cancel Sales Order", () => h.cancel(r))],
    );
  };
}

/* ── Delivery Order ─────────────────────────────────────────────────────────
   No status entries: every DO status move is already a first-class control on
   the row drawer and the detail page, and the DO is the one document where a
   status move has a STOCK consequence — the first entry into a shipped state
   writes the inventory OUT. Putting that behind a right-click, two pixels from
   "Open", is not a convenience. */
export function deliveryOrderRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  transferToSi: (r: R) => void;
  cancel: (r: R) => void;
  canInvoice: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canInvoice(r) && { label: transferToLabel("si"), onClick: () => h.transferToSi(r) }],
    [h.canCancel(r) && dangerItem("Cancel Delivery Order", () => h.cancel(r))],
  );
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
  cancel: (r: R) => void;
  canPay: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canPay(r) && { label: "Record payment", onClick: () => h.recordPayment(r) }],
    [h.canCancel(r) && dangerItem("Cancel Sales Invoice", () => h.cancel(r))],
  );
}
