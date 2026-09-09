// ----------------------------------------------------------------------------
// ShareCalendar — the public, NO-LOGIN calendar behind a share link.
//
//   /c/<token>   a booth CONTRACTOR's confirmed events
//   /b/<token>   a BRAND's confirmed events
//
// The unguessable token in the URL is the only credential (backend gates:
// routes/publicContractorCalendar.ts, routes/publicBrandCalendar.ts). Both
// modes are the same page; what differs is decided by the SERVER route the
// mode talks to, never by this file hiding a field:
//
//   contractor  tap an event → its UNFILLED floorplan, view + download;
//               export = Date, Venue, State, Organizer, Brand, Type, Booth, Size
//   brand       tap an event → its DISPLAY floorplan, Size and Total Sales;
//               export = the same columns + Total Sales, with a Confidential
//               footer naming the brand and the generation time
//
// Owner 2026-09-08. Viewers navigate month by month (the owner removed the
// month/week toggle on 2026-09-09); there is no filter, no search, nothing
// editable. The list is re-read every minute so a
// change in the ERP shows up without a reload. A killed link gets the same
// "not valid" screen an unknown one does.
//
// Deliberately self-contained: its own tiny grid, no import from the giant
// Projects.tsx calendar, so the public bundle stays small.
// ----------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";

import { correlatedFetch } from "../lib/requestCorrelation";
import { fmtDate, fmtDateTime, fmtRM } from "../vendor/shared/format";

