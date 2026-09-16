// ----------------------------------------------------------------------------
// so-save-problems-client — the ONE client-side "what is blocking this Sales
// Order save / proceed" evaluator. Pure: no React, no I/O.
//
// WHY IT EXISTS (owner 2026-09-16, after #4007). Pressing Save / set-Processing-
// Date on a phone ran the guards SEQUENTIALLY (customer, then a line, then
// venue, then the address...), each an early `setError; return`, so the operator
// fixed one thing, pressed again, hit the next. Worse, the mobile per-line
// variant guard reported only the FIRST offending line, and the phone address
// banner fired on the Processing Date alone — which is how a mattress line with
// empty options and a bedframe with no size stayed hidden behind "full delivery
// address required" (#4007). Desktop was better (one-pass required fields) but
// still popped variant gaps in a SECOND dialog.
//
// This collects EVERY client-checkable blocker into ONE flat list, in the shape
// the backend already returns (SaveProblem: code / message / line / field), so
// both surfaces render it through the SAME SaveProblemsList popup the backend's
// validation_failed refusal renders — the phone and the desktop, the pre-flight
// and the server refusal, all read identically.
//
// IT CHANGES NO RULE. Each blocker is still decided by the SAME shared helper it
// always was (soRequiredFieldErrors, soStockLocationError, soDateGuardError,
// missingRequiredVariants via the caller's offender list, the sofa-mix rule, the
// payment sub-field rule). This only aggregates + names them.
//
// PARITY WITH THE BACKEND. The three gates the backend's
// collectProcessingGateProblems also owns — per-line variant completeness, the
// customer/address/postcode/delivery-date completeness a Processing Date
// demands, and the not-in-past / after-delivery date rules — are emitted here
// with the SAME code / message / line / field the backend emits, and
// so-save-problems-client.parity.test.ts asserts that against the live backend
// function so the two cannot drift. The other blockers (phone, venue,
// salesperson, stock location, sofa mix, payment sub-fields) are client
// pre-flight for gates the route enforces elsewhere; they carry their own
// friendly wording and are not part of the parity contract.
// ----------------------------------------------------------------------------
import type { SaveProblem } from './authed-fetch';
import {
  soRequiredFieldErrors,
  soStockLocationError,
  soDateGuardError,
  soErrorText,
  type SoRequiredFieldsInput,
  type SoLocationGuardInput,
  type SoDateGuardInput,
} from './so-form-validate';

/** A line whose category-mandatory variants / size / fabric are not all filled.
 *  `missingLabels` are the human axis labels the shared rule reports
 *  (missingRequiredVariants on desktop, missingVariantAxes(...).label on mobile)
 *  — the SAME labels the backend's axisLabel prints, so the message matches. */
export type VariantGapLine = {
  itemCode: string;
  /** A display name for the line, when the code alone is unfriendly. Unused in
   *  the message today (the code + axis is what the backend prints, and parity
   *  is the point) but carried so a surface need not recompute it. */
  name?: string;
  missingLabels: readonly string[];
};

/** A payment row missing a required sub-field (Merchant → Bank/Plan, Online →
 *  Sub-Type). All rows, not just the first. */
export type PaymentGap = { row: number; method: string; missing: string };

export interface SoSaveProblemsInput {
  /** Always-required identity + line + confirm fields. SAME shape and rule as
   *  the desktop one-pass check — soRequiredFieldErrors decides the set. */
  required: SoRequiredFieldsInput;
  /** Stock-location gate input. Its "State has no warehouse mapped" config case
   *  is reported here; its "no State picked" case is already covered by
   *  `required` (soRequiredFieldErrors), so it is not double-listed. */
  location: SoLocationGuardInput;
  /** Effective Processing Date on this save ('' when none). A Processing Date is
   *  the proceed signal, so the completeness + variant gates below apply only
   *  when it is set — exactly as the backend gates on `procDate`. */
  processingDate: string;
  /** Customer / delivery completeness a Processing Date demands. Mirrors the
   *  backend's ProcessingGateFacts.completeness + the delivery-date term.
   *  `fillAddressLater` blanks address1 + postcode out of the payload, so it
   *  counts them missing (same as the server seeing a blank payload). */
  completeness: {
    customerName: string;
    fillAddressLater: boolean;
    address1: string;
    postcode: string;
    deliveryDate: string;
  };
  /** Date sanity (set-together / not-in-past / processing<=delivery), with the
   *  grandfather + remove-permission carve-outs. SAME shape and rule as the
   *  shared soDateGuardError both surfaces already call. */
  dateGuard: SoDateGuardInput;
  /** Per-line variant / size / fabric gaps — only meaningful when a Processing
   *  Date is set; the caller passes [] otherwise (the variant rule is the
   *  proceed rule). */
  variantOffenders: readonly VariantGapLine[];
  /** True when the lines mix a sofa with a bedframe / mattress in a way the
   *  server refuses (the surface decides create-flat vs edit-introduced). */
  sofaMixConflict: boolean;
  /** The message shown for a sofa-mix conflict (SOFA_MIX_MESSAGE — passed so this
   *  pure module needs no import from the vendored so-variant-rule copy). */
  sofaMixMessage: string;
  /** Payment rows missing a required sub-field — all of them. */
  paymentGaps: readonly PaymentGap[];
  /** Extra surface-specific blockers already SaveProblem-shaped (e.g. mobile's
   *  invalid-email format, desktop's unpicked scanned lines). Appended verbatim
   *  so a surface keeps a check the other does not have without a rule leaking
   *  into the shared evaluator. */
  extra?: readonly SaveProblem[];
}

