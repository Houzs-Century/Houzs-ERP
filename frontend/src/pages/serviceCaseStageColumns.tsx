// Service Cases list · where each case stands in its stage (owner 2026-10-19:
// "In stage since, Target, Days in stage, Days overdue, Case age" as their own
// columns, the same as the Quality Overview's overdue list). Kept out of
// ServiceCases.tsx, which sits at its size ceiling.
import type { Column } from "../components/DataTable";
import type { AssrCase } from "../types";
import { todayMY } from "../vendor/shared/format";

const DAY = 86400000;
const daysSince = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(d) ? Math.floor((Date.parse(`${todayMY()}T00:00:00Z`) - d) / DAY) : null;
};
const open = (r: AssrCase) => r.stage !== "completed" && r.stage !== "voided";
const inStage = (r: AssrCase) => (open(r) ? r.days_in_stage ?? daysSince(r.stage_entered_at ?? r.stage_since) : null);
/** Days past the stage's target; null when there is no target or the case is closed. */
const overdue = (r: AssrCase) => {
  const d = inStage(r); const t = r.stage_target_days;
  return d == null || t == null || !(t > 0) ? null : Math.max(0, Math.floor(d - t));
};

export const STAGE_COLUMNS: Column<AssrCase>[] = [
  {
    key: "stage_entered_at", label: "In stage since", align: "right",
    render: (r) => <span className="tabular-nums">{open(r) ? (r.stage_entered_at ?? r.stage_since ?? "").slice(0, 10) || "—" : "—"}</span>,
    getValue: (r) => (open(r) ? (r.stage_entered_at ?? r.stage_since ?? null) : null),
  },
  {
    key: "stage_target_days", label: "Target", align: "right",
    render: (r) => <span className="tabular-nums">{open(r) && r.stage_target_days != null ? `${r.stage_target_days} days` : "—"}</span>,
    getValue: (r) => (open(r) ? r.stage_target_days ?? null : null),
  },
  {
    key: "days_in_stage_col", label: "Days in stage", align: "right",
    render: (r) => <span className="tabular-nums">{inStage(r) ?? "—"}</span>,
    getValue: (r) => inStage(r),
  },
  {
    key: "days_overdue", label: "Days overdue", align: "right",
    render: (r) => { const o = overdue(r); return <span className={o ? "font-semibold tabular-nums text-err" : "tabular-nums text-ink-muted"}>{o == null ? "—" : o}</span>; },
    getValue: (r) => overdue(r),
  },
  {
    key: "case_age", label: "Case age", align: "right",
    render: (r) => { const a = daysSince(r.complained_date ?? r.created_at); return <span className="tabular-nums">{a == null ? "—" : `${a} days`}</span>; },
    getValue: (r) => daysSince(r.complained_date ?? r.created_at),
  },
];
