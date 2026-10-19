// Logistic Overview · day by day and by region (owner, 2026-10-17): per day the
// orders delivered, their amount, the average order, how many lorries went out
// and the average a lorry carried; per region the same money in one table.
import { useState } from "react";
import { fmtSen } from "../../vendor/shared/format";
import { Th, Td, Panel, Toggle } from "../../components/scm-v2/OverviewKit";
import { Columns, PALETTE, TONE } from "../../components/scm-v2/Charts";

export type DayRow = { date: string; orders: number; amountSen: number; avgOrderSen: number | null; lorries: number; lorryOrders: number; perLorrySen: number | null };
export type RegionRow = { region: string; orders: number; amountSen: number; avgOrderSen: number | null };
export type LorryRow = { lorry: string; internal: boolean; daysOut: number; workingDays: number; occupancyPct: number | null; orders: number; amountSen: number; perDayOutSen: number | null };
export type LorryDay = { date: string; lorry: string; orders: number; amountSen: number };
/** Open the delivery orders behind a figure (title, which DOs). */
export type DoDrill = (title: string, keep: (d: { date: string; region: string; lorry: string | null }) => boolean) => void;

const dd = (d: string) => d.slice(5).replace("-", "/");
const money = (x: number | null) => (x == null ? "—" : fmtSen(x));

