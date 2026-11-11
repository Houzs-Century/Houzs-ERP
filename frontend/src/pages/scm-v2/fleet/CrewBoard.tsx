// Coverage & Fleet, Drivers and Helpers (owner 2026-11-07, the design): one list per crew
// kind with who employs them, the lorry they usually crew, the warehouse they work from,
// their leave and whether they are active. A click opens the person's drawer.
import { useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import { formatPhone } from "@2990s/shared/phone";
import { todayMY } from "../../../vendor/shared/format";
import { useDrivers, type DriverRow } from "../../../vendor/scm/lib/drivers-queries";
import { useHelpers, type HelperRow } from "../../../vendor/scm/lib/helpers-queries";
import { useLorries } from "../../../vendor/scm/lib/lorries-queries";
import { useWarehouses } from "../../../vendor/scm/lib/inventory-queries";
import { useThreePLCompanies } from "../../../vendor/scm/lib/threepl-companies-queries";
import { useDriverLeave } from "../../../vendor/scm/lib/delivery-zones-queries";
import {
  crewMatches, driverAsCrew, employerLabel, helperAsCrew, initials, leaveOf, leaveSummary, lorriesOf,
  type CrewKind, type CrewPerson,
} from "./crewModel";
import { CrewDrawer } from "./CrewDrawer";
import { Chip, ListToolbar, NoMatch, Segmented, exportCsv } from "./ui";

export const DriversSection = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const q = useDrivers({ includeInactive });
  const people = useMemo(() => (q.data ?? []).map((d: DriverRow) => driverAsCrew(d)), [q.data]);
  return <CrewBoard kind="driver" people={people} loading={q.isLoading} failed={q.isError} includeInactive={includeInactive} onIncludeInactive={setIncludeInactive} />;
};

export const HelpersSection = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const q = useHelpers({ includeInactive });
  const people = useMemo(() => (q.data ?? []).map((h: HelperRow) => helperAsCrew(h)), [q.data]);
  return <CrewBoard kind="helper" people={people} loading={q.isLoading} failed={q.isError} includeInactive={includeInactive} onIncludeInactive={setIncludeInactive} />;
};

const Plate = ({ plate }: { plate: string }) => (
  <span className="rounded-md bg-[#1d2420] px-1.5 py-0.5 font-mono text-[12px] tracking-wider text-white">{plate}</span>
);

