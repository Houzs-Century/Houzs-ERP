// Quality Overview · the top (owner, 2026-10-17): cases opened, closed and
// ongoing in the period; where the open cases sit and how old they are; the
// 12-month trend with the backlog; how long each stage takes; and per supplier
// how often their goods come back and how long their cases take.
// Data: GET /api/assr/quality-overview (backend routes/lib/assr-quality.ts).
import type { ReactNode } from "react";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { Panel, Th, Td } from "../components/scm-v2/OverviewKit";
import { Columns, HBars, Tile, TONE, PALETTE } from "../components/scm-v2/Charts";

type Supplier = {
  creditor: string; name: string; cases: number; items: number; receivedQty: number; receivedLines: number;
  perItemPct: number | null; perOrderPct: number | null; open: number; closed: number; avgResolutionDays: number | null;
  stageDays: Record<string, number | null>;
};
type Quality = {
  from: string; to: string; asOf: string; opened: number; closed: number; ongoingNow: number; ongoingAtEnd: number; openedStillOpen: number;
  unattributed: number; avgResolutionDays: number | null; stageDays: Record<string, number | null>;
  ages: Array<{ label: string; count: number }>;
  trend: Array<{ month: string; opened: number; closed: number; backlog: number }>;
  suppliers: Supplier[];
  supplierWindow: { from: string; to: string; cases: number; unattributed: number };
};

const STAGES: Array<[string, string]> = [
  ["pending_review", "Review"], ["under_verification", "Verification"], ["pending_solution", "Solution"],
  ["pending_supplier_pickup", "Pickup / Return"], ["pending_item_ready", "Item ready"], ["pending_delivery_service", "Delivery / Service"],
];
const dayTxt = (x: number | null | undefined) => (x == null ? "—" : `${x} days`);
/* A rate over 100% means the receipts sit under another supplier code (e.g. a
   renamed company), not that every item came back. */
const rateTxt = (x: number | null) => (x == null ? "—" : x > 100 ? "check code" : `${x}%`);