export function LogisticDailySection({ days, regions, onDrill }: { days: DayRow[]; regions: RegionRow[]; onDrill: DoDrill }) {
  const [by, setBy] = useState<"amount" | "orders">("amount");
  const amt = by === "amount";
  const shown = days.filter((x) => x.orders);
  const tot = days.reduce((a, x) => ({ orders: a.orders + x.orders, amountSen: a.amountSen + x.amountSen, lorries: a.lorries + x.lorries, lorryOrders: a.lorryOrders + x.lorryOrders }), { orders: 0, amountSen: 0, lorries: 0, lorryOrders: 0 });
  const lorrySen = days.reduce((a, x) => a + (x.perLorrySen ?? 0) * x.lorries, 0);
  const regionTotal = regions.reduce((a, r) => a + r.amountSen, 0);
  const regionMax = Math.max(1, ...regions.map((r) => (amt ? r.amountSen : r.orders)));
  return (
    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <Panel title="Day by day" hint="delivery orders issued each day · click a day for its orders"
        right={<Toggle value={by} options={[["amount", "By amount"], ["orders", "By orders"]]} onChange={setBy} />}>
        <Columns valueLabels={!amt} height={190} stacked={false} format={amt ? fmtSen : (x) => `${x} orders`} highlight={null}
          labels={days.map((x) => dd(x.date))}
          series={[{ name: amt ? "Delivered amount" : "Orders delivered", color: TONE.good }]}
          values={[days.map((x) => (amt ? x.amountSen : x.orders))]}
          line={amt ? { name: "Average order", color: PALETTE[1]!, values: days.map((x) => x.avgOrderSen), format: fmtSen } : null} />
        <div className="mt-3 max-h-[340px] overflow-y-auto">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-surface"><tr>
              <Th left>Date</Th><Th>Orders</Th><Th>Delivered amount</Th><Th>Average order</Th><Th>Lorries</Th><Th>Average per lorry</Th>
            </tr></thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.date} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onDrill(`Delivered on ${x.date}`, (d) => d.date === x.date)}>
                  <Td left>{x.date}</Td><Td>{x.orders}</Td><Td>{fmtSen(x.amountSen)}</Td><Td>{money(x.avgOrderSen)}</Td>
                  <Td>{x.lorries || "—"}</Td><Td>{money(x.perLorrySen)}</Td>
                </tr>
              ))}
              {shown.length === 0 && <tr><Td left className="text-ink-muted">Nothing delivered in this period.</Td></tr>}
              {shown.length > 0 && (
                <tr className="font-semibold">
                  <Td left>Total</Td><Td>{tot.orders}</Td><Td>{fmtSen(tot.amountSen)}</Td>
                  <Td>{tot.orders ? fmtSen(Math.round(tot.amountSen / tot.orders)) : "—"}</Td>
                  <Td>{tot.lorries || "—"}</Td><Td>{tot.lorries ? fmtSen(Math.round(lorrySen / tot.lorries)) : "—"}</Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] text-ink-muted">
          Average per lorry = the day&apos;s orders whose lorry is known, divided by the lorries that went out.
          {tot.lorryOrders < tot.orders && ` The lorry is recorded on ${tot.lorryOrders} of ${tot.orders} delivery orders; it fills in as the crew and lorry are set on each DO (or the DO is put on a lorry run).`}
        </p>
      </Panel>

      <Panel title="By region" hint="the customer's state, in Delivery Planning's regions · click a region for its orders">
        <table className="w-full border-collapse">
          <thead><tr><Th left>Region</Th><Th left> </Th><Th>Orders</Th><Th>Amount</Th><Th>Share</Th><Th>Average order</Th></tr></thead>
          <tbody>
            {regions.map((r, i) => (
              <tr key={r.region} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onDrill(`Delivered to ${r.region}`, (d) => d.region === r.region)}>
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

/* Each lorry's revenue and occupancy (owner 2026-10-17): days it went out over
   the working days so far (Sundays off). Our own lorries carry a fixed crew
   and instalment, so every working day one stays in costs money. */
export function LorrySection({ lorries, days, recorded, total, onDrill }: { lorries: LorryRow[]; days: LorryDay[]; recorded: number; total: number; onDrill: DoDrill }) {
  const own = lorries.filter((l) => l.internal);
  const ownDays = own.reduce((a, l) => a + l.daysOut, 0);
  const ownPossible = own.reduce((a, l) => a + l.workingDays, 0);
  const work = lorries[0]?.workingDays ?? 0;
  return (
    <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
      <Panel title="Lorries · revenue and occupancy" hint={`${work} working days so far in the period (Sundays off) · occupancy = days out ÷ working days`}>
        {own.length > 0 && (
          <p className="mb-2 text-[12.5px] text-ink-secondary">
            Our own lorries went out on <b className="text-ink">{ownDays}</b> of <b className="text-ink">{ownPossible}</b> lorry working days
            ({ownPossible ? Math.round((ownDays / ownPossible) * 100) : 0}% occupied); {ownPossible - ownDays} lorry-days stood idle.
          </p>
        )}
        <table className="w-full border-collapse">
          <thead><tr><Th left>Lorry</Th><Th left> </Th><Th>Days out</Th><Th left>Occupancy</Th><Th>Orders</Th><Th>Revenue</Th><Th>Per day out</Th></tr></thead>
          <tbody>{lorries.map((l) => (
            <tr key={l.lorry} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onDrill(`Carried by ${l.lorry}`, (d) => d.lorry === l.lorry)}>
              <Td left className="font-semibold">{l.lorry}</Td>
              <Td left className="text-[11px] text-ink-muted">{l.internal ? "own" : "3PL"}</Td>
              <Td>{l.daysOut} / {l.workingDays}</Td>
              <Td left className="w-[22%]">
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-surface-2"><div className="h-2 rounded-full" style={{ width: `${Math.min(100, l.occupancyPct ?? 0)}%`, background: (l.occupancyPct ?? 0) >= 80 ? TONE.good : (l.occupancyPct ?? 0) >= 60 ? TONE.warn : TONE.bad }} /></div>
                  <span className="w-12 text-right tabular-nums text-[12px]">{l.occupancyPct == null ? "—" : `${l.occupancyPct}%`}</span>
                </div>
              </Td>
              <Td>{l.orders}</Td><Td>{fmtSen(l.amountSen)}</Td><Td>{money(l.perDayOutSen)}</Td>
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
              <tbody>{days.map((x) => <tr key={`${x.date}-${x.lorry}`} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onDrill(`${x.lorry} on ${x.date}`, (d) => d.lorry === x.lorry && d.date === x.date)}><Td left>{x.date}</Td><Td left>{x.lorry}</Td><Td>{x.orders}</Td><Td>{fmtSen(x.amountSen)}</Td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
