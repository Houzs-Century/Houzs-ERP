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

import { buildRowMenu, dangerItem, type MaybeItem, type RowMenuItem } from "../../lib/rowMenu";
import {
  printChainLabel, printChainOverflowLabel,
  salesOrderPrintChain, deliveryOrderPrintChain, salesInvoicePrintChain,
  deliveryReturnPrintChain, purchaseOrderPrintChain, grnPrintChain,
  purchaseInvoicePrintChain, purchaseReturnPrintChain,
  type PrintChain, type PrintTarget,
  type SoChainRow, type DoChainRow, type SiChainRow, type DrChainRow,
  type PoChainRow, type GrnChainRow, type PiChainRow, type PrChainRow,
} from "../../lib/printChain";
import { transferToLabel } from "../../lib/convertScope";
import { soCanRaiseDo } from "../../vendor/shared/so-deliverable-states";
import { DO_STOCK_OUT_STATES } from "../../vendor/shared/do-shipped-states";
import { rowIsHeld, type HoldFields } from "../../vendor/scm/components/HoldChip";

/** What every menu needs from a row: something to identify it, a status, and
 *  the mig-0324 hold marker. `HoldFields` rather than a hand-typed `on_hold`,
 *  so the four columns are spelled once for the whole app. */
type StatusRow = { status?: string | null } & HoldFields;

/* ── THE HOLD, ON ALL FIVE DOCUMENTS (owner 2026-08-22) ──────────────────────
   「我们的hold是给我们知道一个 order hold这的」 — a hold is a MARKER telling
   people an order is paused. 「take off hold也要看」 — releasing had to be looked
   at too, and it was where the damage was.

   WHAT THESE TWO ENTRIES USED TO DO, on the Sales Order, and why it was broken:

       Put On Hold     setStatus(r, "ON_HOLD")
       Take Off Hold   setStatus(r, "CONFIRMED")

   The first OVERWROTE the order's progress. `status` is the only place an
   order's position in its life is recorded, so holding an IN_PRODUCTION order
   destroyed the fact that it was in production — permanently, because no
   `previous_status` column exists anywhere in scm. The second then had nothing
   to restore from, so it sent EVERY released order to Confirmed regardless of
   where it had actually been.

   Both now write the mig-0324 MARKER through `setHold`, which touches four
   columns and never `status`. Releasing therefore restores nothing, because
   nothing was lost: the order never moved.

   THE ENTRY IS OFFERED ON ALL FIVE DOCUMENTS NOW. The PO, the GRN and the PI
   were given the WORD "On Hold" on 2026-08-21 (migs 0318/0319/0320) with no
   control anywhere that could produce it; the Delivery Order was asked for on
   the same day (「再加到一个 Hold」) and missed entirely.

   IT IS ALSO THE ONE STATUS-SHAPED ENTRY THE DELIVERY ORDER MENU ACCEPTS, and
   the comment on that menu explains why the others are refused: a DO status
   move writes an inventory OUT, and a stock-moving action does not belong two
   pixels from "Open". A hold moves no stock at all — it is a note. */
function holdEntries<R extends StatusRow>(
  r: R,
  setHold: (r: R, onHold: boolean) => void,
): Array<RowMenuItem | false> {
  /* `rowIsHeld` reads the FLAG or the retired ON_HOLD status, so a legacy row
     is still offered "Take Off Hold" rather than a second "Put On Hold" that
     would do nothing it can see. */
  const held = rowIsHeld(r);
  return [
    !held && { label: "Put On Hold", onClick: () => setHold(r, true) },
    held && { label: "Take Off Hold", onClick: () => setHold(r, false) },
  ];
}

