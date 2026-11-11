// One driver or helper (owner 2026-11-07, the Coverage & Fleet design): their details, the
// lorry they usually crew, their leave and whether they are active. Read first, Edit to
// change; with no person it is the New driver / New helper form.
import { useState } from "react";
import { formatPhone } from "@2990s/shared/phone";
import { ResizableDrawer } from "../../../components/ResizableDrawer";
import { todayMY } from "../../../vendor/shared/format";
import { DateField } from "../../../vendor/scm/components/DateField";
import { useConfirm } from "../../../vendor/scm/components/ConfirmDialog";
import { writeFailedAs } from "../../../vendor/scm/lib/mutation-error";
import { useCreateDriver, useUpdateDriver } from "../../../vendor/scm/lib/drivers-queries";
import { useCreateHelper, useUpdateHelper } from "../../../vendor/scm/lib/helpers-queries";
import { useCreateDriverLeave, useDeleteDriverLeave, type DriverLeaveRow } from "../../../vendor/scm/lib/delivery-zones-queries";
import type { LorryRow } from "../../../vendor/scm/lib/lorries-queries";
import type { ThreePLCompanyRow } from "../../../vendor/scm/lib/threepl-companies-queries";
import {
  crewFormOf, crewFormProblem, crewPatch, employerLabel, initials, leaveDays, leaveOf, leaveRange, leaveState, lorriesOf,
  type CrewForm, type CrewKind, type CrewPerson, type LeaveState,
} from "./crewModel";
import { groupWarehouses, type WarehouseLite } from "./lorryModel";
import { Card, Chip, Field, ReadRows, Switch, inputCls, primaryBtn, secondaryBtn, type Tone } from "./ui";

type Props = {
  kind: CrewKind; person: CrewPerson | null; lorries: LorryRow[]; warehouses: WarehouseLite[];
  carriers: ThreePLCompanyRow[]; leave: DriverLeaveRow[]; onClose: () => void;
};

export function CrewDrawer({ kind, person, lorries, warehouses, carriers, leave, onClose }: Props) {
  const [editing, setEditing] = useState(person === null);
  const role = kind === "driver" ? "Driver" : "Helper";
  const carrierName = (id: string) => carriers.find((c) => c.id === id)?.name ?? null;
  return (
    <ResizableDrawer onClose={onClose} storageKey="fleet-crew-drawer" defaultWidth={520} ariaLabel={person ? `${role} ${person.name}` : `New ${kind}`}
      title={person ? (
        <span className="flex items-center gap-3">
          <span className="grid h-11 w-11 flex-none place-items-center rounded-full bg-primary-soft text-[15px] font-bold text-primary">{initials(person.name)}</span>
          <span className="flex flex-col gap-1"><span className="text-[17px] font-bold">{person.name}</span>
            <span className="flex flex-wrap items-center gap-1.5"><span className="text-[12px] font-normal text-ink-muted">{role} · {person.code}</span>
              <Chip tone={person.inHouse ? "green" : "orange"}>{person.inHouse ? "In-house" : "Outsource"}</Chip>
              <Chip tone={person.active ? "green" : "grey"}>{person.active ? "Active" : "Inactive"}</Chip></span></span>
        </span>
      ) : `New ${kind}`}
      headerActions={person && !editing ? (
        <span className="flex gap-2">
          <button type="button" onClick={() => setEditing(true)} className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-white">Edit</button>
          {person.phone && <a href={`tel:${person.phone.replace(/[^0-9+]/g, "")}`} className="rounded-md border border-white/40 px-3 py-1.5 text-[12.5px] font-semibold text-white">Call</a>}
        </span>
      ) : null}>
      {editing
        ? <CrewEdit kind={kind} person={person} warehouses={warehouses} carriers={carriers} onDone={person ? () => setEditing(false) : onClose} />
        : person && (
          <div className="space-y-3 p-4">
            <Card title="Details">
              <ReadRows rows={[
                ["Phone", person.phone ? formatPhone(person.phone) : "Not recorded"],
                ["IC number", person.ic || "Not recorded"],
                ...(kind === "driver" ? [["Vehicle", person.vehicle || "—"] as [string, string]] : []),
                ["Works for", employerLabel(person, carrierName)],
                ["Works from", warehouses.find((w) => w.id === person.warehouseId)?.name ?? "Not set"],
                [kind === "driver" ? "Usually drives" : "Usually rides in", <UsualLorry key="l" lorries={lorriesOf(lorries, kind, person.id)} />],
              ]} />
            </Card>
            <LeaveCard kind={kind} person={person} rows={leaveOf(leave, kind, person.id)} />
            <ActiveCard kind={kind} person={person} />
          </div>
        )}
    </ResizableDrawer>
  );
}

