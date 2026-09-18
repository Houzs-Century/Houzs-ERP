// ----------------------------------------------------------------------------
// assr-stage-labels — the ONE answer to "what word does a reader see for an
// ASSR service-case stage?".
//
// WHY THIS FILE EXISTS. The stage vocabulary was hand-written in five places
// and the customer-facing one was the copy that never got `voided`:
//
//   · caseTracking.ts `customerStatusFor` — a switch over nine stages plus six
//     legacy aliases, no `voided` arm, `default: { label: stage }`. So the
//     PORTAL — the one surface a customer reads — printed the raw database slug
//     `voided`. Worse than one bad case: portal.ts builds the salesperson
//     stepper by mapping ALL_STAGES through it, and `voided` is in ALL_STAGES
//     (assr.ts), so the raw slug appeared as a STEP LABEL on every sales-portal
//     view, not only on voided cases.
//   · assr_print.ts `STAGE_LABEL` — "Voided — Not Valid"
//   · assrFormIntake.ts `SHEET_STATUS` — "Voided", a third spelling
//   · vendor/scm/lib/assr/stages.ts `ASSR_STAGES.long` — no voided at all
//     (correctly: it is not a pipeline step) so mobile bolted a literal on top
//
// Three different answers for one stage, and the one the customer saw was not
// even English. Nobody was careless: `customerStatusFor` predates `voided`, and
// the next four writers each needed a word in a layer that could not reach it.
//
// The pair of paths is load-bearing, not decorative. check-shared-mirrors.mjs
// enumerates backend/src/scm/shared and looks each basename up in
// frontend/src/vendor/shared and frontend/src/vendor/scm/lib — non-recursively,
// by basename. Landing the map at exactly those two paths puts the existing
// --strict CI gate in front of any future drift between them, with no new
// script. Keep the two files BYTE-IDENTICAL; that is what the gate reads.
// No imports here, for the same reason.
// ----------------------------------------------------------------------------

export type AssrStageColor = "grey" | "blue" | "amber" | "violet" | "green";

/**
 * The app + document wording. This is the vocabulary the ERP screens, the
 * printed service report and the mobile app all speak.
 *
 * The eight live stages are `ALL_STAGES` in backend/src/services/assr.ts and
 * the CHECK on assr_cases.stage bounds the column to them; the tail is retired
 * values, kept so an unmigrated row can never render as a slug. Migrations
 * 0105 (Pending Inspection folded into Verification) and 0110 (Item Pickup
 * folded into the Supplier stage) moved every row, so the tail should be dead
 * — it is insurance, not behaviour.
 */
export const ASSR_STAGE_LABEL: Record<string, string> = {
  // Live stages, in workflow order (Nico 2026-08-11: Solution decides the fix,
  // then Verification inspects it — Solution comes FIRST).
  pending_review: "Pending Review",
  pending_solution: "Pending Solution",
  under_verification: "Under Verification",
  // Renamed from "Supplier Pickup / Return" (Nico 2026-09-04): the stage now
  // spans three legs — customer pickup, supplier pickup, supplier return — so
  // the name stays neutral and the sub-status names the actor.
  pending_supplier_pickup: "Pickup / Return",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Pending Delivery / Service",
  completed: "Completed",
  // Terminal alt-outcome, NOT a pipeline step — it is deliberately absent from
  // the ordered stepper (ASSR_STAGES) and present here, because "is this a step
  // in the funnel" and "what word do we print for it" are different questions.
  voided: "Voided — Not Valid",
  // Retired stage values — see the doc comment above.
  pending_inspection: "Under Verification",
  pending_item_pickup: "Pickup / Return",
  registration: "Pending Review",
  triage: "Under Verification",
  action: "Pending Solution",
  // `logistics` reads "Pending Item Pickup" and NOT the supplier wording above.
  // Both pre-existing copies said exactly this, so it is not drift and is not
  // being silently rewritten here; it is a retired v1 label that predates the
  // 0110 fold and is recorded rather than tidied.
  logistics: "Pending Item Pickup",
  resolution: "Pending Delivery / Service",
  closed: "Completed",
};

