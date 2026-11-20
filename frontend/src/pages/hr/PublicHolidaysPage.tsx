/* HR · Public Holidays (step-2 re-skin). The company's public-holiday list —
 * days nobody is docked for not working, on which hours count as public-holiday
 * OT. New design over HrTablePage, real /api/hr/holidays data, add via a modal
 * and remove with a confirm. (Ported from the old PublicHolidaysTab.) */
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { errText } from "../pos-admin/posAdminUi";
import { hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { HrTablePage, Tag, type HrCol } from "./HrTablePage";
import { HR, useEmployees, useHolidays, type PublicHoliday } from "./hrApi";

type Row = PublicHoliday & { id: string };

export function PublicHolidaysPage() {
  const toast = useToast();
  const dialog = useDialog();
  const holidays = useHolidays();
  const canManage = useEmployees().data?.canManage ?? false;
  const [adding, setAdding] = useState(false);

  const today = todayMY().slice(0, 10);
  const year = today.slice(0, 4);
  const rows = useMemo<Row[]>(
    () => (holidays.data?.holidays ?? []).map((h) => ({ ...h, id: h.date })).sort((a, b) => a.date.localeCompare(b.date)),
    [holidays.data],
  );
  const thisYear = rows.filter((h) => h.date.startsWith(year)).length;
  const upcoming = rows.filter((h) => h.date >= today);
  const next = upcoming.at(0);

  async function remove(h: Row) {
    const ok = await dialog.confirm({
      title: `Remove ${formatDate(h.date)}${h.name ? ` (${h.name})` : ""}?`,
      message: "That day becomes a normal working day again: not working it counts as absent.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${HR}/holidays/${h.date}`);
      toast.success(`${formatDate(h.date)} removed`);
      holidays.reload();
    } catch (e) {
      toast.error(errText(e, "Could not remove the public holiday."));
    }
  }

  const columns: HrCol<Row>[] = [
    { key: "date", label: "Date", render: (h) => <span className="font-semibold text-ink">{formatDate(h.date)}</span> },
    { key: "name", label: "Name", render: (h) => h.name || <span className="text-ink-soft">—</span> },
    { key: "status", label: "Status", render: (h) => (h.date < today ? <Tag tone="muted">Past</Tag> : <Tag tone="ok">Upcoming</Tag>) },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (h) =>
        canManage ? (
          <button type="button" onClick={() => void remove(h)} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-err/40 hover:text-err">Remove</button>
        ) : null,
    },
  ];

  return (
    <>
      <HrTablePage<Row>
        title="Public Holidays"
        subtitle="Days nobody is docked for not working"
        actions={canManage ? <button type="button" className={hrPrimaryBtn} onClick={() => setAdding(true)}>+ Add holiday</button> : undefined}
        stats={[
          { label: "Holidays", value: () => rows.length, sub: "on the list", bar: "bg-primary" },
          { label: `This year (${year})`, value: () => thisYear, sub: "national and state", bar: "bg-accent" },
          { label: "Upcoming", value: () => upcoming.length, sub: "today and ahead", bar: "bg-learning" },
          { label: "Next holiday", value: () => (next ? formatDate(next.date) : "—"), sub: next?.name ?? "none ahead", bar: "bg-time" },
        ]}
        rows={rows}
        columns={columns}
        searchOf={(h) => `${h.name ?? ""} ${h.date}`}
        searchPlaceholder="Search holiday"
        loading={holidays.loading && !holidays.data}
        error={holidays.error}
        emptyLabel="No public holidays yet. Add the dates the company is closed so nobody is docked for them."
        footer={() => <><span className="font-semibold text-ink">{rows.length}</span> holidays</>}
      />
      {adding && <AddHolidayModal onClose={() => setAdding(false)} onAdded={() => { setAdding(false); holidays.reload(); }} />}
    </>
  );
}

function AddHolidayModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!date) return;
    setSaving(true);
    try {
      await api.post(`${HR}/holidays`, { date, name });
      toast.success(`${formatDate(date)} added`);
      onAdded();
    } catch (e) {
      toast.error(errText(e, "Could not add the public holiday."));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-6" style={{ background: "rgba(17,20,15,.42)" }} onMouseDown={onClose}>
      <div className="my-10 w-full max-w-[420px] animate-rise rounded-2xl bg-surface shadow-[0_24px_64px_-16px_rgba(17,20,15,.35)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-bold text-ink">Add public holiday</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink">✕</button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Date</span>
            <DateField fullWidth value={date} onChange={setDate} aria-label="Holiday date" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Name (optional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Deepavali" className="h-9 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[12.5px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none" />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className={hrSecondaryBtn}>Cancel</button>
          <button type="button" disabled={!date || saving} onClick={() => void add()} className={hrPrimaryBtn}>{saving ? "Adding…" : "Add holiday"}</button>
        </div>
      </div>
    </div>
  );
}
