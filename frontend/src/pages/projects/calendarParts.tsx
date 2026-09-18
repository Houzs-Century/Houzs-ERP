import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import type { ProjectStatus } from "./types";
import { upcaseLeadingState } from "./projectHelpers";
import { STATUS_BY_VALUE } from "./projectStatus";
import type { CalendarProject, CalendarTask } from "./calendarModel";

// ── Calendar view ────────────────────────────────────────────
// Month grid: events render as colored bars spanning their date range,
// overdue checklist items render as dots on their due date. Bars are
// tinted by project status (mig 088) — see STATUS_OPTIONS + statusBarStyle.

// Per-task chip rendered inside a calendar cell. Compact: status dot,
// truncated title, owner initials, overdue tint. Click opens the
// parent project's detail panel.
export function CalendarTaskChip({
  task,
  onOpen,
  onHover,
  onMove,
  onLeave,
}: {
  task: CalendarTask;
  onOpen: () => void;
  onHover?: (e: React.MouseEvent) => void;
  onMove?: (e: React.MouseEvent) => void;
  onLeave?: () => void;
}) {
  const overdue = task.is_overdue === 1;
  const initials = (task.owner_name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
  return (
    <button
      onClick={onOpen}
      onMouseEnter={onHover}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={cn(
        "group flex w-full items-center gap-1 rounded border px-1 py-0.5 text-left",
        overdue
          ? "border-err/40 bg-err/5 hover:bg-err/10"
          : "border-border bg-surface hover:border-accent/40 hover:bg-accent-soft/30"
      )}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: (STATUS_BY_VALUE[task.project_status ?? "pending"] ?? STATUS_BY_VALUE.pending).hex }}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[9px] font-medium",
          overdue ? "text-err" : "text-ink"
        )}
      >
        {task.title}
      </span>
      {initials ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-1 text-[8px] font-bold leading-tight",
            overdue ? "bg-err/15 text-err" : "bg-accent-soft text-accent-ink"
          )}
        >
          {initials}
        </span>
      ) : (
        <span
          className="shrink-0 rounded-full bg-bg/80 px-1 text-[8px] font-bold leading-tight text-ink-muted"
          title="Unassigned"
        >
          —
        </span>
      )}
    </button>
  );
}

// Per-day task-count chip in calendar cells. Neutral by default; an
// overdue day gets a small red dot rather than a fully-red pill so the
// month grid isn't a wall of alarm-red badges.
export function DayCountBadge({
  count,
  overdue,
  className,
}: {
  count: number;
  overdue: boolean;
  className?: string;
}) {
  return (
    <span
      title={`${count} task(s) due${overdue ? " — includes overdue" : ""}`}
      className={cn(
        "inline-flex h-4 items-center gap-1 rounded-full bg-surface-dim px-1.5 text-[9px] font-bold text-ink-secondary",
        className
      )}
    >
      {overdue && <span className="h-1.5 w-1.5 rounded-full bg-err" aria-hidden />}
      {count}
    </span>
  );
}

