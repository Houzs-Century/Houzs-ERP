/* Employees & Attendance > Attendance (HC-0125 phase 2, from Hookka's
 * "Attendance — Phone Punches" card). One day at a time, every active
 * employee listed, so "not punched yet" shows too. Each punch shows where it
 * was (site and distance, a map link) and its selfie. HR can key or correct a
 * day: a forgotten punch, a leave day, a wrong time. */
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { cn, formatDate } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { ATTENDANCE_STATUSES, distanceLabel, type AttendanceStatus } from "../../vendor/shared/hr-attendance";
import { minToHhmm } from "../../vendor/shared/hr-pay-rules";
import { Field, Pill, dangerBtn, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, useAttendance, type AttendanceRowOut, type PunchSide } from "./hrApi";

const hm = (min: number) => (min > 0 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : "");
const shiftDate = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const statusLabel = (s: AttendanceStatus) => ATTENDANCE_STATUSES.find((x) => x.value === s)?.label ?? s;

function PunchCell({ side }: { side: PunchSide | null }) {
  if (!side) return <span className="text-ink-muted">--</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono">{side.clock}</span>
      {side.source === "MANUAL" && <Pill tone="info">HR</Pill>}
      {side.source === "AUTO" && <Pill tone="warn">Auto</Pill>}
    </span>
  );
}

function LocationCell({ side }: { side: PunchSide | null }) {
  if (!side || side.source !== "PHONE") return <span className="text-ink-muted">--</span>;
  const map = side.lat != null && side.lng != null ? `https://www.google.com/maps?q=${side.lat},${side.lng}` : null;
  const label =
    side.geo === "IN" ? (
      <Pill tone="ok">{side.siteName ?? "On site"}</Pill>
    ) : side.geo === "OUT" ? (
      <Pill tone="bad">{side.distanceM != null ? `${distanceLabel(side.distanceM)} from ${side.siteName ?? "site"}` : "Off site"}</Pill>
    ) : (
      <Pill tone="muted">{side.lat != null ? "No site set" : "No GPS"}</Pill>
    );
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      {map && (
        <a href={map} target="_blank" rel="noreferrer" className="text-ink-muted hover:text-accent" aria-label="Open on Google Maps" onClick={(e) => e.stopPropagation()}>
          <MapPin size={12} />
        </a>
      )}
    </span>
  );
}

function PhotoThumb({ id, which, label, onOpen }: { id: number; which: "in" | "out"; label: string; onOpen: (url: string, label: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    api
      .fetchBlobUrl(`${HR}/attendance/${id}/photo?which=${which}`)
      .then((u) => {
        made = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, which]);
  if (failed) return <span className="text-[10px] text-ink-muted">no photo</span>;
  if (!url) return <span className="inline-block h-10 w-10 animate-pulse rounded bg-bg" />;
  return (
    <button
      type="button"
      className="relative h-10 w-10 overflow-hidden rounded border border-border"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(url, label);
      }}
      aria-label={`Open ${label}`}
    >
      <img src={url} alt={label} className="h-full w-full object-cover" />
      <span className="absolute bottom-0 left-0 right-0 bg-black/50 text-center text-[8px] font-bold uppercase text-white">{which}</span>
    </button>
  );
}

