// Logistic Overview · day by day, by region and by lorry run (owner,
// 2026-10-17): how much went out and how much was closed delivered each day,
// the average order, lorries and runs per day, the same by region, and every
// lorry run with what it carried. Read by amount or by orders.
import { useState } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { Th, Td, Panel, Toggle } from "../../components/scm-v2/OverviewKit";
import { Columns, HBars, TONE, PALETTE } from "../../components/scm-v2/Charts";

export type DayRow = { date: string; outCount: number; outSen: number; deliveredCount: number; deliveredSen: number; avgOrderSen: number | null; runs: number; lorries: number; runSen: number };
export type RegionRow = { region: string; outCount: number; outSen: number; runs: number; runSen: number; avgOrderSen: number | null; avgRunSen: number | null };
export type RunRow = { id: string; date: string; lorry: string | null; driver: string | null; stops: number; amountSen: number; region: string | null };

const dd = (d: string) => d.slice(5).replace("-", "/");
const money = (x: number | null) => (x == null ? "—" : fmtSen(x));

export function LogisticDailySection({ days, regions, runs }: { days: DayRow[]; regions: RegionRow[]; runs: RunRow[] }) {
  const [by, setBy] = useState<"amount" | "orders">("amount");
  const amt = by === "amount";
  const shown = days.filter((x) => x.outCount || x.deliveredCount || x.runs);
  const tot = days.reduce((a, x) => ({ outCount: a.outCount + x.outCount, outSen: a.outSen + x.outSen, deliveredCount: a.deliveredCount + x.deliveredCount, deliveredSen: a.deliveredSen + x.deliveredSen, runs: a.runs + x.runs, runSen: a.runSen + x.runSen }),
    { outCount: 0, outSen: 0, deliveredCount: 0, deliveredSen: 0, runs: 0, runSen: 0 });
  const lorryDays = days.reduce((a, x) => a + x.lorries, 0);
  return (
    <>
      <Panel title="Day by day" hint="out = DO issued that day · delivered = DO closed delivered that day"
        right={<Toggle value={by} options={[["amount", "By amount"], ["orders", "By orders"]]} onChange={setBy} />}>
        <Columns height={200} stacked={false} format={amt ? fmtSen : (x) => `${x} DO`} highlight={null}
          labels={days.map((x) => dd(x.date))}
          series={[{ name: "Out (DO issued)", color: PALETTE[0]! }, { name: "Delivered", color: TONE.good }]}
          values={[days.map((x) => (amt ? x.outSen : x.outCount)), days.map((x) => (amt ? x.deliveredSen : x.deliveredCount))]}
          line={amt ? { name: "Average order", color: PALETTE[1]!, values: days.map((x) => x.avgOrderSen), format: fmtSen } : null} />
        <div className="mt-3 max-h-[360px] overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr>
              <Th left>Day</Th><Th>DO out</Th><Th>Out amount</Th><Th>Delivered</Th><Th>Delivered amount</Th><Th>Average order</Th><Th>Lorries</Th><Th>Runs</Th><Th>Per lorry run</Th>
            </tr></thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.date}>
                  <Td left>{x.date}</Td><Td>{x.outCount}</Td><Td>{fmtSen(x.outSen)}</Td><Td>{x.deliveredCount}</Td><Td>{fmtSen(x.deliveredSen)}</Td>
                  <Td>{money(x.avgOrderSen)}</Td><Td>{x.lorries || "—"}</Td><Td>{x.runs || "—"}</Td><Td>{x.runs ? fmtSen(Math.round(x.runSen / x.runs)) : "—"}</Td>
                </tr>
              ))}
              {shown.length === 0 && <tr><Td left className="text-ink-muted">Nothing went out in this period.</Td></tr>}
              {shown.length > 0 && (
                <tr className="font-semibold">
                  <Td left>Total</Td><Td>{tot.outCount}</Td><Td>{fmtSen(tot.outSen)}</Td><Td>{tot.deliveredCount}</Td><Td>{fmtSen(tot.deliveredSen)}</Td>
                  <Td>{tot.outCount ? fmtSen(Math.round(tot.outSen / tot.outCount)) : "—"}</Td><Td>{lorryDays || "—"}</Td><Td>{tot.runs || "—"}</Td><Td>{tot.runs ? fmtSen(Math.round(tot.runSen / tot.runs)) : "—"}</Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {tot.runs === 0 && <p className="mt-2 text-[11.5px] text-ink-muted">Lorries and runs fill in once deliveries are planned as lorry runs in Delivery Time Arrangement; until then only the DO money shows.</p>}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="By region" hint="the customer's state, in Delivery Planning's regions">
          <HBars format={amt ? fmtSen : (x) => `${x} DO`} empty="Nothing went out in this period."
            rows={regions.map((r) => ({ key: r.region, label: r.region, value: amt ? r.outSen : r.outCount, color: null, right: amt ? fmtSen(r.outSen) : `${r.outCount} DO`, onClick: null }))} />
          <table className="mt-3 w-full border-collapse">
            <thead><tr><Th left>Region</Th><Th>DO out</Th><Th>Amount</Th><Th>Average order</Th><Th>Runs</Th><Th>Per lorry run</Th></tr></thead>
            <tbody>{regions.map((r) => (
              <tr key={r.region}><Td left>{r.region}</Td><Td>{r.outCount}</Td><Td>{fmtSen(r.outSen)}</Td><Td>{money(r.avgOrderSen)}</Td><Td>{r.runs || "—"}</Td><Td>{money(r.avgRunSen)}</Td></tr>
            ))}</tbody>
          </table>
        </Panel>
        <Panel title="Lorry runs" hint={`${runs.length} runs in the period`}>
          {runs.length === 0 ? <p className="text-[12.5px] text-ink-muted">No lorry runs were planned in this period yet. Each run will list here with its lorry, stops, region and the goods it carried.</p> : (
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-surface"><tr><Th left>Day</Th><Th left>Lorry</Th><Th left>Region</Th><Th>Stops</Th><Th>Carried</Th></tr></thead>
                <tbody>{runs.map((r) => (
                  <tr key={r.id}><Td left>{r.date}</Td><Td left>{r.lorry ?? "—"}</Td><Td left>{r.region ?? "—"}</Td><Td>{r.stops}</Td><Td>{fmtSen(r.amountSen)}</Td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
