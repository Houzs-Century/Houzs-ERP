// ----------------------------------------------------------------------------
// so-submit-problems — THE ONE backend authority for "what is blocking this
// Sales Order submit", returned as a flat SaveProblem[] the frontend simply
// RENDERS. Pure: no React, no I/O, no Hono.
//
// WHY IT EXISTS (owner 2026-09-16: 「跟 backend 串通, frontend 只是显示问题」).
// The submit-blocked reasons used to be authored in TWO places — a client
// evaluator (collectSoSaveProblems / so-form-validate) that held its own copy of
// the required-field / stock-location / sofa-mix / payment wording, and the
// backend gates. Two copies drift. The owner's ruling makes the BACKEND the
// single source of the problem set AND the wording; the frontend calls the
// dry-run `validate` endpoint (which runs this) debounced as it types, and on
// submit renders the same 422 problems[] verbatim. The client evaluator is
// deleted — this is its backend twin, with the wording moved here.
//
// IT CHANGES NO RULE. Every blocker is still decided by the SAME shared helper
// it always was: collectProcessingGateProblems (variants / KIV / completeness /
// dates), soLocationProblem (stock location), the sofa-mix rule (SOFA_MIX_REASON)
// and the payment sub-field cascade. This module only AGGREGATES + NAMES them in
// the order the operator reads them. A caller passes already-computed facts
// (the offenders, the resolved sales location, the sofa flag, the payment gaps),
// exactly as collectProcessingGateProblems already takes its facts, so this stays
// pure and the IO lives in the route / validate endpoint.
// ----------------------------------------------------------------------------
import { fairMissingMessage, type FairWhy } from '../lib/fair-options';
import { SOFA_MIX_REASON } from '../lib/main-mix';
import { soLocationProblem } from '../lib/so-location-gate';
import {
  collectProcessingGateProblems,
  type ProcessingGateFacts,
  type SaveProblem,
} from './so-save-problems';

/** A payment row missing a required sub-field (Merchant -> Bank/Plan, Online ->
 *  Sub-Type, Convert -> source order). All incomplete rows, not just the first. */
export type SubmitPaymentGap = { row: number; method: string; missing: string };

/**
 * Payment method L2 sub-field a row still lacks, or null when complete. The
 * backend twin of the frontend PaymentsTable.missingMethodSubField cascade, kept
 * here so the payment gap the operator sees is backend-authored like every other
 * problem. Keyed on the L1 method label VALUE; unknown / Cash need no sub-field.
 */
export function soPaymentSubFieldGap(d: {
  methodLabel: string;
  merchantProvider?: string | null;
  installmentMonthsLabel?: string | null;
  onlineType?: string | null;
  convertedFromDocNo?: string | null;
}): string | null {
  if (d.methodLabel === 'Convert') return d.convertedFromDocNo ? null : 'order the money comes from';
  if (d.methodLabel === 'Merchant') {
    if (!d.merchantProvider) return 'Bank';
    if (!d.installmentMonthsLabel) return 'Plan';
    return null;
  }
  if (d.methodLabel === 'Online') {
    if (!d.onlineType) return 'Sub-Type';
    return null;
  }
  return null;
}

export interface SoSubmitFacts {
  customerName: string;
  phone: string;
  origPhone: string | null;
  hasNamedLine: boolean;
  asDraft: boolean;
  hasVenue: boolean;
  hasSalesperson: boolean;
  /** A fair EVENT was picked/auto-filled (its organizer is set). Confirm-only.
   *  Owner 2026-09-26: fair is compulsory so the Sales Report can attribute every
   *  order — a submit must EITHER pick a fair OR mark `noFair`. */
  fairChosen: boolean;
  noFair: boolean;
  fairWhy: FairWhy | null;
  /** An EVENT was picked with no day of it (owner 2026-09-24,
   *  `fair-options.ts::fairDayMissing`). Confirm-only, like the venue. */
  fairDayMissing: boolean;
  gateLocation: boolean;
  companyCode: unknown;
  salesLocation: string | null | undefined;
  customerState: string | null | undefined;
  gate: ProcessingGateFacts;
  sofaMixConflict: boolean;
  paymentGaps: readonly SubmitPaymentGap[];
  extra?: readonly SaveProblem[];
}

const requiredFieldProblem = (label: string): SaveProblem => ({
  code: 'required_field',
  message: `${label} is required.`,
  field: label,
});

/**
 * Every reason THIS Sales Order submit is blocked, in the order the operator
 * reads them: always-required identity, then the Processing-Date gate the same
 * shared collector owns (completeness / variants / dates), then the stock
 * location, then the sofa-mix rule, then payment sub-fields, then any surface
 * extras. [] means every gate passes.
 */
export function collectSoSubmitProblems(facts: SoSubmitFacts): SaveProblem[] {
  const out: SaveProblem[] = [];

  const proceeding = !!facts.gate.procDate;
  const gateWillRestateCustomer =
    proceeding && !!facts.gate.completeness && !facts.gate.completeness.hasCustomerName;
  if (facts.customerName.trim() === '' && !gateWillRestateCustomer) {
    out.push(requiredFieldProblem('Customer name'));
  }
  const savedWithoutPhone = facts.origPhone !== null && facts.origPhone.trim() === '';
  if (facts.phone.trim() === '' && !savedWithoutPhone) out.push(requiredFieldProblem('Phone number'));
  if (!facts.hasNamedLine) out.push(requiredFieldProblem('At least one line item with a product'));
  if (!facts.asDraft) {
    if (!facts.hasVenue) out.push(requiredFieldProblem('Venue'));
    // Fair is compulsory (owner 2026-09-26): a fair must be picked, or the sale
    // explicitly marked No-fair / showroom. Blocks the ambiguous "left blank".
    if (!facts.fairChosen && !facts.noFair) {
      out.push({ code: 'fair_required', message: fairMissingMessage(facts.fairWhy), field: 'Fair' });
    }
    if (facts.fairDayMissing) out.push(requiredFieldProblem('Fair day'));
    if (!facts.hasSalesperson) out.push(requiredFieldProblem('Salesperson'));
  }

  for (const p of collectProcessingGateProblems(facts.gate)) out.push(p);

  if (facts.gateLocation) {
    const loc = soLocationProblem({
      companyCode: facts.companyCode,
      salesLocation: facts.salesLocation,
      customerState: facts.customerState,
    });
    if (loc) out.push(loc);
  }

  if (facts.sofaMixConflict) {
    out.push({ code: 'sofa_mix', message: SOFA_MIX_REASON, field: 'Line items' });
  }

  for (const g of facts.paymentGaps) {
    out.push({
      code: 'payment_method_field_required',
      message: `Payment ${g.row} (${g.method}) needs a ${g.missing}.`,
      field: `Payment ${g.row}`,
    });
  }

  for (const p of facts.extra ?? []) out.push(p);

  return out;
}
