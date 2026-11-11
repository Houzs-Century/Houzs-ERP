// A lorry's service and workshop visits, inside the lorry drawer: add, edit and delete a
// record (with the next service due and notes), and upload or view its invoice. The same
// fields the old LorryDetail page carried, so nothing it could do is lost.
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { fmtDate, fmtSen } from "../../../vendor/shared/format";
import { DateField } from "../../../vendor/scm/components/DateField";
import { useConfirm } from "../../../vendor/scm/components/ConfirmDialog";
import { writeFailedAs } from "../../../vendor/scm/lib/mutation-error";
import {
  fetchServiceInvoiceUrl, useCreateLorryServiceRecord, useDeleteLorryServiceRecord, useLorryServiceRecords,
  useUpdateLorryServiceRecord, useUploadServiceInvoice, type LorryServiceRecord,
} from "../../../vendor/scm/lib/lorries-queries";
import { Card, inputCls } from "./ui";
import { openLoadedTab } from "../../../lib/openLoadedTab";

const LinkBtn = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} className="text-[12.5px] font-semibold text-primary hover:underline">{children}</button>
);

export type ServiceForm = { date: string; what: string; workshop: string; cost: string; km: string; nextDate: string; nextKm: string; notes: string };
export const BLANK_SERVICE: ServiceForm = { date: "", what: "", workshop: "", cost: "", km: "", nextDate: "", nextKm: "", notes: "" };

export const serviceFormOf = (r: LorryServiceRecord): ServiceForm => ({
  date: r.service_date.slice(0, 10), what: r.description, workshop: r.workshop ?? "", cost: String(r.cost_sen / 100),
  km: r.odometer_km == null ? "" : String(r.odometer_km), nextDate: r.next_service_date?.slice(0, 10) ?? "",
  nextKm: r.next_service_km == null ? "" : String(r.next_service_km), notes: r.notes ?? "",
});

/** What a save sends: blanks become null, RM becomes sen, km whole numbers. */
export const serviceBody = (f: ServiceForm) => ({
  serviceDate: f.date, description: f.what.trim(), workshop: f.workshop.trim() || null,
  costSen: Math.round(Number(f.cost || 0) * 100), odometerKm: f.km.trim() ? Math.round(Number(f.km)) : null,
  nextServiceDate: f.nextDate || null, nextServiceKm: f.nextKm.trim() ? Math.round(Number(f.nextKm)) : null, notes: f.notes.trim() || null,
});

/** Null when the form can be saved, else what to fix. */
export function serviceProblem(f: ServiceForm): string | null {
  if (!f.date || !f.what.trim()) return "Enter the date and what was done.";
  if ([f.cost, f.km, f.nextKm].some((v) => v.trim() !== "" && !(Number(v) >= 0))) return "Cost and kilometres must be numbers of 0 or more.";
  return null;
}

function ServiceRecordForm({ initial, pending, onSave, onCancel }: { initial: ServiceForm; pending: boolean; onSave: (f: ServiceForm) => void; onCancel: () => void }) {
  const [f, setF] = useState(initial);
  const problem = serviceProblem(f);
  const lbl = "text-[11px] text-ink-muted";
  return (
    <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-3">
      <label className={lbl}>Date<DateField value={f.date} onChange={(v) => setF({ ...f, date: v })} fullWidth aria-label="Service date" /></label>
      <label className={lbl}>Workshop<input value={f.workshop} onChange={(e) => setF({ ...f, workshop: e.target.value })} className={inputCls} /></label>
      <label className={`col-span-2 ${lbl}`}>What was done<input value={f.what} onChange={(e) => setF({ ...f, what: e.target.value })} className={inputCls} /></label>
      <label className={lbl}>Cost (RM)<input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} className={inputCls} /></label>
      <label className={lbl}>Odometer (km)<input inputMode="numeric" value={f.km} onChange={(e) => setF({ ...f, km: e.target.value })} className={inputCls} /></label>
      <label className={lbl}>Next service date<DateField value={f.nextDate} onChange={(v) => setF({ ...f, nextDate: v })} fullWidth aria-label="Next service date" /></label>
      <label className={lbl}>Next service at (km)<input inputMode="numeric" value={f.nextKm} onChange={(e) => setF({ ...f, nextKm: e.target.value })} className={inputCls} /></label>
      <label className={`col-span-2 ${lbl}`}>Notes<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className={inputCls} /></label>
      {problem && f.what !== "" && <p className="col-span-2 text-[12px] text-[color:var(--hz-dk-err,#8a2c2c)]">{problem}</p>}
      <div className="col-span-2 flex gap-2">
        <button type="button" disabled={problem !== null || pending} onClick={() => onSave(f)} className="min-h-[40px] rounded-md bg-primary px-3 text-[12.5px] font-semibold text-white disabled:opacity-50">Save</button>
        <button type="button" onClick={onCancel} className="min-h-[40px] px-2 text-[12.5px] text-ink">Cancel</button>
      </div>
    </div>
  );
}

