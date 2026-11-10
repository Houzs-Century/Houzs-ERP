// Coverage & Fleet, Lorries (owner 2026-11-07): one card per lorry under the warehouse it
// starts the day at, each drawn to its own box size on one scale. Filters by home and by
// owner, a search, and the lorry drawer on a click.
import { useMemo, useState } from "react";
import { cn } from "../../../lib/utils";
import { fmtSen } from "../../../vendor/shared/format";
import { expiryStatus, type ComplianceTone } from "../../../vendor/shared/lorry-compliance";
import { LORRY_TYPE_LABEL, useLorries, useLorryPositions, type LorryRow } from "../../../vendor/scm/lib/lorries-queries";
import { useDrivers } from "../../../vendor/scm/lib/drivers-queries";
import { useHelpers } from "../../../vendor/scm/lib/helpers-queries";
import { useThreePLCompanies } from "../../../vendor/scm/lib/threepl-companies-queries";
import { useWarehouses } from "../../../vendor/scm/lib/inventory-queries";
import { boxOf, byHome, lorryHome, lorryMatches } from "./lorryModel";
import { LorrySide } from "./Lorry3D";
import { LorryDrawer } from "./LorryDrawer";

const RANK: Record<ComplianceTone, number> = { expired: 4, critical: 3, warning: 2, none: 1, ok: 0 };
const docsTone = (l: LorryRow): ComplianceTone =>
  [l.road_tax_expiry, l.insurance_expiry, l.puspakom_expiry].map((d) => expiryStatus(d ?? null).tone).reduce((a, t) => (RANK[t] > RANK[a] ? t : a), "ok" as ComplianceTone);
const DOC_NOTE: Partial<Record<ComplianceTone, [string, string]>> = {
  expired: ["Document expired", "text-[color:var(--hz-dk-err,#8a2c2c)]"], critical: ["Document due soon", "text-[color:var(--hz-dk-err,#8a2c2c)]"], warning: ["Document due in 45 days", "text-[#80501c]"],
};

