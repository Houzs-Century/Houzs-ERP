
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