/* ── backend-parity wording for the shared gates ────────────────────────────
   These strings are byte-for-byte what backend/src/scm/shared/so-save-problems.ts
   emits for the SET-Processing-Date act (CONDITION_SUBJECT + ACT_CLAUSE.processing_date
   and the date-rule messages). so-save-problems-client.parity.test.ts imports the
   live backend function and asserts equality, so a change on either side fails a
   test rather than silently drifting. Do NOT reword one without the other. */
const PROC_CLAUSE = 'before a Processing Date can be set';

const completenessProblem = (
  code: 'processing_date_incomplete',
  subject: string,
  field: string,
): SaveProblem => ({ code, message: `${subject} ${PROC_CLAUSE}`, field });

const variantProblem = (itemCode: string, label: string): SaveProblem => ({
  code: 'variants_incomplete',
  message: `${itemCode} — ${label} is required`,
  line: itemCode,
  field: label,
});

/** Friendly bullet for an always-required field the operator has not filled. */
const requiredFieldProblem = (label: string): SaveProblem => ({
  code: 'required_field',
  message: `${label} is required.`,
  field: label,
});

/**
 * Every client-checkable reason THIS Sales Order save / proceed is blocked, in
 * the order the operator reads them: the always-required identity + line fields,
 * then the customer / delivery completeness a Processing Date demands, then the
 * per-line option / size / fabric gaps, then the date rules, then the remaining
 * pre-flight gates (stock location, sofa mix, payments, surface extras).
 *
 * [] means every client gate passes — the save may go to the server, which is
 * still the authoritative gate and returns its own aggregated `problems[]` (a
 * race the client cannot see, e.g. a live PO lock) rendered through the same
 * list.
 */
export function collectSoSaveProblems(input: SoSaveProblemsInput): SaveProblem[] {
  const out: SaveProblem[] = [];
  const procSet = input.processingDate.trim() !== '';

  // 1. Always-required identity / line / confirm fields (customer name, phone,
  //    a named line, venue, salesperson, delivery State). The proceeding-address
  //    block below re-states customer name with the reason it is required once a
  //    Processing Date is set, so drop the bare "Customer name is required."
  //    duplicate on that path.
  const custMissingForProceed =
    procSet && input.completeness.customerName.trim() === '';
  for (const label of soRequiredFieldErrors(input.required)) {
    if (custMissingForProceed && label === 'Customer name') continue;
    out.push(requiredFieldProblem(label));
  }

  // 2. Customer / delivery completeness a Processing Date demands (owner
  //    2026-07-31: a Processing Date IS Proceed). Backend-parity wording.
  if (procSet) {
    const c = input.completeness;
    if (c.customerName.trim() === '') {
      out.push(completenessProblem('processing_date_incomplete', 'Customer name is required', 'Customer'));
    }
    if (c.fillAddressLater || c.address1.trim() === '') {
      out.push(completenessProblem('processing_date_incomplete', 'Delivery address line 1 is required', 'Address'));
    }
    if (c.fillAddressLater || c.postcode.trim() === '') {
      out.push(completenessProblem('processing_date_incomplete', 'Delivery postcode is required', 'Postcode'));
    }
    if (c.deliveryDate.trim() === '') {
      out.push(completenessProblem('processing_date_incomplete', 'A delivery date is required', 'Delivery date'));
    }
  }

  // 3. Per-line variant / size / fabric completeness — the proceed rule. Every
  //    offending line AND every missing axis, not just the first (the #4007
  //    masker). Backend-parity message: "<code> — <label> is required".
  if (procSet) {
    for (const off of input.variantOffenders) {
      for (const label of off.missingLabels) {
        out.push(variantProblem(off.itemCode, label));
      }
    }
  }

  // 4. Date sanity — set-together / not-in-past / processing<=delivery, with the
  //    grandfather + remove-permission carve-outs the shared guard owns. It
  //    returns the first date fault; date faults rarely co-occur and the guard's
  //    carve-outs are the load-bearing part, so it is reused rather than
  //    re-derived. Listed in the SAME popup as everything else, so a date fault
  //    no longer hides behind, or is hidden by, a variant or address gap.
  const dateErr = soDateGuardError(input.dateGuard);
  if (dateErr) {
    out.push({ code: 'date_invalid', message: soErrorText(dateErr), field: 'Dates' });
  }

  // 5. Stock-location config case — a picked State with no warehouse mapped.
  //    The "no State picked" case is already in step 1 (soRequiredFieldErrors),
  //    so include this only when a State IS picked, to avoid double-listing.
  if (input.location.state.trim() !== '') {
    const locErr = soStockLocationError(input.location);
    if (locErr) out.push({ code: 'stock_location', message: soErrorText(locErr), field: 'State' });
  }

  // 6. Sofa exclusivity — the server 400s so_sofa_no_other_main.
  if (input.sofaMixConflict) {
    out.push({ code: 'sofa_mix', message: input.sofaMixMessage, field: 'Line items' });
  }

  // 7. Payment method sub-fields — every incomplete row.
  for (const g of input.paymentGaps) {
    out.push({
      code: 'payment_method_field_required',
      message: `Payment ${g.row} (${g.method}) needs a ${g.missing}.`,
      field: `Payment ${g.row}`,
    });
  }

  // 8. Surface-specific extras, verbatim.
  for (const p of input.extra ?? []) out.push(p);

  return out;
}
