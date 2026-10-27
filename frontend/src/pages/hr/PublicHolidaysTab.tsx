/* Employees & Attendance > Public Holidays (from Hookka's PublicHolidaysCard):
 * dates nobody is docked for not working, and on which any hours count as
 * public-holiday OT. A company list, kept by HR. */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";
import { Empty, Field, errText, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, useHolidays, useEmployees } from "./hrApi";

export function PublicHolidaysTab() {
  const toast = useToast();
  const dialog = useDialog();
  const holidays = useHolidays();
  const canManage = useEmployees().data?.canManage ?? false;
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const list = holidays.data?.holidays ?? [];
  const years = [...new Set(list.map((h) => h.date.slice(0, 4)))].sort().reverse();

  async function add() {
    if (!date) return;
    setSaving(true);
    try {
      await api.post(`${HR}/holidays`, { date, name });
      toast.success(`${formatDate(date)} added`);
      setDate("");
      setName("");
      holidays.reload();
    } catch (e) {
      toast.error(errText(e, "Could not add the public holiday."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(d: string, label: string | null) {
    const ok = await dialog.confirm({
      title: `Remove ${formatDate(d)}${label ? ` (${label})` : ""}?`,
      message: "That day becomes a normal working day again: not working it counts as absent.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${HR}/holidays/${d}`);
      toast.success(`${formatDate(d)} removed`);
      holidays.reload();
    } catch (e) {
      toast.error(errText(e, "Could not remove the public holiday."));
    }
  }

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3">
          <Field label="Date" className="w-44">
            <DateField fullWidth value={date} onChange={setDate} aria-label="Holiday date" />
          </Field>
          <Field label="Name (optional)" className="w-64 max-sm:w-full">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Deepavali" />
          </Field>
          <button type="button" className={primaryBtn} disabled={!date || saving} onClick={() => void add()}>
            <Plus size={11} /> Add
          </button>
        </div>
      )}
      {holidays.loading && !holidays.data && <div className="text-[11px] text-ink-muted">Loading public holidays...</div>}
      {holidays.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{holidays.error}</div>}
      {holidays.data && list.length === 0 && <Empty>No public holidays yet. Add the dates the company is closed so nobody is docked for them.</Empty>}
      {years.map((y) => (
        <div key={y}>
          <div className="mb-1 font-mono text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted">{y}</div>
          <div className="flex flex-wrap gap-1.5">
            {list
              .filter((h) => h.date.startsWith(y))
              .map((h) => (
                <span key={h.date} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11.5px]">
                  <span className="font-mono">{formatDate(h.date)}</span>
                  {h.name && <span className="text-ink-secondary">{h.name}</span>}
                  {canManage && (
                    <button type="button" className="text-ink-muted hover:text-err" aria-label={`Remove ${h.date}`} onClick={() => void remove(h.date, h.name)}>
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