export function QualitySummary({ from, to, periodLabel, breachNow, funnel, onDrill }: {
  from: string; to: string; periodLabel: string; breachNow: number | null; funnel: ReactNode; onDrill: (metric: string) => void;
}) {
  const q = useQuery<Quality>("/api/assr/quality-overview?from=:&to=:", () => api.get(`/api/assr/quality-overview?from=${from}&to=${to}`), [from, to]);
  const d = q.data;
  const v = (x: number | undefined) => (d && x != null ? x.toLocaleString() : "…");
  return (
    <div className="mb-4 space-y-4">
      {q.error && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not load the quality summary: {q.error}</div>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label={`Opened · ${periodLabel}`} value={v(d?.opened)} note={d ? `${d.openedStillOpen} of them still open` : ""} tone="main" trend={null} onClick={() => onDrill("total_period")} />
        <Tile label={`Closed · ${periodLabel}`} value={v(d?.closed)} note="completed in the period" tone="good" trend={null} onClick={() => onDrill("closed_period")} />
        <Tile label="Ongoing now" value={v(d?.ongoingNow)} note="every open case, whenever it was opened" tone="warn" trend={null} onClick={() => onDrill("open_now")} />
        <Tile label="Past SLA now" value={breachNow != null ? breachNow.toLocaleString() : "…"} note="open and past the stage deadline" tone={breachNow ? "bad" : "good"} trend={null} onClick={() => onDrill("breach_now")} />
        <Tile label="Average to close" value={dayTxt(d?.avgResolutionDays)} note={`cases closed in ${periodLabel}, opened to closed`} tone="brass" trend={null} onClick={null} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Panel title="Where the cases are" hint="open cases by stage, with those completed in the period">{funnel}</Panel>
        <Panel title="How old the open cases are" hint="days since the complaint · click to list the cases over a month">
          {d && <Columns height={200} stacked={false} format={(x) => `${x} cases`} highlight={null} line={null}
            labels={d.ages.map((a) => a.label.replace(" days", "d").replace("Over 90d", "90d+"))}
            series={[{ name: "Open cases", color: PALETTE[0]! }]} values={[d.ages.map((a) => a.count)]} />}
          {d && (
            <button type="button" onClick={() => onDrill("over_1_month")} className="mt-2 text-[12px] text-err hover:underline">
              {d.ages.slice(4).reduce((a, x) => a + x.count, 0)} open cases are over a month old
            </button>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Panel title="Monthly trend" hint="cases opened and closed each month · line = still open at month end">
          {d && <Columns height={220} stacked={false} format={(x) => `${x} cases`} highlight={d.trend.length - 1}
            labels={d.trend.map((t) => `${t.month.slice(2, 4)}/${t.month.slice(5)}`)}
            series={[{ name: "Opened", color: "#c9a77c" }, { name: "Closed", color: TONE.good }]}
            values={[d.trend.map((t) => t.opened), d.trend.map((t) => t.closed)]}
            line={{ name: "Still open at month end", color: TONE.bad, values: d.trend.map((t) => t.backlog), format: (x) => `${x} open` }} />}
        </Panel>
        <Panel title="Time spent in each stage" hint={`average days, cases closed in ${periodLabel}`}>
          {d && <HBars format={(x) => `${x} days`} empty="No case closed in this period."
            rows={STAGES.filter(([k]) => d.stageDays[k] != null).map(([k, label]) => ({ key: k, label, value: d.stageDays[k] ?? 0, color: (d.stageDays[k] ?? 0) > 10 ? TONE.bad : (d.stageDays[k] ?? 0) > 5 ? TONE.warn : TONE.good, right: dayTxt(d.stageDays[k]), onClick: null }))} />}
        </Panel>
      </div>

      {d && (
        <Panel title="Suppliers" hint={`cases opened ${d.supplierWindow.from} – ${d.supplierWindow.to} against goods received from the same supplier in that year`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr>
                <Th left>Supplier</Th><Th>Cases</Th><Th>Items in cases</Th><Th>Items received</Th><Th>Defect rate · per item</Th><Th>Per order line</Th>
                <Th>Open</Th><Th>Closed</Th><Th>Average to close</Th>
                {STAGES.map(([k, l]) => <Th key={k}>{l}</Th>)}
              </tr></thead>
              <tbody>{d.suppliers.map((s) => (
                <tr key={s.creditor}>
                  <Td left className="max-w-[220px] truncate">{s.name}</Td><Td>{s.cases}</Td><Td>{s.items}</Td><Td>{s.receivedQty.toLocaleString()}</Td>
                  <Td className={s.perItemPct == null ? "" : s.perItemPct > 100 ? "text-warning-text" : s.perItemPct >= 5 ? "font-semibold text-err" : s.perItemPct >= 2 ? "text-warning-text" : "text-synced"}>{rateTxt(s.perItemPct)}</Td>
                  <Td>{rateTxt(s.perOrderPct)}</Td>
                  <Td>{s.open}</Td><Td>{s.closed}</Td><Td>{dayTxt(s.avgResolutionDays)}</Td>
                  {STAGES.map(([k]) => <Td key={k} className="text-ink-secondary">{s.stageDays[k] != null ? s.stageDays[k] : "—"}</Td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11.5px] text-ink-muted">
            <li>Defect rate per item = items in that supplier&apos;s cases ÷ items received from them. Per order line = cases ÷ PO lines received. Both over the same year, since a defect shows up months after delivery.</li>
            <li>Average to close is per case, opened to closed. The stage columns are the average days a closed case spent in each stage, so you can see which leg is slow.</li>
            <li>&quot;check code&quot; = more items in cases than received under this supplier code — the goods are booked under another code (a renamed or new company). {d.supplierWindow.unattributed} of {d.supplierWindow.cases} cases in the year have no supplier set and are not counted.</li>
          </ul>
        </Panel>
      )}
    </div>
  );
}
