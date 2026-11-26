
import { ASSR_STAGE_LABEL } from "../assr-stage-labels";
import { ASSR_SUB_STATUSES, assrSubStatusLabelOf, type AssrSubStatusDef } from "../assr-sub-statuses";

export type AssrStageKey =
  | "pending_review"
  | "under_verification"
  | "pending_solution"
  | "pending_supplier_pickup"
  | "pending_item_ready"
  | "pending_delivery_service"
  | "completed"
  | "voided";

export interface AssrStageDef {
  key: AssrStageKey;
  short: string;
  long: string;
  owner: string;
  /** One-line caption under the funnel dot on the desktop detail (Nick
   *  2026-07-23: 在 stage funnel 每个 stage 加上 description). Desktop is the
   *  only surface that renders it today, but it lives on the row it captions:
   *  the desktop table that used to hold it also held its own `long` words, and
   *  four of them had drifted from the canonical ones by the time anyone
   *  compared. A column, not a table. */
  desc: string;
}

export const ASSR_STAGES: AssrStageDef[] = [
  { key: "pending_review",           short: "Review",      long: ASSR_STAGE_LABEL.pending_review,           owner: "Service Admin", desc: "New case — first review" },
  { key: "pending_solution",         short: "Solution",    long: ASSR_STAGE_LABEL.pending_solution,         owner: "Service Admin", desc: "Decide fix & assign supplier" },
  { key: "under_verification",       short: "Verify",      long: ASSR_STAGE_LABEL.under_verification,       owner: "Service Admin", desc: "Inspect & verify the issue" },
  { key: "pending_supplier_pickup",  short: "Pickup",      long: ASSR_STAGE_LABEL.pending_supplier_pickup,  owner: "Service Admin", desc: "Customer pickup · supplier pickup · supplier return" },
  { key: "pending_item_ready",       short: "Pending Item Ready", long: ASSR_STAGE_LABEL.pending_item_ready, owner: "Service Admin", desc: "Repair done — QC check" },
  { key: "pending_delivery_service", short: "Delivery",    long: ASSR_STAGE_LABEL.pending_delivery_service, owner: "Logistic Admin", desc: "Schedule return delivery" },
  { key: "completed",                short: "Completed",   long: ASSR_STAGE_LABEL.completed,                owner: "System", desc: "Closed & rated" },
];

export const ASSR_STAGE_INDEX: Record<string, number> = Object.fromEntries(
  ASSR_STAGES.map((s, i) => [s.key, i]),
);

/** Stages that drop out of the pipeline for the internal resolution route.
 *  EMPTY since Nico 2026-09-04: with the customer-pickup leg, an own-team
 *  repair also collects the item and returns it (Pickup / Return is no longer
 *  supplier-specific), and it has its own "repair done — QC check" phase — so
 *  EVERY case runs the full 7-stage pipeline. The filtering machinery
 *  (isStageActive / filterActiveStages / activeAssrStages) stays wired for the
 *  day a route genuinely skips a stage again; with this list empty it is the
 *  identity filter. Was: pending_supplier_pickup + pending_item_ready. */
export const ASSR_SUPPLIER_ONLY_STAGES: readonly string[] = [];

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

/* The sub-status list itself lives in ../assr-sub-statuses.ts, byte-identical
   with the server's copy, because the server's save allowlist once held a
   different list (docs/bugs/0890-a-service-case-could-never-be-switched-back-to-pending-custo.md).
   Re-exported so the screens keep one import. */
export { ASSR_SUB_STATUSES, type AssrSubStatusDef };

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
  return assrSubStatusLabelOf(key) ?? (key || "—");
}

/** Active canonical stages for a case (the common mobile call). */
export function activeAssrStages(
  method: string | null | undefined,
  currentStage: string,
): AssrStageDef[] {
  return filterActiveStages(ASSR_STAGES, method, currentStage, (s) => s.key);
}
