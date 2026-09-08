// ----------------------------------------------------------------------------
// ContractorCalendar — a booth contractor's confirmed schedule, NO LOGIN.
//
//   /c/<token>
//
// The unguessable token in the URL is the only credential (backend gate:
// routes/publicContractorCalendar.ts + services/contractorShare.ts). The page
// shows ONLY the confirmed events the contractor is in charge of, each with its
// booth number — no finance, no other contractor's work, nothing editable. A
// killed link gets the same "not valid" screen an unknown one does.
//
// Tapping an event opens ONE thing (owner 2026-09-08): the event's UNFILLED
// floorplan — the file(s) on its "Blank Floorplan" task — with View and
// Download. Nothing else from the project reaches this page; the server never
// sends it.
//
// Deliberately self-contained: its own tiny month grid, no import from the giant
// Projects.tsx calendar, so the public bundle stays small.
// ----------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";

import { correlatedFetch } from "../lib/requestCorrelation";
import { fmtDate } from "../vendor/shared/format";

type ShareEvent = {
  eventId: number;
  brand: string | null;
  organizer: string | null;
  state: string | null;
  venue: string | null;
  boothNo: string | null;
  startDate: string | null;
  endDate: string | null;
  name: string | null;
};
type ShareData = { contractor: string; events: ShareEvent[] };
type ShareFile = { fileId: string; fileName: string; contentType: string | null; sizeBytes: number | null };

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string) ||
  (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

/** Parse the date part of a 'YYYY-MM-DD[...]' string to a local Date, or null. */
function parseDay(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Midnight-to-midnight day key so ranges compare cleanly. */
function dayNum(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 42-cell (6×7), Monday-first grid of Dates for a year/month. */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(year, month, 1 - offset + i));
  }
  return cells;
}

type EventRange = { e: ShareEvent; start: number; end: number };
/** One event's bar within a single week row (its label shown once, spanning its days). */
type Seg = { e: ShareEvent; startCol: number; span: number; lane: number; roundL: boolean; roundR: boolean };

