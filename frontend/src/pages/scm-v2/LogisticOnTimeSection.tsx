// Logistic Overview · on-time delivery (owner 2026-11-08). The rate for the period and
// per lorry, driver and region; every figure opens the orders behind it. Worked out on
// the server (GET /logistic-overview/on-time); this only renders.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Panel, Th, Td } from "../../components/scm-v2/OverviewKit";
import { Tile } from "../../components/scm-v2/Charts";
import { DrillDrawer, col, type Drill } from "../../components/scm-v2/DrillDrawer";
import { ON_TIME_LABEL, ratePctText, type OnTimeData, type OnTimeGroup, type OnTimeOrder, type OnTimeResult } from "../../vendor/scm/lib/on-time-queries";

const daysText = (o: OnTimeOrder) => (o.result === "ON_TIME" ? "0" : o.result === "EARLY" ? `${-o.daysLate} early` : `${o.daysLate} late`);

function GroupTable({ title, rows, onPick }: { title: string; rows: OnTimeGroup[]; onPick: (g: OnTimeGroup) => void }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[12px] font-semibold text-ink">{title}</div>
      {rows.length === 0 ? <p className="text-[12px] text-ink-muted">Nothing delivered.</p> : (
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr><Th left>{title.replace(/^By /, "")}</Th><Th>Delivered</Th><Th>On-time rate</Th><Th>Late</Th><Th>Late, not delivered</Th></tr></thead>
            <tbody>{rows.map((g) => (
              <tr key={g.key} onClick={() => onPick(g)} className="cursor-pointer hover:bg-surface-2/50">
                <Td left className={g.key === "Not recorded" ? "text-ink-muted" : "text-primary"}>{g.key}</Td>
                <Td>{g.delivered}</Td>
                <Td className={g.ratePct != null && g.ratePct < 80 ? "font-semibold text-err" : ""}>{ratePctText(g.ratePct)}</Td>
                <Td className={g.late ? "text-err" : ""}>{g.late}</Td>
                <Td className={g.lateOpen ? "text-warning-text" : ""}>{g.lateOpen}</Td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function LogisticOnTimeSection({ data, loading, error }: { data: OnTimeData | null; loading: boolean; error: string | null }) {
  const navigate = useNavigate();
  const [drill, setDrill] = useState<Drill<OnTimeOrder> | null>(null);
  const open = (title: string, keep: (o: OnTimeOrder) => boolean) => setDrill({
    title, subtitle: data ? `${data.from} – ${data.to}` : "", rowKey: (o) => o.soDocNo, groupBy: null,
    rows: (data?.orders ?? []).filter(keep), onRow: (o) => navigate(`/scm/sales-orders/${o.soDocNo}`),
    columns: [
      col<OnTimeOrder>("Result", true, (o) => ON_TIME_LABEL[o.result], (o) => ON_TIME_LABEL[o.result], null, null),
      col<OnTimeOrder>("SO", true, (o) => <span className="text-primary">{o.soDocNo}</span>, (o) => o.soDocNo, null, null),
      col<OnTimeOrder>("Customer", true, (o) => o.customer ?? "—", (o) => o.customer ?? "", null, null),
      col<OnTimeOrder>("Promised", false, (o) => o.promised, null, null, null),
      col<OnTimeOrder>("Delivered", false, (o) => o.delivered ?? "—", null, null, null),
      col<OnTimeOrder>("Days", false, (o) => <span className={o.daysLate > 0 ? "text-err" : ""}>{daysText(o)}</span>, null, null, null),
      col<OnTimeOrder>("Lorry", true, (o) => o.lorry ?? "—", (o) => o.lorry ?? "", null, null),
      col<OnTimeOrder>("Driver", true, (o) => o.driver ?? "—", (o) => o.driver ?? "", null, null),
    ],
  });
  const byResult = (r: OnTimeResult) => (o: OnTimeOrder) => o.result === r;
  const groupKeep = (field: "lorry" | "driver" | "region", g: OnTimeGroup) => (o: OnTimeOrder) => (o[field] ?? "Not recorded") === g.key;
  const ex = data?.excluded;
  const left = ex ? [ex.offPeninsula && `${ex.offPeninsula} East Malaysia / Singapore`, ex.noPromise && `${ex.noPromise} with no delivery date`, ex.noDeliveryTime && `${ex.noDeliveryTime} closed with no delivery time`].filter(Boolean) : [];

  return (
    <Panel title="On-time delivery" hint="delivered on the promised date (amended date, else the customer's) · Malaysia date of the delivery · on-time rate = (on time + early) / delivered · click a figure for its orders">
      {error && <p className="text-[12.5px] text-err">Could not load: {error}</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="On-time rate" tone={data?.ratePct != null && data.ratePct < 80 ? "bad" : "good"} trend={null} onClick={() => open("Delivered in the period", (o) => o.result !== "LATE_OPEN")}
          value={loading ? "…" : ratePctText(data?.ratePct ?? null)} note={data ? `${data.onTime + data.early} of ${data.delivered} delivered` : ""} />
        <Tile label="On time" tone="good" trend={null} onClick={() => open("On time", byResult("ON_TIME"))} value={loading ? "…" : String(data?.onTime ?? 0)} note="on the promised date" />
        <Tile label="Early" tone="main" trend={null} onClick={() => open("Early", byResult("EARLY"))} value={loading ? "…" : String(data?.early ?? 0)} note="before the promised date" />
        <Tile label="Late" tone="bad" trend={null} onClick={() => open("Late", byResult("LATE"))} value={loading ? "…" : String(data?.late ?? 0)} note="after the promised date" />
        <Tile label="Late, not delivered" tone="warn" trend={null} onClick={() => open("Late, not delivered", byResult("LATE_OPEN"))} value={loading ? "…" : String(data?.lateOpen ?? 0)} note="past the promised date · not in the rate" />
      </div>
      {data && (
        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <GroupTable title="By lorry" rows={data.byLorry} onPick={(g) => open(`Lorry · ${g.key}`, groupKeep("lorry", g))} />
          <GroupTable title="By driver" rows={data.byDriver} onPick={(g) => open(`Driver · ${g.key}`, groupKeep("driver", g))} />
          <GroupTable title="By region" rows={data.byRegion} onPick={(g) => open(`Region · ${g.key}`, groupKeep("region", g))} />
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-muted">
        East Malaysia and Singapore are left out, as on Last Mile.{left.length ? ` Left out this period: ${left.join(" · ")}.` : ""} Lorry and driver are from the latest delivery order's crew, else its lorry run.
      </p>
      <DrillDrawer drill={drill} onClose={() => setDrill(null)} />
    </Panel>
  );
}