// ── Calendar bar hover popover ───────────────────────────────
// A lightweight, cursor-anchored card showing a project's basic info
// when the pointer is over its calendar bar. Pointer-events-none so it
// never steals the hover; flips left/up near the viewport edges.
export function CalendarBarPopover({
  info,
}: {
  info: { project: CalendarProject; x: number; y: number };
}) {
  const p = info.project;
  const opt = STATUS_BY_VALUE[p.status] ?? STATUS_BY_VALUE.pending;
  const fmt = (iso: string | null) => (iso ? fmtDate(iso) : null);
  const span =
    p.end_date && p.end_date.slice(0, 10) !== p.start_date.slice(0, 10)
      ? `${fmt(p.start_date)} – ${fmt(p.end_date)}`
      : fmt(p.start_date);
  const stage =
    p.active_section_name ??
    (p.sections_total ? "All sections complete" : null);

  // Anchor near the cursor, flipping when close to the right/bottom edge.
  const W = 268;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = info.x + W + 16 > vw ? info.x - W - 12 : info.x + 16;
  const top = Math.min(info.y + 14, vh - 190);

  const rows: Array<[string, string | null]> = [
    ["Brand", p.brand],
    ["Venue", p.venue],
    ["When", span],
    ["Organizer", p.organizer],
    ["Stage", stage],
  ];

  return createPortal(
    <div
      className="pointer-events-none fixed z-[60] w-[268px] rounded-md border border-border bg-surface p-3 shadow-slab"
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-accent">
          {p.code}
        </span>
        <span
          className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{
            backgroundColor: `color-mix(in srgb, ${opt.hex} 15%, white)`,
            color: opt.hex,
          }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: opt.hex }} />
          {opt.label}
        </span>
      </div>
      <div className="mt-1 font-display text-[13px] font-bold leading-snug tracking-tight text-ink">
        {upcaseLeadingState(p.name, p.state)}
      </div>
      <div className="mt-2 space-y-1">
        {rows
          .filter(([, v]) => !!v)
          .map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px] leading-tight">
              <span className="w-[58px] shrink-0 text-ink-muted">{k}</span>
              <span className="min-w-0 flex-1 text-ink-secondary">{v}</span>
            </div>
          ))}
      </div>
    </div>,
    document.body
  );
}

// ── Calendar task-chip hover popover ─────────────────────────
// Cursor-anchored card for a checklist task chip: parent project, task
// title, due date, owner, and an overdue flag. Mirrors the project bar
// popover so both hovers feel consistent.
export function CalendarTaskPopover({
  info,
}: {
  info: { task: CalendarTask; x: number; y: number };
}) {
  const t = info.task;
  const opt = STATUS_BY_VALUE[t.project_status ?? "pending"] ?? STATUS_BY_VALUE.pending;
  const overdue = t.is_overdue === 1;
  const due = (() => {
    return fmtDate(t.due_date);
  })();

  const W = 268;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = info.x + W + 16 > vw ? info.x - W - 12 : info.x + 16;
  const top = Math.min(info.y + 14, vh - 180);

  const rows: Array<[string, string | null]> = [
    ["Project", t.project_name],
    ["Due", due],
    ["Owner", t.owner_name || "Unassigned"],
  ];

  return createPortal(
    <div
      className="pointer-events-none fixed z-[60] w-[268px] rounded-md border border-border bg-surface p-3 shadow-slab"
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-accent">
          {t.project_code}
        </span>
        {overdue ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-err/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-err">
            <span className="h-1.5 w-1.5 rounded-full bg-err" />
            Overdue
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
            style={{
              backgroundColor: `color-mix(in srgb, ${opt.hex} 15%, white)`,
              color: opt.hex,
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: opt.hex }} />
            {opt.label}
          </span>
        )}
      </div>
      <div className="mt-1 font-display text-[13px] font-bold leading-snug tracking-tight text-ink">
        {t.title}
      </div>
      <div className="mt-2 space-y-1">
        {rows
          .filter(([, v]) => !!v)
          .map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px] leading-tight">
              <span className="w-[58px] shrink-0 text-ink-muted">{k}</span>
              <span className="min-w-0 flex-1 text-ink-secondary">{v}</span>
            </div>
          ))}
      </div>
    </div>,
    document.body
  );
}

// ── Calendar "+N more" day modal ─────────────────────────────
// Surfaces every project + task on a single day without forcing the
// user to swap into week view. Triggered by the month-view "+N more"
// expanders on bar and task overflow.

