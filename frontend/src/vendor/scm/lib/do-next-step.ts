import { SI_TRANSFERABLE_DO_STATES, type DoStatus } from '../../shared/do-shipped-states';
// ----------------------------------------------------------------------------
// do-next-step — what a Delivery Order may do next, and why it may not yet, in
// ONE place, as words an operator can act on.
//
// WHY THIS EXISTS. Owner, 2026-08-18, holding two delivery orders side by side —
// one from each company — and seeing two different green buttons in the same
// corner of the same screen:
//
//   "一个公司显示 Transfer to Sales Invoice，另一个公司却是 Mark signed，
//    这不是同一个系统会统一的东西来的吗？我又不是两套系统"
//
// He was right, and the code was too. The two documents differed only in STATUS
// — DELIVERED versus DISPATCHED — and the status ladder is identical for both
// companies. But the transfer was not shown as UNAVAILABLE; it was simply not
// rendered. From the second company's seat the product did not have the feature.
// A capability that disappears without a word is indistinguishable from a
// capability that does not exist, which is how one system comes to look like two.
//
// So the rule is the same one this codebase has been applying all week to empty
// states and refusals: the thing may be unavailable, but it may not be silent.
// The control stays on screen, disabled, carrying the reason and the next step.
//
// AND THE REASON LIVES HERE, ONCE. That is the other half, and it is the half
// that decides whether this fix is still true in two months. The date-format
// rule was fixed the same way in June — a DateField component that forces one
// format — and it reached 14 of 189 inputs, because each surface kept
// re-deriving the answer by hand and nothing errored when it drifted. Four
// surfaces ask "what may this DO do next?" (desktop detail header, that same
// page's phone action bar, the list quick-view drawer, and the native mobile
// shell), and before this module they answered it four times.
//
// WHAT IS SHARED, AND WHAT DELIBERATELY IS NOT — stated precisely, because a
// header that overstates its own reach is how the next reader comes to trust a
// thing that is not true:
//
//   · The SALES-INVOICE question (siTransferBlockReason) is shared by all four.
//     That is the one the owner hit, and the one that was silently missing.
//   · The ADVANCE question (doAdvanceStep) is shared by the three desktop-side
//     surfaces, and since 2026-08-21 it offers exactly ONE step: DRAFT → Confirm.
//     WHAT CONFIRM WRITES CHANGED ON 2026-08-22 — it lands LOADED now, not
//     DISPATCHED. See doAdvanceStep for the ruling and why the target was the
//     wrong half of that control all along.
//     "Mark signed" (LOADED / DISPATCHED / IN_TRANSIT → DELIVERED) was REMOVED by
//     owner decision — a shipped delivery is closed by the driver's Proof-of-
//     Delivery screen, which signs it, and the office's next action on a shipped
//     DO is its Sales Invoice, not a bare status button. The native mobile shell
//     keeps its own driver rung DISPATCHED → IN_TRANSIT ("Mark In Transit", the
//     "On the way" departure marker, MobileDeliveryPlanning.tsx) — that is not
//     "Mark signed" and stays. SIGNED / DELIVERED are the POD screen's job.
//   · The SCAN question (doScanStep, added 2026-08-26) has exactly ONE caller,
//     the QR landing page DoLoadScan, and is DELIBERATELY not the same ladder as
//     doAdvanceStep. They answer different questions for different people: the
//     office, at a desk, is offered the confirm and then pointed at the Sales
//     Invoice; a person holding the paper at the lorry is offered the one
//     physical step in front of him. Sharing one function between them would
//     have put "Confirm Departure" on the office's detail page. See the SCAN
//     LADDER block at the foot of this file.
//
// ── THE VOCABULARY (measured, not assumed) ──────────────────────────────────
// The eight legal delivery_orders.status values are declared once, server-side,
// in backend/src/scm/shared/do-shipped-states.ts (DO_STATUSES):
//
//   DRAFT, LOADED, DISPATCHED, IN_TRANSIT, SIGNED, DELIVERED, INVOICED, CANCELLED
//
// They are exactly the labels of the scm.do_status enum. That file also records
// what happens when a status is asserted rather than measured: COMPLETED lived
// in these lists for months on the strength of a comment, and Postgres 500'd on
// it in both tenants because the enum never had it. So a status this module does
// not recognise gets the GENERIC sentence, never a guess — naming a step that
// does not exist is worse than saying the state is unexpected.
//
// ── WHAT THE BACKEND ACTUALLY ENFORCES ──────────────────────────────────────
// From routes/delivery-orders-mfg.ts, PATCH /:id/status:
//   · A DO is born LOADED (= Confirmed), or DRAFT when created with `asDraft`.
//     It was born DISPATCHED until 2026-08-22; raising a delivery order IS the
//     confirm, so it lands on Confirmed. The stock is deducted at creation
//     either way — that gate reads `asDraft`, never the status.
//   · CANCELLED IS FINAL. prevStatus === 'CANCELLED' is refused outright with
//     `do_cancelled_final` (:5401) — un-cancelling would leave the cancel's
//     add-back standing while the re-deduct no-ops, inflating stock by the whole
//     DO. There is no reopen, and any control offering one cannot succeed.
//   · A shipped DO may not fall back to a pre-ship status (:5418).
//   · Otherwise forward and lateral moves are all accepted — the ladder is NOT
//     walked one rung at a time, which is why "Mark signed" can jump straight to
//     DELIVERED from LOADED.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// This answers "why not yet", never "may this user do it". Permission is a
// separate question and stays with the caller, which still HIDES the control
// outright (auth/salesAccess.ts:200 — "off, not hide"): advertising an action a
// salesperson may never take is noise and leaks org structure.
// ----------------------------------------------------------------------------

