// One lorry (owner 2026-11-07, the Coverage & Fleet design): where it starts the day,
// where else it picks up, who usually drives it, what it carries, its documents and its
// workshop visits. Read first, Edit to change; every field writes the lorry master.
import { fmtDrive, fmtKm, useRoadFigures } from "../../../vendor/scm/lib/lorry-routes-queries";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ResizableDrawer } from "../../../components/ResizableDrawer";
import { cn } from "../../../lib/utils";
import { api } from "../../../api/client";
import { fmtDate, fmtSen } from "../../../vendor/shared/format";
import { DateField } from "../../../vendor/scm/components/DateField";
import { writeFailed, writeFailedAs } from "../../../vendor/scm/lib/mutation-error";
import { useConfirm } from "../../../vendor/scm/components/ConfirmDialog";
import { expiryStatus, type ComplianceTone } from "../../../vendor/shared/lorry-compliance";
import {
  CAPACITY_LAYERS, CAPACITY_LAYER_LABEL, LORRY_TYPES, LORRY_TYPE_LABEL,
  useDeleteLorry, useUpdateLorry,
  type CapacityLayer, type LorryRow, type LorryType,
} from "../../../vendor/scm/lib/lorries-queries";
import type { DriverRow } from "../../../vendor/scm/lib/drivers-queries";
import type { HelperRow } from "../../../vendor/scm/lib/helpers-queries";
import type { ThreePLCompanyRow } from "../../../vendor/scm/lib/threepl-companies-queries";
import { alsoServes, boxOf, groupWarehouses, lorryHome, type WarehouseLite } from "./lorryModel";
import { Lorry3D } from "./Lorry3D";
import { ServiceRecords } from "./LorryService";
import { todayMyt } from "../../../vendor/scm/lib/dates";
import { OffRoadPanel } from "../../fleet/OffRoadPanel";

const TONE_CLASS: Record<ComplianceTone, string> = {
  expired: "bg-[color:var(--hz-dk-err-bg,#f6dcdc)] text-[color:var(--hz-dk-err,#8a2c2c)]", critical: "bg-[color:var(--hz-dk-err-bg,#f6dcdc)] text-[color:var(--hz-dk-err,#8a2c2c)]",
  warning: "bg-[color:var(--hz-dk-warning-bg,#f6ecd4)] text-[#80501c]", ok: "bg-[color:var(--hz-dk-synced-bg,#dcebe3)] text-[#1f5c43]", none: "bg-surface-2 text-ink-muted",
};
const DOCS = [
  { type: "ROAD_TAX", label: "Road tax", col: "road_tax_expiry" },
  { type: "INSURANCE", label: "Insurance", col: "insurance_expiry" },
  { type: "PUSPAKOM", label: "Puspakom", col: "puspakom_expiry" },
] as const;

const Card = ({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) => (
  <section className="rounded-xl border border-border bg-surface p-4">
    <div className="mb-3 flex items-center justify-between"><h3 className="text-[13px] font-semibold text-ink">{title}</h3>{action}</div>
    {children}
  </section>
);
const LinkBtn = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} className="text-[12.5px] font-semibold text-primary hover:underline">{children}</button>
);
const inputCls = "min-h-[40px] w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink";
/** When a trip on this lorry counts as full, in words. */
const fullWhen = (l: LorryRow): string => {
  const sets = `${l.max_sets ?? 10} sets`, value = fmtSen(l.max_revenue_sen ?? 3_000_000);
  const layer = (l.capacity_layer ?? "SETS") as CapacityLayer;
  return layer === "REVENUE" ? `A trip is full at ${value} of orders.` : layer === "BOTH" ? `A trip is full at ${sets} or ${value}, whichever comes first.` : `A trip is full at ${sets}.`;
};
const docPhrase = (days: number | null, date: string | null) =>
  date == null ? "Not recorded" : days != null && days < 0 ? `Expired ${fmtDate(date)}` : days != null && days <= 45 ? `Expires in ${days} days` : `Valid to ${fmtDate(date)}`;

