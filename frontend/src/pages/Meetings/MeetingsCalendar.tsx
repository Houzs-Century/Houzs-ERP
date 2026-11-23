import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  DAY, DAY_NAMES, GRID_FROM, GRID_TO, HOUR, MIN, MONTH_NAMES, addDays, atHour, fmtDay, fmtDayLong, fmtRange, fmtTime,
  layoutDay, minutesOfDay, ms, peopleOf, personName, snapMinutes, startOfDay, startOfWeek,
  type Meeting, type Person, type Room,
} from "../../lib/meetings";

/* The calendar views of the Meetings page: the month picker in the rail, the day/week
   time grid (drag to book, drag to move, drag the bottom edge to change the length),
   the month grid, the rooms timeline and the list. All of them only draw and report;
   the page decides what a drop or a click does. */

const HH = 48; // pixels per hour in the time grid
const span = (GRID_TO - GRID_FROM) * 60;

export type CalProps = {
  meetings: Meeting[];
  rooms: Room[];
  people: Map<string, Person>;
  colorOf: (m: Meeting) => string;
  now: number;
  onOpen: (m: Meeting, x: number, y: number) => void;
};

export function MiniMonth({ anchor, onPick, week }: { anchor: number; onPick: (d: number) => void; week: boolean }) {
  const [month, setMonth] = useState(() => new Date(new Date(anchor).getFullYear(), new Date(anchor).getMonth(), 1).getTime());
  useEffect(() => setMonth(new Date(new Date(anchor).getFullYear(), new Date(anchor).getMonth(), 1).getTime()), [anchor]);
  const first = startOfWeek(month);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const today = startOfDay(Date.now());
  const ws = startOfWeek(anchor);
  const mm = new Date(month);
  const step = (n: number) => { const d = new Date(month); d.setMonth(d.getMonth() + n); setMonth(d.getTime()); };
  return (
    <div>
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[13px] font-medium text-ink">{MONTH_NAMES[mm.getMonth()]} {mm.getFullYear()}</span>
        <span className="flex">
          <button type="button" aria-label="Previous month" className="rounded-full p-1 text-ink-secondary hover:bg-surface-2" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
          <button type="button" aria-label="Next month" className="rounded-full p-1 text-ink-secondary hover:bg-surface-2" onClick={() => step(1)}><ChevronRight size={16} /></button>
        </span>
      </div>
      <div className="grid grid-cols-7 justify-items-center gap-0.5 text-[11px]">
        {DAY_NAMES.map((n) => n[0]).map((d, i) => <span key={i} className="flex h-7 w-7 items-center justify-center text-ink-muted">{d}</span>)}
        {cells.map((c) => {
          const inWeek = week && c >= ws && c < ws + 7 * DAY;
          return (
            <button key={c} type="button" aria-label={fmtDay(c)} onClick={() => onPick(c)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full",
                c === today ? "bg-primary font-semibold text-white" : inWeek ? "bg-primary-soft text-ink" : "hover:bg-surface-2",
                new Date(c).getMonth() !== mm.getMonth() && c !== today && "text-ink-muted",
              )}>
              {new Date(c).getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type Drag = { type: "new"; di: number; a: number; b: number } | { type: "move"; id: number; s: number; e: number } | null;

export function TimeGrid(p: CalProps & {
  days: number[];
  me: string;
  canChange: (m: Meeting) => boolean;
  onCreate: (start: number, end: number) => void;
  onMove: (m: Meeting, start: number, end: number) => void;
}) {
  const { days, meetings, rooms, now } = p;
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<(HTMLDivElement | null)[]>([]);
  const [drag, setDrag] = useState<Drag>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (minutesOfDay(Date.now()) / 60 - GRID_FROM - 1) * HH);
  }, []);
  const today = startOfDay(now);
  const yToMin = (el: HTMLElement, y: number) => snapMinutes(GRID_FROM * 60 + ((y - el.getBoundingClientRect().top) / HH) * 60);
  const colAt = (x: number) => cols.current.findIndex((c) => { if (!c) return false; const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });

  const begin = (e: RPointerEvent<HTMLDivElement>, di: number) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const col = e.currentTarget;
    if (e.pointerType === "touch") {
      // On a phone a drag scrolls the page; a tap books an hour.
      const y0 = e.clientY;
      const m1 = snapMinutes(yToMin(col, e.clientY), 30);
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointerup", up);
        if (Math.abs(ev.clientY - y0) < 10) { const s = atHour(days[di], 0) + m1 * MIN; p.onCreate(s, s + HOUR); }
      };
      window.addEventListener("pointerup", up);
      return;
    }
    e.preventDefault();
    const cur = { type: "new" as const, di, a: yToMin(col, e.clientY), b: yToMin(col, e.clientY) + 30 };
    setDrag({ ...cur });
    const mv = (ev: PointerEvent) => { cur.b = Math.max(cur.a + 15, yToMin(col, ev.clientY)); setDrag({ ...cur }); };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      const s = atHour(days[cur.di], 0) + Math.min(cur.a, cur.b) * MIN;
      let en = atHour(days[cur.di], 0) + Math.max(cur.a, cur.b) * MIN;
      if (en - s < 30 * MIN) en = s + HOUR;
      p.onCreate(s, en);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const grab = (e: RPointerEvent<HTMLElement>, m: Meeting, mode: "move" | "resize") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const movable = p.canChange(m) && !m.guest && m.status !== "ended";
    if (e.pointerType === "touch" || !movable) {
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointerup", up);
        if (Math.abs(ev.clientY - y0) + Math.abs(ev.clientX - x0) < 8) p.onOpen(m, ev.clientX, ev.clientY);
      };
      window.addEventListener("pointerup", up);
      return;
    }
    e.preventDefault();
    const s0 = ms(m.start);
    const e0 = ms(m.end);
    const di0 = days.findIndex((d) => d === startOfDay(s0));
    const cur = { s: s0, e: e0 };
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - y0) + Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      const dmin = snapMinutes(((ev.clientY - y0) / HH) * 60);
      if (mode === "move") {
        const ci = colAt(ev.clientX);
        const dd = ci >= 0 && di0 >= 0 ? ci - di0 : 0;
        cur.s = addDays(s0, dd) + dmin * MIN;
        cur.e = addDays(e0, dd) + dmin * MIN;
      } else cur.e = Math.max(s0 + 15 * MIN, e0 + dmin * MIN);
      setDrag({ type: "move", id: m.id, s: cur.s, e: cur.e });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!moved) { p.onOpen(m, ev.clientX, ev.clientY); return; }
      if (cur.s !== s0 || cur.e !== e0) p.onMove(m, cur.s, cur.e);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const top = (t: number) => ((minutesOfDay(t) - GRID_FROM * 60) / 60) * HH;
  const template = `52px repeat(${days.length}, minmax(0, 1fr))`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid border-b border-border pr-2" style={{ gridTemplateColumns: template }}>
        <div className="self-end pb-1 text-[10px] text-ink-muted">GMT+8</div>
        {days.map((d) => (
          <div key={d} className={cn("py-1.5 text-center text-[11px] font-medium", d === today ? "text-primary" : "text-ink-muted")}>
            {DAY_NAMES[new Date(d).getDay()].toUpperCase()}
            <span className={cn("mx-auto mt-0.5 flex h-9 w-9 items-center justify-center rounded-full text-[19px] font-normal", d === today ? "bg-primary text-white" : "text-ink")}>{new Date(d).getDate()}</span>
          </div>
        ))}
      </div>
      <div ref={scroller} className="relative flex-1 overflow-auto">
        <div className="relative grid" style={{ gridTemplateColumns: template, height: (GRID_TO - GRID_FROM) * HH, backgroundImage: `repeating-linear-gradient(to bottom, rgb(var(--hz-border) / 0.6) 0, rgb(var(--hz-border) / 0.6) 1px, transparent 1px, transparent ${HH}px)` }}>
          <div className="pr-2 text-right text-[10px] text-ink-muted">
            {Array.from({ length: GRID_TO - GRID_FROM }, (_, i) => GRID_FROM + i).map((h) => (
              <div key={h} style={{ height: HH, transform: "translateY(-6px)" }}>{h === GRID_FROM ? "" : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`}</div>
            ))}
          </div>
          {days.map((d, di) => {
            const evs = meetings.filter((m) => startOfDay(ms(m.start)) === d && !(drag?.type === "move" && drag.id === m.id)).map((m) => ({ m, start: ms(m.start), end: ms(m.end) }));
            const laid = layoutDay(evs);
            const dow = new Date(d).getDay();
            return (
              <div key={d} ref={(el) => { cols.current[di] = el; }} onPointerDown={(e) => begin(e, di)}
                className={cn("relative border-l border-border/60", (dow === 0 || dow === 6) && "bg-surface-2/40")} style={{ touchAction: "pan-y" }}>
                {laid.map(({ item, lane, lanes: n0, cluster }) => {
                  const n = Math.min(n0, 4);
                  const m = item.m;
                  if (n0 > 4 && lane > 3) return null;
                  if (n0 > 4 && lane === 3) {
                    const extra = laid.filter((x) => x.cluster === cluster && x.lane >= 3).length;
                    return (
                      <button key={m.id} type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => p.onOpen(m, e.clientX, e.clientY)}
                        className="absolute h-[22px] rounded-md bg-surface-2 text-center text-[11.5px] font-semibold text-ink" style={{ top: top(item.start), left: "calc(75% + 2px)", width: "calc(25% - 6px)" }}>+{extra}</button>
                    );
                  }
                  const h = Math.max(18, ((item.end - item.start) / HOUR) * HH);
                  const room = rooms.find((r) => r.id === m.roomId);
                  const org = p.people.get(m.organizer);
                  return (
                    <div key={m.id} role="button" tabIndex={0} aria-label={`${m.title}, ${fmtRange(item.start, item.end)}`}
                      onPointerDown={(e) => grab(e, m, "move")}
                      onKeyDown={(e) => { if (e.key === "Enter") { const r = e.currentTarget.getBoundingClientRect(); p.onOpen(m, r.right, r.top); } }}
                      className={cn("absolute cursor-pointer select-none overflow-hidden rounded-md border border-surface px-1.5 py-0.5 text-[11.5px] leading-[15px] text-white", m.status === "ended" && "opacity-55", m.status === "live" && "ring-2 ring-synced ring-offset-1")}
                      style={{ top: top(item.start), height: h - 2, left: `calc(${(lane / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 6px)`, background: p.colorOf(m), touchAction: "pan-y" }}>
                      <b className="block truncate text-[12px] font-semibold">{m.status === "live" ? "Live · " : ""}{m.title || "(No title)"}</b>
                      {h > 30 && <span>{fmtRange(item.start, item.end)}{room ? ` · ${room.name}` : ""}</span>}
                      {h > 58 && <span className="block truncate opacity-90">{m.guest ? `Guest · host ${personName(m.organizer, p.people)}` : [org?.company, org?.department].filter(Boolean).join(" · ")}</span>}
                      {!m.guest && m.status !== "ended" && p.canChange(m) && (
                        <div className="absolute inset-x-0 bottom-0 h-[7px] cursor-ns-resize" onPointerDown={(e) => grab(e, m, "resize")} />
                      )}
                    </div>
                  );
                })}
                {drag?.type === "new" && drag.di === di && (
                  <div className="pointer-events-none absolute left-0.5 right-1.5 rounded-md bg-primary px-1.5 py-0.5 text-[11.5px] text-white opacity-85"
                    style={{ top: ((Math.min(drag.a, drag.b) - GRID_FROM * 60) / 60) * HH, height: (Math.abs(drag.b - drag.a) / 60) * HH }}>
                    <b className="block">(No title)</b>{fmtRange(atHour(d, 0) + Math.min(drag.a, drag.b) * MIN, atHour(d, 0) + Math.max(drag.a, drag.b) * MIN)}
                  </div>
                )}
                {drag?.type === "move" && startOfDay(drag.s) === d && (
                  <div className="pointer-events-none absolute left-0.5 right-1.5 rounded-md bg-primary px-1.5 py-0.5 text-[11.5px] text-white opacity-85" style={{ top: top(drag.s), height: ((drag.e - drag.s) / HOUR) * HH }}>
                    <b className="block truncate">{meetings.find((x) => x.id === drag.id)?.title}</b>{fmtRange(drag.s, drag.e)}
                  </div>
                )}
                {d === today && new Date(now).getHours() >= GRID_FROM && new Date(now).getHours() < GRID_TO && (
                  <div className="pointer-events-none absolute -left-px right-0 z-[3] h-0.5 bg-[#ea4335]" style={{ top: top(now) }}>
                    <span className="absolute -left-1.5 -top-[5px] h-3 w-3 rounded-full bg-[#ea4335]" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function MonthView(p: CalProps & { anchor: number; onDay: (d: number) => void; onCreate: (d: number) => void }) {
  const a = new Date(p.anchor);
  const first = startOfWeek(new Date(a.getFullYear(), a.getMonth(), 1).getTime());
  const cells = Array.from({ length: 35 }, (_, i) => addDays(first, i));
  const today = startOfDay(p.now);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-border">{DAY_NAMES.map((d) => <div key={d} className="py-1.5 text-center text-[11px] font-medium text-ink-muted">{d.toUpperCase()}</div>)}</div>
      <div className="grid flex-1 auto-rows-[minmax(96px,1fr)] grid-cols-7 overflow-auto">
        {cells.map((c) => {
          const evs = p.meetings.filter((m) => startOfDay(ms(m.start)) === c).sort((x, y) => ms(x.start) - ms(y.start));
          const other = new Date(c).getMonth() !== a.getMonth();
          return (
            <div key={c} className="flex min-w-0 cursor-pointer flex-col gap-0.5 border-l border-t border-border/60 p-0.5" onClick={(e) => { if (e.target === e.currentTarget) p.onCreate(c); }}>
              <button type="button" aria-label={fmtDay(c)} onClick={() => p.onDay(c)}
                className={cn("mx-auto h-6 w-6 rounded-full text-[12px] font-medium", c === today ? "bg-primary text-white" : other ? "text-ink-muted" : "text-ink")}>{new Date(c).getDate()}</button>
              {evs.slice(0, 3).map((m) => (
                <button key={m.id} type="button" onClick={(e) => p.onOpen(m, e.clientX, e.clientY)}
                  className={cn("truncate rounded px-1.5 text-left text-[11.5px] leading-[18px] text-ink hover:bg-surface-2", m.status === "ended" && "opacity-55")}>
                  <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: p.colorOf(m) }} />{fmtTime(ms(m.start))} {m.title}
                </button>
              ))}
              {evs.length > 3 && <button type="button" className="px-1.5 text-left text-[11.5px] font-semibold text-ink" onClick={() => p.onDay(c)}>{evs.length - 3} more</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RoomsTimeline(p: CalProps & { day: number; onCreate: (s: number, e: number, roomId: number) => void }) {
  const [drag, setDrag] = useState<{ rid: number; a: number; b: number } | null>(null);
  const xToMin = (el: HTMLElement, x: number) => { const r = el.getBoundingClientRect(); return snapMinutes(GRID_FROM * 60 + ((x - r.left) / r.width) * span); };
  const begin = (e: RPointerEvent<HTMLDivElement>, r: Room) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const el = e.currentTarget;
    const cur = { rid: r.id, a: xToMin(el, e.clientX), b: xToMin(el, e.clientX) + 30 };
    setDrag({ ...cur });
    const mv = (ev: PointerEvent) => { cur.b = Math.max(cur.a + 15, xToMin(el, ev.clientX)); setDrag({ ...cur }); };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      const s = atHour(p.day, 0) + cur.a * MIN;
      let en = atHour(p.day, 0) + cur.b * MIN;
      if (en - s < 30 * MIN) en = s + HOUR;
      p.onCreate(s, en, cur.rid);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const pct = (t: number) => ((minutesOfDay(t) - GRID_FROM * 60) / span) * 100;
  return (
    <div className="flex-1 overflow-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[110px_1fr] bg-surface-2 text-[11px] text-ink-muted sm:grid-cols-[190px_1fr]">
          <div className="px-3.5 py-2 font-semibold">ROOM</div>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${GRID_TO - GRID_FROM}, 1fr)` }}>
            {Array.from({ length: GRID_TO - GRID_FROM }, (_, i) => GRID_FROM + i).map((h) => <span key={h} className="border-l border-border/60 px-1 py-2">{h % 12 || 12}{h < 12 ? "am" : "pm"}</span>)}
          </div>
        </div>
        {p.rooms.filter((r) => r.active).map((r) => (
          <div key={r.id} className="grid grid-cols-[110px_1fr] sm:grid-cols-[190px_1fr]">
            <div className="border-t border-border/60 px-3.5 py-3">
              <div className="flex items-center gap-2 font-semibold text-ink"><span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />{r.name}</div>
              <div className="mt-0.5 text-[12px] text-ink-muted">{[r.floor, `${r.seats} seats`].filter(Boolean).join(" · ")}</div>
            </div>
            <div className="relative h-[84px] border-t border-border/60" onPointerDown={(e) => begin(e, r)}
              style={{ backgroundImage: `repeating-linear-gradient(to right, rgb(var(--hz-border) / 0.6) 0, rgb(var(--hz-border) / 0.6) 1px, transparent 1px, transparent ${100 / (GRID_TO - GRID_FROM)}%)` }}>
              {p.meetings.filter((m) => m.roomId === r.id && startOfDay(ms(m.start)) === p.day).map((m) => {
                const org = p.people.get(m.organizer);
                return (
                  <button key={m.id} type="button" onClick={(e) => p.onOpen(m, e.clientX, e.clientY)}
                    className={cn("absolute bottom-2.5 top-2.5 overflow-hidden rounded-md px-2 py-1 text-left text-[11.5px] leading-[15px] text-white", m.status === "ended" && "opacity-55")}
                    style={{ left: `${pct(ms(m.start))}%`, width: `calc(${pct(ms(m.end)) - pct(ms(m.start))}% - 3px)`, background: p.colorOf(m) }}>
                    <b className="block truncate">{m.title}</b>{fmtRange(ms(m.start), ms(m.end))}
                    <span className="block truncate">{m.guest ? "Guest booking" : [org?.company, org?.department].filter(Boolean).join(" · ")}</span>
                  </button>
                );
              })}
              {drag?.rid === r.id && (
                <div className="pointer-events-none absolute bottom-2.5 top-2.5 rounded-md bg-primary px-2 py-1 text-[11.5px] text-white opacity-85"
                  style={{ left: `${((drag.a - GRID_FROM * 60) / span) * 100}%`, width: `${((drag.b - drag.a) / span) * 100}%` }}><b>(No title)</b></div>
              )}
              {startOfDay(p.now) === p.day && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-[#ea4335]" style={{ left: `${pct(p.now)}%` }} />}
            </div>
          </div>
        ))}
        {p.rooms.filter((r) => r.active).length === 0 && <p className="px-4 py-10 text-center text-ink-muted">No rooms yet. Someone with Manage meeting rooms adds them under Rooms.</p>}
      </div>
    </div>
  );
}

export function ListView(p: CalProps & { query: string }) {
  const items = [...p.meetings].filter((m) => p.query || ms(m.end) >= startOfDay(p.now)).sort((a, b) => ms(a.start) - ms(b.start));
  let last: number | null = null;
  return (
    <div className="flex-1 overflow-auto px-4 pb-8 pt-2">
      {p.query && <p className="text-ink-secondary">{items.length} result{items.length === 1 ? "" : "s"} for "{p.query}"</p>}
      {items.length === 0 && <p className="py-8 text-ink-muted">Nothing found.</p>}
      {items.map((m) => {
        const d = startOfDay(ms(m.start));
        const head = d !== last;
        last = d;
        const r = p.rooms.find((x) => x.id === m.roomId);
        return (
          <div key={m.id}>
            {head && <div className="mb-1.5 mt-4 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">{fmtDayLong(d)}</div>}
            <button type="button" onClick={(e) => p.onOpen(m, e.clientX, e.clientY)}
              className={cn("grid w-full grid-cols-[110px_12px_minmax(0,1fr)] items-center gap-3 border-b border-border/60 px-1 py-2.5 text-left", m.status === "ended" && "opacity-60")}>
              <span className="tabular-nums">{fmtRange(ms(m.start), ms(m.end))}</span>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.colorOf(m) }} />
              <span className="min-w-0 truncate"><b>{m.title}</b> <span className="text-ink-muted">· {r ? r.name : "No room"} · {m.guest ? `Guest: ${m.guest.name}` : personName(m.organizer, p.people)} · {peopleOf(m).length} people</span></span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