/* THE OWNER'S RULE, FROM ITS ONE HOME — NOT A HAND-TYPED LIST. `['signed',
   'delivered']` stood here until 2026-08-18 and was the narrowest of three live
   spellings of "this delivery may be invoiced". Two things fixed it, a day
   apart, and BOTH are kept:

     · WHERE the rule lives (2026-08-18). SI_TRANSFERABLE_DO_STATES in
       shared/do-shipped-states.ts is the single declaration; the backend
       ENFORCES it in routes/sales-invoices.ts, the server's own DO picker and
       the phone's convert wizard read the same constant, and the frontend twin
       is held byte-identical by check-shared-mirrors.mjs --strict. This module
       derives from it instead of restating it.
     · WHAT the rule says (2026-08-19, #2485). Every CONFIRMED delivery order —
       anything past DRAFT that is not CANCELLED — may be invoiced, LOADED
       included. That superseded the previous day's four-state list, and it is
       what the server has always permitted: the SI-from-DO create refuses only
       a CANCELLED source. "Mark signed" was never a prerequisite for the
       invoice, and on 2026-08-21 it was REMOVED entirely (owner) — the driver's
       Proof-of-Delivery screen is what records delivery now.

   It read as a status bug and is a MULTI-ORGANISATION one. The predicate carries
   no company term and never did; it fired on one organisation because of DATA.
   2990's source system has no "delivered" step, so its imported deliveries sit
   at DISPATCHED, while the HOUZS AutoCount carry-overs were inserted as literal
   'DELIVERED'. One build, one permission set — and 2990 was told the transfer
   did not exist. */
export const SI_TRANSFERABLE_DO_STATUSES =
  SI_TRANSFERABLE_DO_STATES.map((s) => s.toLowerCase()) as readonly string[];

/** Normalise a raw status off a row into the lower-case token used here. */
function norm(status: string | null | undefined): string {
  return String(status ?? '').trim().toLowerCase();
}

/**
 * Where to raise the Sales Invoice on the NATIVE MOBILE SHELL, which does not
 * host the convert wizard on the delivery-order screen.
 *
 * The capability is genuinely reachable there — MobileApp's MODULE_TO_CONVERT
 * maps the Sales Invoices module to the "si" convert target, whose source is a
 * delivery order (MobileConvertWizard META.si), and the "+" appears for anyone
 * `canOperateSalesInvoices` allows. So this is a DISCOVERABILITY gap, not a
 * missing feature, and the honest sentence names the route rather than
 * pretending the phone cannot do it.
 *
 * It is a separate string from {@link siTransferBlockReason} because it answers
 * a different question: that one says why the transfer is not YET possible,
 * this one says where to perform a transfer that IS possible.
 */
export const SI_TRANSFER_MOBILE_ROUTE_HINT =
  'The next step is the Sales Invoice — raise it from the Sales Invoices screen with "+".';

/**
 * `null` when the transfer is available. Otherwise the sentence to show on the
 * disabled control — what is blocking it, and what to do about it.
 */
