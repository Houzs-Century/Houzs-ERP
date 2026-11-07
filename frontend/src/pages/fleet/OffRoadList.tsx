// The lorry's off-the-road windows. The record endpoint has always returned them
// (maintenanceWindows) and nothing showed them, so a lorry could read "Out of
// service" with no way to see from when to when. Read-only: Fleet Health has no
// route that adds or ends a window.
import { cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import { Pill } from "../FleetHealth";
import { offRoadRows, type OffRoadWindow } from "./fleetHealthModel";

const STATE = { now: { label: "Off the road now", tone: "crit" }, planned: { label: "Planned", tone: "warn" }, ended: { label: "Ended", tone: "neutral" } } as const;

export function OffRoadList({ windows, today }: { windows: readonly OffRoadWindow[]; today: string }) {
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
              {r.from ? fmtDate(r.from) : "—"} to {r.to ? fmtDate(r.to) : "—"}
              {r.days != null ? ` · ${r.days} day${r.days === 1 ? "" : "s"}` : ""}
            </span>
          </span>
          <Pill tone={STATE[r.state].tone}>{STATE[r.state].label}</Pill>
        </li>
      ))}
      {rows.length > 12 && <li className="pt-2 text-[12.5px] text-ink-muted">Showing the latest 12 of {rows.length}.</li>}
    </ul>
  );
}