const UsualLorry = ({ lorries }: { lorries: LorryRow[] }) => lorries.length === 0
  ? <span className="text-ink-muted">No regular lorry. Set it on the lorry, in the Lorries tab.</span>
  : <span className="flex flex-wrap gap-1">{lorries.map((l) => <span key={l.id} className="rounded-md bg-[#1d2420] px-1.5 py-0.5 font-mono text-[12px] tracking-wider text-white">{l.plate}</span>)}</span>;

const LEAVE_CHIP: Record<LeaveState, [string, Tone]> = { past: ["Past", "grey"], now: ["On leave now", "amber"], upcoming: ["Upcoming", "blue"] };

function LeaveCard({ kind, person, rows }: { kind: CrewKind; person: CrewPerson; rows: DriverLeaveRow[] }) {
  const create = useCreateDriverLeave();
  const del = useDeleteDriverLeave();
  const confirm = useConfirm();
  const today = todayMY();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ from: today, to: today, reason: "" });
  /* Leave is an in-house concept: the route refuses a 3PL driver's leave (driver-leave.ts isInHouseDriver). */
  const allowed = kind === "helper" || person.inHouse;
  const save = () => create.mutate(
    { ...(kind === "driver" ? { driverId: person.id } : { helperId: person.id }), startDate: f.from, endDate: f.to, reason: f.reason.trim() || null },
    { onSuccess: () => { setAdding(false); setF({ from: today, to: today, reason: "" }); }, onError: writeFailedAs("The leave was not saved") },
  );
  const remove = (r: DriverLeaveRow) => {
    void confirm({ title: "Remove this leave?", body: `${person.name}, ${leaveRange(r.startDate, r.endDate)}. They become available for the auto-assigner again.`, confirmLabel: "Remove" })
      .then((ok) => { if (ok) del.mutate(r.id, { onError: writeFailedAs("The leave was not removed") }); });
  };
  return (
    <Card title="Leave" action={allowed && !adding ? <button type="button" onClick={() => setAdding(true)} className="text-[12.5px] font-semibold text-primary hover:underline">Add leave</button> : null}>
      {!allowed && <p className="text-[12.5px] text-ink-muted">Leave is kept for in-house drivers only.</p>}
      {adding && (
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-3">
          <label className="text-[11px] text-ink-muted">From<DateField value={f.from} onChange={(v) => setF({ ...f, from: v })} fullWidth aria-label="Leave from" /></label>
          <label className="text-[11px] text-ink-muted">To<DateField value={f.to} onChange={(v) => setF({ ...f, to: v })} fullWidth aria-label="Leave to" /></label>
          <label className="col-span-2 text-[11px] text-ink-muted">Reason (optional)<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="MC, annual leave" className={inputCls} /></label>
          {f.from > f.to && <p className="col-span-2 text-[12px] text-[color:var(--hz-dk-err,#8a2c2c)]">The start date must be on or before the end date.</p>}
          <div className="col-span-2 flex gap-2">
            <button type="button" disabled={!f.from || !f.to || f.from > f.to || create.isPending} onClick={save} className={primaryBtn}>{create.isPending ? "Saving…" : "Save leave"}</button>
            <button type="button" onClick={() => setAdding(false)} className="min-h-[40px] px-2 text-[12.5px] text-ink">Cancel</button>
          </div>
        </div>
      )}
      {allowed && rows.length === 0 && !adding && <p className="rounded-lg border border-dashed border-border p-2.5 text-[12.5px] text-ink-muted">No leave booked.</p>}
      {rows.map((r) => {
        const [text, tone] = LEAVE_CHIP[leaveState(r.startDate, r.endDate, today)];
        const n = leaveDays(r.startDate, r.endDate);
        return (
          <div key={r.id} className="flex items-center gap-2 border-t border-border-subtle py-2 first:border-t-0">
            <span className="flex-1 text-[12.5px]"><span className="block font-semibold text-ink">{leaveRange(r.startDate, r.endDate)}</span>
              <span className="text-ink-muted">{r.reason || "No reason given"} · {n} {n === 1 ? "day" : "days"}</span></span>
            <Chip tone={tone}>{text}</Chip>
            <button type="button" onClick={() => remove(r)} disabled={del.isPending} className="text-[12.5px] font-semibold text-primary hover:underline">Remove</button>
          </div>
        );
      })}
    </Card>
  );
}

