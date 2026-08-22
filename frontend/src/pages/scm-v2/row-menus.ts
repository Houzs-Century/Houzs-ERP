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
   THE OWNER'S ASK (2026-08-22), looking at this very menu: 「DO 这一边没有问题，
   可是为什么没有 Cancel 呢？By right 每一个 Transaction Record 应该都可以右键
   （Right click）Move to Cancel，或者在 Draft 那边右键 Confirm 之类的」 and
   「我的 DO 也应该有右键 Transfer to Delivery Return，对吧？」

   SO CANCEL IS HERE NOW, and the paragraph it replaces said the opposite. That
   text argued a stock-reversing action must not sit two pixels from "Open"
   without the detail page's confirmation copy. The objection was to the MISSING
   CONFIRMATION, not to the entry — so the entry ships WITH one: the list's
   `cancel` handler goes through `askConfirm` before it writes, exactly like the
   Sales Order list's, and it is the SAME endpoint the detail page posts
   (`PATCH /delivery-orders-mfg/:id/status`, status CANCELLED). Nothing new
   happens here; the capability is the page's, the menu only offers it.

   `canCancel` is the LIST's to compute and it cannot be complete, which is
   worth saying rather than hiding. The route refuses a cancel on two grounds:
   a DO that is already CANCELLED (`do_cancelled_final` — un-cancelling would
   leave the stock add-back standing), and a DO with a live Sales Invoice or
   Delivery Return hanging off it (`doHasDownstream`). Only the FIRST is visible
   in a list row. The second is a server-side fact no row carries, so that
   refusal reaches the operator through the mutation's error path instead of by
   the entry being absent — a refusal somebody reads, rather than a capability
   that silently is not there.

   NO OTHER STATUS ENTRIES. `Confirm` is the DRAFT rung and only that: it is
   `doAdvanceStep`'s single step, the same one the detail page and the drawer
   already offer. The rest of the ladder stays off this menu because the DO is
   the one document where a status move has a STOCK consequence — the first
   entry into a shipped state writes the inventory OUT — and DELIVERED belongs
   to the driver's Proof-of-Delivery screen, which closes it WITH a signature. */
export function deliveryOrderRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (r: R) => void;
  transferToSi: (r: R) => void;
  transferToDr: (r: R) => void;
  confirm: (r: R) => void;
  cancel: (r: R) => void;
  canInvoice: (r: R) => boolean;
  canReturn: (r: R) => boolean;
  canConfirm: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [
      h.canInvoice(r) && { label: transferToLabel("si"), onClick: () => h.transferToSi(r) },
      h.canReturn(r) && { label: transferToLabel("dr"), onClick: () => h.transferToDr(r) },
    ],
    [h.canConfirm(r) && { label: "Confirm", onClick: () => h.confirm(r) }],
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