/* ── PRINT, FOR THE WHOLE CHAIN (owner 2026-08-22) ───────────────────────────
   「正常我们 print PDF 都是点进去 print 的吧。那我要在这边 right click，可以点
   print SalesOrder、print DO，这样的意思其实就是 print PDF」 and, asked whether
   he meant only the Sales Order, 「要的啊，我是要全部的 Transaction Flow 都要」.

   WHAT "Print" USED TO DO, and why it was not this. Every one of the ten lists
   had `print: (r) => navigate('/scm/<doc>/<key>?print=1')` — it left the list,
   opened the document, and let the detail page open its own preview. That is a
   shortcut for "click into it", which is the thing he is asking to avoid, and
   it could only ever reach the row's OWN document.

   Now `h.print` takes a TARGET rather than a row, and the entries come from
   `printChain.ts`, which reads what the row already carries. Three properties
   follow, and each one is the point:

     · NOTHING IS FETCHED TO BUILD A MENU. A round trip per row would cost more
       than the navigation it replaces; these lists page 50 rows at a time.
     · AN ENTRY THAT CANNOT WORK IS NOT BUILT. Not greyed out — `buildRowMenu`
       drops empty groups, so a Sales Order with no delivery order simply has no
       "Print Delivery Order" line. A PDF is fetched by ADDRESS, and several
       rows carry a related document's NUMBER without one; those build nothing,
       and §8b of docs/modules/document-conversion.md names each gap.
     · THE WORDS COME FROM `TRANSFER_DOC`. "Print Delivery Order HC-DO-2608-003"
       is generated, never typed, so this is not a thirteenth spelling of the
       document names (frontend/src/vendor/shared/transfer-vocabulary.ts).

   ONE-TO-MANY IS LISTED, NOT COLLAPSED. A part-delivered order has several
   delivery orders and each gets its own entry, because "print the delivery
   order" is a question the menu cannot answer on the operator's behalf. Past
   PRINT_CHAIN_MAX the remainder becomes ONE entry that SAYS how many are not
   listed and opens the document — a silent cap reads as "that's all of them".
 */