export function siTransferBlockReason(status: string | null | undefined): string | null {
  const s = norm(status);
  if ((SI_TRANSFERABLE_DO_STATUSES as readonly string[]).includes(s)) return null;
  if (s === 'cancelled') {
    return 'This delivery order was cancelled, so it cannot be invoiced. Raise a new delivery order to deliver these goods again.';
  }
  if (s === 'draft') {
    return 'This delivery order is still a draft — confirm it before raising a Sales Invoice.';
  }
  /* INVOICED deliberately falls through to the generic sentence rather than
     getting an "already invoiced" one. routes/unbilled-deliveries.ts:13 records
     the measurement: NOTHING in the codebase ever writes
     delivery_orders.status='INVOICED' — creating a Sales Invoice from a DO does
     not advance the DO — so the label means "somebody clicked it", not "this was
     billed", and it is unreliable in both directions. Saying "already invoiced"
     here would state as fact the exact thing that file proves the flag cannot
     tell us. The generic sentence states the gate, which is true. An unrecognised
     status also lands here rather than a guess (COMPLETED once did — see header). */
  return 'A Sales Invoice can only be raised from a confirmed delivery order.';
}

/**
 * The one status step this document is ready for, as the control that performs
 * it: the target status to PATCH and the words on the button.
 *
 * `null` when no step applies — pair it with {@link doAdvanceBlockReason}, which
 * says why. The two are deliberately separate functions because a caller that
 * renders the control disabled needs BOTH the label (so the slot keeps its verb)
 * and the reason.
 *
 * There is ONE advance step now (owner 2026-08-21, removing "Mark signed"):
 *   · DRAFT → LOADED, "Confirm"
 *
 * THE TARGET WAS WRONG UNTIL 2026-08-22, and the label was right. This button
 * said "Confirm" while writing DISPATCHED — which every screen renders as
 * "Loaded" (it read "Shipped" until 2026-08-26) — so pressing Confirm skipped
 * the Confirmed state entirely and
 * landed the document two rungs along. The owner settled where the stock leaves:
 *
 *   「once confirmed就代表出货了 就是直接扣库存」
 *   「draft 没出货，Confirmed就代表出货了 然后delivered只是记录而已，记录送到了」
 *
 * So Confirm writes LOADED, LOADED is where the inventory OUT fires
 * (shared/do-shipped-states.ts), and Loaded / In transit / Delivered are the
 * operator's record of where the goods have got to. Nothing about the ladder was
 * removed — 「保留全部状态 我可以convert」.
 *
 * The "Mark signed" step (LOADED / DISPATCHED / IN_TRANSIT → DELIVERED) was
 * REMOVED. A shipped delivery does not need marking delivered from these office
 * surfaces: the Sales Invoice is raised straight from DISPATCHED
 * (siTransferBlockReason already allows it), and the ONE path that records
 * DELIVERED is the driver's Proof-of-Delivery screen (MobilePOD), which closes
 * the delivery WITH a signature. So a shipped DO's next action is its Sales
 * Invoice, not a bare status button — and doAdvanceBlockReason says exactly that.
 */
export type DoAdvanceStep = {
  /** Target delivery_orders.status to PATCH. */
  status: 'LOADED';
  /** The words on the button. */
  label: string;
};

export function doAdvanceStep(status: string | null | undefined): DoAdvanceStep | null {
  const s = norm(status);
  if (s === 'draft') return { status: 'LOADED', label: 'Confirm' };
  return null;
}

/**
 * `null` when {@link doAdvanceStep} has a step to offer. Otherwise the sentence
 * that stands in for the (absent) advance control — telling the operator what
 * this document's next real step is.
 *
 * Every shipped state points at the Sales Invoice now that "Mark signed" is
 * gone: there is no status button to explain, so the sentence names the next
 * action (raise the invoice) rather than a block. The "two questions are never
 * both silent" test pins that a non-advanceable status still returns a sentence.
 */