function ActiveCard({ kind, person }: { kind: CrewKind; person: CrewPerson }) {
  const driver = useUpdateDriver();
  const helper = useUpdateHelper();
  const confirm = useConfirm();
  const busy = driver.isPending || helper.isPending;
  const flip = () => {
    void confirm(person.active
      ? { title: `Mark ${person.name} inactive?`, body: `They leave the ${kind} pickers on delivery planning. Their history stays.`, confirmLabel: "Mark inactive" }
      : { title: `Mark ${person.name} active again?`, confirmLabel: "Mark active" })
      .then((ok) => {
        if (!ok) return;
        const opts = { onError: writeFailedAs(`The ${kind} was not changed`) };
        if (kind === "driver") driver.mutate({ id: person.id, active: !person.active }, { onError: opts.onError });
        else helper.mutate({ id: person.id, active: !person.active }, { onError: opts.onError });
      });
  };
  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className="flex-1"><span className="block text-[13px] font-semibold text-ink">Active</span>
          <span className="text-[12px] text-ink-muted">{person.active ? `Offered in the ${kind} pickers.` : `Hidden from the ${kind} pickers.`}</span></span>
        <Switch on={person.active} label="Active" onClick={flip} disabled={busy} />
      </div>
    </Card>
  );
}

function CrewEdit({ kind, person, warehouses, carriers, onDone }: {
  kind: CrewKind; person: CrewPerson | null; warehouses: WarehouseLite[]; carriers: ThreePLCompanyRow[]; onDone: () => void;
}) {
  const createDriver = useCreateDriver();
  const createHelper = useCreateHelper();
  const updateDriver = useUpdateDriver();
  const updateHelper = useUpdateHelper();
  const [f, setF] = useState<CrewForm>(crewFormOf(person));
  const problem = crewFormProblem(kind, f);
  const pending = createDriver.isPending || createHelper.isPending || updateDriver.isPending || updateHelper.isPending;
  const save = () => {
    const patch = crewPatch(kind, person, f);
    const opts = { onSuccess: onDone, onError: writeFailedAs(person ? `The ${kind} was not saved` : `The ${kind} was not added`) };
    if (person) {
      if (Object.keys(patch).length === 0) { onDone(); return; }
      if (kind === "driver") updateDriver.mutate({ id: person.id, ...patch }, { onSuccess: opts.onSuccess, onError: opts.onError });
      else updateHelper.mutate({ id: person.id, ...patch }, { onSuccess: opts.onSuccess, onError: opts.onError });
    } else if (kind === "driver") createDriver.mutate({ ...patch, name: f.name.trim(), phone: f.phone.trim(), active: true }, { onSuccess: opts.onSuccess, onError: opts.onError });
    else createHelper.mutate({ ...patch, name: f.name.trim(), active: true }, { onSuccess: opts.onSuccess, onError: opts.onError });
  };
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" wide><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} /></Field>
        <Field label={kind === "driver" ? "Phone" : "Phone (optional)"}><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+60 12-345-6789" className={inputCls} /></Field>
        <Field label="IC number"><input value={f.ic} onChange={(e) => setF({ ...f, ic: e.target.value })} className={inputCls} /></Field>
        {kind === "driver" && <Field label="Vehicle" wide><input value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} placeholder="e.g. Hilux WMN1234" className={inputCls} /></Field>}
        <Field label="Who employs them" wide>
          <select value={f.employer} onChange={(e) => setF({ ...f, employer: e.target.value })} className={inputCls}>
            <option value="in">In-house</option>
            <option value="out">Outsource, no 3PL company</option>
            {carriers.length > 0 && <optgroup label="Outsource, 3PL company">{carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}
          </select>
        </Field>
        <Field label="Works from" wide>
          <select value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })} className={inputCls}>
            <option value="">Not set</option>
            {groupWarehouses(warehouses).map((g) => <optgroup key={g.region} label={g.region}>{g.items.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>)}
          </select>
        </Field>
      </div>
      <p className="text-[12px] text-ink-muted">{person ? "The usual lorry is set on the lorry, in the Lorries tab." : "The code is given automatically when you add them."}</p>
      {problem && f.name !== "" && <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={problem !== null || pending} onClick={save} className={primaryBtn}>{pending ? "Saving…" : person ? "Save changes" : `Add ${kind}`}</button>
        <button type="button" onClick={onDone} className={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}