export type ShareMode = "contractor" | "brand";

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
type ShareData = { contractor?: string; brand?: string; events: ShareEvent[] };
type ShareFile = { fileId: string; fileName: string; contentType: string | null; sizeBytes: number | null };
type ShareFigures = { sizeSqm: number | null; totalSales: number | null };
type ExportRow = {
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  state: string | null;
  organizer: string | null;
  brand: string | null;
  eventType: string | null;
  boothNo: string | null;
  sizeSqm: number | null;
  totalSales?: number | null;
};
type ExportBody = { contractor?: string; brand?: string; generatedAt: string; rows: ExportRow[] };

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string) ||
  (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

const API_SEGMENT: Record<ShareMode, string> = {
  contractor: "contractor-calendar",
  brand: "brand-calendar",
};
const PLAN_LABEL: Record<ShareMode, string> = {
  contractor: "Unfilled floorplan",
  brand: "Display floorplan",
};
// Polling is the realtime mechanism here (no WebSockets); one minute is the
// cadence the ERP's own lists use.
const POLL_MS = 60_000;
const DAY = 86400000;

/** Parse the date part of a 'YYYY-MM-DD[...]' string to a local Date, or null. */
function parseDay(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
/** Local-midnight epoch ms, so day arithmetic is exact across DST. */
function dayNum(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** The Monday-first week containing `d`. */
function weekOf(d: Date): Date[] {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (start.getDay() + 6) % 7; // Mon=0 … Sun=6
  start.setDate(start.getDate() - dow);
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}
/** 6 Monday-first weeks (42 cells) covering the month. */
function monthGrid(year: number, month: number): Date[] {
  const first = weekOf(new Date(year, month, 1))[0];
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
}

type EventRange = { e: ShareEvent; start: number; end: number };
/** One event's bar within a single week row (its label shown once, spanning its days). */
type Seg = { e: ShareEvent; startCol: number; span: number; lane: number; roundL: boolean; roundR: boolean };

// Lay a week's events out as SPANNING bars — one bar per event across the days
// it covers, its details shown ONCE — packed into lanes so overlapping events
// stack instead of repeating on every day.
function layoutWeek(week: Date[], ranges: EventRange[]): { segs: Seg[]; laneCount: number } {
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
    segs.push({ e: r.e, startCol, span: endCol - startCol + 1, lane, roundL: r.start >= weekStart, roundR: r.end <= weekEnd });
  }
  return { segs, laneCount: tracks.length };
}

function label(e: ShareEvent): string {
  const brand = e.brand ? `[${e.brand}] ` : "";
  return `${brand}${e.venue ?? e.name ?? "Event"}`;
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

/** "16/08/2026" or "16/08/2026 – 18/08/2026". */
function fmtSpan(start: string | null, end: string | null): string {
  const s = start ? fmtDate(start) : "";
  const e = end ? fmtDate(end) : "";
  return e && e !== s ? `${s} – ${e}` : s;
}

export function ShareCalendar({ mode }: { mode: ShareMode }) {
  // Read from the location — this surface is chosen before any <Routes> exists.
  const token = window.location.pathname.split("/")[2] || "";
  const base = useMemo(
    () => `${apiBase()}/api/public/${API_SEGMENT[mode]}/${encodeURIComponent(token)}`,
    [mode, token],
  );
  const [data, setData] = useState<ShareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState<{ y: number; m: number }>({ y: today.getFullYear(), m: today.getMonth() });
  // The event whose panel is open, and what the server said about it.
  const [open, setOpen] = useState<ShareEvent | null>(null);
  const [files, setFiles] = useState<ShareFile[] | null>(null);
  const [figures, setFigures] = useState<ShareFigures | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // `silent` = the minute poll: never flash the loading screen or wipe the grid
  // over a blip; a failed poll keeps the last good schedule on screen.
  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await correlatedFetch(base);
        if (!res.ok) {
          if (!silent) {
            setError(
              res.status === 404
                ? "This link is not valid. Please ask Houzs for a current link."
                : "Could not load the schedule just now. Please try again in a moment.",
            );
          }
          return;
        }
        const body = (await res.json()) as ShareData;
        setData(body);
      } catch {
        if (!silent) setError("Could not load the schedule just now. Please try again in a moment.");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("This link is missing its code.");
      return;
    }
    void load(false);
    const id = window.setInterval(() => void load(true), POLL_MS);
    return () => window.clearInterval(id);
  }, [token, load]);

  useEffect(() => {
    if (!open) return;
    // A ref-shaped flag, not a `let`: the closure reads it after an await, and a
    // plain boolean is narrowed to its initial value there.
    const live = { current: true };
    setFiles(null);
    setFigures(null);
    setPanelError(null);
    void (async () => {
      try {
        const eventUrl = `${base}/events/${open.eventId}`;
        const [filesRes, figuresRes] = await Promise.all([
          correlatedFetch(`${eventUrl}/floorplan`),
          mode === "brand" ? correlatedFetch(eventUrl) : Promise.resolve(null),
        ]);
        const filesBody = filesRes.ok ? ((await filesRes.json()) as { files: ShareFile[] }) : null;
        const figuresBody = figuresRes && figuresRes.ok ? ((await figuresRes.json()) as ShareFigures) : null;
        if (!live.current) return;
        if (!filesBody) {
          setPanelError("Could not load this event just now. Please try again in a moment.");
          return;
        }
        setFiles(filesBody.files);
        setFigures(figuresBody);
      } catch {
        if (live.current) setPanelError("Could not load this event just now. Please try again in a moment.");
      }
    })();
    return () => {
      live.current = false;
    };
  }, [open, base, mode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const ranges = useMemo<EventRange[]>(() => {
    const out: EventRange[] = [];
    for (const e of data?.events ?? []) {
      const s = parseDay(e.startDate);
      if (!s) continue;
      const en = parseDay(e.endDate) || s;
      out.push({ e, start: dayNum(s), end: dayNum(en) });
    }
    return out;
  }, [data]);

  const cells = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor]);
  const weeks = useMemo<Date[][]>(() => {
    const out: Date[][] = [];
    for (let w = 0; w < 6; w++) out.push(cells.slice(w * 7, w * 7 + 7));
    return out;
  }, [cells]);
  const todayKey = dayNum(today);
  // Derived, not literal arrays, so the month/weekday names have one home in the
  // platform instead of a duplicated-decision copy of the ERP's own lists.
  const monthLabel = new Date(cursor.y, cursor.m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const weekdayNames = weeks[0].map((d) => d.toLocaleDateString("en-US", { weekday: "short" }));

  function prev() {
    setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
  }
  function next() {
    setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));
  }
  function goToday() {
    setCursor({ y: today.getFullYear(), m: today.getMonth() });
  }

  // Excel: the rows come from the server already scoped to this link (and, for
  // a brand, already logged there); the browser only lays them out.
  async function exportExcel() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await correlatedFetch(`${base}/export`);
      if (!res.ok) {
        setExportError("Could not prepare the export just now. Please try again in a moment.");
        return;
      }
      const body = (await res.json()) as ExportBody;
      const XLSX = await import("../lib/xlsx-runtime");
      const header: string[] = ["Date", "Venue", "State", "Organizer", "Brand", "Type", "Booth", "Size (sqm)"];
      if (mode === "brand") header.push("Total Sales (RM)");
      const aoa: (string | number)[][] = [header];
      for (const r of body.rows) {
        const row: (string | number)[] = [
          fmtSpan(r.startDate, r.endDate),
          r.venue ?? "",
          r.state ?? "",
          r.organizer ?? "",
          r.brand ?? "",
          r.eventType ?? "",
          r.boothNo ?? "",
          r.sizeSqm ?? "",
        ];
        if (mode === "brand") row.push(r.totalSales ?? "");
        aoa.push(row);
      }
      const party = body.brand ?? body.contractor ?? "";
      if (mode === "brand") {
        // Sales is sensitive: the sheet says whose it is and when it was cut.
        aoa.push([], [`Brand: ${party}`], [`Generated: ${fmtDateTime(body.generatedAt)}`], ["Confidential"]);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Schedule");
      const stem = party.replace(/[\\/:*?"<>|]+/g, " ").trim() || "schedule";
      XLSX.writeFileXLSX(wb, `${stem} schedule ${fmtDate(new Date())}.xlsx`);
    } catch {
      setExportError("Could not prepare the export just now. Please try again in a moment.");
    } finally {
      setExporting(false);
    }
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

  const party = data ? (data.contractor ?? data.brand ?? "") : "";
  const eventCount = data ? data.events.length : 0;
  const navBtn = "h-9 rounded-md border border-gray-200 bg-white text-gray-600 hover:border-[#0F766E]";

  return (
    <div className="min-h-screen bg-[#0F766E]/5 text-gray-900">
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-5 sm:py-6">
        <div className="mb-4 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#0F766E]">Houzs Event Schedule</div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl">{party}</h1>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {mode === "brand" ? "Confirmed events for your brand" : "Confirmed events you are in charge of"} · {eventCount} total · view-only
          </p>
        </div>

        {/* Owner 2026-09-09: the export sits on the navigation row, at the right
            end where the Month/Week toggle used to be. */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={prev} className={`${navBtn} w-9`} aria-label="Previous month">‹</button>
          <button type="button" onClick={next} className={`${navBtn} w-9`} aria-label="Next month">›</button>
          <button type="button" onClick={goToday} className={`${navBtn} px-3 text-[12px] font-semibold`}>Today</button>
          <div className="ml-1 text-[15px] font-bold text-gray-900">{monthLabel}</div>
          <div className="ml-auto text-right">
            <button
              type="button"
              onClick={() => void exportExcel()}
              disabled={exporting}
              className="h-9 rounded-md bg-[#0F766E] px-3 text-[12px] font-semibold text-white hover:bg-[#0c5f59] disabled:opacity-60"
            >
              {exporting ? "Preparing…" : "Export to Excel"}
            </button>
            {exportError ? <p className="mt-1 text-[12px] text-red-700">{exportError}</p> : null}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border-2 border-slate-400 bg-white shadow-md ring-1 ring-slate-900/5">
          <div className="grid grid-cols-7 border-b-2 border-slate-600 bg-slate-800">
            {weekdayNames.map((w) => (
              <div key={w} className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-white">
                {w}
              </div>
            ))}
          </div>
          <div>
            {weeks.map((wk, wi) => {
              const { segs, laneCount } = layoutWeek(wk, ranges);
              const minH = Math.max(76, 24 + laneCount * 20 + 4);
              return (
                <div key={wi} className="relative grid grid-cols-7" style={{ minHeight: minH }}>
                  {wk.map((cell, ci) => {
                    const inMonth = cell.getMonth() === cursor.m;
                    const isToday = dayNum(cell) === todayKey;
                    return (
                      <div key={ci} className={`border-b border-r border-slate-200 p-1 ${inMonth ? "bg-white" : "bg-slate-50"}`}>
                        <div className={`text-right text-[11px] ${isToday ? "font-bold text-[#0F766E]" : inMonth ? "text-gray-500" : "text-gray-300"}`}>
                          {cell.getDate()}
                        </div>
                      </div>
                    );
                  })}
                  {segs.map((seg, si) => {
                    const booth = (seg.e.boothNo ?? "").trim();
                    return (
                      <div
                        key={si}
                        className="absolute px-[3px]"
                        style={{ left: `${(seg.startCol / 7) * 100}%`, width: `${(seg.span / 7) * 100}%`, top: 24 + seg.lane * 20 }}
                      >
                        <button
                          type="button"
                          onClick={() => setOpen(seg.e)}
                          className={`block w-full truncate bg-[#0F766E] px-1.5 py-[3px] text-left text-[9.5px] font-semibold leading-tight text-white hover:bg-[#0c5f59] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                            seg.roundL ? "rounded-l-md" : ""
                          } ${seg.roundR ? "rounded-r-md" : ""}`}
                          title={`${label(seg.e)}${booth ? " — Booth " + booth : ""} — tap for details`}
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
          Live schedule from Houzs · updates automatically · tap an event for details · this link is private to you
        </p>
      </div>

      {open ? (
        <EventPanel
          mode={mode}
          event={open}
          files={files}
          figures={figures}
          error={panelError}
          fileUrl={(f) => `${base}/events/${open.eventId}/floorplan/${encodeURIComponent(f.fileId)}`}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/** The only detail a link holder can open. Contractor: the unfilled floorplan.
 *  Brand: the display floorplan plus its own size and total sales. */
function EventPanel({
  mode,
  event,
  files,
  figures,
  error,
  fileUrl,
  onClose,
}: {
  mode: ShareMode;
  event: ShareEvent;
  files: ShareFile[] | null;
  figures: ShareFigures | null;
  error: string | null;
  fileUrl: (f: ShareFile) => string;
  onClose: () => void;
}) {
  const booth = (event.boothNo ?? "").trim();
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-event-title"
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">{PLAN_LABEL[mode]}</div>
            <h2 id="share-event-title" className="truncate text-[15px] font-bold text-gray-900">
              {event.brand ? `[${event.brand}] ` : ""}
              {event.venue ?? event.name ?? "Event"}
            </h2>
            <div className="mt-0.5 text-[12px] text-gray-500">
              {booth ? `Booth ${booth} · ` : ""}
              {fmtSpan(event.startDate, event.endDate)}
              {event.organizer ? ` · ${event.organizer}` : ""}
            </div>
          </div>
          <button type="button" onClick={onClose} className="h-8 w-8 shrink-0 rounded-md border border-gray-200 text-gray-600 hover:border-accent" aria-label="Close">×</button>
        </div>

        {mode === "brand" ? (
          <dl className="grid grid-cols-2 gap-3 border-b border-slate-200 px-4 py-3 text-[13px]">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-gray-500">Size</dt>
              <dd className="font-semibold text-gray-900">{figures?.sizeSqm != null ? `${figures.sizeSqm} sqm` : "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-gray-500">Total sales</dt>
              <dd className="font-semibold text-gray-900">{figures?.totalSales != null ? fmtRM(figures.totalSales) : "—"}</dd>
            </div>
          </dl>
        ) : null}

        <div className="px-4 py-3">
          {error ? (
            <p className="text-[13px] text-red-700">{error}</p>
          ) : files === null ? (
            <p className="text-[13px] text-gray-500">Loading floorplan…</p>
          ) : files.length === 0 ? (
            <p className="text-[13px] text-gray-500">
              No {PLAN_LABEL[mode].toLowerCase()} has been uploaded for this event yet. Please check back later or ask Houzs.
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
                        <div className="truncate text-[13px] font-semibold text-gray-900" title={f.fileName}>{f.fileName}</div>
                        <div className="text-[11px] text-gray-500">{fmtSize(f.sizeBytes)}</div>
                      </div>
                      <div className="flex gap-2">
                        <a href={url} target="_blank" rel="noopener noreferrer" className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:border-accent">View</a>
                        <a href={`${url}?download=1`} className="rounded-md bg-[#0F766E] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#0c5f59]">Download</a>
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
