/* Trip Pay > Rates (HC-0125 phase 5): every amount Nico's sheet pays, as an
 * effective-dated version like the pay rules. A version may start on a past
 * date (September's rates set after the fact) but never inside a payroll
 * month that is already approved. */
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { OUTSTATION_AREAS, OUTSTATION_LABEL, normalizeTripRates, tripRatesProblem, type OutstationArea, type TripRates } from "../../vendor/shared/hr-trip-pay";
import { Field, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, rmFromSen, senFromRm, useTripRates } from "./hrApi";

type MoneyKey = Exclude<keyof TripRates, "commission2Bps" | "commission3Bps" | "leaveCutBps" | "leaveCutAfterBps" | "driverOutstationSen" | "helperTransportSen" | "overnightSen" | "overnightMinHours">;
const MONEY: { key: MoneyKey; label: string }[] = [
  { key: "fairSen", label: "Fair, per day" },
  { key: "fairNightSen", label: "Fair night" },
  { key: "fairNoonSen", label: "Fair noon" },
  { key: "fair2ndSen", label: "Fair 2nd trip" },
  { key: "fair2BoothSen", label: "Fair, 1 trip 2 booths" },
  { key: "serviceDeliverySen", label: "Service - delivery" },
  { key: "servicePickupSen", label: "Service - pickup" },
  { key: "serviceInspectionSen", label: "Service - inspection" },
  { key: "supplierTripSen", label: "Supplier - per trip" },
  { key: "supplierFullSen", label: "Supplier - full load" },
  { key: "transferSen", label: "Transfer item" },
];

type Draft = Record<string, string>;
const pctText = (bps: number) => String(bps / 100);
const bpsOf = (pct: string) => Math.round(Number(pct) * 100);

const draftOf = (r: TripRates): Draft => {
  const d: Draft = {
    commission3: pctText(r.commission3Bps),
    commission2: pctText(r.commission2Bps),
    cuts: r.leaveCutBps.map(pctText).join(", "),
    cutAfter: pctText(r.leaveCutAfterBps),
    overnight: rmFromSen(r.overnightSen),
    overnightHours: String(r.overnightMinHours),
  };
  for (const m of MONEY) d[m.key] = rmFromSen(r[m.key]);
  for (const a of OUTSTATION_AREAS) {
    d[`driver_${a}`] = rmFromSen(r.driverOutstationSen[a]);
    d[`helper_${a}`] = rmFromSen(r.helperTransportSen[a]);
  }
  return d;
};

const ratesOf = (d: Draft): TripRates => {
  const raw: Record<string, unknown> = {
    commission3Bps: bpsOf(d.commission3),
    commission2Bps: bpsOf(d.commission2),
    leaveCutBps: d.cuts
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(bpsOf),
    leaveCutAfterBps: bpsOf(d.cutAfter),
    overnightSen: senFromRm(d.overnight),
    overnightMinHours: Number(d.overnightHours),
    driverOutstationSen: Object.fromEntries(OUTSTATION_AREAS.map((a) => [a, senFromRm(d[`driver_${a}`])])),
    helperTransportSen: Object.fromEntries(OUTSTATION_AREAS.map((a) => [a, senFromRm(d[`helper_${a}`])])),
  };
  for (const m of MONEY) raw[m.key] = senFromRm(d[m.key]);
  return normalizeTripRates(raw);
};

