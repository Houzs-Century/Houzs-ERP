/* HR · Employees & Attendance — secondary sidebar (redesign).
 *
 * Replaces the 14-tab horizontal strip with a grouped, resizable, collapsible
 * rail that sits between the dark app sidebar and the content. Width (264,
 * clamp 200-420, double-click resets) and open/collapsed state persist to
 * localStorage; it auto-collapses once on a narrow screen. Sub-labels are
 * SAMPLE data for now (handoff: data wiring comes later).
 *
 * Group accent colours map to design-system tokens: People/Overview = primary
 * (petrol), Time = time (amber) on warning-bg, Pay = accent (brass),
 * Performance = learning (blue). */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const MIN_W = 200;
const MAX_W = 420;
const DEFAULT_W = 264;
const RAIL_W = 52;
const KEY_W = "hr-subnav-w";
const KEY_OPEN = "hr-subnav-open";

type Group = "overview" | "people" | "time" | "pay" | "perf";

type Item = { key: string; label: string; glyph: ReactNode; sub: string; group: Group };

/** Group chip colours — soft background + glyph colour; active swaps to the
 *  solid colour with a white glyph. */
const GROUP: Record<Group, { soft: string; glyph: string; solid: string; heading: string | null }> = {
  overview: { soft: "bg-primary-soft", glyph: "text-primary", solid: "bg-primary", heading: null },
  people: { soft: "bg-primary-soft", glyph: "text-primary", solid: "bg-primary", heading: "PEOPLE" },
  time: { soft: "bg-warning-bg", glyph: "text-time", solid: "bg-time", heading: "TIME" },
  pay: { soft: "bg-accent-soft", glyph: "text-accent", solid: "bg-accent", heading: "PAY" },
  perf: { soft: "bg-learning-soft", glyph: "text-learning", solid: "bg-learning", heading: "PERFORMANCE" },
};

const OverviewGlyph = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.4" fill="currentColor" />
    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.4" fill="currentColor" opacity="0.55" />
    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.4" fill="currentColor" opacity="0.55" />
    <rect x="9" y="9" width="5.5" height="5.5" rx="1.4" fill="currentColor" />
  </svg>
);
const g = (t: string) => <span className="text-[11px] font-bold leading-none tracking-tight">{t}</span>;

/** The nav model. `key` matches HrEmployees' page keys. */
export const HR_NAV: Item[] = [
  { key: "overview", label: "Overview", glyph: OverviewGlyph, sub: "today at a glance", group: "overview" },
  { key: "employees", label: "Employee Master", glyph: g("E"), sub: "17 active · 1 not linked", group: "people" },
  { key: "shifts", label: "Shifts", glyph: g("S"), sub: "4 shifts", group: "people" },
  { key: "sites", label: "Punch Sites", glyph: g("P"), sub: "5 sites · 14 punches today", group: "people" },
  { key: "attendance", label: "Attendance", glyph: g("A"), sub: "14 / 17 in today", group: "time" },
  { key: "ot-requests", label: "OT Requests", glyph: g("OT"), sub: "4 pending", group: "time" },
  { key: "hours", label: "Working Hours", glyph: g("W"), sub: "November", group: "time" },
  { key: "holidays", label: "Public Holidays", glyph: g("PH"), sub: "Next: 11 Dec", group: "time" },
  { key: "payroll", label: "Payroll", glyph: g("P"), sub: "Nov · Draft", group: "pay" },
  { key: "pay-rules", label: "Pay Rules", glyph: g("R"), sub: "4 active rules", group: "pay" },
  { key: "trip-pay", label: "Trip Pay", glyph: g("T"), sub: "5 drivers", group: "pay" },
  { key: "allowances", label: "Allowances", glyph: g("A"), sub: "10 active", group: "pay" },
  { key: "advances", label: "Advances", glyph: g("Ad"), sub: "1 request", group: "pay" },
  { key: "penalties", label: "Penalty", glyph: g("Pe"), sub: "1 this month", group: "pay" },
  { key: "labor", label: "Labor Cost", glyph: g("L"), sub: "November", group: "pay" },
  { key: "kpi", label: "KPI", glyph: g("K"), sub: "team avg 82", group: "perf" },
];

