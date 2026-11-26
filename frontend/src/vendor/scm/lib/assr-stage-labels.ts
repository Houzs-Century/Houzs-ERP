
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
  pending_review: "Pending Review",
  pending_solution: "Pending Solution",
  under_verification: "Under Verification",
  pending_supplier_pickup: "Pickup / Return",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Pending Delivery / Service",
  completed: "Completed",
  voided: "Voided — Not Valid",
  pending_inspection: "Under Verification",
  pending_item_pickup: "Pickup / Return",
  registration: "Pending Review",
  triage: "Under Verification",
  action: "Pending Solution",
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
