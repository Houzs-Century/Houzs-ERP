/* HR · Punch Sites (step-2 re-skin). Where a phone punch counts as on site, and
 * the two punch-rule switches (selfie / on-site) that turn a soft check into a
 * hard block. New design; real /api/hr/punch-sites, add/edit via a modal, rules
 * toggled inline. (Ported from the old PunchSitesTab; parseCoords kept.) */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MapPin } from "lucide-react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { Toggle, errText } from "../pos-admin/posAdminUi";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { Tag } from "./HrTablePage";
import { HR, savePunchSettings, usePunchSites, type PunchSettings } from "./hrApi";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

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
  const canManage = q.data?.canManage ?? false;
  const sites = q.data?.sites ?? [];
  const active = sites.filter((s) => s.active).length;

  const [gates, setGates] = useState<PunchSettings>({ requireSelfie: false, requireOnSite: false });
  const [savingGates, setSavingGates] = useState(false);
  useEffect(() => {
    if (q.data) setGates(q.data.settings);
  }, [q.data]);
  const hasSite = sites.some((s) => s.active);

  async function setGate(patch: Partial<PunchSettings>) {
    const next = { ...gates, ...patch };
    setGates(next);
    setSavingGates(true);
    try {
      await savePunchSettings(next);
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not save the punch rules."));
      if (q.data) setGates(q.data.settings);
    } finally {
      setSavingGates(false);
    }
  }

  return (
    <>
      <HrPageHeader
        title="Punch Sites"
        subtitle="Where a phone punch counts as on site"
        actions={canManage ? <button type="button" className={hrPrimaryBtn} onClick={() => setDraft(blank)}>+ Add site</button> : undefined}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        {/* Punch rules */}
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="text-[13px] font-bold text-ink">Punch rules</div>
          <div className="mt-0.5 text-[11px] text-ink-muted">Off: the selfie and location are kept as evidence only. On: a punch missing it is refused on the phone.</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5">
              <Toggle checked={gates.requireSelfie} onChange={(v) => void setGate({ requireSelfie: v })} disabled={!canManage || savingGates} label="Require a photo" hint="A clock in / out without a selfie is refused." />
            </div>
            <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5">
              <Toggle checked={gates.requireOnSite} onChange={(v) => void setGate({ requireOnSite: v })} disabled={!canManage || savingGates} label="Require being on site" hint="A clock in / out outside every active site (or with location off) is refused." />
            </div>
          </div>
          {gates.requireOnSite && !hasSite && (
            <div className="mt-2 rounded-md bg-err-bg px-2.5 py-1.5 text-[11px] font-semibold text-err">No active punch site yet, so this would refuse every punch. Add a site first.</div>
          )}
        </div>

        {/* stat cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat bar="bg-primary" label="Sites" value={sites.length} sub="all locations" />
          <Stat bar="bg-synced" label="Active" value={active} sub="checked for punches" />
          <Stat bar="bg-accent" label="Selfie required" value={gates.requireSelfie ? "On" : "Off"} sub="phone punch gate" />
          <Stat bar="bg-time" label="On-site required" value={gates.requireOnSite ? "On" : "Off"} sub="phone punch gate" />
        </div>

        {/* table */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="thin-scroll min-h-0 flex-1 overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-[12px]">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                  <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-4 py-2 text-left">Site</th>
                  <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-3 py-2 text-left">Location</th>
                  <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-3 py-2 text-right">Radius</th>
                  <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id} className={cx("hover:bg-row-hover", canManage && "cursor-pointer")} onClick={canManage ? () => setDraft({ id: s.id, name: s.name, coords: `${s.lat}, ${s.lng}`, radiusM: String(s.radiusM), active: s.active }) : undefined}>
                    <td className="border-b border-border-subtle px-4 py-2 font-semibold text-ink">{s.name}</td>
                    <td className="border-b border-border-subtle px-3 py-2">
                      <a href={`https://www.google.com/maps?q=${s.lat},${s.lng}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline">
                        <MapPin size={11} /> {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
                      </a>
                    </td>
                    <td className="border-b border-border-subtle px-3 py-2 text-right font-mono">{s.radiusM} m</td>
                    <td className="border-b border-border-subtle px-3 py-2">{s.active ? <Tag tone="ok">Active</Tag> : <Tag tone="muted">Inactive</Tag>}</td>
                  </tr>
                ))}
                {q.loading && !q.data && <tr><td colSpan={4} className="px-4 py-10 text-center text-[12px] text-ink-muted">Loading…</td></tr>}
                {q.error && <tr><td colSpan={4} className="px-4 py-10 text-center text-[12px] text-err">{q.error}</td></tr>}
                {q.data && sites.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-[12px] text-ink-muted">No punch sites yet. Add each warehouse or showroom where staff punch in.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2 text-[11px]">
            <span className="text-ink-muted"><span className="font-semibold text-ink">{sites.length}</span> sites · {active} active</span>
          </div>
        </div>
      </div>
      {draft && canManage && <SiteModal draft={draft} onClose={() => setDraft(null)} onDone={() => { setDraft(null); q.reload(); }} />}
    </>
  );
}

function Stat({ bar, label, value, sub }: { bar: string; label: string; value: ReactNode; sub: string }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className={cx("h-[3px] w-full", bar)} />
      <div className="px-3.5 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
        <div className="mt-1 text-[22px] font-bold leading-none text-ink">{value}</div>
        <div className="mt-1.5 text-[11px] text-ink-muted">{sub}</div>
      </div>
    </div>
  );
}

function SiteModal({ draft: initial, onClose, onDone }: { draft: Draft; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const coords = parseCoords(draft.coords);

  async function save() {
    if (!coords) { toast.error("Paste the location as latitude, longitude, e.g. 3.0738, 101.5183."); return; }
    setSaving(true);
    try {
      const body = { name: draft.name, lat: coords.lat, lng: coords.lng, radiusM: Number(draft.radiusM), active: draft.active };
      if (draft.id == null) await api.post(`${HR}/punch-sites`, body);
      else await api.patch(`${HR}/punch-sites/${draft.id}`, body);
      toast.success(`${draft.name} saved`);
      onDone();
    } catch (e) {
      toast.error(errText(e, "Could not save the site."));
      setSaving(false);
    }
  }

  const fieldCls = "h-9 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[12.5px] text-ink focus:border-primary focus:outline-none";
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-6" style={{ background: "rgba(17,20,15,.42)" }} onMouseDown={onClose}>
      <div className="my-10 w-full max-w-[460px] animate-rise rounded-2xl bg-surface shadow-[0_24px_64px_-16px_rgba(17,20,15,.35)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-bold text-ink">{draft.id == null ? "Add punch site" : "Edit punch site"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink">✕</button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Site name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="KL Warehouse" className={fieldCls} />
          </label>
          <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Location (latitude, longitude)</span>
            <input value={draft.coords} onChange={(e) => setDraft({ ...draft, coords: e.target.value })} placeholder="3.0738, 101.5183" className={cx(fieldCls, "font-mono")} />
            <span className="mt-1 block text-[11px] text-ink-muted">In Google Maps, right-click the gate and click the numbers to copy them.{coords && <> · <a href={`https://www.google.com/maps?q=${coords.lat},${coords.lng}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">check</a></>}</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Radius (m)</span>
              <input value={draft.radiusM} onChange={(e) => setDraft({ ...draft, radiusM: e.target.value })} inputMode="numeric" className={fieldCls} />
            </label>
            <label className="flex items-end gap-2 pb-2 text-[12px] text-ink-secondary"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Active</label>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className={hrSecondaryBtn}>Cancel</button>
          <button type="button" disabled={saving || !draft.name.trim() || !coords} onClick={() => void save()} className={hrPrimaryBtn}>{saving ? "Saving…" : "Save site"}</button>
        </div>
      </div>
    </div>
  );
}