export function doAdvanceBlockReason(status: string | null | undefined): string | null {
  if (doAdvanceStep(status)) return null;
  const s = norm(status);
  if (s === 'cancelled') {
    /* The backend's own words, from the `do_cancelled_final` refusal at
       delivery-orders-mfg.ts:5403. This is why no surface should offer a
       "Reopen" here: the write is refused every time. */
    return 'A cancelled delivery order cannot be reactivated — its stock was already returned. Raise a new delivery order to deliver again.';
  }
  if (s === 'loaded' || s === 'dispatched' || s === 'in_transit') {
    /* On its way, not yet closed. Since 2026-08-21 there is no "Mark signed" step
       on these surfaces; the delivery is closed by the driver's Proof-of-Delivery
       screen, and the office's next action is the Sales Invoice. */
    return 'This delivery order is on its way. The next step is to raise its Sales Invoice.';
  }
  if (s === 'signed' || s === 'delivered') {
    return 'This delivery order is complete. The next step is to raise its Sales Invoice.';
  }
  if (s === 'invoiced') {
    return 'This delivery order is marked invoiced, so there is no further delivery step.';
  }
  return 'This delivery order is in an unexpected state, so no next step can be offered. Please check with the office.';
}

// ── THE SCAN LADDER (owner, 2026-08-25/26) ──────────────────────────────────
//
// Three scans on the paper that travels with the goods, each moving the
// delivery order exactly ONE step:
//
//   ① storekeeper: loaded onto the lorry   LOADED     -> DISPATCHED
//   ② driver: departs                      DISPATCHED -> IN_TRANSIT
//   ③ driver: delivered                    IN_TRANSIT -> DELIVERED
//
// The office raising the DO is what writes LOADED, and DRAFT -> LOADED stays
// on this ladder as the rung it always was, so a delivery order raised as a
// draft can still be confirmed at the dock.
//
// 「就是我状态只要一点，它基本上都只能剩最后一个状态（下一个状态）」 — ONE button,
// the next one, never a choice of several and never a way back. That is why this
// is a single-valued function and not a list: a caller cannot render two rungs
// because there is only ever one to render.
//
// STOCK IS NOT TOUCHED BY ANY OF THESE. 「只要我一开 DO，我就扣库存。In transit、
// Delivered，这些都只是状态，看一下情况而已。」 The inventory OUT fires on the first
// entry into a shipped state, and LOADED is already one (shared/do-shipped-states.ts),
// so every rung below is past the deduction and finds it already done.
//
// SIGNED IS NEVER A TARGET, and the type is what enforces that rather than a
// comment. `SIGNED` counts as delivered everywhere (doCountsAsDelivered), and
// bug 0481 is the record of what a bare button writing it costs: "Mark Signed"
// wrote the status and collected no signature, no photo and no GPS. Nothing has
// written SIGNED since it was removed on 2026-08-21 and this ladder does not
// bring it back. A row that ALREADY carries SIGNED is a different question and
// is answered as finished, because it counts as delivered.
//
// EVERY TARGET IS A REAL MEMBER OF `scm.do_status`, checked by the compiler.
// `Extract<DoStatus, …>` collapses to `never` for a label the enum does not
// define, so a typo cannot be returned. Bug 0530 is why that is worth a type:
// `status.eq.ON_HOLD` against an enum with no such label is a 22P02 and a 400,
// not an empty match, and it took the whole Delivery Orders page down for two
// days. The eight members are DRAFT, LOADED, DISPATCHED, IN_TRANSIT, SIGNED,
// DELIVERED, INVOICED, CANCELLED.

export type DoScanStep = {
  /** Target delivery_orders.status to PATCH. A `scm.do_status` member by TYPE. */
  status: Extract<DoStatus, 'LOADED' | 'DISPATCHED' | 'IN_TRANSIT' | 'DELIVERED'>;
  /** The words on the one button. */
  label: string;
  /* THE LINE UNDER THE BUTTON, CARRIED HERE RATHER THAN IN A MAP BESIDE THE
     CALLER. It started life as a `Record<DoScanStep['status'], string>` on the
     scan page and `check-duplicated-decisions` caught it at Jaccard 0.80
     against SI_TRANSFERABLE_DO_STATES — correctly: a second hand-typed set of
     the same four labels is a second place to forget a rung. Attaching the
     sentence to the rung means adding a rung cannot leave one behind, and the
     compiler says so. */
  note: string;
};

/**
 * The ONE step a scanned delivery order is ready for, or `null` when there is
 * none — pair it with {@link doScanBlockReason}, which says why.
 *
 * `onHold` is REQUIRED and nullable rather than optional, per the repo rule
 * that a parameter which DECIDES something must fail to compile when forgotten:
 * a held delivery order gets no button at all, and an `onHold?: boolean` would
 * silently offer one to every caller that had not heard of holds. Note what
 * this is NOT: `PATCH /:id/status` does not read `on_hold` (mig 0324 gave the
 * DO the marker columns and left the handler alone), so this is the scan
 * screen's own refusal, not a server guard being mirrored.
 */
