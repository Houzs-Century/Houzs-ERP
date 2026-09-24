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
  /** Always-required identity fields. */
  customerName: string;
  phone: string;
  /** True when at least one line has a product picked AND qty > 0. */
  hasNamedLine: boolean;
  /** Save-as-draft: a draft needs none of the confirm-only fields (venue,
   *  salesperson, stock location). */
  asDraft: boolean;
  /** Resolved venue — false when none picked. Confirm-only. */
  hasVenue: boolean;
  /** Resolved salesperson — false when none. Confirm-only. */
  hasSalesperson: boolean;
  /** An EVENT was picked with no day of it (owner 2026-09-24,
   *  `fair-options.ts::fairDayMissing`). Confirm-only, like the venue. */
  fairDayMissing: boolean;
  /** Whether to run the stock-location gate at all. False for a draft, an edit,
   *  or while the mappings are still loading (an in-flight mapping table makes
   *  every State look unmapped, and refusing an order because a read is in flight
   *  is worse than letting the server have the last word). The company predicate
   *  itself lives in soLocationProblem. */
  gateLocation: boolean;
  /** Active company code — soLocationProblem decides whether the company needs a
   *  location at all. */
  companyCode: unknown;
  /** Sales location the State resolved ('' / null = none). */
  salesLocation: string | null | undefined;
  /** Picked delivery State ('' / null = none) — names which stock-location cause. */
  customerState: string | null | undefined;
  /** Tier-1 processing / proceed gate facts, delegated VERBATIM to
   *  collectProcessingGateProblems (variants, KIV, completeness, dates). */
  gate: ProcessingGateFacts;
  /** True when the lines mix a sofa with a bedframe / mattress. */
  sofaMixConflict: boolean;
  /** Payment rows missing a required sub-field — all of them. */
  paymentGaps: readonly SubmitPaymentGap[];
  /** Surface-specific blockers already SaveProblem-shaped (e.g. an unpicked
   *  scanned line). Appended verbatim. */
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

  // 1. Always-required identity / line / confirm fields. When a Processing Date
  //    is set the tier-1 gate below RE-STATES the customer name with the reason
  //    it is required, so the bare "Customer name is required." duplicate is
  //    dropped on that path (mirrors the old client dedup).
  const proceeding = !!facts.gate.procDate;
  const gateWillRestateCustomer =
    proceeding && !!facts.gate.completeness && !facts.gate.completeness.hasCustomerName;
  if (facts.customerName.trim() === '' && !gateWillRestateCustomer) {
    out.push(requiredFieldProblem('Customer name'));
  }
  if (facts.phone.trim() === '') out.push(requiredFieldProblem('Phone number'));
  if (!facts.hasNamedLine) out.push(requiredFieldProblem('At least one line item with a product'));
  if (!facts.asDraft) {
    if (!facts.hasVenue) out.push(requiredFieldProblem('Venue'));
    if (facts.fairDayMissing) out.push(requiredFieldProblem('Fair day'));
    if (!facts.hasSalesperson) out.push(requiredFieldProblem('Salesperson'));
  }

  // 2. Processing-Date / proceed gate (variants, KIV, customer/address/postcode/
  //    delivery completeness, date rules) — delegated verbatim so its wording
  //    cannot drift from the write paths that already return it.
  for (const p of collectProcessingGateProblems(facts.gate)) out.push(p);

  // 3. Stock location — soLocationProblem owns both causes (no State picked / the
  //    picked State has no warehouse). Confirm-only, and only for a company that
  //    needs it (the predicate is inside soLocationProblem).
  if (facts.gateLocation) {
    const loc = soLocationProblem({
      companyCode: facts.companyCode,
      salesLocation: facts.salesLocation,
      customerState: facts.customerState,
    });
    if (loc) out.push(loc);
  }

  // 4. Sofa exclusivity — one shared sentence (SOFA_MIX_REASON), the same the
  //    write path refuses with.
  if (facts.sofaMixConflict) {
    out.push({ code: 'sofa_mix', message: SOFA_MIX_REASON, field: 'Line items' });
  }

  // 5. Payment method sub-fields — every incomplete row.
  for (const g of facts.paymentGaps) {
    out.push({
      code: 'payment_method_field_required',
      message: `Payment ${g.row} (${g.method}) needs a ${g.missing}.`,
      field: `Payment ${g.row}`,
    });
  }

  // 6. Surface-specific extras, verbatim.
  for (const p of facts.extra ?? []) out.push(p);

  return out;
}
