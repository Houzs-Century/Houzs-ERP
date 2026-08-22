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

   CLOSE REMAINING IS THE FOURTH, and it passes the same test (2026-08-22). No
   machine can derive it: nothing in this system knows that a customer took 7 of
   the 10 and does not want the rest, or that the supplier cannot supply it —
   only the person on the phone knows, so there is nowhere else for it to come
   from. The owner, asked whether that case happens here: 「有的」.

   IT IS LABELLED "Close remaining", NOT "Close". "Close" reads as "finish", and
   finishing is the opposite of what this does: a remainder is being ABANDONED.
   It is also not Cancel, which sits two entries below it in red — Cancel voids
   the whole document as if it never happened, Close keeps it and everything
   already delivered against it. One word between them in a menu is not enough.
   Offered only on a LIVE order: a draft has no remainder to give up on, and a
   cancelled or already-closed one has nothing left to decide.

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
  close: (r: R) => void;
  cancel: (r: R) => void;
  reopen: (r: R) => void;
  canDeliver: boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => {
    const s = norm(r.status);
    const isDraft = s === "DRAFT";
    const isCancelled = s === "CANCELLED";
    const isClosed = s === "CLOSED";
    const live = !isDraft && !isCancelled && !isClosed;
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
        live && { label: "Close remaining", onClick: () => h.close(r) },
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
