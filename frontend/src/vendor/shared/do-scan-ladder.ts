import type { DoStatus } from './do-shipped-states';
// ----------------------------------------------------------------------------
// do-scan-ladder — the three scans on the paper that travels with the goods,
// declared ONCE for both the screen and the server.
//
// WHY IT LEFT do-next-step.ts (2026-08-26). It was declared there, in the
// FRONTEND, and that was fine while the only caller was the logged-in scan page.
// It stopped being fine the moment the same ladder had to be reachable without a
// login: the public scan endpoint must decide the target status ON THE SERVER —
// a rung named in a request body is a rung an attacker chooses — so the server
// needed the ladder too. A second copy of it in backend/ is precisely the
// duplicated-decision class this repo gates on, and the ladder is the worst
// possible thing to hold twice: one copy gaining a rung the other has not is a
// delivery order that moves on the phone and not in the books.
//
// So it lives HERE, as a mirrored rule module: backend/src/scm/shared/ is the
// original, frontend/src/vendor/shared/ is the byte-identical copy, and
// backend/scripts/check-shared-mirrors.mjs --strict fails the build when they
// differ. Same mechanism that has kept do-shipped-states.ts honest.
// do-next-step.ts re-exports every symbol below, so nothing that imported the
// ladder from there had to change.
// ----------------------------------------------------------------------------

/** Normalise a raw status off a row into the lower-case token used here. */
function norm(status: string | null | undefined): string {
  return String(status ?? '').trim().toLowerCase();
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

/**
 * The ladder's rungs IN ORDER, lower-case, DERIVED by walking {@link doScanStep}
 * from `draft` — never typed out a second time.
 *
 * WHY IT IS DERIVED. Everything else in this file answers "what is next"; this
 * answers "is this document already past a given rung", which the no-login scan
 * needs and the logged-in page does not. A hand-written
 * `['draft','loaded','dispatched','in_transit','delivered']` would be a SECOND
 * declaration of the ladder — add a rung to doScanStep, forget it here, and a
 * repeat scan of the new rung stops reading as "already done" and starts
 * writing. Walking the function cannot fall out of step with the function.
 *
 * The walk is BOUNDED at the size of `scm.do_status` (eight members) rather than
 * looping until null: a future edit that made the ladder cyclic would otherwise
 * hang the request instead of failing a test.
 */
export function doScanLadderOrder(): string[] {
  const order = ['draft'];
  let cur: string = 'DRAFT';
  for (let i = 0; i < 8; i += 1) {
    const next = doScanStep(cur, false);
    if (!next) break;
    order.push(next.status.toLowerCase());
    cur = next.status;
  }
  return order;
}

/**
 * How far along the ladder a raw status sits, or `-1` for a status the ladder
 * does not contain (CANCELLED, SIGNED, INVOICED, or anything unexpected).
 *
 * `-1` deliberately does NOT compare as "before everything": every caller must
 * check for it explicitly, because "this status is not on the ladder" is a
 * different answer from "this status is early on the ladder" and treating them
 * alike is how a CANCELLED delivery order would come to look advanceable.
 */
export function doScanRungIndex(status: string | null | undefined): number {
  return doScanLadderOrder().indexOf(norm(status));
}