export function TripRatesDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const q = useTripRates();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [from, setFrom] = useState(todayMY());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const current = d?.effectiveToday;
  const form = draft ?? (current ? draftOf(current) : null);
  const set = (k: string, v: string) => setDraft((p) => ({ ...(p ?? form ?? {}), [k]: v }));

  const save = async () => {
    if (!form) return;
    const rates = ratesOf(form);
    const problem = tripRatesProblem(rates);
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      await api.post(`${HR}/trip-rates`, { effectiveFrom: from, rates, note });
      toast.success(`Rates from ${formatDate(from)} saved`);
      setDraft(null);
      q.reload();
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the rates."));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number, effectiveFrom: string) => {
    if (!(await dialog.confirm({ title: `Remove the rates from ${formatDate(effectiveFrom)}?`, confirmLabel: "Remove", tone: "danger" }))) return;
    try {
      await api.del(`${HR}/trip-rates/${id}`);
      toast.success("Rates removed");
      q.reload();
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not remove the rates."));
    }
  };

  const money = (k: string, label: string) => (
    <Field key={k} label={`${label} (RM)`}>
      <input className={inputCls} value={form?.[k] ?? ""} disabled={!d?.canManage} onChange={(e) => set(k, e.target.value)} inputMode="decimal" />
    </Field>
  );
  return (
    <ResizableDrawer
      onClose={onClose}
      title="Trip pay rates"
      subtitle={d ? `In force today; ${d.versions.length ? `${d.versions.length} dated version(s)` : "the defaults from Nico's sheet"}` : "Loading..."}
      storageKey="hr-trip-rates-drawer"
      defaultWidth={560}
      footer={
        d?.canManage ? (
          <div className="flex items-end justify-end gap-2">
            <Field label="Takes effect" className="w-40">
              <DateField fullWidth value={from} onChange={setFrom} aria-label="Takes effect" />
            </Field>
            <Field label="Note" className="w-48">
              <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <button type="button" className={ghostBtn} onClick={onClose}>
              Close
            </button>
            <button type="button" className={primaryBtn} disabled={busy || !form} onClick={() => void save()}>
              Save rates
            </button>
          </div>
        ) : undefined
      }
    >
      {form && (
        <div className="space-y-3 p-3">
          <section>
            <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Driver commission (% of Local Total)</h3>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <Field label="3-person crew (%)" hint="1 driver + 2 helpers, or 2 drivers + 1 helper">
                <input className={inputCls} value={form.commission3} disabled={!d?.canManage} onChange={(e) => set("commission3", e.target.value)} inputMode="decimal" />
              </Field>
              <Field label="2-person crew (%)" hint="1 driver + 1 helper">
                <input className={inputCls} value={form.commission2} disabled={!d?.canManage} onChange={(e) => set("commission2", e.target.value)} inputMode="decimal" />
              </Field>
              <Field label="Cut per missed day (%)" hint="1st, 2nd, 3rd day... added up">
                <input className={inputCls} value={form.cuts} disabled={!d?.canManage} onChange={(e) => set("cuts", e.target.value)} />
              </Field>
              <Field label="Each later day (%)">
                <input className={inputCls} value={form.cutAfter} disabled={!d?.canManage} onChange={(e) => set("cutAfter", e.target.value)} inputMode="decimal" />
              </Field>
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Driver allowances</h3>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">{MONEY.map((m) => money(m.key, m.label))}</div>
          </section>
          <section>
            <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Overnight, driver and helper</h3>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              {money("overnight", "Per time")}
              <Field label="When a punch runs past midnight and lasts over (hours)">
                <input className={inputCls} value={form.overnightHours} disabled={!d?.canManage} onChange={(e) => set("overnightHours", e.target.value)} inputMode="decimal" />
              </Field>
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Outstation, per day per area</h3>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              {OUTSTATION_AREAS.map((a: OutstationArea) => money(`driver_${a}`, `Driver, ${OUTSTATION_LABEL[a]}`))}
              {OUTSTATION_AREAS.map((a: OutstationArea) => money(`helper_${a}`, `Helper, ${OUTSTATION_LABEL[a]}`))}
            </div>
          </section>
          {d && d.versions.length > 0 && (
            <section>
              <h3 className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Dated versions</h3>
              {d.versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between py-0.5 text-[12px]">
                  <span>
                    From <span className="font-mono">{formatDate(v.effectiveFrom)}</span>
                    {v.note ? ` · ${v.note}` : ""}
                  </span>
                  {d.canManage && (
                    <button type="button" className="text-ink-muted hover:text-err" aria-label={`Remove rates from ${v.effectiveFrom}`} onClick={() => void remove(v.id, v.effectiveFrom)}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </ResizableDrawer>
  );
}