export function AttendanceTab() {
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? (params.get("date") as string) : today;
  const setDate = (d: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (d && d !== today) n.set("date", d);
        else n.delete("date");
        return n;
      },
      { replace: true },
    );
  const q = useAttendance(date);
  const [editing, setEditing] = useState<AttendanceRowOut | null>(null);
  const [photo, setPhoto] = useState<{ url: string; label: string } | null>(null);
  const rows = q.data?.rows ?? [];
  const canManage = q.data?.canManage ?? false;

  const counts = useMemo(() => {
    const active = rows.filter((r) => r.employee.status === "ACTIVE");
    return {
      in: active.filter((r) => r.day?.in).length,
      open: active.filter((r) => r.day?.open).length,
      none: active.filter((r) => !r.day).length,
      off: rows.filter((r) => r.day?.in?.geo === "OUT" || r.day?.out?.geo === "OUT").length,
      late: rows.filter((r) => (r.day?.lateMin ?? 0) > 0).length,
    };
  }, [rows]);

  const columns: Column<AttendanceRowOut>[] = [
    { key: "empNo", label: "Emp No", getValue: (r) => r.employee.empNo, render: (r) => <span className="font-mono text-[11px] font-semibold text-accent">{r.employee.empNo}</span> },
    {
      key: "name",
      label: "Name",
      getValue: (r) => r.employee.name,
      render: (r) => (
        <span>
          {r.employee.name}
          {!r.employee.linked && <span className="ml-1 text-[10px] text-amber-800">(no ERP account)</span>}
        </span>
      ),
    },
    { key: "department", label: "Department", getValue: (r) => r.employee.department ?? "", render: (r) => r.employee.department ?? <span className="text-ink-muted">--</span> },
    {
      key: "status",
      label: "Status",
      getValue: (r) => (r.day ? (r.day.open ? "Clocked in" : statusLabel(r.day.status)) : "No punch"),
      render: (r) =>
        !r.day ? (
          <Pill tone="muted">No punch</Pill>
        ) : r.day.open ? (
          <Pill tone="info">Clocked in</Pill>
        ) : r.day.status === "PRESENT" ? (
          <Pill tone="ok">Present</Pill>
        ) : (
          <Pill tone="warn">{statusLabel(r.day.status)}</Pill>
        ),
    },
    { key: "in", label: "Clock In", getValue: (r) => r.day?.in?.clock ?? "", render: (r) => <PunchCell side={r.day?.in ?? null} /> },
    { key: "out", label: "Clock Out", getValue: (r) => r.day?.out?.clock ?? "", render: (r) => <PunchCell side={r.day?.out ?? null} /> },
    {
      key: "late",
      label: "Late",
      align: "right",
      getValue: (r) => r.day?.lateMin ?? 0,
      render: (r) => ((r.day?.lateMin ?? 0) > 0 ? <span className="font-mono text-err">{r.day?.lateMin} min</span> : null),
    },
    {
      key: "hours",
      label: "Hours",
      align: "right",
      description: "Regular hours inside the shift, lunch taken off. While still clocked in: so far.",
      getValue: (r) => r.day?.regularMin ?? 0,
      render: (r) => <span className="font-mono">{hm(r.day?.regularMin ?? 0)}</span>,
    },
    { key: "ot", label: "OT", align: "right", getValue: (r) => r.day?.otMin ?? 0, render: (r) => <span className="font-mono">{hm(r.day?.otMin ?? 0)}</span> },
    { key: "inLoc", label: "In Location", getValue: (r) => r.day?.in?.siteName ?? r.day?.in?.geo ?? "", render: (r) => <LocationCell side={r.day?.in ?? null} /> },
    { key: "outLoc", label: "Out Location", defaultHidden: true, getValue: (r) => r.day?.out?.siteName ?? r.day?.out?.geo ?? "", render: (r) => <LocationCell side={r.day?.out ?? null} /> },
    {
      key: "photo",
      label: "Photo",
      disableSort: true,
      getValue: (r) => (r.day?.in?.hasPhoto ? 1 : 0) + (r.day?.out?.hasPhoto ? 1 : 0),
      render: (r) =>
        r.day && (r.day.in?.hasPhoto || r.day.out?.hasPhoto) ? (
          <span className="inline-flex gap-1">
            {r.day.in?.hasPhoto && <PhotoThumb id={r.day.id} which="in" label={`${r.employee.name} · Clock in ${r.day.in.clock}`} onOpen={(url, label) => setPhoto({ url, label })} />}
            {r.day.out?.hasPhoto && <PhotoThumb id={r.day.id} which="out" label={`${r.employee.name} · Clock out ${r.day.out.clock}`} onOpen={(url, label) => setPhoto({ url, label })} />}
          </span>
        ) : (
          <span className="text-[10.5px] text-ink-muted">--</span>
        ),
    },
    { key: "notes", label: "Note", defaultHidden: true, getValue: (r) => r.day?.notes ?? "", render: (r) => <span className="text-[11px]">{r.day?.notes ?? ""}</span> },
  ];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" className={ghostBtn} onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day">
          <ChevronLeft size={12} />
        </button>
        <div className="w-36">
          <DateField fullWidth value={date} onChange={(iso) => iso && setDate(iso)} aria-label="Attendance date" />
        </div>
        <button type="button" className={ghostBtn} disabled={date >= today} onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day">
          <ChevronRight size={12} />
        </button>
        {date !== today && (
          <button type="button" className={ghostBtn} onClick={() => setDate(today)}>
            Today
          </button>
        )}
        {q.data && (
          <span className="text-[11px] text-ink-secondary">
            Shift {minToHhmm(q.data.shift.startMin)} to {minToHhmm(q.data.shift.endMin)} · {counts.in} clocked in{counts.open ? ` (${counts.open} still on)` : ""} · {counts.none} no punch
            {counts.late ? ` · ${counts.late} late` : ""}
            {counts.off ? <span className="text-err"> · {counts.off} off site</span> : null}
          </span>
        )}
      </div>
      {q.data && q.data.sitesConfigured === 0 && (
        <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
          No punch site is set up, so phone punches record their GPS but are not checked against a location. Add the warehouses in the Punch Sites tab.
        </div>
      )}
      <DataTable<AttendanceRowOut>
        tableId="hr-attendance-day"
        columns={columns}
        rows={q.data ? rows : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No active employees. Add them in Employee Master."
        getRowKey={(r) => r.employee.id}
        onRowClick={canManage ? (r) => setEditing(r) : undefined}
        exportName={`attendance-${date}`}
      />
      {editing && (
        <DayDrawer
          row={editing}
          date={date}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            q.reload();
          }}
        />
      )}
      {photo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPhoto(null)} role="dialog" aria-label={photo.label}>
          <div className="max-h-full max-w-md rounded-lg bg-surface p-2" onClick={(e) => e.stopPropagation()}>
            <img src={photo.url} alt={photo.label} className="max-h-[75vh] w-full rounded object-contain" />
            <div className="mt-2 flex items-center justify-between gap-2 px-1 text-[12px]">
              <span>{photo.label}</span>
              <button type="button" className={ghostBtn} onClick={() => setPhoto(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DayDrawer({ row, date, onClose, onSaved }: { row: AttendanceRowOut; date: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const day = row.day;
  const plainClock = (side: PunchSide | null) => (side ? side.clock.replace(/ \(\+\d+\)$/, "") : "");
  const [status, setStatus] = useState<AttendanceStatus>(day?.status ?? "PRESENT");
  const [clockIn, setClockIn] = useState(plainClock(day?.in ?? null));
  const [clockOut, setClockOut] = useState(plainClock(day?.out ?? null));
  const [notes, setNotes] = useState(day?.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.put(`${HR}/attendance`, { employeeId: row.employee.id, date, status, clockIn, clockOut, notes });
      toast.success(`${row.employee.empNo} ${formatDate(date)} saved`);
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the day."));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!day) return;
    const ok = await dialog.confirm({
      title: `Remove ${row.employee.empNo}'s ${formatDate(date)}?`,
      message: "The punches, their photos and GPS are removed from this day. Use it for a punch on the wrong day.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${HR}/attendance/${day.id}`);
      toast.success("Day removed");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not remove the day."));
    }
  }

  return (
    <ResizableDrawer
      onClose={onClose}
      title={
        <span>
          <span className="font-mono">{row.employee.empNo}</span> {row.employee.name}
        </span>
      }
      subtitle={`${formatDate(date)} · set or correct this day`}
      storageKey="hr-attendance-day-drawer"
      defaultWidth={460}
      footer={
        <div className="flex items-center gap-2">
          {day && (
            <button type="button" className={dangerBtn} onClick={() => void remove()}>
              Remove day
            </button>
          )}
          <span className="ml-auto" />
          <button type="button" className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} disabled={saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-3">
        <Field label="Status">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as AttendanceStatus)}>
            {ATTENDANCE_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Clock in (HH:MM)" hint={day?.in?.source === "PHONE" ? `Phone punch ${day.in.clock}` : undefined}>
            <input className={cn(inputCls, "font-mono")} value={clockIn} onChange={(e) => setClockIn(e.target.value)} placeholder="08:00" />
          </Field>
          <Field label="Clock out (HH:MM)" hint="Earlier than clock-in = next morning.">
            <input className={cn(inputCls, "font-mono")} value={clockOut} onChange={(e) => setClockOut(e.target.value)} placeholder="18:00" />
          </Field>
        </div>
        <Field label="Note" hint="Why it was changed, e.g. forgot to punch in, phone flat, MC.">
          <textarea className={cn(inputCls, "h-16 py-1")} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="text-[10.5px] text-ink-muted">
          A time you change is marked HR on the Attendance list; the phone punch it replaced keeps its photo and GPS on the record.
        </p>
      </div>
    </ResizableDrawer>
  );
}