export function LorriesBoard({ onNew }: { onNew: () => void }) {
  const [showStopped, setShowStopped] = useState(false);
  const lorries = useLorries({ includeInactive: showStopped });
  const warehouses = useWarehouses();
  const drivers = useDrivers();
  const helpers = useHelpers();
  const carriers = useThreePLCompanies();
  const positions = useLorryPositions();
  const [home, setHome] = useState<string>("all");
  const [owner, setOwner] = useState<"all" | "own" | "3pl">("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const ws = useMemo(() => (warehouses.data ?? []).map((w) => ({ id: w.id, code: w.code, name: w.name })), [warehouses.data]);
  const driverName = useMemo(() => new Map((drivers.data ?? []).map((d) => [d.id, d.name])), [drivers.data]);
  const gpsAt = useMemo(() => new Map((positions.data ?? []).map((p) => [p.lorry_id, p.recorded_at])), [positions.data]);
  const all = lorries.data ?? [];
  const shown = all.filter((l) => (home === "all" || (lorryHome(l) ?? "none") === home)
    && (owner === "all" || (owner === "own") === (l.is_internal !== false))
    && lorryMatches(l, q, l.usual_driver_id ? driverName.get(l.usual_driver_id) ?? null : null));
  const homes = byHome(all, ws);
  const groups = byHome(shown, ws);
  const open = openId ? all.find((l) => l.id === openId) ?? null : null;
  const pill = (on: boolean) => cn("min-h-[34px] rounded-md px-3 text-[12.5px] font-semibold", on ? "bg-surface text-ink shadow-sm" : "text-ink-muted");

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search plate, model or driver" aria-label="Search lorries"
          className="min-h-[40px] min-w-[200px] flex-1 rounded-md border border-border bg-surface px-3 text-[13px]" />
        <div className="flex rounded-lg bg-surface-2 p-0.5">
          <button type="button" className={pill(home === "all")} onClick={() => setHome("all")}>All homes</button>
          {homes.map((h) => <button key={h.homeId ?? "none"} type="button" className={pill(home === (h.homeId ?? "none"))} onClick={() => setHome(h.homeId ?? "none")}>{h.homeId ? h.label.replace(/ WAREHOUSE$/i, "") : "Not set"}</button>)}
        </div>
        <div className="flex rounded-lg bg-surface-2 p-0.5">
          {(["all", "own", "3pl"] as const).map((o) => <button key={o} type="button" className={pill(owner === o)} onClick={() => setOwner(o)}>{{ all: "All", own: "Own fleet", "3pl": "3PL" }[o]}</button>)}
        </div>
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink"><input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} />Show lorries not in use</label>
        <button type="button" onClick={onNew} className="ml-auto min-h-[40px] rounded-md bg-primary px-4 text-[13px] font-semibold text-white">New lorry</button>
      </div>
      <p className="text-[12px] text-ink-muted">Showing {shown.length} of {all.length}</p>
      {lorries.isError && <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">Lorries could not be loaded.</p>}
      {lorries.isLoading && <p className="text-[13px] text-ink-muted">Loading lorries…</p>}
      {!lorries.isLoading && !lorries.isError && shown.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-ink-muted">
          No lorry matches. <button type="button" className="font-semibold text-primary" onClick={() => { setQ(""); setHome("all"); setOwner("all"); }}>Clear</button>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.homeId ?? "none"}>
          <h3 className="mb-2 text-[13px] font-semibold text-ink">{g.label} <span className="font-normal text-ink-muted">· {g.lorries.length}</span></h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.lorries.map((l) => {
              const box = boxOf(l);
              const own = l.is_internal !== false;
              const carrier = (carriers.data ?? []).find((c) => c.id === l.threepl_company_id)?.name;
              const note = DOC_NOTE[docsTone(l)];
              return (
                <button key={l.id} type="button" onClick={() => setOpenId(l.id)}
                  className={cn("rounded-xl border border-border bg-surface p-3 text-left hover:border-primary", !l.active && "opacity-60")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-md bg-[#1d2420] px-2 py-0.5 font-mono text-[13px] tracking-wider text-white">{l.plate}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", gpsAt.has(l.id) ? "bg-[#dcebe3] text-[#1f5c43]" : "bg-surface-2 text-ink-muted")}>{gpsAt.has(l.id) ? "GPS live" : "No GPS"}</span>
                  </div>
                  <div className="mt-1 text-[12px] text-ink-muted">{own ? "Own fleet" : carrier ?? "3PL"} · {LORRY_TYPE_LABEL[l.type]}{l.model ? ` · ${l.model}` : ""}{l.active ? "" : " · Not in use"}</div>
                  <div className="my-1.5"><LorrySide box={box} /></div>
                  <div className="flex flex-wrap gap-x-3 text-[12px] text-ink">
                    {box ? <span>{box.length} × {box.width} × {box.height} ft · {box.m3} m³</span> : <span className="text-[#80501c]">Box size not entered</span>}
                  </div>
                  <div className="mt-1 text-[12px] text-ink-secondary">Up to {l.max_sets ?? 10} sets · {fmtSen(l.max_revenue_sen ?? 3_000_000)}</div>
                  <div className="mt-1 text-[12px] text-ink-secondary">Driver: {l.usual_driver_id ? driverName.get(l.usual_driver_id) ?? "—" : "Not set"}</div>
                  {note && <div className={cn("mt-1 text-[12px] font-semibold", note[1])}>{note[0]}</div>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {open && <LorryDrawer lorry={open} warehouses={ws} drivers={drivers.data ?? []} helpers={helpers.data ?? []} carriers={carriers.data ?? []}
        gpsAt={gpsAt.get(open.id) ?? null} onClose={() => setOpenId(null)} />}
    </section>
  );
}
