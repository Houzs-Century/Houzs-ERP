// Project Overview · Venue rent (owner 2026-10-23): what each venue costs per
// square metre (the booth size is keyed in m2, as on the event page) and per day, and - click a venue - what each operator (organizer)
// charges there, to see who charges the most. Events of the period with a
// rental and a booth size.
import { Fragment, useState } from "react";
import { Panel, SortTh, Td, useTableSort } from "../../components/scm-v2/OverviewKit";
import { formatCurrency, cn } from "../../lib/utils";
import { figuresOf, type OvProject } from "./projectOverviewModel";

const money = (n: number | null) => (n == null ? "—" : formatCurrency(n));
const days = (p: OvProject) => {
  if (!p.startDate) return 0;
  const a = Date.parse(`${p.startDate}T00:00:00Z`); const b = Date.parse(`${(p.endDate ?? p.startDate)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 86400000) + 1 : 0;
};

type Row = { key: string; events: number; rent: number; sqm: number; sqmDays: number; eventDays: number };
const rowOf = (key: string, ps: OvProject[]): Row => {
  const r: Row = { key, events: 0, rent: 0, sqm: 0, sqmDays: 0, eventDays: 0 };
  for (const p of ps) {
    const rent = figuresOf(p).rental; const sqm = p.sizeSqm ?? 0; const d = days(p);
    r.events += 1; r.rent += rent; r.sqm += sqm; r.sqmDays += sqm * d; r.eventDays += d;
  }
  return r;
};
/* Totals over totals, so a big booth weighs what it costs. */
const perSqm = (r: Row) => (r.sqm > 0 ? r.rent / r.sqm : null);
const perSqmDay = (r: Row) => (r.sqmDays > 0 ? r.rent / r.sqmDays : null);
const perDay = (r: Row) => (r.eventDays > 0 ? r.rent / r.eventDays : null);
const perEvent = (r: Row) => (r.events > 0 ? r.rent / r.events : null);
const value = (r: Row, k: string) =>
  k === "key" ? r.key : k === "events" ? r.events : k === "perEvent" ? perEvent(r) : k === "perSqm" ? perSqm(r) : k === "perSqmDay" ? perSqmDay(r) : perDay(r);

function cells(r: Row) {
  return <>
    <Td>{r.events}</Td><Td>{money(perEvent(r))}</Td>
    <Td className="font-semibold">{money(perSqm(r))}</Td><Td>{money(perSqmDay(r))}</Td><Td>{money(perDay(r))}</Td>
  </>;
}

export function VenueRentPanel({ projects, periodLabel }: { projects: OvProject[]; periodLabel: string }) {
  const usable = projects.filter((p) => p.venue && (p.sizeSqm ?? 0) > 0 && figuresOf(p).rental > 0 && days(p) > 0);
  const byVenue = new Map<string, OvProject[]>();
  for (const p of usable) byVenue.set(p.venue!.trim().toUpperCase(), [...(byVenue.get(p.venue!.trim().toUpperCase()) ?? []), p]);
  const venues = [...byVenue.entries()].map(([k, ps]) => rowOf(k, ps)).sort((a, b) => b.events - a.events);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const shown = all ? venues : venues.slice(0, 10);
  const { sorted, sort, toggle } = useTableSort(shown, value);
  const skipped = projects.filter((p) => p.venue && figuresOf(p).rental > 0 && !((p.sizeSqm ?? 0) > 0)).length;
  return (
    <Panel title="Venue rent" hint={`${periodLabel} · events with a rental and a booth size · most visited first · click a venue for each operator there · click a header to rank`}
      right={venues.length > 10 ? <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setAll(!all)}>{all ? "Top 10" : `All ${venues.length} venues`}</button> : null}>
      <table className="w-full border-collapse">
        <thead><tr>
          <SortTh left k="key" sort={sort} onSort={toggle}>Venue / operator</SortTh><SortTh k="events" sort={sort} onSort={toggle}>Events</SortTh>
          <SortTh k="perEvent" sort={sort} onSort={toggle}>Rent per event</SortTh><SortTh k="perSqm" sort={sort} onSort={toggle}>Rent per m²</SortTh>
          <SortTh k="perSqmDay" sort={sort} onSort={toggle}>Per m² per day</SortTh><SortTh k="perDay" sort={sort} onSort={toggle}>Rent per day</SortTh>
        </tr></thead>
        <tbody>{sorted.map((v) => {
          const isOpen = open === v.key;
          const ops = isOpen ? [...new Map(byVenue.get(v.key)!.map((p) => [(p.organizer ?? "—").trim(), 0])).keys()]
            .map((o) => rowOf(o, byVenue.get(v.key)!.filter((p) => (p.organizer ?? "—").trim() === o)))
            .sort((a, b) => (perSqm(b) ?? 0) - (perSqm(a) ?? 0)) : [];
          return (
            <Fragment key={v.key}>
              <tr className={cn("cursor-pointer hover:bg-surface-2/50", isOpen && "bg-primary-soft/50")} onClick={() => setOpen(isOpen ? null : v.key)}>
                <Td left className="max-w-[320px] truncate font-medium">{isOpen ? "▾ " : "▸ "}{v.key}</Td>{cells(v)}
              </tr>
              {ops.map((o) => (
                <tr key={`${v.key}|${o.key}`} className="bg-surface-2/30">
                  <Td left className="max-w-[320px] truncate pl-8 text-ink-secondary">{o.key}</Td>{cells(o)}
                </tr>
              ))}
            </Fragment>
          );
        })}
          {venues.length === 0 && <tr><Td left className="text-ink-muted">No event in this period has both a rental and a booth size.</Td></tr>}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-ink-muted">Rent per m² = the venue&apos;s total rent ÷ total booth area (m², as keyed on the event); per day uses the event&apos;s days, start to end. Operators under a venue: dearest per m² first.{skipped ? ` ${skipped} event${skipped === 1 ? "" : "s"} with a rental but no booth size are left out.` : ""}</p>
    </Panel>
  );
}