export function doScanStep(
  status: string | null | undefined,
  onHold: boolean | null,
): DoScanStep | null {
  if (onHold === true) return null;
  switch (norm(status)) {
    case 'draft':
      return {
        status: 'LOADED',
        label: 'Confirm loading',
        note: 'This confirms the delivery order and takes the goods out of warehouse stock.',
      };
    case 'loaded':
      return {
        status: 'DISPATCHED',
        label: 'Confirm Loaded',
        note: 'Press this once every item on this delivery order is on the lorry. Stock is not touched — it left when the delivery order was confirmed.',
      };
    case 'dispatched':
      return {
        status: 'IN_TRANSIT',
        label: 'Confirm Departure',
        note: 'Press this when the lorry pulls out. Stock is not touched.',
      };
    case 'in_transit':
      return {
        status: 'DELIVERED',
        label: 'Confirm Delivered',
        note: DO_SCAN_DELIVERED_EVIDENCE_NOTE,
      };
    default:
      return null;
  }
}

/**
 * `null` when {@link doScanStep} has a step. Otherwise the sentence the person
 * holding the paper reads INSTEAD of a button — never silence, which is the
 * standing rule this module exists for.
 */
export function doScanBlockReason(
  status: string | null | undefined,
  onHold: boolean | null,
): string | null {
  if (doScanStep(status, onHold)) return null;
  if (onHold === true) {
    return 'This delivery order is on hold, so it must not move. Call the office before putting anything on or off the lorry.';
  }
  const s = norm(status);
  if (s === 'cancelled') {
    /* The backend refuses every transition out of CANCELLED outright
       (`do_cancelled_final`), so a button here could not succeed. The words are
       aimed at somebody standing at a lorry, not at a screen. */
    return 'This delivery order is cancelled. Do not load or move these goods — call the office.';
  }
  /* SIGNED sits with DELIVERED because doCountsAsDelivered returns true for it:
     the delivery is closed everywhere that reads it, so there is genuinely
     nothing left for a scan to do. */
  if (s === 'signed' || s === 'delivered' || s === 'invoiced') {
    return 'Nothing left to do on this document.';
  }
  return 'This delivery order is in an unexpected state, so no next step can be offered. Please check with the office.';
}

/**
 * What the scan screen says AFTER a rung has been written — the confirmation
 * card, in the words of the step that was just taken.
 *
 * A separate function from the two above because it answers a different
 * question: those say what may happen next, this says what DID happen. The page
 * shows this and NO button until the paper is scanned again, which is the
 * physical shape of the owner's rule — one scan is one step, so three steps
 * take three scans and cannot be chained from one screen.
 */
export function doScanConfirmation(written: DoScanStep['status']): string {
  switch (written) {
    case 'LOADED':     return 'Loading confirmed. The goods are out of warehouse stock.';
    case 'DISPATCHED': return 'Recorded as loaded onto the lorry. The driver scans again when the lorry leaves.';
    case 'IN_TRANSIT': return 'Recorded as departed. Scan again at the delivery address.';
    case 'DELIVERED':  return 'Recorded as delivered.';
  }
}

/**
 * The sentence shown BESIDE the "Confirm Delivered" button, before it is
 * pressed.
 *
 * THIS IS THE ANSWER TO BUG 0481, and it is deliberate rather than an omission.
 * That entry is the record of a "Mark Signed" button that wrote a
 * delivered-counting status and collected no signature, no photo and no GPS —
 * *"the status is literally named for the evidence it does not collect"*. This
 * scan writes DELIVERED and collects nothing either, so the screen has to say
 * so in the same breath as offering the button, or it is the same defect with a
 * QR code in front of it.
 *
 * The alternative — capturing a signature here — was not taken: MobilePOD is
 * the screen that captures signature, photo and GPS and posts all three through
 * the shared hook (bug 0480), and a second capture path is exactly the
 * divergence 0480 was written about. So this one names the loss instead of
 * duplicating the remedy, which is also the loosen-rather-than-restrict rule
 * 0480 settled: evidence is allowed everywhere and required nowhere.
 */
export const DO_SCAN_DELIVERED_EVIDENCE_NOTE =
  'This records that the driver reported the goods as delivered. It is not a signed receipt — no customer signature, no photo and no location are captured here. Use Proof of Delivery in the Delivery app when the customer signs.';
