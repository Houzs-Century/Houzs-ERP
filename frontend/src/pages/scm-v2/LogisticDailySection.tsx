// Logistic Overview · day by day and by region (owner, 2026-10-17): per day the
// orders delivered, their amount, the average order, how many lorries went out
// and the average a lorry carried; per region the same money in one table.
import { useState } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { Th, Td, Panel, Toggle } from "../../components/scm-v2/OverviewKit";
import { Columns, PALETTE, TONE } from "../../components/scm-v2/Charts";

export type DayRow = { date: string; orders: number; amountSen: number; avgOrderSen: number | null; lorries: number; lorryOrders: number; perLorrySen: number | null };
export type RegionRow = { region: string; orders: number; amountSen: number; avgOrderSen: number | null };
export type LorryRow = { lorry: string; internal: boolean; daysOut: number; fairTrips: number; stockTrips: number; usedDays: number; trips: number; otherTrips: number; doOrders: number; serviceOrders: number; workingDays: number; downDays: number; occupancyPct: number | null; orders: number; amountSen: number; perDayOutSen: number | null };
export type LorryDay = { date: string; lorry: string; orders: number; amountSen: number };
/** Open the delivery orders behind a figure (title, which DOs). */
export type DoDrill = (title: string, keep: (d: { date: string; region: string; lorry: string | null }) => boolean) => void;

const dd = (d: string) => d.slice(5).replace("-", "/");
const money = (x: number | null) => (x == null ? "—" : fmtSen(x));
/** Capacity: 100% and over is a lorry earning its day, under is not (owner 2026-11-07). */
export const capacityTone = (pct: number | null) => ((pct ?? 0) >= 100 ? TONE.good : TONE.bad);

