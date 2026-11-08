// Fleet Health in pictures (owner, 2026-10-17): what state the own fleet is in,
// how the compliance documents stand, and which lorries lose the most days.
// Own file because FleetHealth.tsx sits near its size ceiling.
import { Donut, HBars, SplitBar, TONE } from "../components/scm-v2/Charts";
import type { VehicleRow } from "./FleetHealth";
import { FleetCard } from "./fleet/FleetUi";
import { attentionScore } from "./fleet/fleetHealthModel";

const STATUS_COLOR: Record<string, string> = {
  AVAILABLE: TONE.good, SERVICE_DUE: TONE.warn, PLANNED_MAINTENANCE: "#4f7cac", WAITING_PARTS: "#8a5a9e",
  BREAKDOWN: "#c2603d", COMPLIANCE_BLOCKED: TONE.bad, OUT_OF_SERVICE: "#6b7a8f",
};

export function FleetHealthCharts({ vehicles, kpis, onOpen }: {
  vehicles: VehicleRow[];
  /** Opens a lorry's record from the attention chart. */
  onOpen: (id: string) => void;
  kpis: { expiredDocs?: number; expiring30?: number; expiring60?: number; expiring90?: number } | null;
}) {
  const byStatus = new Map<string, { label: string; value: number; color: string | null }>();
  for (const v of vehicles) {
    const cur = byStatus.get(v.status) ?? { label: v.statusLabel, value: 0, color: STATUS_COLOR[v.status] ?? null };
    cur.value += 1;
    byStatus.set(v.status, cur);
  }
  const REQUIRED = [["ROAD_TAX", "road tax"], ["INSURANCE", "insurance"], ["PUSPAKOM", "PUSPAKOM"]] as const;
  const noDocs = vehicles
    .map((v) => ({ plate: v.plate, missing: REQUIRED.filter(([k]) => !v.compliance[k]?.expiryDate).map(([, l]) => l) }))
    .filter((x) => x.missing.length > 0);
  const attention = vehicles
    .map((v) => ({ v, score: attentionScore(v) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <FleetCard title="Fleet status" sub={`${vehicles.length} lorries`}>
        <Donut size={116} format={(n) => `${n}`} center={{ value: String(vehicles.filter((v) => v.canDispatch).length), label: "can go out" }} data={[...byStatus.values()]} />
      </FleetCard>
      <FleetCard title="Compliance documents" sub="by when they expire">
        <SplitBar format={(n) => `${n}`} parts={[
          { label: "Expired", value: kpis?.expiredDocs ?? 0, color: TONE.bad },
          { label: "Within 30 days", value: kpis?.expiring30 ?? 0, color: TONE.warn },
          { label: "31–60 days", value: kpis?.expiring60 ?? 0, color: "#d9b867" },
          { label: "61–90 days", value: kpis?.expiring90 ?? 0, color: "#8fb3ae" },
        ]} />
        {noDocs.length > 0
          ? <p className="text-[12.5px] leading-relaxed text-warning-text">Nothing on file yet for {noDocs.map((x) => `${x.plate} (${x.missing.join(", ")})`).join("; ")}. The chart only counts documents that were entered.</p>
          : <p className="text-[12.5px] leading-relaxed text-ink-muted">An expired road tax, insurance, PUSPAKOM or permit grounds the lorry until it is renewed.</p>}
      </FleetCard>
      <FleetCard title="Lorries needing the most attention" sub="downtime, overdue service, open work orders">
        <HBars format={(n) => `${Math.round(n)}`} empty="No lorry is down, overdue or in repair."
          rows={attention.map(({ v, score }) => ({
            key: v.id, label: v.plate, value: score, color: v.canDispatch ? TONE.warn : TONE.bad,
            right: [v.downtimeHours ? `${Math.round(v.downtimeHours)}h down` : null, v.plansOverdue ? `${v.plansOverdue} service overdue` : null, v.openWorkOrders ? `${v.openWorkOrders} WO open` : null].filter(Boolean).join(" · "),
            onClick: () => onOpen(v.id),
          }))} />
      </FleetCard>
    </div>
  );
}
