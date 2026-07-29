// ----------------------------------------------------------------------------
// assr/stages — the CANONICAL service-case (ASSR) stage pipeline + the
// resolution-routing rule. NO React, no query client, no I/O.
//
// This is the single source of truth for the 7-stage workflow and, crucially,
// for the ONE rule that used to drift between desktop and mobile: when a case
// is resolved in-house (own field service / return visit) the two
// supplier-only stages — Supplier Pickup and Item Ready — drop out of the
// pipeline entirely. Desktop enforced this via getActiveStages; mobile did
// not, so internal-resolution cases on mobile mis-routed INTO those stages and
// showed the wrong progress denominator. Both surfaces now share this file.
//
// Stage vocabulary since mig 0110 (Item Pickup retired; the customer-side
// collection lives inside the Supplier stage) / mig 0105 (Pending Inspection
// folded into Verification).
// ----------------------------------------------------------------------------

export type AssrStageKey =
  | "pending_review"
  | "under_verification"
  | "pending_solution"
  | "pending_supplier_pickup"
  | "pending_item_ready"
  | "pending_delivery_service"
  | "completed"
  // voided = terminal alt-outcome; NOT in ASSR_STAGES (never a funnel dot).
  | "voided";

export interface AssrStageDef {
  /** SQL enum value. */
  key: AssrStageKey;
  /** Chip-short label. */
  short: string;
  /** Card / badge label. */
  long: string;
  /** Responsible role (drives the "next-stage owner" hint on the advance sheet). */
  owner: string;
}

export const ASSR_STAGES: AssrStageDef[] = [
  { key: "pending_review",           short: "Review",      long: "Pending Review",             owner: "Service Admin" },
  { key: "under_verification",       short: "Verify",      long: "Under Verification",         owner: "Service Admin" },
  { key: "pending_solution",         short: "Solution",    long: "Pending Solution",           owner: "Service Admin" },
  { key: "pending_supplier_pickup",  short: "Supplier",    long: "Supplier Pickup / Return",   owner: "Service Admin" },
  { key: "pending_item_ready",       short: "Pending Item Ready", long: "Pending Item Ready",  owner: "Service Admin" },
  { key: "pending_delivery_service", short: "Delivery",    long: "Pending Delivery / Service", owner: "Logistic Admin" },
  { key: "completed",                short: "Completed",   long: "Completed",                  owner: "System" },
];

export const ASSR_STAGE_INDEX: Record<string, number> = Object.fromEntries(
  ASSR_STAGES.map((s, i) => [s.key, i]),
);

/** The two stages that exist only when a supplier is in the loop. */
export const ASSR_SUPPLIER_ONLY_STAGES: readonly string[] = [
  "pending_supplier_pickup",
  "pending_item_ready",
];

/**
 * Which side of the flow a resolution method routes to. `internal` = own team
 * handles it end-to-end (no supplier hand-off), so the supplier-only stages
 * drop out. `null` = not decided yet (full pipeline shown).
 */
export function resolutionRoute(
  m: string | null | undefined,
): "supplier" | "internal" | null {
  if (!m) return null;
  if (m === "field_service_own" || m === "return_visit") return "internal";
  return "supplier";
}

/**
 * Is `stageKey` part of the active pipeline for a case with this resolution
 * method? The current stage is ALWAYS active as a safety net — a case parked on
 * a filtered-out stage (shouldn't happen, but ops can) still renders.
 */
export function isStageActive(
  method: string | null | undefined,
  stageKey: string,
  currentStage: string,
): boolean {
  if (stageKey === currentStage) return true;
  if (resolutionRoute(method) !== "internal") return true;
  return !ASSR_SUPPLIER_ONLY_STAGES.includes(stageKey);
}

/**
 * Filter an ordered stage table down to the pipeline that actually applies to
 * this case. Generic over any table shaped `{ <keyProp>: string }` so both the
 * desktop table (`{ id }`) and the canonical table (`{ key }`) can use it.
 */
export function filterActiveStages<T>(
  stages: readonly T[],
  method: string | null | undefined,
  currentStage: string,
  keyOf: (s: T) => string,
): T[] {
  return stages.filter((s) => isStageActive(method, keyOf(s), currentStage));
}

export interface AssrSubStatusDef {
  key: string;
  label: string;
}

/**
 * Sub-statuses (小类) inside two stages — DIRECTLY switchable by ops
 * (Nick 2026-07-15: "我要可以直接换" — the earlier field-derived version
 * wasn't controllable). Stored on assr_cases.sub_status; entering a
 * stage with sub-states seeds the first entry (transitionStage), other
 * stages carry NULL.
 */
export const ASSR_SUB_STATUSES: Record<string, AssrSubStatusDef[]> = {
  under_verification: [
    { key: "pending_inspection", label: "Pending Inspection" },
    { key: "qc_issue_result", label: "QC Issue Result" },
  ],
  pending_supplier_pickup: [
    { key: "pending_supplier_pickup", label: "Pending Supplier Pickup" },
    { key: "pending_supplier_return", label: "Pending Supplier Return" },
  ],
};

/**
 * Resolve a case's current sub-status from the STORED value. Falls
 * back to the stage's first sub-state for rows written before the
 * column existed (or between deploys). Stages without sub-states → null.
 */
export function assrSubStatus(
  stage: string | null | undefined,
  stored: string | null | undefined,
): AssrSubStatusDef | null {
  const opts = ASSR_SUB_STATUSES[stage || ""];
  if (!opts) return null;
  return opts.find((o) => o.key === stored) ?? opts[0];
}

/**
 * Does a sub-status label ADD information next to its stage label, or does it
 * merely restate it? Owner 2026-07-16 ("為什麼這裡 duplicate 了"): the Cases
 * list stacked "Supplier Pickup" over "Pending Supplier Pickup", which reads as
 * a duplicate. "Pending Supplier Return" under the same stage is NOT a
 * duplicate — it names which leg the case is on.
 *
 * Rule: strip a leading "Pending" and every non-alphanumeric, casefold, then
 * compare. Sub-status restates the stage → false (caller hides it). Comparing
 * the LABELS (not the keys) keeps the rule true for any wording the stage /
 * sub-status tables grow later, without a hand-maintained duplicate list.
 */
const normalizeStageLabel = (s: string): string =>
  s
    .replace(/^\s*pending\s+/i, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();

export function assrSubStatusAddsInfo(
  stageLabel: string,
  subStatusLabel: string,
): boolean {
  return normalizeStageLabel(subStatusLabel) !== normalizeStageLabel(stageLabel);
}

/** Human label for a sub-status key (timeline rendering). */
export function assrSubStatusLabel(key: string | null | undefined): string {
  for (const opts of Object.values(ASSR_SUB_STATUSES)) {
    const hit = opts.find((o) => o.key === key);
    if (hit) return hit.label;
  }
  return key || "—";
}

/** Active canonical stages for a case (the common mobile call). */
export function activeAssrStages(
  method: string | null | undefined,
  currentStage: string,
): AssrStageDef[] {
  return filterActiveStages(ASSR_STAGES, method, currentStage, (s) => s.key);
}