function CrewBoard({ kind, people, loading, failed, includeInactive, onIncludeInactive }: {
  kind: CrewKind; people: CrewPerson[]; loading: boolean; failed: boolean;
  includeInactive: boolean; onIncludeInactive: (v: boolean) => void;
}) {
  const lorries = useLorries();
  const warehouses = useWarehouses();
  const carriers = useThreePLCompanies();
  const leave = useDriverLeave();
  const [q, setQ] = useState("");
  const [who, setWho] = useState<"all" | "in" | "out">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const today = todayMY();
  const noun = kind === "driver" ? "driver" : "helper";
  const title = kind === "driver" ? "Drivers" : "Helpers";

  const ws = useMemo(() => (warehouses.data ?? []).map((w) => ({ id: w.id, code: w.code, name: w.name })), [warehouses.data]);
  const whName = useMemo(() => new Map(ws.map((w) => [w.id, w.name])), [ws]);
  const carrierName = useMemo(() => { const m = new Map((carriers.data ?? []).map((c) => [c.id, c.name])); return (id: string) => m.get(id) ?? null; }, [carriers.data]);
  const rows = useMemo(() => people.map((p) => {
    const plates = lorriesOf(lorries.data ?? [], kind, p.id).map((l) => l.plate);
    const home = p.warehouseId ? whName.get(p.warehouseId) ?? "" : "";
    return { p, plates, home, employer: employerLabel(p, carrierName), leave: leaveSummary(leaveOf(leave.data ?? [], kind, p.id), today) };
  }), [people, lorries.data, kind, whName, carrierName, leave.data, today]);
  const shown = rows.filter((r) => (who === "all" || (who === "in") === r.p.inHouse) && crewMatches(r.p, q, [...r.plates, r.home, r.employer]));
  const open = openId ? people.find((p) => p.id === openId) ?? null : null;

  const doExport = () => exportCsv(`${title.toLowerCase()}.csv`, shown, [
    { key: "code", label: "Code", getValue: (r) => r.p.code },
    { key: "name", label: "Name", getValue: (r) => r.p.name },
    { key: "phone", label: "Phone", getValue: (r) => r.p.phone },
    { key: "ic", label: "IC number", getValue: (r) => r.p.ic },
    ...(kind === "driver" ? [{ key: "vehicle", label: "Vehicle", getValue: (r: (typeof shown)[number]) => r.p.vehicle }] : []),
    { key: "employer", label: "Who employs", getValue: (r) => r.employer },
    { key: "lorry", label: "Usual lorry", getValue: (r) => r.plates.join(", ") },
    { key: "home", label: "Works from", getValue: (r) => r.home },
    { key: "leave", label: "Leave", getValue: (r) => r.leave?.text ?? "" },
    { key: "active", label: "Active", getValue: (r) => (r.p.active ? "Active" : "Inactive") },
  ]);

  return (
    <section className="space-y-3">
      <ListToolbar search={q} onSearch={setQ} placeholder="Search name, code, phone or lorry" shown={shown.length} total={people.length}
        onExport={doExport} newLabel={`New ${noun}`} onNew={() => setCreating(true)}
        filters={<>
          <Segmented label="Who employs" value={who} onChange={setWho} options={[["all", "All"], ["in", "In-house"], ["out", "Outsource"]] as const} />
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink"><input type="checkbox" checked={includeInactive} onChange={(e) => onIncludeInactive(e.target.checked)} />Show inactive</label>
        </>} />
      {failed && <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The {noun} list could not be loaded.</p>}
      {loading && <p className="text-[13px] text-ink-muted">Loading {noun}s…</p>}
      {!loading && !failed && shown.length === 0 && (
        <NoMatch text={people.length === 0 ? `This list came back with no ${noun}s.` : `No ${noun} matches this search.`}
          onClear={people.length === 0 ? null : () => { setQ(""); setWho("all"); }} />
      )}
      {shown.length > 0 && (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface md:block">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead className="bg-surface-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                <tr>{["Name", "Phone", "Who employs", kind === "driver" ? "Usually drives" : "Usually rides in", "Works from", "Leave", "Status"].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
              </thead>
              <tbody>
                {shown.map(({ p, plates, home, employer, leave: lv }) => (
                  <tr key={p.id} onClick={() => setOpenId(p.id)} className={cn("cursor-pointer border-t border-border-subtle hover:bg-surface-2/60", !p.active && "opacity-60")}>
                    <td className="px-3 py-2.5">
                      <button type="button" onClick={(e) => { e.stopPropagation(); setOpenId(p.id); }} className="text-left">
                        <span className="block font-semibold text-primary underline decoration-primary/30 underline-offset-2">{p.name}</span>
                        <span className="block text-[12px] text-ink-muted">{p.code}{kind === "driver" && p.vehicle ? ` · ${p.vehicle}` : ""}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-ink">{p.phone ? formatPhone(p.phone) : "—"}</td>
                    <td className="px-3 py-2.5"><Chip tone={p.inHouse ? "green" : "orange"}>{employer}</Chip></td>
                    <td className="px-3 py-2.5">{plates.length ? <span className="flex flex-wrap gap-1">{plates.map((pl) => <Plate key={pl} plate={pl} />)}</span> : <span className="text-ink-muted">None</span>}</td>
                    <td className="px-3 py-2.5 text-ink">{home || <span className="text-ink-muted">Not set</span>}</td>
                    <td className="px-3 py-2.5">{lv ? <Chip tone={lv.now ? "amber" : "blue"}>{lv.text}</Chip> : <span className="text-ink-muted">—</span>}</td>
                    <td className="px-3 py-2.5"><Chip tone={p.active ? "green" : "grey"}>{p.active ? "Active" : "Inactive"}</Chip></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 md:hidden">
            {shown.map(({ p, plates, home, employer, leave: lv }) => (
              <button key={p.id} type="button" onClick={() => setOpenId(p.id)}
                className={cn("flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-3 text-left", !p.active && "opacity-60")}>
                <span className="flex w-full items-center gap-2">
                  <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-primary-soft text-[12px] font-semibold text-primary">{initials(p.name)}</span>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{p.name}</span>
                  {plates[0] && <Plate plate={plates[0]} />}
                </span>
                <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-muted">
                  {p.code} · {home || "No warehouse"}
                  <Chip tone={p.inHouse ? "green" : "orange"}>{employer}</Chip>
                  <Chip tone={p.active ? "green" : "grey"}>{p.active ? "Active" : "Inactive"}</Chip>
                </span>
                {lv && <span><Chip tone={lv.now ? "amber" : "blue"}>{lv.text}</Chip></span>}
              </button>
            ))}
          </div>
        </>
      )}
      {(open || creating) && (
        <CrewDrawer kind={kind} person={creating ? null : open} lorries={lorries.data ?? []} warehouses={ws} carriers={carriers.data ?? []}
          leave={leave.data ?? []} onClose={() => { setOpenId(null); setCreating(false); }} />
      )}
    </section>
  );
}
