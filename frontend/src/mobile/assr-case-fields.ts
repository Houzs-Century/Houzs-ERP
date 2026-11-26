import { formatDate, formatDateTime } from "../lib/utils";
import { ASSR_STAGE_LABEL } from "../vendor/scm/lib/assr-stage-labels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type Any = Record<string, any>;

/** First present value among `keys`. `''` counts as absent — see the header.
 *
 *  `r` accepts null/undefined ON PURPOSE. Callers read straight off
 *  `data?.case ?? {}`, a `.find()` result, or a row inside a list that may not
 *  have loaded yet; making the caller null-check first would put that guard at
 *  every one of ~200 call sites and it would be forgotten at some of them. */
export const get = (r: Any | null | undefined, ...keys: string[]) => {
  for (const k of keys) {
    const v = r?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

export const caseNo = (r: Any) => get(r, "assrNo", "assr_no", "docNo", "doc_no") ?? "—";
export const customer = (r: Any) => get(r, "customerName", "customer_name") ?? "—";
export const stageOf = (r: Any) => String(get(r, "stage") ?? "");
export const priorityOf = (r: Any) => String(get(r, "priority") ?? "normal").toLowerCase();
export const statusOf = (r: Any) => String(get(r, "status") ?? "");

export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Human labels for the resolution_method slugs (mirrors desktop). */
export const RESOLUTION_LABELS: Record<string, string> = {
  replace_unit: "Replace Unit",
  supplier_repair: "Supplier Service",
  field_service_own: "On Site Service (Own Team)",
  field_service_supplier: "On Site Service (Supplier)",
  return_visit: "2nd Services",
};
export const resolutionLabel = (v: string) => RESOLUTION_LABELS[v] ?? cap(v.replace(/_/g, " "));

export const prettyStage = (stage: string) =>
  ASSR_STAGE_LABEL[stage] ?? (cap(stage.replace(/_/g, " ")) || "—");

export const dm = (d: string | null | undefined) => formatDate(d);
export const dtm = (d: string | null | undefined) => formatDateTime(d);

/** Human overdue / due-in from hours-to-deadline (drives the SLA banner). */
export const slaText = (h: number | null): { label: string; overdue: boolean } | null => {
  if (h == null || !isFinite(h)) return null;
  if (h < 0) {
    const days = Math.floor(-h / 24);
    return { label: days >= 1 ? `${days} days overdue` : `Overdue ${Math.abs(Math.round(h))}h`, overdue: true };
  }
  const days = Math.floor(h / 24);
  return { label: days >= 1 ? `Due in ${days} days` : `Due in ${Math.round(h)}h`, overdue: false };
};

/** One-line truncation, shared by every card that renders a customer name. */
export const cellEllipsis: React.CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
