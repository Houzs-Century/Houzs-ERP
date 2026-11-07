// The Vehicle tab of a lorry record: what it can carry on a delivery run, and
// the vehicle's own dates and purchase. Read first, Edit to change; both write
// the lorry master (PATCH /lorries/:id) exactly as the Coverage & Fleet editors
// do. Fleet Health keeps own-fleet lorries only, so there is no 3PL choice here.
import { useMemo, useState } from "react";
import {
  CAPACITY_LAYERS, CAPACITY_LAYER_LABEL, useUpdateLorry,
  type CapacityLayer, type LorryRow,
} from "../../vendor/scm/lib/lorries-queries";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";
import { writeFailedAs } from "../../vendor/scm/lib/mutation-error";
import { DateField } from "../../vendor/scm/components/DateField";
import { fmtDate, fmtSen } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { BTN_PRI, BTN_SEC, Fact, FactGrid, FleetCard, INPUT, LABEL } from "./FleetUi";

const FT3_TO_M3 = 0.0283168;
const numOrNull = (v: string): number | null => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const boxM3 = (l: number | null, w: number | null, h: number | null): number | null =>
  l != null && w != null && h != null ? Math.round(l * w * h * FT3_TO_M3 * 100) / 100 : null;
const str = (v: number | string | null | undefined) => (v == null ? "" : String(v));
/* Mig 0245 columns the LorryRow type does not declare. */
const col = (l: LorryRow, key: string): string | null => {
  const v = (l as unknown as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
};

/** The warehouses a lorry serves; one lorry can cover several (owner, 2026-10-16). */
export const servedWarehouseIds = (l: LorryRow): string[] => {
  const many = (l as { warehouse_ids?: string[] | null }).warehouse_ids;
  if (many && many.length) return many;
  return l.warehouse_id ? [l.warehouse_id] : [];
};

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={cn("block min-w-0", wide && "sm:col-span-2 lg:col-span-3")}><span className={LABEL}>{label}</span>{children}</label>;
}

const FORM_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";
const Actions = ({ busy, onSave, onCancel }: { busy: boolean; onSave: () => void; onCancel: () => void }) => (
  <div className="flex flex-wrap gap-2 border-t border-[#ece8df] pt-3">
    <button type="button" className={BTN_PRI} onClick={onSave} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    <button type="button" className={BTN_SEC} onClick={onCancel} disabled={busy}>Cancel</button>
  </div>
);