export function LorryDrawer({ lorry, warehouses, drivers, helpers, carriers, gpsAt, onClose }: {
  lorry: LorryRow; warehouses: WarehouseLite[]; drivers: DriverRow[]; helpers: HelperRow[]; carriers: ThreePLCompanyRow[];
  gpsAt: string | null; onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const own = lorry.is_internal !== false;
  const carrier = carriers.find((c) => c.id === (lorry.threepl_company_id ?? null)) ?? null;
  const whName = (id: string | null) => warehouses.find((w) => w.id === id)?.name ?? "Not set";
  const home = lorryHome(lorry);
  const box = boxOf(lorry);
  return (
    <ResizableDrawer onClose={onClose} storageKey="fleet-lorry-drawer" defaultWidth={620} ariaLabel={`Lorry ${lorry.plate}`}
      title={<span className="flex items-center gap-2"><span className="rounded-md bg-[#1d2420] px-2 py-0.5 font-mono text-[14px] tracking-wider text-white">{lorry.plate}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", own ? "bg-[color:var(--hz-dk-synced-bg,#dcebe3)] text-[#1f5c43]" : "bg-[color:var(--hz-dk-warning-bg,#f6e6d4)] text-[#80501c]")}>{own ? "Own fleet" : carrier?.name ?? "3PL"}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", gpsAt ? "bg-[color:var(--hz-dk-synced-bg,#dcebe3)] text-[#1f5c43]" : "bg-surface-2 text-ink-muted")}>{gpsAt ? "GPS live" : "No GPS signal"}</span></span>}
      subtitle={[LORRY_TYPE_LABEL[lorry.type], lorry.model, lorry.active ? null : "Not in use"].filter(Boolean).join(" · ")}
      headerActions={!editing ? <span className="flex gap-2"><button type="button" onClick={() => setEditing(true)} className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-white">Edit</button>
        <Link to="/scm/delivery-maintenance?tab=live-map" className="rounded-md border border-white/40 px-3 py-1.5 text-[12.5px] font-semibold text-white">See on map</Link></span> : null}>
      {editing
        ? <LorryEdit lorry={lorry} warehouses={warehouses} drivers={drivers} helpers={helpers} carriers={carriers} onDone={() => setEditing(false)} />
        : (
          <div className="space-y-3 p-4">
            <section className="rounded-xl bg-primary p-4 text-white">
              <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">Home warehouse</div>
              <div className="text-[18px] font-semibold">{whName(home)}</div>
              <div className="text-[12px] opacity-80">Starts and ends every day here</div>
            </section>
            <Card title="Also picks up from">
              {alsoServes(lorry).length === 0 ? <p className="text-[12.5px] text-ink-muted">Only its home warehouse.</p> : (
                <div className="space-y-1.5">
                  {groupWarehouses(warehouses.filter((w) => alsoServes(lorry).includes(w.id))).map((g) => (
                    <div key={g.region} className="flex flex-wrap items-center gap-1.5 text-[12.5px]"><span className="w-24 text-ink-muted">{g.region}</span>
                      {g.items.map((w) => <span key={w.id} className="rounded bg-surface-2 px-2 py-0.5 text-ink">{w.name}</span>)}</div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Crew usually on it">
              <CrewLine role="Driver" person={drivers.find((d) => d.id === lorry.usual_driver_id) ?? null} />
              <CrewLine role="Helper" person={helpers.find((h) => h.id === lorry.usual_helper_id) ?? null} />
            </Card>
            <RoadThisMonth lorryId={lorry.id} />
            <Card title="How much it can carry">
              <Lorry3D box={box} height={230} />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-surface-2 p-2.5"><div className="text-[11px] text-ink-muted">Max sets per trip</div><div className="text-[16px] font-semibold">{lorry.max_sets ?? 10}</div>{lorry.max_sets == null && <div className="text-[11px] text-ink-muted">Usual is 10</div>}</div>
                <div className="rounded-lg bg-surface-2 p-2.5"><div className="text-[11px] text-ink-muted">Max order value per trip</div><div className="text-[16px] font-semibold">{fmtSen(lorry.max_revenue_sen ?? 3_000_000)}</div>{lorry.max_revenue_sen == null && <div className="text-[11px] text-ink-muted">Usual is RM 30,000</div>}</div>
              </div>
              <p className="mt-2 text-[12px] text-ink-secondary">{fullWhen(lorry)}</p>
            </Card>
            <Documents lorry={lorry} />
            {own && <Card title="Off the road"><OffRoadPanel lorryId={lorry.id} plate={lorry.plate} onChanged={null} /></Card>}
            <ServiceRecords lorryId={lorry.id} />
            <LorryEndActions lorry={lorry} onDeleted={onClose} />
          </div>
        )}
    </ResizableDrawer>
  );
}

/** Kilometres and driving time by road this month, home and back, from Last Mile. */
function RoadThisMonth({ lorryId }: { lorryId: string }) {
  const today = todayMyt();
  const road = useRoadFigures(`${today.slice(0, 7)}-01`, today, lorryId);
  const rows = road.data ?? [];
  const m = rows.reduce((a, r) => a + r.distanceM, 0), s = rows.reduce((a, r) => a + r.durationS, 0);
  return (
    <Card title="Google this month">
      {road.isError ? <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">Road figures could not be loaded.</p>
        : rows.length === 0 ? <p className="text-[12.5px] text-ink-muted">No run worked out yet this month.</p>
        : <div className="grid grid-cols-3 gap-2 text-[12.5px]">
            <div className="rounded-lg bg-surface-2 p-2.5"><div className="text-[11px] text-ink-muted">Google km</div><div className="text-[16px] font-semibold">{fmtKm(m)}</div></div>
            <div className="rounded-lg bg-surface-2 p-2.5"><div className="text-[11px] text-ink-muted">Google time</div><div className="text-[16px] font-semibold">{fmtDrive(s)}</div></div>
            <div className="rounded-lg bg-surface-2 p-2.5"><div className="text-[11px] text-ink-muted">Days out</div><div className="text-[16px] font-semibold">{rows.length}</div></div>
          </div>}
    </Card>
  );
}

function CrewLine({ role, person }: { role: string; person: { name: string; in_house?: boolean } | null }) {
  return (
    <div className="flex items-center gap-3 border-t border-border-subtle py-2 first:border-t-0">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink">{person ? person.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join("") : "—"}</span>
      <div className="text-[12.5px]"><div className="font-semibold text-ink">{person?.name ?? "Not set"}</div><div className="text-ink-muted">{role}{person ? ` · ${person.in_house === false ? "Outsource" : "In-house"}` : ""}</div></div>
    </div>
  );
}

function Documents({ lorry }: { lorry: LorryRow }) {
  const qc = useQueryClient();
  const [renew, setRenew] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!renew || !expiry) return;
    setBusy(true);
    try {
      await api.post(`/api/fleet-maintenance/vehicles/${lorry.id}/compliance`, { docType: renew, expiryDate: expiry, documentRef: ref || null });
      await qc.invalidateQueries({ queryKey: ["lorries"] });
      setRenew(null); setExpiry(""); setRef("");
    } catch (e) {
      /* The renew writes the Fleet Health vault, which needs fleet.write, not the lorry master's permission. */
      if ((e as { status?: number } | null)?.status === 403) {
        writeFailedAs("The document was not renewed")(new Error("You do not have Fleet Health permission (fleet write). Ask an admin to grant it."));
      } else writeFailed(e);
    } finally { setBusy(false); }
  };
  return (
    <Card title="Documents" action={<Link to={`/fleet-health/${lorry.id}`} className="text-[12.5px] font-semibold text-primary hover:underline">Full history</Link>}>
      {DOCS.map((d) => {
        const s = expiryStatus(lorry[d.col] ?? null);
        return (
          <div key={d.type} className="border-t border-border-subtle py-2 first:border-t-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-semibold text-ink">{d.label}</span>
              <span className="flex items-center gap-2"><span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE_CLASS[s.tone])}>{docPhrase(s.days, s.date)}</span>
                <LinkBtn onClick={() => { setRenew(d.type); setExpiry(""); setRef(""); }}>Renew</LinkBtn></span>
            </div>
            {renew === d.type && (
              <div className="mt-2 grid grid-cols-[1fr_1fr_auto_auto] items-end gap-2">
                <label className="text-[11px] text-ink-muted">New expiry date<DateField value={expiry} onChange={setExpiry} fullWidth aria-label="New expiry date" /></label>
                <label className="text-[11px] text-ink-muted">Reference no.<input value={ref} onChange={(e) => setRef(e.target.value)} className={inputCls} /></label>
                <button type="button" disabled={!expiry || busy} onClick={() => void save()} className="min-h-[40px] rounded-md bg-primary px-3 text-[12.5px] font-semibold text-white disabled:opacity-50">Save</button>
                <button type="button" onClick={() => setRenew(null)} className="min-h-[40px] px-2 text-[12.5px] text-ink">Cancel</button>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function LorryEndActions({ lorry, onDeleted }: { lorry: LorryRow; onDeleted: () => void }) {
  const update = useUpdateLorry();
  const del = useDeleteLorry();
  const confirm = useConfirm();
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <button type="button" className="min-h-[40px] rounded-md border border-border px-3 text-[12.5px] font-semibold text-ink"
        onClick={() => { void confirm(lorry.active
          ? { title: `Stop using ${lorry.plate}?`, body: "It leaves the delivery planning lists. Its history stays.", confirmLabel: "Stop using" }
          : { title: `Use ${lorry.plate} again?`, confirmLabel: "Use again" }).then((ok) => { if (ok) update.mutate({ id: lorry.id, active: !lorry.active }, { onError: writeFailedAs("The lorry was not changed") }); }); }}>
        {lorry.active ? "Stop using this lorry" : "Use this lorry again"}
      </button>
      <button type="button" className="min-h-[40px] rounded-md border border-[#e3b4b4] px-3 text-[12.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]"
        onClick={() => { void confirm({ title: `Delete ${lorry.plate}?`, body: "This cannot be undone. A lorry with runs or records cannot be deleted; stop using it instead.", confirmLabel: "Delete", danger: true })
          .then((ok) => { if (ok) del.mutate(lorry.id, { onSuccess: onDeleted, onError: writeFailedAs("The lorry was not deleted") }); }); }}>
        Delete lorry
      </button>
    </div>
  );
}

function LorryEdit({ lorry, warehouses, drivers, helpers, carriers, onDone }: {
  lorry: LorryRow; warehouses: WarehouseLite[]; drivers: DriverRow[]; helpers: HelperRow[]; carriers: ThreePLCompanyRow[]; onDone: () => void;
}) {
  const update = useUpdateLorry();
  const s = (v: number | string | null | undefined) => (v == null ? "" : String(v));
  const [f, setF] = useState({
    plate: lorry.plate, type: lorry.type as LorryType, model: lorry.model ?? "",
    home: lorryHome(lorry) ?? "", serves: new Set(alsoServes(lorry)),
    carrier: lorry.threepl_company_id ?? "", driver: lorry.usual_driver_id ?? "", helper: lorry.usual_helper_id ?? "",
    length: s(lorry.length_ft), width: s(lorry.width_ft), height: s(lorry.height_ft),
    maxSets: s(lorry.max_sets), maxRm: lorry.max_revenue_sen == null ? "" : String(lorry.max_revenue_sen / 100),
    layer: (lorry.capacity_layer ?? "SETS") as CapacityLayer,
  });
  const n = (v: string) => (v.trim() === "" ? null : Number(v));
  const m3 = useMemo(() => { const l = n(f.length), w = n(f.width), h = n(f.height); return l && w && h ? Math.round(l * w * h * 0.0283168 * 10) / 10 : null; }, [f.length, f.width, f.height]);
  const toggle = (id: string) => { const next = new Set(f.serves); if (next.has(id)) next.delete(id); else next.add(id); setF({ ...f, serves: next }); };
  const bad = [f.length, f.width, f.height, f.maxSets, f.maxRm].some((v) => v.trim() !== "" && !(Number(v) >= 0));
  const save = () => update.mutate({
    id: lorry.id, plate: f.plate, type: f.type, model: f.model.trim() || null,
    homeWarehouseId: f.home || null, warehouseIds: [...f.serves].filter((id) => id !== f.home),
    threeplCompanyId: f.carrier || null, usualDriverId: f.driver || null, usualHelperId: f.helper || null,
    lengthFt: n(f.length), widthFt: n(f.width), heightFt: n(f.height),
    maxSets: n(f.maxSets), maxRevenueSen: f.maxRm.trim() === "" ? null : Math.round(Number(f.maxRm) * 100), capacityLayer: f.layer,
  }, { onSuccess: onDone, onError: writeFailedAs("The lorry was not saved") });
  const box = n(f.length) && n(f.width) && n(f.height) ? { length: n(f.length)!, width: n(f.width)!, height: n(f.height)! } : null;
  const label = "text-[11px] font-semibold uppercase tracking-wide text-ink-muted";
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>Plate<input value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} className={inputCls} /></label>
        <label className={label}>Type<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as LorryType })} className={inputCls}>{LORRY_TYPES.map((t) => <option key={t} value={t}>{LORRY_TYPE_LABEL[t]}</option>)}</select></label>
        <label className={label}>Model<input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} className={inputCls} /></label>
        <label className={label}>Owner<select value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} className={inputCls}><option value="">Own fleet</option>{carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      </div>
      <div className="rounded-xl bg-primary-soft/40 p-3">
        <label className={label}>Home warehouse<select value={f.home} onChange={(e) => setF({ ...f, home: e.target.value })} className={inputCls}><option value="">Not set</option>
          {groupWarehouses(warehouses).map((g) => <optgroup key={g.region} label={g.region}>{g.items.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>)}</select></label>
      </div>
      <div>
        <div className={label}>Also picks up from</div>
        <div className="mt-1 space-y-2">
          {groupWarehouses(warehouses.filter((w) => w.id !== f.home)).map((g) => (
            <div key={g.region}><div className="text-[12px] font-semibold text-ink">{g.region}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">{g.items.map((w) => (
                <button key={w.id} type="button" onClick={() => toggle(w.id)} className={cn("min-h-[34px] rounded-full border px-3 text-[12px]", f.serves.has(w.id) ? "border-primary bg-primary text-white" : "border-border bg-surface text-ink")}>{w.name}</button>
              ))}</div></div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>Usual driver<select value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })} className={inputCls}><option value="">Not set</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className={label}>Usual helper<select value={f.helper} onChange={(e) => setF({ ...f, helper: e.target.value })} className={inputCls}><option value="">Not set</option>{helpers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      </div>
      <div>
        <div className={label}>Box size (feet)</div>
        <div className="my-2"><Lorry3D box={box} height={200} /></div>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-[11px] text-ink-muted">Length<input inputMode="decimal" value={f.length} onChange={(e) => setF({ ...f, length: e.target.value })} className={inputCls} /></label>
          <label className="text-[11px] text-ink-muted">Width<input inputMode="decimal" value={f.width} onChange={(e) => setF({ ...f, width: e.target.value })} className={inputCls} /></label>
          <label className="text-[11px] text-ink-muted">Height<input inputMode="decimal" value={f.height} onChange={(e) => setF({ ...f, height: e.target.value })} className={inputCls} /></label>
        </div>
        <p className="mt-1 text-[12.5px] text-ink">{m3 != null ? `${m3} m³` : "Enter all three sides for the space in m³"}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className={label}>Max sets<input inputMode="numeric" placeholder="10" value={f.maxSets} onChange={(e) => setF({ ...f, maxSets: e.target.value })} className={inputCls} /></label>
        <label className={label}>Max value (RM)<input inputMode="decimal" placeholder="30000" value={f.maxRm} onChange={(e) => setF({ ...f, maxRm: e.target.value })} className={inputCls} /></label>
        <label className={label}>Full when<select value={f.layer} onChange={(e) => setF({ ...f, layer: e.target.value as CapacityLayer })} className={inputCls}>{CAPACITY_LAYERS.map((c) => <option key={c} value={c}>{CAPACITY_LAYER_LABEL[c]}</option>)}</select></label>
      </div>
      {bad && <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">Sizes and limits must be numbers of 0 or more.</p>}
      <div className="flex gap-2">
        <button type="button" disabled={bad || !f.plate.trim() || update.isPending} onClick={save} className="min-h-[40px] rounded-md bg-primary px-4 text-[13px] font-semibold text-white disabled:opacity-50">{update.isPending ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onDone} className="min-h-[40px] px-3 text-[13px] text-ink">Cancel</button>
      </div>
    </div>
  );
}
