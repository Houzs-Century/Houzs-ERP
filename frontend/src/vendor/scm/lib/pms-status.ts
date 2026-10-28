// ----------------------------------------------------------------------------
// pms-status — CANONICAL project (PMS) stage label + variant. NO React, no I/O.
// Desktop `Projects.tsx` and mobile `MobilePMS.tsx` both hardcoded these
// ("Mirrors desktop" per the mobile comment); this is the single source so the
// stage vocabulary can't drift. Each surface keeps its OWN variant→visual map
// (desktop pill classes / mobile STAGE_TINT) — only the stage→variant string
// contract is shared.
//
// The workflow `stage` enum (mig 053) is draft → setup → live → dismantle →
// completed. `closed` / `cancelled` are STATUS values on desktop (modelled
// separately) but can appear on a row's stage badge on mobile, which conflates
// stage+status into one badge — so the maps below tolerate them.
// ----------------------------------------------------------------------------

export type PmsStageVariant = "neutral" | "open" | "in-progress" | "closed" | "error";

export const PMS_STAGE_LABEL: Record<string, string> = {
  draft: "Draft",
  setup: "Setup",
  live: "Live",
  dismantle: "Dismantle",
  completed: "Completed",
  closed: "Closed",
  cancelled: "Cancelled",
};

/** Title-case an unknown slug ("some_stage" → "Some Stage"). */
const humanizeStage = (s: string): string =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const pmsStageLabel = (stage: string | null | undefined): string => {
  const s = (stage ?? "").toLowerCase();
  return PMS_STAGE_LABEL[s] ?? (s ? humanizeStage(s) : "—");
};

/**
 * Stage → semantic variant string. draft=neutral · setup=open ·
 * live/dismantle=in-progress · completed/closed=closed · cancelled=error ·
 * anything else=neutral. Callers map the variant onto their own palette.
 */
export function pmsStageVariant(stage: string | null | undefined): PmsStageVariant {
  switch ((stage ?? "").toLowerCase()) {
    case "draft":
      return "neutral";
    case "setup":
      return "open";
    case "live":
    case "dismantle":
      return "in-progress";
    case "completed":
    case "closed":
      return "closed";
    case "cancelled":
      return "error";
    default:
      return "neutral";
  }
}