function printEntries(chain: PrintChain, h: { print: (t: PrintTarget) => void; open: () => void }): MaybeItem[] {
  return [
    { label: "Print", onClick: () => h.print(chain.own) },
    ...chain.related.map((t) => ({ label: printChainLabel(t), onClick: () => h.print(t) })),
    ...chain.hidden.map((x) => ({ label: printChainOverflowLabel(x), onClick: h.open })),
  ];
}

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
export function salesOrderRowMenu<R extends StatusRow & SoChainRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (t: PrintTarget) => void;
  confirm: (r: R) => void;
  transferToDo: (r: R) => void;
  setStatus: (r: R, status: string) => void;
  /** Stop chasing the remainder. Its own handler, not a setStatus, because the
   *  confirmation wording is the point — see MfgSalesOrdersListV2. */
  close: (r: R) => void;
  /** Put the mig-0324 hold marker on, or take it off. NEVER a status write. */
  setHold: (r: R, onHold: boolean) => void;
  cancel: (r: R) => void;
  reopen: (r: R) => void;
  canDeliver: boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => {
    const s = norm(r.status);
    const isDraft = s === "DRAFT";
    const isCancelled = s === "CANCELLED";
    const isClosed = s === "CLOSED";
    /* Only `Close remaining` reads this. The hold entries deliberately do not:
       since mig 0324 a hold is a MARKER, so it is offered on every row and says
       nothing about where the order is. */
    const live = !isDraft && !isCancelled && !isClosed;
    return buildRowMenu(
      [
        { label: "Open", onClick: () => h.open(r) },
        { label: "Edit", onClick: () => h.edit(r) },
        ...printEntries(salesOrderPrintChain(r), { print: h.print, open: () => h.open(r) }),
      ],
      [
        h.canDeliver && soCanRaiseDo(r.status, r.on_hold ?? null) && !isDraft &&
          { label: transferToLabel("do"), onClick: () => h.transferToDo(r) },
      ],
      [
        isDraft && { label: "Confirm", onClick: () => h.confirm(r) },
        ...holdEntries(r, h.setHold),
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

   `Confirm` is the DRAFT rung and only that: it is `doAdvanceStep`'s single
   step, the same one the detail page and the drawer already offer.

   AND THREE MANUAL STATUS MOVES — Mark Loaded / In Transit / Delivered — which
   are a NAMED, DATED EXCEPTION to the rule the Sales Order menu above states: a
   status a MACHINE derives is never offered to a person
   (docs/modules/document-status-vocabulary.md §1b). Read that section before
   touching this block; the exception is recorded there too, with what retires
   each entry.

   THE SENTENCE THIS REPLACES SAID THE REST OF THE LADDER STAYS OFF THIS MENU,
   "because the DO is the one document where a status move has a STOCK
   consequence". That was true and has stopped being true. Since 2026-08-22 the
   inventory OUT fires on the FIRST entry into a shipped state, and that state is
   Confirm (LOADED) — the owner moved it there. Every status these three entries
   can reach is already past Confirm, so `deductInventoryForDo` finds this
   delivery order's own OUT rows and returns without writing. The objection was
   to a stock-MOVING action behind a right-click; these cannot move stock.

   WHY THEY SATISFY §1b RATHER THAN WAIVING IT. That section decides membership
   by asking whether a MACHINE derives the status from a fact. For these three,
   TODAY, none does:

     Loaded      (DISPATCHED)  THIS SENTENCE CHANGED ON 2026-08-26 and the entry
                               did not. It read "the storekeeper QR scan that
                               will write it does not exist"; the owner's
                               three-scan flow built it, so DoLoadScan now offers
                               DRAFT→LOADED, LOADED→DISPATCHED, DISPATCHED→
                               IN_TRANSIT and IN_TRANSIT→DELIVERED, one rung at a
                               time. The machine EXISTS. By this block's own rule
                               ("each entry retires itself the day its machine
                               goes into use") the first two entries are now
                               candidates for removal — but EXISTING is not IN
                               USE, and whether the storekeepers actually scan is
                               the owner's fact to give, not one this file may
                               assume. Left standing, and said out loud, rather
                               than removed on a guess.
     In transit  (IN_TRANSIT)  two writers now: the driver trip flow
                               (MobileDeliveryPlanning), which has never written
                               a row, and the driver's second scan on DoLoadScan.
     Delivered   (DELIVERED)   the driver's Proof-of-Delivery screen (MobilePOD)
                               DOES write it, the one machine of the three — but
                               asked directly whether drivers use that app, the
                               owner answered 「没有」. The manual entry is the
                               stopgap for a machine that exists and is unused.

   A status no machine writes is a decision a person makes, which is the same
   test that keeps Hold and Cancel on the Sales Order menu. Each entry retires
   itself the day its machine goes into use.

   There is deliberately no `Mark Invoiced`: nothing in this codebase writes
   `delivery_orders.status = 'INVOICED'`, so the label would mean "somebody
   clicked it", not "this was billed".

   HOLD IS A SEPARATE AXIS AGAIN, and neither of the two 2026-08-22 changes
   weakens the other. A hold is not a status (mig 0324): the DO got four columns
   and `scm.do_status` was left untouched, so a hold writes no stock movement of
   any kind and the STOCK objection above never reached it. The three entries
   above answer "where has this delivery got to"; the marker answers "did
   somebody stop it". They are ANDed, never folded together — and every entry
   here that #2661 gated on `!rowIsHeld` stays gated, these three included. */
export function deliveryOrderRowMenu<R extends StatusRow & DoChainRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (t: PrintTarget) => void;
  transferToSi: (r: R) => void;
  transferToDr: (r: R) => void;
  confirm: (r: R) => void;
  setStatus: (r: R, status: string) => void;
  setHold: (r: R, onHold: boolean) => void;
  cancel: (r: R) => void;
  canInvoice: (r: R) => boolean;
  canReturn: (r: R) => boolean;
  canConfirm: (r: R) => boolean;
  canCancel: (r: R) => boolean;
  /* Write permission AND the hold, per row — the same shape as the three
     predicates above, so #2661's `!rowIsHeld` gate reaches these entries too. It
     was a bare boolean until the merge; a held delivery order must not be
     offered a status move on this menu any more than it is offered a Confirm. */
  canSetStatus: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => {
    const s = norm(r.status);
    /* Confirmed or later, from the SHARED set rather than a list typed here — a
       fourth hand-written copy of the delivery ladder is the exact shape
       check-duplicated-decisions hunts, and it caught this one when it was one.
       DO_STOCK_OUT_STATES is also the RIGHT question: these entries are offered
       precisely where the stock has already gone out, which is what makes them
       unable to move it. DRAFT, CANCELLED and any status this file does not
       recognise fall out by not being members — naming a step for an unknown
       state is the COMPLETED mistake, and offering nothing is the cheap answer. */
    const canMark = h.canSetStatus(r) && (DO_STOCK_OUT_STATES as readonly string[]).includes(s);
    return buildRowMenu(
      [
        { label: "Open", onClick: () => h.open(r) },
        { label: "Edit", onClick: () => h.edit(r) },
        ...printEntries(deliveryOrderPrintChain(r), { print: h.print, open: () => h.open(r) }),
      ],
      [
        h.canInvoice(r) && { label: transferToLabel("si"), onClick: () => h.transferToSi(r) },
        h.canReturn(r) && { label: transferToLabel("dr"), onClick: () => h.transferToDr(r) },
      ],
      /* Confirm, the ladder, Hold, then Cancel — Confirm first and Hold last, so
         the "same three, same order" shape the other four menus keep is intact
         with the three manual rungs sitting inside it in ladder order. */
      [
        h.canConfirm(r) && { label: "Confirm", onClick: () => h.confirm(r) },
        /* The status the row already carries is left out: re-writing it is a
           no-op the operator would read as a real choice. */
        canMark && s !== "DISPATCHED" && { label: "Mark Loaded", onClick: () => h.setStatus(r, "DISPATCHED") },
        canMark && s !== "IN_TRANSIT" && { label: "Mark In Transit", onClick: () => h.setStatus(r, "IN_TRANSIT") },
        canMark && s !== "DELIVERED" && { label: "Mark Delivered", onClick: () => h.setStatus(r, "DELIVERED") },
        ...holdEntries(r, h.setHold),
      ],
      [h.canCancel(r) && dangerItem("Cancel Delivery Order", () => h.cancel(r))],
    );
  };
}

/* ── Purchase Order ─────────────────────────────────────────────────────────
   PO -> GRN is the one transfer in this system that was already complete from
   the source side (detail, row drawer AND a list bulk bar), so the menu adds
   the entry point rather than the capability. */
export function purchaseOrderRowMenu<R extends StatusRow & PoChainRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (t: PrintTarget) => void;
  transferToGrn: (r: R) => void;
  setHold: (r: R, onHold: boolean) => void;
  cancel: (r: R) => void;
  canReceive: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      ...printEntries(purchaseOrderPrintChain(r), { print: h.print, open: () => h.open(r) }),
    ],
    [h.canReceive(r) && { label: transferToLabel("grn"), onClick: () => h.transferToGrn(r) }],
    holdEntries(r, h.setHold),
    [h.canCancel(r) && dangerItem("Cancel Purchase Order", () => h.cancel(r))],
  );
}

