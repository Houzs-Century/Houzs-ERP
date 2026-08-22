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
  canInvoice: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  /* NO CANCEL, and it is a recorded gap rather than a decision. The delivery
     order list has no cancel handler today — cancelling one lives on the detail
     page. This menu EXPOSES what the page already does; adding the capability
     here would put a stock-reversing action behind a right-click without the
     detail page's confirmation copy. */
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canInvoice(r) && { label: transferToLabel("si"), onClick: () => h.transferToSi(r) }],
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

/* ════════════════════════════════════════════════════════════════════════════
   THE OTHER FIVE LISTS (owner, 2026-08-22)

   His words: 「为什么我的 Purchase Invoice 是没有的呢？」, 「By right 每一个
   Transaction Record 应该都可以右键（Right click）Move to Cancel，或者在 Draft
   那边右键 Confirm 之类的。」 and 「只要有 Cancel / On Hold 状态的，全部都可以右键
   Cancel 或 On Hold。」

   Five lists above, five below, and the shape is the same one. The five below
   are the documents at the END of their chains, which is why every one of them
   has an EMPTY transfer group: `CONVERT_LINKS` in `lib/convertScope.tsx` holds
   six pairs and none of them starts at a Purchase Invoice, a Purchase Return, a
   Delivery Return, a Stock Transfer or a Stock Take. `buildRowMenu` drops the
   empty group, so the separator it would have needed never renders.

   ONLY CONFIRM AND CANCEL ARE OFFERED. A status a MACHINE decides is never in
   this menu — the Delivery Return's Inspected and Refunded, the Purchase
   Return's Complete and the Purchase Invoice's Mark Paid all stay on the row
   drawer where they already live, beside the numbers that justify them. That is
   the same judgement `salesOrderRowMenu` records above for READY_TO_SHIP and
   DELIVERED, applied to the rest of the system.
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Purchase Invoice ───────────────────────────────────────────────────────
   The list he right-clicked and got Chrome's menu.

   CANCEL WAS ALREADY BUILT AND WIRED TO NOTHING. `useCancelPurchaseInvoice()`
   was called in the list and its result never used — the page held the whole
   capability and offered the operator no way to reach it. `noUnusedLocals` is
   false on the frontend tsconfig, so nothing said a word.

   The server refuses a cancel once any money has been paid
   (`cancelPurchaseInvoiceHandler`: PAID or `paid_sen > 0` → 409), so `canCancel`
   has to know that too — an entry the server will refuse is a menu that lies. */
export function purchaseInvoiceRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  confirm: (r: R) => void;
  cancel: (r: R) => void;
  canConfirm: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  // Hold follows: ON_HOLD is being converted from a status into a flag.
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canConfirm(r) && { label: "Confirm", onClick: () => h.confirm(r) }],
    [h.canCancel(r) && dangerItem("Cancel Purchase Invoice", () => h.cancel(r))],
  );
}

/* ── Purchase Return ────────────────────────────────────────────────────────
   The one of the five that needed nothing new: Post, Complete and Cancel are
   all handlers the list already had on its drawer.

   COMPLETE IS DELIBERATELY ABSENT. It records the supplier's credit note — a
   money statement that wants the reference field the drawer's Complete tab
   asks for, and a right-click cannot ask for it. */
export function purchaseReturnRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  confirm: (r: R) => void;
  cancel: (r: R) => void;
  canConfirm: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  // Hold follows: ON_HOLD is being converted from a status into a flag.
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canConfirm(r) && { label: "Confirm", onClick: () => h.confirm(r) }],
    [h.canCancel(r) && dangerItem("Cancel Purchase Return", () => h.cancel(r))],
  );
}

/* ── Delivery Return ────────────────────────────────────────────────────────
   NO CONFIRM, and it is not an omission. A Delivery Return has no draft step:
   it is RECEIVED the moment it is created and the stock is already back in, so
   there is no "make this real" transition for a person to perform. Its states
   are Received, Inspected, Refunded, Credit noted, Rejected, Cancelled —
   `document-status-vocabulary.md` has no Confirmed row for this document
   because there is nothing to put in it.

   CANCEL IS FINAL HERE, which is why `canCancel` excludes an already-cancelled
   row rather than relying on the server: un-cancelling is refused outright
   (`patchDeliveryReturnStatusHandler` — the cancel's stock drain would be left
   in place), so a second Cancel is a dead entry, not a no-op. */
export function deliveryReturnRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  cancel: (r: R) => void;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  // Hold follows: ON_HOLD is being converted from a status into a flag.
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canCancel(r) && dangerItem("Cancel Delivery Return", () => h.cancel(r))],
  );
}

/* ── Stock Transfer ─────────────────────────────────────────────────────────
   OPEN ONLY, then Cancel. There is no Edit and no Print because there is
   nothing to call: `StockTransferDetail.tsx` is read-only ("no edits post-0078")
   and neither the list nor the detail page has ever had a print handler. An
   entry pointing at a route that does not exist is worse than a shorter menu.

   NO CONFIRM: a transfer is POSTED at the moment it is created — atomic, as the
   list's own header comment says — so the confirm step it would name has
   already happened by the time the row exists.

   Cancel was the same dead handler as the Purchase Invoice's: `doCancel` was
   written, complete with its confirmation, and called from nowhere. */
export function stockTransferRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  cancel: (r: R) => void;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  // Hold follows: ON_HOLD is being converted from a status into a flag.
  return (r) => buildRowMenu(
    [{ label: "Open", onClick: () => h.open(r) }],
    [h.canCancel(r) && dangerItem("Cancel Stock Transfer", () => h.cancel(r))],
  );
}

/* ── Stock Take ─────────────────────────────────────────────────────────────
   Open and Cancel, for the same reasons as the Stock Transfer: no edit route,
   no print handler, and a `doCancel` that existed and was reachable from
   nothing.

   NO CONFIRM, and this one IS a judgement rather than an absence. Posting a
   stock take books an ADJUSTMENT movement per non-zero-variance line, and the
   detail page's confirmation shows the operator exactly what he is about to
   book — counted, untouched, variance lines, net variance — before he agrees.
   The list row carries none of those numbers. A right-click Confirm here would
   move stock on a summary the operator cannot see, so posting stays on the
   detail page. Cancel is offered because it does the opposite: an OPEN take has
   written no movement, so cancelling one changes no stock at all.

   The server agrees on that boundary — `/stock-takes/:id/cancel` accepts OPEN
   only, and undoing a POSTED take is a different route (`/reverse`) with its own
   words. `canCancel` therefore means OPEN, not "not already cancelled". */
export function stockTakeRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  cancel: (r: R) => void;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  // Hold follows: ON_HOLD is being converted from a status into a flag.
  return (r) => buildRowMenu(
    [{ label: "Open", onClick: () => h.open(r) }],
    [h.canCancel(r) && dangerItem("Cancel Stock Take", () => h.cancel(r))],
  );
}
