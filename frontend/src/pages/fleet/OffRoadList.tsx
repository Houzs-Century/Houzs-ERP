// The lorry's off-the-road windows. Read-only unless the caller passes onEnd, which
// adds "Back on the road" to the windows staff entered by hand (a lorry service job
// or Repair Days owns its own windows and ends them from its own screen).
import { cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import { Pill } from "../FleetHealth";
import { offRoadRows, type OffRoadRow, type OffRoadWindow } from "./fleetHealthModel";

const STATE = { now: { label: "Off the road now", tone: "crit" }, planned: { label: "Planned", tone: "warn" }, ended: { label: "Ended", tone: "neutral" } } as const;

const OWNER = { dp_job: "Set by a lorry service job", repair_days: "Set by Repair Days on Lorry Capacity" } as const;

export function OffRoadList({ windows, today, onEnd, endingId }: {
  windows: readonly OffRoadWindow[]; today: string;
  onEnd?: (row: OffRoadRow) => void; endingId?: string | null;
}) {
  const rows = offRoadRows(windows, today);
  if (rows.length === 0) return <p className="text-[13.5px] text-ink-muted">Never taken off the road.</p>;
  return (
    <ul className="flex flex-col">
      {rows.slice(0, 12).map((r, i) => (
        <li key={`${r.from}-${r.to}-${i}`} className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-border/60 py-3 last:border-b-0">
          <span className={cn("h-2.5 w-2.5 flex-none rounded-full", r.state === "now" ? "bg-err" : r.state === "planned" ? "bg-warning-text" : "bg-ink-muted")} />
          <span className="flex min-w-[200px] flex-1 flex-col gap-0.5">
            <span className="text-[14px] font-semibold text-ink">{r.reason || "No reason given"}</span>
            <span className="text-[12.5px] text-ink-muted">
              {r.from ? fmtDate(r.from) : "—"} to {r.to ? fmtDate(r.to) : r.from ? "further notice" : "—"}
              {r.days != null ? ` · ${r.days} day${r.days === 1 ? "" : "s"}` : ""}
              {r.source && r.source !== "manual" && r.state !== "ended" ? ` · ${OWNER[r.source]}` : ""}
            </span>
          </span>
          <Pill tone={STATE[r.state].tone}>{STATE[r.state].label}</Pill>
          {onEnd && r.id && r.source === "manual" && r.state !== "ended" && (
            <button type="button" disabled={endingId === r.id} onClick={() => onEnd(r)}
              className="min-h-[36px] rounded-md border border-border px-3 text-[12.5px] font-semibold text-ink disabled:opacity-50">
              {r.state === "planned" ? "Cancel" : "Back on the road"}
            </button>
          )}
        </li>
      ))}
      {rows.length > 12 && <li className="pt-2 text-[12.5px] text-ink-muted">Showing the latest 12 of {rows.length}.</li>}
    </ul>
  );
}