/* ── Goods Received Note ────────────────────────────────────────────────────
   Two transfers out of one document — the invoice and the return — which is why
   this list's drawer already carried both and the menu simply mirrors it.
   `Post` stays here because it is the GRN's confirm step and it is what moves
   the stock IN; it reads as a status change and is grouped as one. */
export function grnRowMenu<R extends StatusRow & GrnChainRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (t: PrintTarget) => void;
  transferToPi: (r: R) => void;
  transferToPr: (r: R) => void;
  post: (r: R) => void;
  setHold: (r: R, onHold: boolean) => void;
  cancel: (r: R) => void;
  canBill: (r: R) => boolean;
  canPost: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      ...printEntries(grnPrintChain(r), { print: h.print, open: () => h.open(r) }),
    ],
    [
      h.canBill(r) && { label: transferToLabel("pi"), onClick: () => h.transferToPi(r) },
      h.canBill(r) && { label: transferToLabel("pr"), onClick: () => h.transferToPr(r) },
    ],
    [
      h.canPost(r) && { label: "Confirm", onClick: () => h.post(r) },
      ...holdEntries(r, h.setHold),
    ],
    [h.canCancel(r) && dangerItem("Cancel Goods Received Note", () => h.cancel(r))],
  );
}

/* ── Sales Invoice ──────────────────────────────────────────────────────────
   No transfer: a Sales Invoice is the end of the sales chain. SO -> SI does not
   exist in this system in either direction — the only converter the backend
   exposes is `from-dos`, which is why the button that once pointed at
   `/scm/sales-invoices/from-so` was REMOVED rather than repointed. */
export function salesInvoiceRowMenu<R extends StatusRow & SiChainRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (t: PrintTarget) => void;
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
      ...printEntries(salesInvoicePrintChain(r), { print: h.print, open: () => h.open(r) }),
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
export function purchaseInvoiceRowMenu<R extends StatusRow & PiChainRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  /* Copy as new (owner 2026-09-03, AutoCount in hand: right click 就能直接
     copy) — content as a template, identity fresh; any status qualifies. */
  copyAsNew: (r: R) => void;
  print: (t: PrintTarget) => void;
  confirm: (r: R) => void;
  setHold: (r: R, onHold: boolean) => void;
  cancel: (r: R) => void;
  canConfirm: (r: R) => boolean;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  /* HOLD ARRIVED LATE, and the note that stood here is why it is worth saying so:
     it read "Hold follows: ON_HOLD is being converted from a status into a flag."
     True when this menu was written — the flag work was in flight — and nobody
     came back. Meanwhile mig 0324 mounted `PATCH /purchase-invoices/:id/hold`
     and the list kept its **On Hold tab**, so the screen offered a tab for a
     state the product had no way to reach. That is the same fault #2661 was
     written to remove from the PO and the GRN, reintroduced on the one document
     whose menu did not exist yet when that change ran. */
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      { label: "Copy as new", onClick: () => h.copyAsNew(r) },
      ...printEntries(purchaseInvoicePrintChain(r), { print: h.print, open: () => h.open(r) }),
    ],
    [h.canConfirm(r) && { label: "Confirm", onClick: () => h.confirm(r) }],
    holdEntries(r, h.setHold),
    [h.canCancel(r) && dangerItem("Cancel Purchase Invoice", () => h.cancel(r))],
  );
}