const clampW = (w: number) => Math.min(Math.max(w, MIN_W), MAX_W);

function readOpen(): boolean {
  try {
    const v = window.localStorage.getItem(KEY_OPEN);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch { /* private mode */ }
  // No stored preference: auto-collapse once on a narrow screen.
  return typeof window === "undefined" || window.innerWidth >= 1100;
}
function readWidth(): number {
  try {
    const n = Number(window.localStorage.getItem(KEY_W));
    if (Number.isFinite(n) && n > 0) return clampW(n);
  } catch { /* private mode */ }
  return DEFAULT_W;
}

export function HrSubnav({ active, onSelect }: { active: string; onSelect: (key: string) => void }) {
  const [open, setOpen] = useState<boolean>(readOpen);
  const [width, setWidth] = useState<number>(readWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(KEY_OPEN, open ? "1" : "0"); } catch { /* private mode */ }
  }, [open]);

  const onDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: width };
      setDragging(true);
    },
    [width],
  );
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setWidth(clampW(d.startW + (e.clientX - d.startX)));
    };
    const up = () => {
      setDragging(false);
      dragRef.current = null;
      try { window.localStorage.setItem(KEY_W, String(Math.round(width))); } catch { /* private mode */ }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, width]);
  const resetWidth = () => {
    setWidth(DEFAULT_W);
    try { window.localStorage.setItem(KEY_W, String(DEFAULT_W)); } catch { /* private mode */ }
  };

  // ── collapsed 52px rail ────────────────────────────────────────────────────
  if (!open) {
    return (
      <nav className="relative flex shrink-0 flex-col items-center gap-1 border-r border-border-subtle bg-surface-2 py-2" style={{ width: RAIL_W }} aria-label="HR navigation">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Expand sidebar"
          className="mb-1 flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-ink/5 hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {HR_NAV.map((it) => {
          const on = it.key === active;
          const gc = GROUP[it.group];
          return (
            <button
              key={it.key}
              type="button"
              title={it.label}
              onClick={() => onSelect(it.key)}
              className={cx("flex h-[34px] w-[34px] items-center justify-center rounded-lg", on ? gc.solid + " text-white" : gc.soft + " " + gc.glyph)}
            >
              {it.glyph}
            </button>
          );
        })}
      </nav>
    );
  }

  // ── expanded sidebar ───────────────────────────────────────────────────────
  let lastGroup: Group | null = null;
  return (
    <nav className="relative flex shrink-0 flex-col border-r border-border-subtle bg-surface-2" style={{ width }} aria-label="HR navigation">
      {/* header */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border-subtle px-3">
        <div className="min-w-0">
          <div className="text-[15px] font-bold leading-tight text-ink">HR</div>
          <div className="truncate text-[11px] leading-tight text-ink-muted">Employees &amp; Attendance</div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Collapse sidebar"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-ink/5 hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>

      {/* scrollable item list */}
      <div className="thin-scroll flex-1 overflow-y-auto px-2 py-2">
        {HR_NAV.map((it) => {
          const gc = GROUP[it.group];
          const showHeading = it.group !== lastGroup && gc.heading;
          lastGroup = it.group;
          const on = it.key === active;
          return (
            <div key={it.key}>
              {showHeading && <div className="px-2 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-muted">{gc.heading}</div>}
              <button
                type="button"
                onClick={() => onSelect(it.key)}
                aria-current={on ? "page" : undefined}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors",
                  on ? "bg-primary-soft" : "hover:bg-ink/[0.045]",
                )}
              >
                <span className={cx("flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full", on ? gc.solid + " text-white" : gc.soft + " " + gc.glyph)}>
                  {it.glyph}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx("block truncate text-[13px] font-semibold leading-tight", on ? "text-primary-ink" : "text-ink")}>{it.label}</span>
                  <span className="block truncate text-[11px] leading-tight text-ink-muted">{it.sub}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* drag handle on the right edge */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={onDown}
        onDoubleClick={resetWidth}
        className="absolute right-0 top-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize"
      >
        <div className={cx("mx-auto h-full w-0.5", dragging ? "bg-primary" : "bg-transparent hover:bg-border-strong")} />
      </div>
    </nav>
  );
}