/**
 * The customer portal's ONE deliberate departure from the wording above.
 *
 * OPEN QUESTION FOR THE OWNER, held here instead of being merged under cover of
 * a refactor: the app and the printed report say "Supplier Pickup / Return",
 * the portal says "Pending Supplier Pickup". Both readings look intentional —
 * the app names both legs of the supplier trip because ops switch between them
 * via the sub-status, while the customer is only ever told the case is with the
 * supplier. Picking a side is a wording decision, not a bug fix, so both
 * wordings are preserved exactly as they are today and the difference is
 * reduced to these two lines. If the owner unifies them, delete this map.
 */
export const ASSR_CUSTOMER_STAGE_LABEL: Record<string, string | undefined> = {
  pending_supplier_pickup: "Pending Supplier Pickup",
  // Retired alias of the row above (mig 0110) — kept on the same wording.
  pending_item_pickup: "Pending Supplier Pickup",
};

/** Portal StatusPill palette. Server-authoritative: the portal renders this. */
export const ASSR_STAGE_COLOR: Record<string, AssrStageColor | undefined> = {
  pending_review: "grey",
  pending_solution: "amber",
  under_verification: "blue",
  pending_supplier_pickup: "violet",
  pending_item_ready: "violet",
  pending_delivery_service: "violet",
  completed: "green",
  // Grey, which is what `voided` already resolved to through the missing-arm
  // default. The pill palette has no red; the printed report and the desktop
  // banner carry the red treatment, and this fix changes the WORD only.
  voided: "grey",
  pending_inspection: "blue",
  pending_item_pickup: "violet",
  registration: "grey",
  triage: "blue",
  action: "amber",
  logistics: "violet",
  resolution: "violet",
  closed: "green",
};

/**
 * The app + document label for a stage. An unrecognised value comes back
 * untouched — the same fallback every call site already had, so a stage the
 * table has not heard of still renders as itself rather than as "undefined".
 */
export function assrStageLabel(stage: string | null | undefined): string {
  const key = stage ?? "";
  return ASSR_STAGE_LABEL[key] ?? key;
}

/**
 * What the CUSTOMER sees: label + pill colour. Replaces `customerStatusFor`,
 * whose whole body this is.
 */
export function assrCustomerStatus(stage: string | null | undefined): {
  label: string;
  color: AssrStageColor;
} {
  const key = stage ?? "";
  const override = ASSR_CUSTOMER_STAGE_LABEL[key];
  return {
    // `key ? … : "Unknown"` and not `… || "Unknown"`: an empty/absent stage is
    // the only value that becomes "Unknown". Anything else the table has not
    // heard of comes back as itself, exactly as the switch's `default` did.
    label: override ?? (key ? assrStageLabel(key) : "Unknown"),
    color: ASSR_STAGE_COLOR[key] ?? "grey",
  };
}

/**
 * A DIFFERENT VOCABULARY, deliberately — do not fold it into the map above.
 *
 * The "ASSR Case" tab of the ops delivery sheet is rewritten from this by an
 * Apps Script time trigger, and the sheet's own stats block COUNTS these exact
 * strings. Two of them are not the app's words and must not become them:
 * "Pending Delivery/Service" has no spaces around the slash, and `voided` is
 * the bare "Voided". Changing either silently breaks the spreadsheet's
 * counters, which is a different failure from a customer reading a slug.
 */
export const ASSR_SHEET_STATUS: Record<string, string> = {
  pending_review: "Pending Review",
  under_verification: "Under Verification",
  pending_solution: "Pending Solution",
  pending_supplier_pickup: "Pending Supplier Pickup",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Pending Delivery/Service",
  completed: "Completed",
  voided: "Voided",
};
