/* Employees & Attendance > Trip Pay (HC-0125 phase 5): Nico's "Driver Comm +
 * Worker Allowance" sheet as a screen. A trip month (23rd to 22nd) is filled
 * by pasting her Trip Report, or by reading Delivery Planning's lorry runs once
 * the team plans there; every row can be corrected (the job kind, a name).
 * Each person's commission and allowances are worked out from the rows and
 * the rates, and land on the payslip of the month of the same name. */
import { useMemo, useState } from "react";
import { ClipboardPaste, Pencil, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { TRIP_KINDS, TRIP_KIND_LABEL, tripMonthOf, type TripKind } from "../../vendor/shared/hr-trip-pay";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, rmFromSen, senFromRm, useTripPay, type TripPersonPay, type TripRowOut } from "./hrApi";
import { TripRatesDrawer } from "./TripRatesDrawer";

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const SOURCE: Record<TripRowOut["source"], string> = { SHEET: "Pasted", PLANNING: "Planning", MANUAL: "Added" };

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-semibold text-ink">{value}</div>
      {sub && <div className="text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

function NameCell({ p, matched }: { p: { name: string }; matched: number | null | undefined }) {
  if (!p.name && matched === undefined) return null;
  if (matched == null) return <span className="font-semibold text-err" title="Nobody in Employee Master goes by this name">{p.name || "?"}</span>;
  return <span>{p.name}</span>;
}

export function TripPayTab() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? (params.get("month") as string) : tripMonthOf(today);
  const setMonth = (m: string) =>
    setParams(
      (x) => {
        const n = new URLSearchParams(x);
        n.set("month", m);
        return n;
      },
      { replace: true },
    );
  const q = useTripPay(month);
  const d = q.data;
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState<string | null>(null);
  const [editing, setEditing] = useState<TripRowOut | "new" | null>(null);
  const [person, setPerson] = useState<TripPersonPay | null>(null);
  const [rates, setRates] = useState(false);
  const canEdit = !!d?.canManage && !d.locked;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      q.reload();
      return true;
    } catch (e) {
      toast.error(errText(e, "Could not update the trip month."));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const replaceWarning = (d?.sources ?? []).some((s) => s !== "MANUAL") ? " The rows pasted or read before are replaced; rows added by hand stay." : "";
  const importPaste = async () => {
    if (!paste?.trim()) return;
    if (await run(() => api.post(`${HR}/trip-pay/import`, { month, text: paste }), "Trip Report pasted")) setPaste(null);
  };
  const pull = async () => {
    if (!(await dialog.confirm({ title: `Read Delivery Planning for ${month}?`, message: `Every stop of our own lorry runs from ${d?.first ?? ""} to ${d?.last ?? ""} becomes a row.${replaceWarning}`, confirmLabel: "Read" }))) return;
    await run(() => api.post(`${HR}/trip-pay/pull`, { month }), "Lorry runs read");
  };
  const setKind = (r: TripRowOut, kind: TripKind) =>
    void run(
      () =>
        api.patch(`${HR}/trip-pay/rows/${r.id}`, {
          tripDate: r.tripDate,
          docNo: r.docNo,
          transferTo: r.transferTo,
          refNo: r.refNo,
          kind,
          localTotalSen: r.localTotalSen,
          state: r.state,
          lorryPlate: r.lorryPlate,
          driver1: r.driver1.name,
          driver2: r.driver2.name,
          helper1: r.helper1.name,
          helper2: r.helper2.name,
        }),
      "Row updated",
    );
  const remove = async (r: TripRowOut) => {
    if (!(await dialog.confirm({ title: `Remove the ${formatDate(r.tripDate)} row ${r.docNo}?`, confirmLabel: "Remove", tone: "danger" }))) return;
    await run(() => api.del(`${HR}/trip-pay/rows/${r.id}`), "Row removed");
  };

  const peopleCols: Column<TripPersonPay>[] = [
    { key: "empNo", label: "Emp No", getValue: (p) => p.empNo, render: (p) => <span className="font-mono text-[11px] font-semibold text-accent">{p.empNo}</span> },
    { key: "name", label: "Name", getValue: (p) => p.name, render: (p) => p.name },
    { key: "role", label: "Role", getValue: (p) => (p.drove ? "Driver" : "Helper"), render: (p) => (p.drove ? <Pill tone="info">Driver</Pill> : <Pill tone="muted">Helper</Pill>) },
    { key: "base", label: "Commission Base", align: "right", getValue: (p) => p.commission.baseSen, render: (p) => (p.drove ? fmtSen(p.commission.baseSen) : null) },
    {
      key: "rate",
      label: "Rate",
      align: "right",
      getValue: (p) => p.commission.lines[0]?.rateBps ?? 0,
      render: (p) => (p.commission.lines.length ? <span className="font-mono text-[11px]">{p.commission.lines.map((l) => pct(l.rateBps)).join(" / ")}</span> : null),
    },
    {
      key: "missed",
      label: "Missed Work Days",
      align: "right",
      getValue: (p) => p.missed?.days ?? 0,
      render: (p) =>
        p.missed ? (
          <span className={p.missed.days > 0 ? "text-err" : ""}>
            {p.missed.days}
            {p.missed.override != null ? " (HR)" : p.missed.noAttendance ? " (no punches)" : ""}
          </span>
        ) : null,
    },
    { key: "commission", label: "Commission", align: "right", getValue: (p) => p.commission.amountSen, render: (p) => (p.drove ? fmtSen(p.commission.amountSen) : null), total: (r) => fmtSen(r.reduce((s, p) => s + p.commission.amountSen, 0)) },
    { key: "allowance", label: "Allowances", align: "right", getValue: (p) => p.allowanceSen, render: (p) => fmtSen(p.allowanceSen), total: (r) => fmtSen(r.reduce((s, p) => s + p.allowanceSen, 0)) },
    { key: "total", label: "Total", align: "right", getValue: (p) => p.totalSen, render: (p) => <span className="font-semibold">{fmtSen(p.totalSen)}</span>, total: (r) => fmtSen(r.reduce((s, p) => s + p.totalSen, 0)) },
  ];

  const rowCols: Column<TripRowOut>[] = [
    { key: "date", label: "Date", getValue: (r) => r.tripDate, render: (r) => <span className="font-mono">{formatDate(r.tripDate)}</span> },
    { key: "docNo", label: "Doc No.", getValue: (r) => r.docNo, render: (r) => r.docNo },
    { key: "transferTo", label: "Transfer To", getValue: (r) => r.transferTo, render: (r) => r.transferTo },
    { key: "refNo", label: "Ref No.", defaultHidden: true, getValue: (r) => r.refNo, render: (r) => r.refNo },
    {
      key: "kind",
      label: "Job Type",
      getValue: (r) => TRIP_KIND_LABEL[r.kind],
      render: (r) =>
        canEdit ? (
          <select className="h-6 rounded border border-border bg-surface px-1 text-[11px]" value={r.kind} disabled={busy} onClick={(e) => e.stopPropagation()} onChange={(e) => setKind(r, e.target.value as TripKind)}>
            {TRIP_KINDS.map((k) => (
              <option key={k} value={k}>
                {TRIP_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        ) : (
          TRIP_KIND_LABEL[r.kind]
        ),
    },
    { key: "localTotal", label: "Local Total", align: "right", getValue: (r) => r.localTotalSen, render: (r) => (r.localTotalSen ? fmtSen(r.localTotalSen) : null), total: (rows) => fmtSen(rows.reduce((s, r) => s + r.localTotalSen, 0)) },
    { key: "state", label: "State", getValue: (r) => r.state, render: (r) => r.state },
    { key: "lorry", label: "Lorry", getValue: (r) => r.lorryPlate, render: (r) => r.lorryPlate },
    {
      key: "driver",
      label: "Driver",
      getValue: (r) => [r.driver1.name, r.driver2.name].filter(Boolean).join(", "),
      render: (r) => (
        <span className="inline-flex gap-1">
          <NameCell p={r.driver1} matched={r.matched.driver1} />
          {r.driver2.name && <NameCell p={r.driver2} matched={r.matched.driver2} />}
        </span>
      ),
    },
    { key: "helper1", label: "Helper 1", getValue: (r) => r.helper1.name, render: (r) => <NameCell p={r.helper1} matched={r.matched.helper1} /> },
    { key: "helper2", label: "Helper 2", getValue: (r) => r.helper2.name, render: (r) => <NameCell p={r.helper2} matched={r.matched.helper2} /> },
    { key: "source", label: "Source", defaultHidden: true, getValue: (r) => SOURCE[r.source], render: (r) => SOURCE[r.source] },
    {
      key: "actions",
      label: "",
      disableSort: true,
      getValue: () => "",
      render: (r) =>
        canEdit ? (
          <span className="inline-flex gap-2">
            <button type="button" className="text-ink-muted hover:text-accent" aria-label="Edit row" onClick={() => setEditing(r)}>
              <Pencil size={12} />
            </button>
            <button type="button" className="text-ink-muted hover:text-err" aria-label="Remove row" onClick={() => void remove(r)}>
              <Trash2 size={12} />
            </button>
          </span>
        ) : null,
    },
  ];

  const people = useMemo(() => d?.people ?? [], [d]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Trip month" className="w-40">
          <input type="month" className={inputCls} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
        {d && (
          <span className="pb-2 text-[11px] text-ink-secondary">
            {formatDate(d.first)} to {formatDate(d.last)}, paid on the {month} payslip
          </span>
        )}
        {d?.locked && <span className="pb-2"><Pill tone="info">Payroll approved</Pill></span>}
        <span className="ml-auto flex flex-wrap gap-2 pb-1">
          <button type="button" className={ghostBtn} onClick={() => setRates(true)}>
            <Settings2 size={11} /> Rates
          </button>
          {canEdit && (
            <>
              <button type="button" className={ghostBtn} disabled={busy} onClick={() => setEditing("new")}>
                <Plus size={11} /> Add row
              </button>
              <button type="button" className={ghostBtn} disabled={busy} onClick={() => void pull()}>
                <RefreshCw size={11} /> Read Delivery Planning
              </button>
              <button type="button" className={primaryBtn} disabled={busy} onClick={() => setPaste("")}>
                <ClipboardPaste size={11} /> Paste Trip Report
              </button>
            </>
          )}
        </span>
      </div>

      {paste !== null && (
        <div className="space-y-2 rounded-md border border-border bg-surface p-3">
          <div className="text-[11.5px] text-ink-secondary">
            In the Trip Report tab, select the rows from Doc. No. to Helper 2 (the header row may come too), copy, and paste here.{replaceWarning}
          </div>
          <textarea className={`${inputCls} h-40 py-1 font-mono text-[11px]`} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Trip Report rows" />
          <div className="flex justify-end gap-2">
            <button type="button" className={ghostBtn} disabled={busy} onClick={() => setPaste(null)}>
              Cancel
            </button>
            <button type="button" className={primaryBtn} disabled={busy || !paste.trim()} onClick={() => void importPaste()}>
              Import
            </button>
          </div>
        </div>
      )}

      {d && d.unmatched.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
          Names nobody in Employee Master goes by, so they earn nothing yet:{" "}
          <span className="font-semibold">{d.unmatched.map((u) => `${u.name} (${u.rows})`).join(", ")}</span>. Type each under Trip sheet names on the person in Employee Master.
        </div>
      )}
      {people.some((p) => p.missed?.noAttendance && p.missed.override == null) && (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-[11.5px] text-ink-secondary">
          Some drivers have no punches this trip month, so their missed days read 0. Open the driver to enter the days missed without leave.
        </div>
      )}

      {d && d.rows.length > 0 && (
        <div className="grid grid-cols-4 gap-2 max-md:grid-cols-2">
          <Kpi label="Commission" value={fmtSen(d.totals.commissionSen)} sub={`${pct(d.rates.commission3Bps)} / ${pct(d.rates.commission2Bps)} by crew`} />
          <Kpi label="Allowances" value={fmtSen(d.totals.allowanceSen)} />
          <Kpi label="Total" value={fmtSen(d.totals.commissionSen + d.totals.allowanceSen)} />
          <Kpi label="Rows" value={String(d.rows.length)} sub={d.sources.map((s) => (SOURCE as Record<string, string>)[s] ?? s).join(", ")} />
        </div>
      )}

      <DataTable<TripPersonPay>
        tableId="hr-trip-pay-people"
        columns={peopleCols}
        rows={d ? people : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No trip rows for this month yet. Paste the Trip Report or read Delivery Planning."
        getRowKey={(p) => p.employeeId}
        onRowClick={(p) => setPerson(p)}
        exportName={`trip-pay-${month}`}
      />
      {d && d.rows.length > 0 && (
        <DataTable<TripRowOut>
          tableId="hr-trip-rows"
          columns={rowCols}
          rows={d.rows}
          loading={q.loading}
          error={q.error}
          emptyLabel="No trip rows."
          getRowKey={(r) => r.id}
          exportName={`trip-rows-${month}`}
        />
      )}

      {editing && d && <RowDrawer row={editing === "new" ? null : editing} month={month} first={d.first} last={d.last} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} />}
      {person && d && <PersonDrawer p={person} month={month} canEdit={canEdit} onClose={() => setPerson(null)} onSaved={() => { setPerson(null); q.reload(); }} />}
      {rates && <TripRatesDrawer onClose={() => setRates(false)} onSaved={() => q.reload()} />}
    </div>
  );
}

function RowDrawer({ row, month, first, last, onClose, onSaved }: { row: TripRowOut | null; month: string; first: string; last: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    tripDate: row?.tripDate ?? (todayMY() <= last && todayMY() >= first ? todayMY() : last),
    docNo: row?.docNo ?? "",
    transferTo: row?.transferTo ?? "",
    refNo: row?.refNo ?? "",
    kind: (row?.kind ?? "DO") as TripKind,
    localTotal: row ? rmFromSen(row.localTotalSen) : "",
    state: row?.state ?? "",
    lorryPlate: row?.lorryPlate ?? "",
    driver1: row?.driver1.name ?? "",
    driver2: row?.driver2.name ?? "",
    helper1: row?.helper1.name ?? "",
    helper2: row?.helper2.name ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    const localTotalSen = senFromRm(f.localTotal);
    if (!(localTotalSen >= 0)) {
      toast.error("Local Total must be RM 0.00 or more.");
      return;
    }
    setBusy(true);
    try {
      const body = { ...f, localTotalSen };
      if (row) await api.patch(`${HR}/trip-pay/rows/${row.id}`, body);
      else await api.post(`${HR}/trip-pay/rows`, body);
      toast.success(row ? "Row updated" : "Row added");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the row."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ResizableDrawer
      onClose={onClose}
      title={row ? "Edit trip row" : "Add trip row"}
      subtitle={`Trip month ${month}: ${formatDate(first)} to ${formatDate(last)}`}
      storageKey="hr-trip-row-drawer"
      defaultWidth={460}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} disabled={busy || !f.driver1.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 p-3 max-sm:grid-cols-1">
        <Field label="Date">
          <DateField fullWidth value={f.tripDate} onChange={(iso) => set("tripDate", iso)} aria-label="Date" />
        </Field>
        <Field label="Job type">
          <select className={inputCls} value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            {TRIP_KINDS.map((k) => (
              <option key={k} value={k}>
                {TRIP_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Doc No.">
          <input className={inputCls} value={f.docNo} onChange={(e) => set("docNo", e.target.value)} />
        </Field>
        <Field label="Transfer To (DO)">
          <input className={inputCls} value={f.transferTo} onChange={(e) => set("transferTo", e.target.value)} />
        </Field>
        <Field label="Ref No.">
          <input className={inputCls} value={f.refNo} onChange={(e) => set("refNo", e.target.value)} />
        </Field>
        <Field label="Local Total (RM)" hint="Counts toward the driver's commission.">
          <input className={inputCls} value={f.localTotal} onChange={(e) => set("localTotal", e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="State" hint="Decides the outstation allowance.">
          <input className={inputCls} value={f.state} onChange={(e) => set("state", e.target.value)} placeholder="Johor" />
        </Field>
        <Field label="Lorry">
          <input className={inputCls} value={f.lorryPlate} onChange={(e) => set("lorryPlate", e.target.value)} />
        </Field>
        <Field label="Driver">
          <input className={inputCls} value={f.driver1} onChange={(e) => set("driver1", e.target.value)} placeholder="AMIR" />
        </Field>
        <Field label="Driver 2">
          <input className={inputCls} value={f.driver2} onChange={(e) => set("driver2", e.target.value)} />
        </Field>
        <Field label="Helper 1">
          <input className={inputCls} value={f.helper1} onChange={(e) => set("helper1", e.target.value)} />
        </Field>
        <Field label="Helper 2">
          <input className={inputCls} value={f.helper2} onChange={(e) => set("helper2", e.target.value)} />
        </Field>
      </div>
    </ResizableDrawer>
  );
}

function PersonDrawer({ p, month, canEdit, onClose, onSaved }: { p: TripPersonPay; month: string; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState(p.missed?.override != null ? String(p.missed.override) : "");
  const [note, setNote] = useState(p.missed?.note ?? "");
  const [busy, setBusy] = useState(false);
  const saveMissed = async (clear: boolean) => {
    const n = Number(days);
    if (!clear && (!Number.isInteger(n) || n < 0 || n > 31)) {
      toast.error("Missed days: a whole number from 0 to 31.");
      return;
    }
    setBusy(true);
    try {
      await api.put(`${HR}/trip-pay/missed`, { employeeId: p.employeeId, month, missedDays: clear ? null : n, note });
      toast.success(clear ? "Missed days follow the punches again" : "Missed days saved");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the missed days."));
    } finally {
      setBusy(false);
    }
  };
  const line = (label: string, value: string, sub?: string) => (
    <div className="py-0.5 text-[12px]">
      <div className="flex justify-between">
        <span className="text-ink-secondary">{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      {sub && <div className="text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
  return (
    <ResizableDrawer
      onClose={onClose}
      title={
        <span>
          <span className="font-mono">{p.empNo}</span> {p.name}
        </span>
      }
      subtitle={`Trip month ${month} · ${p.drove ? "driver" : "helper"}`}
      storageKey="hr-trip-person-drawer"
      defaultWidth={460}
    >
      <div className="space-y-3 p-3">
        {p.drove && (
          <section>
            <h3 className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Commission</h3>
            {p.commission.lines.map((l) => line(`${l.crew}-person crew: ${fmtSen(l.baseSen)} x ${pct(l.rateBps)}`, fmtSen(l.amountSen)))}
            {p.commission.cutBps > 0 && line(`Rate cut for ${p.commission.missedDays} missed day(s)`, `-${pct(p.commission.cutBps)}`)}
            {line("Commission", fmtSen(p.commission.amountSen))}
          </section>
        )}
        <section>
          <h3 className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Allowances</h3>
          {p.lines.length === 0 && <div className="text-[11.5px] text-ink-muted">None this month.</div>}
          {p.lines.map((l) => (
            <div key={l.key}>{line(`${l.label} x ${l.count} @ ${fmtSen(l.unitSen)}`, fmtSen(l.amountSen), l.dates.map(formatDate).join(", "))}</div>
          ))}
          {line("Total", fmtSen(p.totalSen))}
        </section>
        {p.drove && p.missed && (
          <section className="space-y-2">
            <h3 className="text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Missed working days</h3>
            <div className="text-[11.5px] text-ink-secondary">
              {p.missed.noAttendance
                ? "No punches this trip month, so the screen cannot tell. Enter the days missed without leave."
                : `From the punches: ${p.missed.dates.length} working day(s) with no hours and no leave keyed${p.missed.dates.length ? ` (${p.missed.dates.map(formatDate).join(", ")})` : ""}. Leave is keyed on the Attendance tab.`}
            </div>
            {canEdit && (
              <div className="grid grid-cols-[90px_1fr_auto] items-end gap-2">
                <Field label="Days">
                  <input className={inputCls} value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
                </Field>
                <Field label="Note">
                  <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="From Infotech" />
                </Field>
                <span className="flex gap-2 pb-0.5">
                  {p.missed.override != null && (
                    <button type="button" className={ghostBtn} disabled={busy} onClick={() => void saveMissed(true)}>
                      Use punches
                    </button>
                  )}
                  <button type="button" className={primaryBtn} disabled={busy || days.trim() === ""} onClick={() => void saveMissed(false)}>
                    Save
                  </button>
                </span>
              </div>
            )}
          </section>
        )}
      </div>
    </ResizableDrawer>
  );
}