export function CalendarDayModal({
  iso,
  projects,
  tasks,
  holidays,
  onClose,
  onOpenProject,
}: {
  iso: string;
  projects: CalendarProject[];
  tasks: CalendarTask[];
  holidays: Array<{ name: string; type?: string | null }>;
  onClose: () => void;
  onOpenProject: (id: number) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const heading = (() => {
    const [y, m, d] = iso.split("-");
    const weekday = new Date(Number(y), Number(m) - 1, Number(d))
      .toLocaleDateString("en-GB", { weekday: "long" });
    return `${weekday} ${fmtDate(iso)}`;
  })();

  // Portal into document.body so the fixed-position overlay escapes any
  // transformed ancestor (the calendar's transformed bar segments would
  // otherwise scope the "fixed" element to the calendar, not the
  // viewport — leaving the modal offscreen on long calendars).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="thin-scroll max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              Day view
            </div>
            <h2 className="font-display text-[16px] font-extrabold tracking-tight text-ink">
              {heading}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full border border-border bg-bg/40 p-1.5 text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
          >
            <X size={14} />
          </button>
        </div>

        {holidays.length > 0 && (
          <div className="mb-3 rounded-md border border-[#c9cbe3] bg-[#ecedf6] px-3 py-2 text-[12px] text-[#474d79]">
            <div className="text-[10px] font-semibold uppercase tracking-wider">
              Holiday
            </div>
            <div className="mt-0.5">{holidays.map((h) => h.name).join(", ")}</div>
          </div>
        )}

        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Projects · {projects.length}
        </div>
        {projects.length === 0 ? (
          <div className="mb-4 rounded-md border border-dashed border-border px-3 py-3 text-[12px] text-ink-muted">
            No projects on this day.
          </div>
        ) : (
          <ul className="mb-4 divide-y divide-border-subtle rounded-md border border-border">
            {projects.map((p) => {
              const opt = STATUS_BY_VALUE[p.status] ?? STATUS_BY_VALUE.pending;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => onOpenProject(p.id)}
                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg/40"
                  >
                    <span
                      className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: opt.hex }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-ink">
                        {upcaseLeadingState(p.name, p.state)}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                            opt.chip
                          )}
                        >
                          {opt.label}
                        </span>
                        {p.brand && (
                          <span className="shrink-0 font-mono text-ink-muted">
                            {p.brand}
                          </span>
                        )}
                        {p.venue && (
                          <span className="min-w-0 truncate text-ink-secondary">
                            · {p.venue}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {tasks.length > 0 && (
          <>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Tasks due · {tasks.length}
            </div>
            {/* Grouped by project so the (long) project code shows once as a
                section header instead of repeating on every task row. */}
            <div className="space-y-2.5">
              {(() => {
                const groups: Array<{
                  id: number;
                  code: string;
                  name: string;
                  status: ProjectStatus | null;
                  items: CalendarTask[];
                }> = [];
                const byId = new Map<number, (typeof groups)[number]>();
                for (const t of tasks) {
                  let g = byId.get(t.project_id);
                  if (!g) {
                    g = {
                      id: t.project_id,
                      code: t.project_code,
                      name: t.project_name,
                      status: t.project_status,
                      items: [],
                    };
                    byId.set(t.project_id, g);
                    groups.push(g);
                  }
                  g.items.push(t);
                }
                return groups.map((g) => {
                  const opt =
                    STATUS_BY_VALUE[g.status ?? "pending"] ??
                    STATUS_BY_VALUE.pending;
                  return (
                    <div
                      key={g.id}
                      className="overflow-hidden rounded-md border border-border"
                    >
                      <button
                        onClick={() => onOpenProject(g.id)}
                        className="flex w-full items-center gap-2 border-b border-border-subtle bg-bg/50 px-3 py-2 text-left transition-colors hover:bg-bg/80"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: opt.hex }}
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">
                          {g.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-[9px] font-bold text-ink-muted">
                          {g.items.length}
                        </span>
                      </button>
                      <ul className="divide-y divide-border-subtle">
                        {g.items.map((t) => (
                          <li key={t.id}>
                            <button
                              onClick={() => onOpenProject(t.project_id)}
                              className="flex w-full items-center gap-2 px-3 py-2 pl-[26px] text-left transition-colors hover:bg-bg/40"
                            >
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: t.is_overdue ? "#b23b3b" : "#cdc8b8" }}
                              />
                              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                                {t.title}
                              </span>
                              {t.owner_name && (
                                <span className="shrink-0 text-[10px] text-ink-muted">
                                  {t.owner_name}
                                </span>
                              )}
                              {t.is_overdue && (
                                <span className="shrink-0 rounded-full bg-err/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-err">
                                  Overdue
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                });
              })()}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