export function LogisticDailySection({ days, regions, region, setRegion, day, setDay, onDrill }: { days: DayRow[]; regions: RegionRow[]; region: string | null; setRegion: (r: string | null) => void; day: string | null; setDay: (d: string | null) => void; onDrill: DoDrill }) {
  const [by, setBy] = useState<"amount" | "orders">("amount");
  const amt = by === "amount";
  const shown = days.filter((x) => x.orders);
  const tot = days.reduce((a, x) => ({ orders: a.orders + x.orders, amountSen: a.amountSen + x.amountSen, lorries: a.lorries + x.lorries, lorryOrders: a.lorryOrders + x.lorryOrders }), { orders: 0, amountSen: 0, lorries: 0, lorryOrders: 0 });
  const lorrySen = days.reduce((a, x) => a + (x.perLorrySen ?? 0) * x.lorries, 0);
  const regionTotal = regions.reduce((a, r) => a + r.amountSen, 0);
  const regionMax = Math.max(1, ...regions.map((r) => (amt ? r.amountSen : r.orders)));
  return (
    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <Panel title={region ? `Day by day · ${region}` : "Day by day"} hint="delivery orders issued each day · click a day or a region and the page follows it"
        right={<span className="flex items-center gap-2">
          {region && <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setRegion(null)}>All regions</button>}
          {day && <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => onDrill(`Delivered on ${day}${region ? ` · ${region}` : ""}`, (d) => d.date === day && (!region || d.region === region))}>See orders</button>}
          {day && <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setDay(null)}>All days</button>}
          <Toggle value={by} options={[["amount", "By amount"], ["orders", "By orders"]]} onChange={setBy} />
        </span>}>
        <Columns axes={false} valueLabels={by === "orders"} height={190} stacked={false} format={by === "orders" ? (x) => `${x} orders` : fmtSen} highlight={null}
          labels={days.map((x) => dd(x.date))}
          series={[{ name: amt ? "Delivered amount" : "Orders delivered", color: TONE.good }]}
          values={[days.map((x) => (amt ? x.amountSen : x.orders))]}
          line={amt ? [
            { name: "Average order", color: PALETTE[1]!, values: days.map((x) => x.avgOrderSen), format: fmtSen },
            { name: "Average per delivery lorry", color: PALETTE[2]!, values: days.map((x) => x.perLorrySen), format: fmtSen },
          ] : null} />
        <div className="mt-3 max-h-[340px] overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr>
              <Th left>Date</Th><Th>Orders</Th><Th>Delivered amount</Th><Th>Average order</Th><Th>Delivery lorries</Th><Th>Average per delivery lorry</Th>
            </tr></thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.date} className={cn("cursor-pointer hover:bg-surface-2/50", day === x.date && "bg-primary-soft/50")} onClick={() => setDay(day === x.date ? null : x.date)}>
                  <Td left>{x.date}</Td><Td>{x.orders}</Td><Td>{fmtSen(x.amountSen)}</Td><Td>{money(x.avgOrderSen)}</Td>
                  <Td>{x.lorries || "—"}</Td><Td>{money(x.perLorrySen)}</Td>
                </tr>
              ))}
              {shown.length === 0 && <tr><Td left className="text-ink-muted">Nothing delivered in this period.</Td></tr>}
              {shown.length > 0 && (
                <tr className="font-semibold">
                  <Td left>Total</Td><Td>{tot.orders}</Td><Td>{fmtSen(tot.amountSen)}</Td>
                  <Td>{tot.orders ? fmtSen(Math.round(tot.amountSen / tot.orders)) : "—"}</Td>
                  <Td>{tot.lorries ? `${tot.lorries} lorry-days` : "—"}</Td><Td>{tot.lorries ? fmtSen(Math.round(lorrySen / tot.lorries)) : "—"}</Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] text-ink-muted">
          Average per delivery lorry = the day&apos;s KL, Southern and Northern orders whose lorry is known, divided by the lorries that carried them. East Malaysia goes out trip by trip and is not counted. Other jobs are not counted.
          {tot.lorryOrders < tot.orders && ` The lorry is recorded on ${tot.lorryOrders} of ${tot.orders} delivery orders; it fills in as the crew and lorry are set on each DO (or the DO is put on a lorry run).`}
        </p>
      </Panel>

      <Panel title="By region" hint="the customer's state, in Delivery Planning's regions · click a region and the whole page follows it">
        <table className="w-full border-collapse">
          <thead><tr><Th left>Region</Th><Th left> </Th><Th>Orders</Th><Th>Amount</Th><Th>Share</Th><Th>Average order</Th></tr></thead>
          <tbody>
            {regions.map((r, i) => (
              <tr key={r.region} className={cn("cursor-pointer hover:bg-surface-2/50", region === r.region && "bg-primary-soft/50")} onClick={() => setRegion(region === r.region ? null : r.region)}>
                <Td left>{r.region}</Td>
                <Td left className="w-[28%]">
                  <div className="h-2 rounded-full bg-surface-2"><div className="h-2 rounded-full" style={{ width: `${((amt ? r.amountSen : r.orders) / regionMax) * 100}%`, background: PALETTE[i % PALETTE.length] }} /></div>
                </Td>
                <Td>{r.orders}</Td><Td>{fmtSen(r.amountSen)}</Td>
                <Td className="text-ink-secondary">{regionTotal ? `${Math.round((r.amountSen / regionTotal) * 100)}%` : "—"}</Td>
                <Td>{money(r.avgOrderSen)}</Td>
              </tr>
            ))}
            {regions.length === 0 && <tr><Td left className="text-ink-muted">Nothing delivered in this period.</Td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

/* Each lorry's revenue and occupancy: delivery days earn the revenue, days in use
   show how full it is, both over the days it could work (Sundays and workshop days
   off). Our own lorries carry a fixed crew and instalment, so every working day one
   stays in costs money. */
export function LorrySection({ lorries, days, recorded, total, region, day, onLorry }: { lorries: LorryRow[]; days: LorryDay[]; recorded: number; total: number; region: string | null; day: string | null; onLorry: (plate: string) => void }) {
  const own = lorries.filter((l) => l.internal);
  const ownDays = own.reduce((a, l) => a + l.daysOut, 0);
  const ownTrips = own.reduce((a, l) => a + l.trips, 0);
  const ownOther = own.reduce((a, l) => a + l.otherTrips, 0);
  const scope = [region, day].filter(Boolean).join(" · ");
  const ownPossible = own.reduce((a, l) => a + l.workingDays, 0);
  return (
    <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
      <Panel title={`Lorries · revenue and capacity${scope ? ` · ${scope}` : ""}`} hint="KL, Southern and Northern only · Delivery trip = a day's delivery or service run; under 3 orders (delivery orders and service jobs) it is half a trip · Fair trip = a set-up or dismantle · Stock trip = a supplier pickup or stock transfer, half a trip · Capacity = total trips ÷ days it could work (workshop days off, Sundays only if it went out), and can pass 100% · Per delivery trip = revenue ÷ delivery trips">
        {own.length > 0 && (
          <p className="mb-2 text-[12.5px] text-ink-secondary">
            Our own lorries had <b className="text-ink">{ownPossible}</b> lorry working days: <b className="text-ink">{ownDays}</b> delivery trips and
            {" "}<b className="text-ink">{ownOther}</b> other trips, <b className="text-ink">{ownPossible ? Math.round((ownTrips / ownPossible) * 100) : 0}%</b> capacity used.
          </p>
        )}
        <table className="w-full border-collapse">
          <thead><tr><Th left>Lorry</Th><Th left> </Th><Th>Delivery trips</Th><Th>Fair trips</Th><Th>Stock trips</Th><Th>Total trips</Th><Th>Day in use</Th><Th left>Capacity</Th><Th>Orders</Th><Th>Revenue</Th><Th>Per delivery trip</Th><Th>Per order</Th></tr></thead>
          <tbody>{lorries.map((l) => (
            <tr key={l.lorry} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onLorry(l.lorry)}>
              <Td left className="font-semibold">{l.lorry}</Td>
              <Td left className="text-[11px] text-ink-muted">{l.internal ? "own" : "3PL"}</Td>
              <Td>{l.daysOut}</Td><Td>{l.fairTrips}</Td><Td>{l.stockTrips}</Td><Td className="font-semibold">{l.trips}</Td>
              <Td>{l.usedDays} / {l.workingDays}{l.downDays > 0 && <span className="ml-1 text-[11px] text-warning-text">{l.downDays} in workshop</span>}</Td>
              <Td left className="w-[22%]">
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-surface-2"><div className="h-2 rounded-full" style={{ width: `${Math.min(100, l.occupancyPct ?? 0)}%`, background: capacityTone(l.occupancyPct) }} /></div>
                  <span className="w-12 text-right tabular-nums text-[12px] font-semibold" style={{ color: capacityTone(l.occupancyPct) }}>{l.occupancyPct == null ? "—" : `${l.occupancyPct}%`}</span>
                </div>
              </Td>
              <Td><span title={`${l.doOrders} delivery orders + ${l.serviceOrders} service jobs`}>{l.orders}</span></Td><Td>{fmtSen(l.amountSen)}</Td><Td>{money(l.perDayOutSen)}</Td><Td>{l.orders ? fmtSen(Math.round(l.amountSen / l.orders)) : "—"}</Td>
            </tr>
          ))}
            {lorries.length === 0 && <tr><Td left className="text-ink-muted">No lorry recorded in this period.</Td></tr>}
          </tbody>
        </table>
        {recorded < total && <p className="mt-2 text-[11.5px] text-warning-text">The lorry is recorded on {recorded} of {total} delivery orders in this period, so these figures read low until the crew and lorry are set on each DO.</p>}
      </Panel>
      <Panel title="Each lorry, each day" hint="orders and revenue a lorry carried on a day">
        {days.length === 0 ? <p className="text-[12.5px] text-ink-muted">No delivery order in this period has its lorry recorded yet.</p> : (
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-surface"><tr><Th left>Date</Th><Th left>Lorry</Th><Th>Orders</Th><Th>Revenue</Th></tr></thead>
              <tbody>{days.map((x) => <tr key={`${x.date}-${x.lorry}`} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onLorry(x.lorry)}><Td left>{x.date}</Td><Td left>{x.lorry}</Td><Td>{x.orders}</Td><Td>{fmtSen(x.amountSen)}</Td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
