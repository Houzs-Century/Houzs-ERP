// Add an in-house lorry from Fleet Health (owner, 2026-10-16: in-house lorries
// are added here, with their length / width / height, and they show up on
// Coverage & Fleet by themselves — it is the same lorry master, scm.lorries).
// Always own fleet: isInternal true, no 3PL company.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { Button } from "../../components/Button";
import { useCreateLorry, LORRY_TYPES, LORRY_TYPE_LABEL, type LorryType } from "../../vendor/scm/lib/lorries-queries";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";
import { DateField } from "../../vendor/scm/components/DateField";

const CLS = "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink focus:border-primary focus:outline-none";
const LABEL = "mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

const numOrNull = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export function NewInHouseLorry({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const create = useCreateLorry();
  const warehouses = useWarehouses();
  const navigate = useNavigate();
  const [f, setF] = useState({ plate: "", model: "", warehouseId: "", lengthFt: "", widthFt: "", heightFt: "", maxSets: "", maxRevenueRm: "", registrationDate: "" });
  const [type, setType] = useState<LorryType>("LORRY_17FT");
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const save = () => {
    if (!f.plate.trim()) { setErr("Plate is required."); return; }
    const l = numOrNull(f.lengthFt); const w = numOrNull(f.widthFt); const h = numOrNull(f.heightFt);
    const sets = numOrNull(f.maxSets); const rev = numOrNull(f.maxRevenueRm);
    if ([l, w, h, sets, rev].some((n) => Number.isNaN(n))) { setErr("Sizes, sets and revenue must be numbers, 0 or more."); return; }
    setErr(null);
    create.mutate({
      plate: f.plate.trim(),
      type,
      isInternal: true,
      threeplCompanyId: null,
      model: f.model.trim() || null,
      warehouseId: f.warehouseId || null,
      lengthFt: l, widthFt: w, heightFt: h,
      maxSets: sets != null ? Math.round(sets) : null,
      maxRevenueSen: rev != null ? Math.round(rev * 100) : null,
      registrationDate: f.registrationDate || null,
      active: true,
    }, {
      onSuccess: (r) => { onCreated(); onClose(); const id = (r as { lorry?: { id?: string } }).lorry?.id; if (id) navigate(`/fleet-health/${id}`); },
      onError: (e) => setErr(e instanceof Error ? e.message : "Could not add the lorry."),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink">New in-house lorry</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-secondary hover:bg-surface-2"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={LABEL}>Plate *</label><input className={CLS} value={f.plate} onChange={(e) => set("plate", e.target.value)} placeholder="e.g. VNB9058" /></div>
          <div><label className={LABEL}>Type</label>
            <select className={CLS} value={type} onChange={(e) => setType(e.target.value as LorryType)}>
              {LORRY_TYPES.map((t) => <option key={t} value={t}>{LORRY_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
          <div><label className={LABEL}>Model</label><input className={CLS} value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. Isuzu NPR75" /></div>
          <div><label className={LABEL}>Home warehouse</label>
            <select className={CLS} value={f.warehouseId} onChange={(e) => set("warehouseId", e.target.value)}>
              <option value="">Any region</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{warehouseLabel(w)}</option>)}
            </select>
          </div>
          <div><label className={LABEL}>Length (ft)</label><input className={CLS} inputMode="decimal" value={f.lengthFt} onChange={(e) => set("lengthFt", e.target.value)} placeholder="e.g. 17" /></div>
          <div><label className={LABEL}>Width (ft)</label><input className={CLS} inputMode="decimal" value={f.widthFt} onChange={(e) => set("widthFt", e.target.value)} placeholder="e.g. 7" /></div>
          <div><label className={LABEL}>Height (ft)</label><input className={CLS} inputMode="decimal" value={f.heightFt} onChange={(e) => set("heightFt", e.target.value)} placeholder="e.g. 6.7" /></div>
          <div><label className={LABEL}>Registered</label><DateField fullWidth className={CLS} value={f.registrationDate} onChange={(iso) => set("registrationDate", iso)} /></div>
          <div><label className={LABEL}>Max sets / trip</label><input className={CLS} inputMode="numeric" value={f.maxSets} onChange={(e) => set("maxSets", e.target.value)} placeholder="blank = default 10" /></div>
          <div><label className={LABEL}>Max revenue / trip (RM)</label><input className={CLS} inputMode="decimal" value={f.maxRevenueRm} onChange={(e) => set("maxRevenueRm", e.target.value)} placeholder="blank = default 30000" /></div>
        </div>
        <p className="mt-2 text-[10.5px] text-ink-muted">Own fleet. It appears on Coverage &amp; Fleet straight away; road tax, insurance and the rest are added on its page.</p>
        {err && <div className="mt-2 text-[11px] text-err">{err}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={create.isPending}>{create.isPending ? "Adding…" : "Add lorry"}</Button>
        </div>
      </div>
    </div>
  );
}