export function CapacityCard({ lorry }: { lorry: LorryRow }) {
  const update = useUpdateLorry();
  const warehouses = useWarehouses();
  const [editing, setEditing] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  const initial = () => ({
    warehouseIds: servedWarehouseIds(lorry),
    maxSets: str(lorry.max_sets),
    maxRevenueRm: lorry.max_revenue_sen != null ? String(lorry.max_revenue_sen / 100) : "",
    layer: (lorry.capacity_layer ?? "SETS") as CapacityLayer,
    lengthFt: str(lorry.length_ft), widthFt: str(lorry.width_ft), heightFt: str(lorry.height_ft),
  });
  const [form, setForm] = useState(initial);
  const set = <K extends keyof ReturnType<typeof initial>>(k: K, v: ReturnType<typeof initial>[K]) => setForm((s) => ({ ...s, [k]: v }));
  const toggleWh = (id: string) => setForm((s) => ({ ...s, warehouseIds: s.warehouseIds.includes(id) ? s.warehouseIds.filter((x) => x !== id) : [...s.warehouseIds, id] }));
  const whName = useMemo(() => new Map((warehouses.data ?? []).map((w) => [w.id, warehouseLabel(w) ?? ""])), [warehouses.data]);

  const save = () => {
    const sets = form.maxSets.trim(), rev = form.maxRevenueRm.trim();
    if (sets && !(Number.isInteger(Number(sets)) && Number(sets) >= 0)) { setBad("Max sets must be a whole number."); return; }
    if (rev && !(Number.isFinite(Number(rev)) && Number(rev) >= 0)) { setBad("Max order value must be a number, 0 or more."); return; }
    for (const [label, v] of [["Length", form.lengthFt], ["Width", form.widthFt], ["Height", form.heightFt]] as const) {
      if (v.trim() && !(Number.isFinite(Number(v)) && Number(v) >= 0)) { setBad(`${label} must be a number, 0 or more.`); return; }
    }
    setBad(null);
    update.mutate({
      id: lorry.id,
      warehouseIds: form.warehouseIds,
      maxSets: sets ? Math.round(Number(sets)) : null,
      maxRevenueSen: rev ? Math.round(Number(rev) * 100) : null,
      capacityLayer: form.layer,
      lengthFt: numOrNull(form.lengthFt), widthFt: numOrNull(form.widthFt), heightFt: numOrNull(form.heightFt),
    }, { onSuccess: () => setEditing(false), onError: writeFailedAs("Delivery capacity was not saved") });
  };

  const served = servedWarehouseIds(lorry);
  const box = lorry.length_ft != null && lorry.width_ft != null && lorry.height_ft != null ? `${lorry.length_ft} × ${lorry.width_ft} × ${lorry.height_ft} ft` : null;
  const m3 = lorry.capacity_m3 != null && lorry.capacity_m3 !== "" ? `${lorry.capacity_m3} m³` : null;
  const formM3 = boxM3(numOrNull(form.lengthFt), numOrNull(form.widthFt), numOrNull(form.heightFt));

  return (
    <FleetCard
      title="Delivery capacity"
      sub="What a delivery run may load on this lorry. Blank limits use the usual 10 sets / RM 30,000."
      actions={!editing && <button type="button" className={BTN_SEC} onClick={() => { setForm(initial()); setBad(null); setEditing(true); }}>Edit</button>}
    >
      {!editing ? (
        <FactGrid>
          <Fact label="Warehouses it serves" value={served.length ? served.map((id) => whName.get(id) || "Unknown warehouse").join(", ") : "Any warehouse"} />
          <Fact label="Box (L × W × H)" value={box} />
          <Fact label="Capacity" value={m3} />
          <Fact label="Max sets per trip" value={lorry.max_sets != null ? String(lorry.max_sets) : "Usual (10)"} />
          <Fact label="Max order value per trip" value={lorry.max_revenue_sen != null ? fmtSen(lorry.max_revenue_sen) : "Usual (RM 30,000)"} />
          <Fact label="A trip is full on" value={CAPACITY_LAYER_LABEL[(lorry.capacity_layer ?? "SETS") as CapacityLayer]} />
        </FactGrid>
      ) : (
        <div className="flex flex-col gap-4">
          <fieldset className="min-w-0">
            <legend className={LABEL}>Warehouses it serves (none ticked means any warehouse)</legend>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {warehouses.isLoading && <span className="text-[13px] text-ink-muted">Loading warehouses…</span>}
              {warehouses.error != null && <span role="alert" className="text-[13px] text-err">Could not load the warehouses: {warehouses.error instanceof Error ? warehouses.error.message : "try again"}.</span>}
              {(warehouses.data ?? []).map((w) => {
                const on = form.warehouseIds.includes(w.id);
                return (
                  <button key={w.id} type="button" aria-pressed={on} onClick={() => toggleWh(w.id)}
                    className={cn("min-h-[36px] rounded-full border px-3 text-[13px]", on ? "border-primary bg-primary font-semibold text-white" : "border-[#d9d3c6] bg-surface text-ink hover:border-primary/50")}>
                    {warehouseLabel(w)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className={FORM_GRID}>
            <Field label="Length (ft)"><input className={INPUT} inputMode="decimal" value={form.lengthFt} onChange={(e) => set("lengthFt", e.target.value)} placeholder="e.g. 17" /></Field>
            <Field label="Width (ft)"><input className={INPUT} inputMode="decimal" value={form.widthFt} onChange={(e) => set("widthFt", e.target.value)} placeholder="e.g. 7" /></Field>
            <Field label="Height (ft)"><input className={INPUT} inputMode="decimal" value={form.heightFt} onChange={(e) => set("heightFt", e.target.value)} placeholder="e.g. 6.7" /></Field>
            <Field label="Max sets per trip"><input className={INPUT} inputMode="numeric" value={form.maxSets} onChange={(e) => set("maxSets", e.target.value)} placeholder="Blank for the usual 10" /></Field>
            <Field label="Max order value per trip (RM)"><input className={INPUT} inputMode="decimal" value={form.maxRevenueRm} onChange={(e) => set("maxRevenueRm", e.target.value)} placeholder="Blank for the usual 30000" /></Field>
            <Field label="A trip is full on">
              <select className={INPUT} value={form.layer} onChange={(e) => set("layer", e.target.value as CapacityLayer)}>
                {CAPACITY_LAYERS.map((l) => <option key={l} value={l}>{CAPACITY_LAYER_LABEL[l]}</option>)}
              </select>
            </Field>
          </div>
          <p className="text-[13px] text-ink-secondary">Capacity: <b className="text-ink">{formM3 != null ? `${formM3} m³` : "enter all three sides"}</b>, worked out from length × width × height.</p>
          {bad && <p role="alert" className="text-[13px] font-semibold text-err">{bad}</p>}
          <Actions busy={update.isPending} onSave={save} onCancel={() => { setEditing(false); setBad(null); }} />
        </div>
      )}
    </FleetCard>
  );
}

export function PurchaseCard({ lorry }: { lorry: LorryRow }) {
  const update = useUpdateLorry();
  const [editing, setEditing] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  /* Four DIFFERENT dates (mig 0245): a reconditioned import is registered years
     after it was built, and a lorry can start work before its transfer clears. */
  const initial = () => ({
    model: lorry.model ?? "",
    manufactureDate: col(lorry, "manufacture_date") ?? "",
    registrationDate: col(lorry, "registration_date") ?? "",
    inServiceDate: col(lorry, "in_service_date") ?? "",
    purchaseDate: lorry.purchase_date ?? "",
    price: lorry.purchase_price_sen != null ? String(lorry.purchase_price_sen / 100) : "",
    perKm: lorry.cost_per_km_sen != null ? String(lorry.cost_per_km_sen / 100) : "",
  });
  const [form, setForm] = useState(initial);
  const set = (k: keyof ReturnType<typeof initial>, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const save = () => {
    const rm = form.price.trim(), perKm = form.perKm.trim();
    if (rm && !Number.isFinite(Number(rm))) { setBad("Purchase price must be a number."); return; }
    if (perKm && !(Number.isFinite(Number(perKm)) && Number(perKm) >= 0)) { setBad("Running cost per km must be a number, 0 or more."); return; }
    setBad(null);
    update.mutate({
      id: lorry.id,
      model: form.model.trim() || null,
      manufactureDate: form.manufactureDate || null,
      registrationDate: form.registrationDate || null,
      inServiceDate: form.inServiceDate || null,
      purchaseDate: form.purchaseDate || null,
      // Math.round: 1234.56 * 100 is 123455.99999 in floating point.
      purchasePriceSen: rm ? Math.round(Number(rm) * 100) : null,
      costPerKmSen: perKm ? Math.round(Number(perKm) * 100) : null,
    }, { onSuccess: () => setEditing(false), onError: writeFailedAs("Vehicle details were not saved") });
  };

  const date = (v: string | null | undefined) => (v ? fmtDate(v) : null);
  return (
    <FleetCard
      title="Vehicle & purchase"
      sub="Road tax, insurance and PUSPAKOM are renewals under Compliance."
      actions={!editing && <button type="button" className={BTN_SEC} onClick={() => { setForm(initial()); setBad(null); setEditing(true); }}>Edit</button>}
    >
      {!editing ? (
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-[13px] font-bold text-ink-secondary">Vehicle</h3>
            <FactGrid min={180}>
              <Fact label="Model" value={lorry.model} />
              <Fact label="Manufactured" value={date(col(lorry, "manufacture_date"))} />
              <Fact label="Registered (JPJ)" value={date(col(lorry, "registration_date"))} />
              <Fact label="First day in service" value={date(col(lorry, "in_service_date"))} />
            </FactGrid>
          </div>
          <div>
            <h3 className="mb-1 text-[13px] font-bold text-ink-secondary">Purchase</h3>
            <FactGrid min={180}>
              <Fact label="Purchase date" value={date(lorry.purchase_date)} />
              <Fact label="Purchase price" value={lorry.purchase_price_sen != null ? fmtSen(lorry.purchase_price_sen) : null} />
              <Fact label="Running cost per km" value={lorry.cost_per_km_sen != null ? fmtSen(lorry.cost_per_km_sen) : null} hint="Times the km driven on the Live Map" />
            </FactGrid>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className={FORM_GRID}>
            <Field label="Model"><input className={INPUT} value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. Isuzu NPR 3.0" /></Field>
            <Field label="Manufactured"><DateField fullWidth className={INPUT} value={form.manufactureDate} onChange={(iso) => set("manufactureDate", iso)} aria-label="Manufactured" /></Field>
            <Field label="Registered (JPJ)"><DateField fullWidth className={INPUT} value={form.registrationDate} onChange={(iso) => set("registrationDate", iso)} aria-label="Registered (JPJ)" /></Field>
            <Field label="First day in service"><DateField fullWidth className={INPUT} value={form.inServiceDate} onChange={(iso) => set("inServiceDate", iso)} aria-label="First day in service" /></Field>
            <Field label="Purchase date"><DateField fullWidth className={INPUT} value={form.purchaseDate} onChange={(iso) => set("purchaseDate", iso)} aria-label="Purchase date" /></Field>
            <Field label="Purchase price (RM)"><input className={INPUT} inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} placeholder="e.g. 128000" /></Field>
            {/* Fuel, tyres, service, driver: whatever the company counts as running cost, per km. */}
            <Field label="Running cost per km (RM)"><input className={INPUT} inputMode="decimal" value={form.perKm} onChange={(e) => set("perKm", e.target.value)} placeholder="e.g. 0.85" /></Field>
          </div>
          {bad && <p role="alert" className="text-[13px] font-semibold text-err">{bad}</p>}
          <Actions busy={update.isPending} onSave={save} onCancel={() => { setEditing(false); setBad(null); }} />
        </div>
      )}
    </FleetCard>
  );
}
