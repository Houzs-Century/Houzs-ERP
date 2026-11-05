/* Employees & Attendance > Punch Sites (HC-0125 phase 2): where a phone punch
 * counts as on site. Hookka had one hard-coded factory point; Century has
 * several warehouses and showrooms, so each is a point and a radius. The
 * check is soft: an off-site punch still records, HR sees the distance. */
import { useState } from "react";
import { MapPin, Plus } from "lucide-react";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { useToast } from "../../hooks/useToast";
import { Field, Pill, Toggle, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, usePunchSites, type PunchSiteOut } from "./hrApi";

type Draft = { id: number | null; name: string; coords: string; radiusM: string; active: boolean };
const blank: Draft = { id: null, name: "", coords: "", radiusM: "200", active: true };

/** "3.0738, 101.5183" as Google Maps copies it (right-click a point), or two numbers. */
export function parseCoords(s: string): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export function PunchSitesTab() {
  const toast = useToast();
  const q = usePunchSites();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const canManage = q.data?.canManage ?? false;
  const coords = draft ? parseCoords(draft.coords) : null;

  async function save() {
    if (!draft) return;
    if (!coords) {
      toast.error("Paste the location as latitude, longitude, e.g. 3.0738, 101.5183.");
      return;
    }
    setSaving(true);
    try {
      const body = { name: draft.name, lat: coords.lat, lng: coords.lng, radiusM: Number(draft.radiusM), active: draft.active };
      if (draft.id == null) await api.post(`${HR}/punch-sites`, body);
      else await api.patch(`${HR}/punch-sites/${draft.id}`, body);
      toast.success(`${draft.name} saved`);
      setDraft(null);
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not save the site."));
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<PunchSiteOut>[] = [
    { key: "name", label: "Site", getValue: (s) => s.name, render: (s) => <span className="font-semibold">{s.name}</span> },
    {
      key: "where",
      label: "Location",
      getValue: (s) => `${s.lat}, ${s.lng}`,
      render: (s) => (
        <a
          href={`https://www.google.com/maps?q=${s.lat},${s.lng}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <MapPin size={11} /> {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
        </a>
      ),
    },
    { key: "radius", label: "Radius", align: "right", getValue: (s) => s.radiusM, render: (s) => <span className="font-mono">{s.radiusM} m</span> },
    { key: "active", label: "Status", getValue: (s) => (s.active ? "Active" : "Inactive"), render: (s) => (s.active ? <Pill tone="ok">Active</Pill> : <Pill tone="muted">Inactive</Pill>) },
  ];

  return (
    <div className="space-y-3">
      {canManage && !draft && (
        <div className="flex justify-end">
          <button type="button" className={primaryBtn} onClick={() => setDraft(blank)}>
            <Plus size={11} /> Add site
          </button>
        </div>
      )}
      {draft && (
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="grid grid-cols-[1fr_1fr_120px] gap-3 max-md:grid-cols-1">
            <Field label="Site name">
              <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="KL WAREHOUSE" />
            </Field>
            <Field label="Location (latitude, longitude)" hint="In Google Maps, right-click the gate and click the numbers to copy them.">
              <input className={`${inputCls} font-mono`} value={draft.coords} onChange={(e) => setDraft({ ...draft, coords: e.target.value })} placeholder="3.0738, 101.5183" />
            </Field>
            <Field label="Radius (m)" hint="200 covers a warehouse yard.">
              <input className={inputCls} value={draft.radiusM} onChange={(e) => setDraft({ ...draft, radiusM: e.target.value })} inputMode="numeric" />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Toggle checked={draft.active} onChange={(v) => setDraft({ ...draft, active: v })} label="Active" hint="An inactive site is not checked, but still names its old punches." />
            {coords && (
              <a href={`https://www.google.com/maps?q=${coords.lat},${coords.lng}`} target="_blank" rel="noreferrer" className="text-[11px] text-accent hover:underline">
                Check on Google Maps
              </a>
            )}
            <span className="ml-auto flex gap-2">
              <button type="button" className={ghostBtn} disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="button" className={primaryBtn} disabled={saving || !draft.name.trim() || !coords} onClick={() => void save()}>
                {saving ? "Saving..." : "Save site"}
              </button>
            </span>
          </div>
        </div>
      )}
      <DataTable<PunchSiteOut>
        tableId="hr-punch-sites"
        columns={columns}
        rows={q.data ? q.data.sites : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No punch sites yet. Add each warehouse or showroom where staff punch in."
        getRowKey={(s) => s.id}
        onRowClick={canManage ? (s) => setDraft({ id: s.id, name: s.name, coords: `${s.lat}, ${s.lng}`, radiusM: String(s.radiusM), active: s.active }) : undefined}
      />
    </div>
  );
}