/* ── Purchase Return ────────────────────────────────────────────────────────
   The one of the five that needed nothing new: Post, Complete and Cancel are
   all handlers the list already had on its drawer.

   COMPLETE IS DELIBERATELY ABSENT. It records the supplier's credit note — a
   money statement that wants the reference field the drawer's Complete tab
   asks for, and a right-click cannot ask for it. */
export function purchaseReturnRowMenu<R extends StatusRow & PrChainRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (t: PrintTarget) => void;
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
      ...printEntries(purchaseReturnPrintChain(r), { print: h.print, open: () => h.open(r) }),
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
export function deliveryReturnRowMenu<R extends StatusRow & DrChainRow>(h: {
  open: (r: R) => void;
  edit: (r: R) => void;
  print: (t: PrintTarget) => void;
  cancel: (r: R) => void;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  // Hold follows: ON_HOLD is being converted from a status into a flag.
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Edit", onClick: () => h.edit(r) },
      ...printEntries(deliveryReturnPrintChain(r), { print: h.print, open: () => h.open(r) }),
    ],
    [h.canCancel(r) && dangerItem("Cancel Delivery Return", () => h.cancel(r))],
  );
}

/* ── Stock Transfer ─────────────────────────────────────────────────────────
   OPEN and PRINT, then Cancel. Still no Edit: `StockTransferDetail.tsx` is
   read-only ("no edits post-0078"), so there is no `?edit=1` route to point at.

   PRINT ARRIVED 2026-08-22. PROVENANCE, corrected 2026-08-23. This used to cite two owner quotes
   (「right click全部也要有可以print SI DO 之类的」 and 「不是就是print PDF 啊
   print documentation」). NEITHER appears in any message the owner sent in the
   session that produced this change — they came from the agent's brief, not
   from him, and this repo is PUBLIC, so a fabricated ruling is a false record
   of what he decided. The CHANGE stands on its own and is unchanged: the Stock
   Transfer and the Stock Take were the last two documents in the system with no
   print handler on any surface. The CITATION did not, so it is gone.

   This
   paragraph used to say Print was absent because "neither the list nor the
   detail page has ever had a print handler", which was true and was the gap,
   not the reason. `vendor/scm/lib/stock-transfer-pdf.ts` is the handler now,
   and it goes through `PrintPreviewModal` like every other document.

   NO CONFIRM: a transfer is POSTED at the moment it is created — atomic, as the
   list's own header comment says — so the confirm step it would name has
   already happened by the time the row exists.

   Cancel was the same dead handler as the Purchase Invoice's: `doCancel` was
   written, complete with its confirmation, and called from nowhere. */
export function stockTransferRowMenu<R extends StatusRow>(h: {
  open: (r: R) => void;
  print: (r: R) => void;
  cancel: (r: R) => void;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  // Hold follows: ON_HOLD is being converted from a status into a flag.
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canCancel(r) && dangerItem("Cancel Stock Transfer", () => h.cancel(r))],
  );
}

/* ── Stock Take ─────────────────────────────────────────────────────────────
   Open, Print and Cancel. No Edit, for the same reason as the Stock Transfer:
   counting happens in place on the detail sheet and there is no `?edit=1`
   route. Cancel was a `doCancel` that existed and was reachable from nothing.

   PRINT ARRIVED 2026-08-22 with the Stock Transfer's, on the same owner ask.
   `vendor/scm/lib/stock-take-pdf.ts` prints an OPEN take as the count sheet and
   a POSTED one as the variance record; a BLIND take prints as a count sheet
   with no system column, because the SERVER has already stripped those fields
   from the payload for anyone without `scm.stock_take.supervise`. The entry is
   offered on every row: printing reads, it does not write, and there is no
   state in which a person may not have this document on paper.

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
  print: (r: R) => void;
  cancel: (r: R) => void;
  canCancel: (r: R) => boolean;
}): (r: R) => RowMenuItem[] {
  // Hold follows: ON_HOLD is being converted from a status into a flag.
  return (r) => buildRowMenu(
    [
      { label: "Open", onClick: () => h.open(r) },
      { label: "Print", onClick: () => h.print(r) },
    ],
    [h.canCancel(r) && dangerItem("Cancel Stock Take", () => h.cancel(r))],
  );
}