export function ContractorCalendar() {
  // Read from the location — this surface is chosen before any <Routes> exists.
  const token = window.location.pathname.split("/")[2] || "";
  const [data, setData] = useState<ShareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState<{ y: number; m: number }>({
    y: today.getFullYear(),
    m: today.getMonth(),
  });
  // The event whose floorplan panel is open, and what the server said about it.
  const [open, setOpen] = useState<ShareEvent | null>(null);
  const [files, setFiles] = useState<ShareFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await correlatedFetch(
        `${apiBase()}/api/public/contractor-calendar/${encodeURIComponent(token)}`,
      );
      if (!res.ok) {
        setError(
          res.status === 404
            ? "This link is not valid. Please ask Houzs for a current link."
            : "Could not load the schedule just now. Please try again in a moment.",
        );
        return;
      }
      const body = (await res.json()) as ShareData;
      setData(body);
    } catch {
      setError("Could not load the schedule just now. Please try again in a moment.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("This link is missing its code.");
      return;
    }
    void load();
  }, [token, load]);

  const eventBase = useCallback(
    (e: ShareEvent) =>
      `${apiBase()}/api/public/contractor-calendar/${encodeURIComponent(token)}/events/${e.eventId}/floorplan`,
    [token],
  );

  useEffect(() => {
    if (!open) return;
    // A ref-shaped flag, not a `let`: the closure reads it after an await, and a
    // plain boolean is narrowed to its initial value there.
    const live = { current: true };
    setFiles(null);
    setFilesError(null);
    void (async () => {
      try {
        const res = await correlatedFetch(eventBase(open));
        const body = res.ok ? ((await res.json()) as { files: ShareFile[] }) : null;
        if (!live.current) return;
        if (!body) {
          setFilesError("Could not load the floorplan just now. Please try again in a moment.");
          return;
        }
        setFiles(body.files);
      } catch {
        if (live.current) setFilesError("Could not load the floorplan just now. Please try again in a moment.");
      }
    })();
    return () => {
      live.current = false;
    };
  }, [open, eventBase]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const ranges = useMemo<EventRange[]>(() => {
    const list = data?.events ?? [];
    const out: EventRange[] = [];
    for (const e of list) {
      const s = parseDay(e.startDate);
      if (!s) continue;
      const en = parseDay(e.endDate) || s;
      out.push({ e, start: dayNum(s), end: dayNum(en) });
    }
    return out;
  }, [data]);

  const cells = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
  const todayKey = dayNum(today);
  // Derived, not literal arrays, so the month/weekday names have one home in the
  // platform instead of a duplicated-decision copy of the ERP's own lists.
  const monthLabel = new Date(cursor.y, cursor.m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const weekdayNames = cells.slice(0, 7).map((d) => d.toLocaleDateString("en-US", { weekday: "short" }));

  function prev() {
    setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
  }
  function next() {
    setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));
  }
  function goToday() {
    setCursor({ y: today.getFullYear(), m: today.getMonth() });
  }

  const weeks = useMemo<Date[][]>(() => {
    const out: Date[][] = [];
    for (let w = 0; w < 6; w++) out.push(cells.slice(w * 7, w * 7 + 7));
    return out;
  }, [cells]);

  // Lay a week's events out as SPANNING bars — one bar per event across the days
  // it covers, its details shown ONCE — packed into lanes so overlapping events
  // stack instead of repeating on every day.
  function layoutWeek(week: Date[]): { segs: Seg[]; laneCount: number } {
    const DAY = 86400000;
    const weekStart = dayNum(week[0]);
    const weekEnd = dayNum(week[6]);
    const hits = ranges
      .filter((r) => r.end >= weekStart && r.start <= weekEnd)
      .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const tracks: boolean[][] = [];
    const segs: Seg[] = [];
    for (const r of hits) {
      const startCol = Math.round((Math.max(r.start, weekStart) - weekStart) / DAY);
      const endCol = Math.round((Math.min(r.end, weekEnd) - weekStart) / DAY);
      let lane = 0;
      for (; lane <= hits.length; lane++) {
        if (!tracks[lane]) tracks[lane] = [false, false, false, false, false, false, false];
        let free = true;
        for (let col = startCol; col <= endCol; col++) {
          if (tracks[lane][col]) { free = false; break; }
        }
        if (free) {
          for (let col = startCol; col <= endCol; col++) tracks[lane][col] = true;
          break;
        }
      }
      segs.push({
        e: r.e,
        startCol,
        span: endCol - startCol + 1,
        lane,
        roundL: r.start >= weekStart,
        roundR: r.end <= weekEnd,
      });
    }
    return { segs, laneCount: tracks.length };
  }

  function label(e: ShareEvent): string {
    const brand = e.brand ? `[${e.brand}] ` : "";
    return `${brand}${e.venue ?? e.name ?? "Event"}`;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">
        Loading schedule…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="text-lg font-semibold text-gray-800">Houzs Event Schedule</div>
          <p className="mt-2 text-sm text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  const contractorName = data ? data.contractor : "";
  const eventCount = data ? data.events.length : 0;

  return (
    <div className="min-h-screen bg-[#0F766E]/5 text-gray-900">
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-5 sm:py-6">
        {/* Header */}
        <div className="mb-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#0F766E]">
            Houzs Event Schedule
          </div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl">{contractorName}</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Confirmed events you are in charge of · {eventCount} total · view-only
          </p>
        </div>

        {/* Month nav */}
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={prev}
            className="h-9 w-9 rounded-md border border-gray-200 bg-white text-gray-600 hover:border-[#0F766E]"
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={next}
            className="h-9 w-9 rounded-md border border-gray-200 bg-white text-gray-600 hover:border-[#0F766E]"
            aria-label="Next month"
          >
            ›
          </button>
          <button
            type="button"
            onClick={goToday}
            className="h-9 rounded-md border border-gray-200 bg-white px-3 text-[12px] font-semibold text-gray-600 hover:border-[#0F766E]"
          >
            Today
          </button>
          <div className="ml-1 text-[15px] font-bold text-gray-900">
            {monthLabel}
          </div>
        </div>

        {/* Calendar grid */}
        <div className="overflow-hidden rounded-xl border-2 border-accent/60 bg-white shadow-md ring-1 ring-accent/10">
          <div className="grid grid-cols-7 border-b-2 border-accent-hover bg-accent">
            {weekdayNames.map((w) => (
              <div key={w} className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-white">
                {w}
              </div>
            ))}
          </div>
          <div>
            {weeks.map((week, wi) => {
              const { segs, laneCount } = layoutWeek(week);
              const minH = Math.max(76, 24 + laneCount * 20 + 4);
              return (
                <div key={wi} className="relative grid grid-cols-7" style={{ minHeight: minH }}>
                  {week.map((cell, ci) => {
                    const inMonth = cell.getMonth() === cursor.m;
                    const isToday = dayNum(cell) === todayKey;
                    return (
                      <div
                        key={ci}
                        className={`border-b border-r border-slate-200 p-1 ${
                          inMonth ? "bg-white" : "bg-slate-50"
                        }`}
                      >
                        <div
                          className={`text-right text-[11px] ${
                            isToday
                              ? "font-bold text-[#0F766E]"
                              : inMonth
                                ? "text-gray-500"
                                : "text-gray-300"
                          }`}
                        >
                          {cell.getDate()}
                        </div>
                      </div>
                    );
                  })}
                  {/* One spanning bar per event — its details shown ONCE across its days. */}
                  {segs.map((seg, si) => {
                    const booth = (seg.e.boothNo ?? "").trim();
                    return (
                      <div
                        key={si}
                        className="absolute px-[3px]"
                        style={{
                          left: `${(seg.startCol / 7) * 100}%`,
                          width: `${(seg.span / 7) * 100}%`,
                          top: 24 + seg.lane * 20,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setOpen(seg.e)}
                          className={`block w-full truncate bg-[#0F766E] px-1.5 py-[3px] text-left text-[9.5px] font-semibold leading-tight text-white hover:bg-[#0c5f59] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                            seg.roundL ? "rounded-l-md" : ""
                          } ${seg.roundR ? "rounded-r-md" : ""}`}
                          title={`${label(seg.e)}${booth ? " — Booth " + booth : ""} — tap for the floorplan`}
                        >
                          {label(seg.e)}
                          {booth ? ` · Booth ${booth}` : ""}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        <p className="mt-3 text-center text-[11px] text-gray-400">
          Live schedule from Houzs · updates automatically · tap an event for its floorplan · this link is private to you
        </p>
      </div>

      {open ? (
        <FloorplanPanel
          event={open}
          files={files}
          error={filesError}
          fileUrl={(f) => `${eventBase(open)}/${encodeURIComponent(f.fileId)}`}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

function fmtSize(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKind(f: ShareFile): "image" | "pdf" | "other" {
  const t = (f.contentType ?? "").toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.includes("pdf") || /\.pdf$/i.test(f.fileName)) return "pdf";
  if (/\.(png|jpe?g|gif|webp)$/i.test(f.fileName)) return "image";
  return "other";
}

/** The ONLY detail a contractor can open: the event's unfilled floorplan. */
function FloorplanPanel({
  event,
  files,
  error,
  fileUrl,
  onClose,
}: {
  event: ShareEvent;
  files: ShareFile[] | null;
  error: string | null;
  fileUrl: (f: ShareFile) => string;
  onClose: () => void;
}) {
  const booth = (event.boothNo ?? "").trim();
  // The ONE date format (fmtDate → "16/08/2026"); a missing date renders as "—".
  const start = event.startDate ? fmtDate(event.startDate) : "";
  const end = event.endDate ? fmtDate(event.endDate) : "";
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="floorplan-title"
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">Unfilled floorplan</div>
            <h2 id="floorplan-title" className="truncate text-[15px] font-bold text-gray-900">
              {event.brand ? `[${event.brand}] ` : ""}
              {event.venue ?? event.name ?? "Event"}
            </h2>
            <div className="mt-0.5 text-[12px] text-gray-500">
              {booth ? `Booth ${booth} · ` : ""}
              {start}
              {end && end !== start ? ` – ${end}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 text-gray-600 hover:border-accent"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-3">
          {error ? (
            <p className="text-[13px] text-red-700">{error}</p>
          ) : files === null ? (
            <p className="text-[13px] text-gray-500">Loading floorplan…</p>
          ) : files.length === 0 ? (
            <p className="text-[13px] text-gray-500">
              No unfilled floorplan has been uploaded for this event yet. Please check back later or ask Houzs.
            </p>
          ) : (
            <ul className="space-y-4">
              {files.map((f) => {
                const url = fileUrl(f);
                const kind = fileKind(f);
                return (
                  <li key={f.fileId} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-gray-900" title={f.fileName}>
                          {f.fileName}
                        </div>
                        <div className="text-[11px] text-gray-500">{fmtSize(f.sizeBytes)}</div>
                      </div>
                      <div className="flex gap-2">
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:border-accent"
                        >
                          View
                        </a>
                        <a
                          href={`${url}?download=1`}
                          className="rounded-md bg-[#0F766E] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#0c5f59]"
                        >
                          Download
                        </a>
                      </div>
                    </div>
                    {kind === "image" ? (
                      <img src={url} alt={f.fileName} className="mt-3 max-h-[60vh] w-full rounded-md object-contain" />
                    ) : kind === "pdf" ? (
                      <iframe src={url} title={f.fileName} className="mt-3 h-[60vh] w-full rounded-md border border-slate-200" />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