export function ServiceRecords({ lorryId }: { lorryId: string }) {
  const records = useLorryServiceRecords(lorryId);
  const create = useCreateLorryServiceRecord(lorryId);
  const update = useUpdateLorryServiceRecord(lorryId);
  const upload = useUploadServiceInvoice(lorryId);
  const del = useDeleteLorryServiceRecord(lorryId);
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const add = (f: ServiceForm) => create.mutate(serviceBody(f), { onSuccess: () => setAdding(false), onError: writeFailedAs("The service record was not saved") });
  const save = (id: string, f: ServiceForm) => update.mutate({ id, ...serviceBody(f) }, { onSuccess: () => setEditId(null), onError: writeFailedAs("The service record was not saved") });
  const attach = (id: string, file: File | undefined) => { if (file) upload.mutate({ id, file }, { onError: writeFailedAs("The invoice was not uploaded") }); };
  const view = (id: string) => { void openLoadedTab(async () => (await fetchServiceInvoiceUrl(id)).url, null).catch(writeFailedAs("The invoice could not be opened")); };
  const remove = (r: LorryServiceRecord) => {
    void confirm({ title: "Delete this service record?", body: `${fmtDate(r.service_date)} · ${r.description}`, confirmLabel: "Delete", danger: true })
      .then((ok) => { if (ok) del.mutate(r.id, { onError: writeFailedAs("The record was not deleted") }); });
  };
  const list = records.data ?? [];
  return (
    <Card title="Service and workshop" action={<span className="flex gap-3"><LinkBtn onClick={() => setAdding(true)}>Add record</LinkBtn><Link to={`/fleet-health/${lorryId}`} className="text-[12.5px] font-semibold text-primary hover:underline">Repairs</Link></span>}>
      {adding && <ServiceRecordForm initial={BLANK_SERVICE} pending={create.isPending} onSave={add} onCancel={() => setAdding(false)} />}
      {records.isError && <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">Service records could not be loaded.</p>}
      {!records.isLoading && !records.isError && list.length === 0 && <p className="text-[12.5px] text-ink-muted">No service recorded yet.</p>}
      {list.map((r) => editId === r.id
        ? <ServiceRecordForm key={r.id} initial={serviceFormOf(r)} pending={update.isPending} onSave={(f) => save(r.id, f)} onCancel={() => setEditId(null)} />
        : (
          <div key={r.id} className="flex items-start justify-between gap-2 border-t border-border-subtle py-2 text-[12.5px] first:border-t-0">
            <div className="min-w-0">
              <div className="font-semibold text-ink">{fmtDate(r.service_date)}</div>
              <div className="text-ink">{r.description}</div>
              <div className="text-ink-muted">{[r.workshop, r.odometer_km != null ? `${r.odometer_km.toLocaleString()} km` : null].filter(Boolean).join(" · ")}</div>
              {(r.next_service_date || r.next_service_km != null) && (
                <div className="text-ink-muted">Next service: {[r.next_service_date ? fmtDate(r.next_service_date) : null, r.next_service_km != null ? `${r.next_service_km.toLocaleString()} km` : null].filter(Boolean).join(" or ")}</div>
              )}
              {r.notes && <div className="text-ink-muted">{r.notes}</div>}
              <div className="mt-1 flex flex-wrap gap-3">
                {r.invoice_key && <LinkBtn onClick={() => view(r.id)}>View invoice</LinkBtn>}
                <label className="cursor-pointer text-[12.5px] font-semibold text-primary hover:underline">
                  {upload.isPending && upload.variables.id === r.id ? "Uploading…" : r.invoice_key ? "Replace invoice" : "Upload invoice"}
                  <input type="file" accept="image/*,application/pdf" className="sr-only" disabled={upload.isPending}
                    onChange={(e) => { attach(r.id, e.target.files?.[0]); e.target.value = ""; }} />
                </label>
              </div>
            </div>
            <span className="flex flex-none items-center gap-3"><b>{fmtSen(r.cost_sen)}</b>
              <LinkBtn onClick={() => setEditId(r.id)}>Edit</LinkBtn>
              <LinkBtn onClick={() => remove(r)}>Delete</LinkBtn></span>
          </div>
        ))}
    </Card>
  );
}
