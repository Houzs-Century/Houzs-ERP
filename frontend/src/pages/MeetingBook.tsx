import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { correlatedFetch } from "../lib/requestCorrelation";
import { DAY_NAMES, fmtDay, fmtRange, ms } from "../lib/meetings";

/**
 * /book/:code — someone with a booking link books a meeting room. NO LOGIN.
 *
 * They pick the day, the room and the time range themselves (owner, 2026-11-23). Each room shows the
 * times already taken, never what the meeting is or who booked it (the IT Hub's /public routes send
 * only start and end). Confirmed straight away; the booking's own address (/book/:code?b=<token>)
 * lets them see or cancel it. Times are Malaysia time (UTC+8), as everywhere in Meetings.
 */

// PUBLIC_CALL: how this ERP reaches the hub's guest routes (backend routes/meetings.ts publicMeetings).
const apiBase = (): string => (import.meta.env.VITE_API_URL as string) || (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await correlatedFetch(`${apiBase()}/api/public/meetings${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  let body: (T & { error?: string }) | null = null;
  try {
    body = (await res.json()) as T & { error?: string };
  } catch {
    // Not JSON (a gateway page): a failure, never an empty result.
  }
  if (!res.ok || !body) throw new Error(body?.error ?? "Something went wrong. Please try again.");
  return body;
}

type LinkRoom = { id: number; name: string; seats: number; location: string; floor: string; equipment: string[]; openDays?: number[]; openFrom?: number; openTo?: number; maxHours?: number };
type LinkInfo = { code: string; name: string; maxMinutes?: number; length: number; days: number[]; from: number; to: number; until: string | null; audience?: string; rooms?: LinkRoom[] };
type Company = { name: string; departments: string[] };
type DayInfo = { day: string; open: boolean; rooms: { id: number; closed: string | null; from?: number; to?: number; busy: { start: string; end: string }[] }[] };
type Booking = { code: string; title?: string; people?: number | null; start: string; end: string; cancelled?: boolean; room: string | { name: string; floor: string; location: string } | null; floor?: string | null; location?: string | null };

const MY = 8 * 3600_000;
const DAYMS = 86400_000;
const OTHER = "__other";
/** YYYY-MM-DD in Malaysia for a moment. */
const myDay = (t: number) => new Date(t + MY).toISOString().slice(0, 10);
/** Minutes since midnight, Malaysia time. */
const myMin = (t: number) => Math.round(((t + MY) % DAYMS) / 60_000);
const at = (day: string, min: number) => `${day}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00+08:00`;
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const lenLabel = (min: number) => (min < 60 ? `${min} min` : min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} h`);

const CARD = "flex flex-col gap-3.5 rounded-2xl border border-border bg-surface p-4 sm:p-5";
const STEP = "text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-muted";
const FIELD = "flex min-w-0 flex-col gap-1.5 text-[13.5px] text-ink-secondary";
const INPUT = "h-12 w-full min-w-0 rounded-xl border border-border bg-surface px-3.5 text-[15px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none disabled:bg-surface-2";

export function MeetingBook() {
  const parts = window.location.pathname.split("/");
  const code = decodeURIComponent(parts[2] ?? "");
  // Read once: booking writes ?b=<token> into the address, which must not refetch the page.
  const [token] = useState(() => new URLSearchParams(window.location.search).get("b"));
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [f, setF] = useState({ company: "", department: "", otherCompany: "", name: "", phone: "", email: "", title: "", people: 2 });
  const [day, setDay] = useState<string | null>(null);
  const [dayInfo, setDayInfo] = useState<DayInfo | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (token) {
      call<{ booking: Booking }>(`/bookings/${token}`).then((r) => setBooking(r.booking)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    call<{ link: LinkInfo; companies?: Company[] }>(`/links/${encodeURIComponent(code)}`)
      .then((r) => { setLink(r.link); setCompanies(r.companies ?? []); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [code, token]);

  const rooms = link?.rooms ?? [];
  const linkMax = link ? link.maxMinutes ?? link.length : 60;
  const days = useMemo(() => {
    const out: string[] = [];
    if (!link) return out;
    for (let i = 0; out.length < 14 && i < 60; i++) {
      const d = myDay(now + i * DAYMS);
      const wd = new Date(`${d}T12:00:00+08:00`).getUTCDay();
      if (link.until && d > link.until) break;
      const roomOpen = !link.rooms?.length || link.rooms.some((r) => !r.openDays || r.openDays.includes(wd));
      const lateToday = i === 0 && myMin(now) >= Math.min(link.to * 60, Math.max(...(link.rooms ?? []).map((r) => (r.openTo ?? 24) * 60), 0) || link.to * 60) - 15;
      if (link.days.includes(wd) && roomOpen && !lateToday) out.push(d);
    }
    return out;
  }, [link, now]);
  const chosen = day ?? days.at(0) ?? null;

  const loadDay = (d: string) => {
    call<DayInfo>(`/links/${encodeURIComponent(code)}/day?day=${d}`).then(setDayInfo).catch(() => setDayInfo({ day: d, open: false, rooms: [] }));
  };
  useEffect(() => { if (link && chosen) loadDay(chosen); }, [link, chosen]); // eslint-disable-line react-hooks/exhaustive-deps -- loadDay reads only code

  // The answer for the chosen day only; while another day loads, nothing stale is drawn.
  const dayNow = dayInfo?.day === chosen ? dayInfo : null;
  // Each room has its own bookable window that day (its opening hours within the link's); the bars share one scale.
  const dayRoom = (rid: number) => dayNow?.rooms.find((r) => r.id === rid);
  const openWins = (dayNow?.rooms ?? []).filter((r) => !r.closed && r.from !== undefined && r.to !== undefined);
  const open = openWins.length ? Math.min(...openWins.map((r) => r.from ?? 0)) : link ? Math.max(link.from * 60, 8 * 60) : 0;
  const close = openWins.length ? Math.max(...openWins.map((r) => r.to ?? 1440)) : link ? Math.min(link.to * 60, 20 * 60) : 0;
  const earliest = chosen === myDay(now) ? Math.ceil((myMin(now) + 1) / 15) * 15 : 0;
  const winOf = (rid: number): [number, number] => [Math.max(dayRoom(rid)?.from ?? open, earliest), dayRoom(rid)?.to ?? close];
  const maxOf = (rid: number | null) => {
    const r = rooms.find((x) => x.id === rid);
    return r?.maxHours ? Math.min(linkMax, r.maxHours * 60) : linkMax;
  };
  const busyOf = (rid: number) => (dayRoom(rid)?.busy ?? []).map((b) => [myMin(ms(b.start)), myMin(ms(b.end)) || 1440] as const);
  const closedOf = (rid: number) => dayRoom(rid)?.closed ?? null;
  const room = rooms.find((r) => r.id === roomId) ?? null;
  const maxMin = maxOf(roomId);
  const outside = !!room && from !== null && to !== null && (from < winOf(room.id)[0] || to > winOf(room.id)[1]);

  const clash = (() => {
    if (!room || from === null || to === null) return null;
    const busy = busyOf(room.id);
    const hit = busy.find(([a, b]) => from < b && a < to);
    if (!hit) return null;
    const len = to - from;
    const end = winOf(room.id)[1];
    let t = hit[1];
    while (t + len <= end && busy.some(([a, b]) => t < b && a < t + len)) t += 15;
    const other = rooms.find((r) => {
      if (r.id === room.id || (r.seats && r.seats < f.people) || closedOf(r.id)) return false;
      const [a0, b0] = winOf(r.id);
      return from >= a0 && to <= b0 && !busyOf(r.id).some(([a, b]) => from < b && a < to);
    });
    return { hit, next: t + len <= end ? t : null, other };
  })();

  const companyName = f.company === OTHER ? f.otherCompany.trim() : f.company;
  const ourCompany = !!f.company && f.company !== OTHER;
  const deps = companies.find((c) => c.name === f.company)?.departments ?? [];
  const missing: string[] = [];
  if (!companyName) missing.push("your company");
  if (ourCompany && deps.length && !f.department) missing.push("your department");
  if (!f.name.trim()) missing.push("your name");
  if (!f.phone.trim()) missing.push("phone");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) missing.push("a valid email");
  if (!room) missing.push("a room");
  if (from === null || to === null) missing.push("a time");
  if (!f.title.trim()) missing.push("a meeting title");
  if (room && room.seats && room.seats < f.people) missing.push(`a room for ${f.people} people`);
  if (room && closedOf(room.id)) missing.push("an open room");
  if (outside) missing.push(`a time inside ${room.name}'s hours (${hm(winOf(room.id)[0])}-${hm(winOf(room.id)[1])})`);
  if (from !== null && to !== null && to - from > maxMin) missing.push(`at most ${lenLabel(maxMin)}`);
  if (clash) missing.push("a free time");
  const ready = missing.length === 0;

  const firstFree = (rid: number, len: number): number | null => {
    const busy = busyOf(rid);
    const [a0, b0] = winOf(rid);
    let t = Math.ceil(a0 / 30) * 30;
    while (t + len <= b0 && busy.some(([a, b]) => t < b && a < t + len)) t += 30;
    return t + len <= b0 ? t : null;
  };
  const pickRoom = (rid: number) => {
    setRoomId(rid);
    if (closedOf(rid)) return;
    const [a0, b0] = winOf(rid);
    // Keep the chosen time when it fits this room; otherwise start at its first free hour, so a tap is a usable choice.
    if (from !== null && to !== null && from >= a0 && to <= b0 && to - from <= maxOf(rid)) return;
    const t = firstFree(rid, Math.min(60, maxOf(rid)));
    if (t !== null) { setFrom(t); setTo(t + Math.min(60, maxOf(rid))); }
  };

  // Drag along a room's bar to choose the time (15-minute steps, inside the room's hours, at most its longest booking).
  const drag = useRef<{ el: HTMLDivElement; start: number; rid: number } | null>(null);
  const minAt = (el: HTMLDivElement, x: number) => {
    const r = el.getBoundingClientRect();
    const m = open + ((x - r.left) / r.width) * (close - open);
    return Math.max(open, Math.min(close, Math.round(m / 15) * 15));
  };
  const onDown = (rid: number, e: RPointerEvent<HTMLDivElement>) => {
    if (closedOf(rid)) return;
    const [a0, b0] = winOf(rid);
    if (b0 - a0 < 15) return;
    const s = Math.max(a0, Math.min(minAt(e.currentTarget, e.clientX), b0 - 15));
    drag.current = { el: e.currentTarget, start: s, rid };
    e.currentTarget.setPointerCapture(e.pointerId);
    setRoomId(rid);
    setFrom(s);
    setTo(Math.min(b0, s + Math.min(60, maxOf(rid))));
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const [a0, b0] = winOf(d.rid);
    const mx = maxOf(d.rid);
    const m = minAt(d.el, e.clientX);
    let a = Math.max(a0, Math.min(d.start, m));
    let b = Math.min(b0, Math.max(d.start + 15, m));
    if (b - a > mx) { if (m < d.start) a = b - mx; else b = a + mx; }
    setFrom(a);
    setTo(b);
  };
  const onUp = () => { drag.current = null; };

  const [lo, hi] = room ? winOf(room.id) : [Math.max(open, earliest), close];
  const fromOptions: number[] = [];
  for (let m = Math.ceil(lo / 15) * 15; m <= hi - 15; m += 15) fromOptions.push(m);
  const toOptions: number[] = [];
  if (from !== null) for (let m = from + 15; m <= Math.min(hi, from + maxMin); m += 15) toOptions.push(m);

  const book = async () => {
    if (!ready || !room || from === null || to === null || !chosen) return;
    setSending(true);
    setFormError(null);
    try {
      const r = await call<{ token: string; booking: Booking }>(`/links/${encodeURIComponent(code)}/book`, {
        method: "POST",
        body: JSON.stringify({
          name: f.name.trim(), phone: f.phone.trim(), email: f.email.trim(), company: companyName, department: ourCompany ? f.department : "",
          title: f.title.trim(), people: f.people, roomId: room.id, start: at(chosen, from), end: at(chosen, to),
        }),
      });
      window.history.replaceState(null, "", `/book/${encodeURIComponent(code)}?b=${r.token}`);
      setBooking(r.booking);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      loadDay(chosen);
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    const t = new URLSearchParams(window.location.search).get("b");
    if (!t) return;
    setSending(true);
    try {
      await call(`/bookings/${t}/cancel`, { method: "POST" });
      setBooking((b) => (b ? { ...b, cancelled: true } : b));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const shell = (children: ReactNode, wide = false) => (
    <div className="min-h-[100dvh] bg-bg px-4 pb-28 lg:pb-12">
      <div className={`mx-auto flex w-full flex-col gap-4 pt-6 ${wide ? "max-w-[1120px]" : "max-w-[560px]"}`}>{children}</div>
    </div>
  );

  if (error) return shell(<div className={CARD}><h1 className="text-[20px] font-bold">This booking link is not active</h1><p className="text-ink-secondary">{/not active/i.test(error) ? "" : `${error} `}Ask the person who sent it for a new link.</p></div>);

  if (booking) {
    const r = typeof booking.room === "string" ? { name: booking.room, floor: booking.floor ?? "", location: booking.location ?? "" } : booking.room;
    return shell(
      <>
        <div className={CARD}>
          {booking.cancelled ? (
            <><h1 className="text-[22px] font-bold">Booking cancelled</h1><p className="text-ink-secondary">The room is free again. You can book a new time with the same link.</p></>
          ) : (
            <>
              <div className="rounded-xl bg-synced-bg px-3.5 py-2.5 font-semibold text-synced">Booked. You are confirmed.</div>
              <h1 className="text-[22px] font-bold">{booking.title || "Your booking"}</h1>
              <div>
                {[
                  ["When", `${fmtDay(ms(booking.start))}, ${fmtRange(ms(booking.start), ms(booking.end))}`],
                  ["Where", [r?.name, r?.floor, r?.location].filter(Boolean).join(", ")],
                  ...(booking.people ? [["People", String(booking.people)]] : []),
                  ["Booking no.", booking.code],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-t border-border/60 py-2.5"><span className="text-ink-muted">{k}</span><b className="text-right">{v}</b></div>
                ))}
              </div>
            </>
          )}
        </div>
        {!booking.cancelled && <button type="button" disabled={sending} onClick={() => void cancel()} className="h-12 rounded-xl border border-border bg-surface font-medium text-err">Cancel this booking</button>}
        {formError && <p className="text-err">{formError}</p>}
        {!booking.cancelled && <p className="text-center text-[13px] text-ink-muted">Keep this page's address to see or cancel your booking later. It is yours only. To change the time, cancel and book again.</p>}
      </>,
    );
  }

  if (!link) return shell(<p className="text-ink-muted">Loading...</p>);

  // Whole hours under each bar, at most five of them, always including the opening and closing hour.
  const h0 = Math.floor(open / 60);
  const h1 = Math.ceil(close / 60);
  const stepH = Math.max(1, Math.ceil((h1 - h0) / 4));
  const ticks: number[] = [];
  for (let h = h0; h < h1; h += stepH) ticks.push(h * 60);
  if (ticks.length && h1 * 60 - ticks[ticks.length - 1] < stepH * 30) ticks.pop();
  ticks.push(h1 * 60);
  const pct = (m: number) => `${((m - open) / (close - open)) * 100}%`;
  const preview: [string, [string, string][]][] = [
    ["Who", [["Company", companyName], ["Department", f.company === OTHER ? (f.otherCompany ? "Visitor" : "") : f.department], ["Name", f.name.trim()], ["Contact", [f.phone.trim(), f.email.trim()].filter(Boolean).join(" · ")]]],
    ["When", [["Room", room?.name ?? ""], ["Date", chosen && (room || from !== null) ? fmtDay(ms(at(chosen, 720))) : ""], ["Time", from !== null && to !== null ? `${hm(from)} - ${hm(to)}` : ""]]],
    ["Meeting", [["Title", f.title.trim()], ["People", `${f.people}`]]],
  ];
  const filled = [companyName, !!companyName && (f.company === OTHER || !deps.length || !!f.department), f.name.trim(), f.phone.trim(), f.email.trim(), room, from !== null && to !== null, f.title.trim(), true].filter(Boolean).length;
  const summary = ready && room && from !== null && to !== null && chosen ? `${room.name}, ${fmtDay(ms(at(chosen, 720)))}, ${hm(from)} - ${hm(to)}` : `Still needed: ${missing.join(", ")}`;

  return shell(
    <>
      <div>
        <h1 className="text-[26px] font-bold [text-wrap:balance]">Book a meeting room</h1>
        <p className="text-ink-secondary">{link.name}. Pick a day, a room and a time. You are confirmed straight away.</p>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className={CARD}>
            <div className={STEP}>1 · Who is booking</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={FIELD}>Company
                <select className={INPUT} value={f.company} onChange={(e) => setF({ ...f, company: e.target.value, department: "" })}>
                  <option value="">Choose your company</option>
                  {companies.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  {link.audience !== "staff" && <option value={OTHER}>Another company (visitor)</option>}
                </select>
              </label>
              {f.company === OTHER ? (
                <label className={FIELD}>Your company name<input className={INPUT} autoComplete="organization" placeholder="e.g. ABC Trading Sdn Bhd" value={f.otherCompany} onChange={(e) => setF({ ...f, otherCompany: e.target.value })} /></label>
              ) : (
                <label className={FIELD}>Department
                  <select className={INPUT} disabled={!ourCompany || !deps.length} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>
                    <option value="">{ourCompany ? "Choose your department" : "Choose a company first"}</option>
                    {deps.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={FIELD}>Your name<input className={INPUT} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
              <label className={FIELD}>Phone<input className={INPUT} inputMode="tel" autoComplete="tel" placeholder="+60 12-345 6789" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
            </div>
            <label className={FIELD}>Email (for the confirmation)<input className={INPUT} type="email" autoComplete="email" placeholder="you@company.com" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          </section>

          <section className={CARD}>
            <div className={STEP}>2 · Pick a room and time</div>
            {days.length === 0 ? <p className="text-ink-secondary">This link has no open days left. Ask the person who sent it for a new link.</p> : (
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Day">
                {days.map((d, i) => {
                  const on = d === chosen;
                  return (
                    <button key={d} type="button" aria-pressed={on} aria-label={fmtDay(ms(at(d, 720)))} onClick={() => { setDay(d); setFrom(null); setTo(null); setFormError(null); }}
                      className={`flex h-[72px] w-[68px] shrink-0 flex-col items-center justify-center rounded-xl border text-[12.5px] ${on ? "border-primary bg-primary text-white" : "border-border bg-surface text-ink-secondary"}`}>
                      {i === 0 && d === myDay(now) ? "Today" : DAY_NAMES[new Date(`${d}T12:00:00+08:00`).getUTCDay()]}
                      <b className={`text-[21px] ${on ? "text-white" : "text-ink"}`}>{Number(d.slice(8))}</b>
                    </button>
                  );
                })}
              </div>
            )}
            {dayNow === null && chosen ? <p className="text-ink-muted">Loading the rooms...</p> : rooms.length === 0 ? <p className="text-ink-secondary">No rooms are open through this link.</p> : (
              <div className="flex flex-col gap-2.5">
                {rooms.map((r) => {
                  const busy = busyOf(r.id);
                  const closed = closedOf(r.id);
                  const small = !!r.seats && r.seats < f.people;
                  const [w0, w1] = winOf(r.id);
                  const freeMin = closed ? 0 : Math.max(0, w1 - w0 - busy.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, w1) - Math.max(a, w0)), 0));
                  const on = roomId === r.id;
                  return (
                    <div key={r.id} role="button" tabIndex={0} aria-pressed={on} aria-label={`${r.name}${r.seats ? `, ${r.seats} seats` : ""}${closed ? ", closed" : ""}`} onClick={() => pickRoom(r.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickRoom(r.id); } }}
                      className={`flex cursor-pointer flex-col gap-2.5 rounded-xl border bg-surface p-3.5 ${on ? "border-primary ring-1 ring-primary" : "border-border"} ${small || closed ? "opacity-60" : ""}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[16.5px] font-semibold">{r.name}</div>
                          <div className="text-[13px] text-ink-secondary">
                            {[r.seats ? `${r.seats} seats` : "", [r.floor, r.location].filter(Boolean).join(", "), r.equipment.join(", ")].filter(Boolean).join(" · ")}
                            {small && <b className="text-warning-text"> · too small for {f.people}</b>}
                          </div>
                        </div>
                        <div className="whitespace-nowrap text-right text-[13px] tabular-nums text-ink-secondary">{closed ? closed : <>{lenLabel(freeMin)} free<span className="block text-[12px] text-ink-muted">open {hm(dayRoom(r.id)?.from ?? open)}-{hm(w1)}</span></>}</div>
                      </div>
                      <div className="relative h-8 touch-none select-none overflow-hidden rounded-lg bg-synced-bg" onPointerDown={(e) => onDown(r.id, e)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                        {w0 > open && <div className="absolute inset-y-0 left-0 bg-surface-2" style={{ width: pct(Math.min(close, w0)) }} title={w0 === earliest && earliest > (dayRoom(r.id)?.from ?? open) ? "Already past" : "Closed"} />}
                        {w1 < close && <div className="absolute inset-y-0 right-0 bg-surface-2" style={{ left: pct(Math.max(open, w1)) }} title="Closed" />}
                        {closed && <div className="absolute inset-0 bg-surface-2" />}
                        {busy.map(([a, b]) => (
                          <div key={`${a}-${b}`} className="absolute inset-y-0 flex items-center justify-center bg-ink-muted/35 text-[11px] text-ink-secondary" style={{ left: pct(Math.max(open, a)), width: `calc(${pct(Math.min(close, b))} - ${pct(Math.max(open, a))})` }} title="Booked">{Math.min(close, b) - Math.max(open, a) >= (close - open) / 10 ? "Booked" : ""}</div>
                        ))}
                        {on && from !== null && to !== null && (
                          <div className="absolute inset-y-[3px] flex items-center justify-center overflow-hidden whitespace-nowrap rounded-md bg-primary text-[11.5px] font-semibold text-white" style={{ left: pct(from), width: `calc(${pct(to)} - ${pct(from)})` }}>{hm(from)}-{hm(to)}</div>
                        )}
                      </div>
                      <div className="flex justify-between font-mono text-[11px] text-ink-muted">{ticks.map((t) => <span key={t}>{hm(t)}</span>)}</div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className={FIELD}>From
                <select className={INPUT} value={from ?? ""} onChange={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); setFrom(v); if (v !== null && (to === null || to <= v || to - v > maxMin)) setTo(Math.min(close, v + Math.min(60, maxMin))); }}>
                  <option value="">Start</option>
                  {fromOptions.map((m) => <option key={m} value={m}>{hm(m)}</option>)}
                </select>
              </label>
              <label className={FIELD}>To
                <select className={INPUT} value={to ?? ""} disabled={from === null} onChange={(e) => setTo(e.target.value === "" ? null : Number(e.target.value))}>
                  <option value="">End</option>
                  {toOptions.map((m) => <option key={m} value={m}>{hm(m)} ({lenLabel(m - (from ?? 0))})</option>)}
                </select>
              </label>
            </div>
            {clash && room && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-warning-bg px-3.5 py-2.5 text-[14px] text-warning-text">
                <span>{room.name} is booked {hm(clash.hit[0])}-{hm(clash.hit[1])}.{clash.next !== null ? ` Free from ${hm(clash.next)}.` : ""}{clash.other ? ` ${clash.other.name} is free at your time.` : ""}</span>
                <span className="flex flex-wrap gap-1.5">
                  {clash.next !== null && <button type="button" className="rounded-full bg-primary px-3 py-1.5 text-[13px] font-semibold text-white" onClick={() => { const len = (to ?? 0) - (from ?? 0); setFrom(clash.next); setTo((clash.next ?? 0) + len); }}>Move to {hm(clash.next)}</button>}
                  {clash.other && <button type="button" className="rounded-full bg-primary px-3 py-1.5 text-[13px] font-semibold text-white" onClick={() => setRoomId(clash.other?.id ?? null)}>Use {clash.other.name}</button>}
                </span>
              </div>
            )}
            <p className="text-[13px] text-ink-muted">Drag along a room's bar to choose the time, or use From and To. Each room shows its own opening hours. Darker grey means already booked; you will not see by whom.</p>
          </section>

          <section className={CARD}>
            <div className={STEP}>3 · Meeting</div>
            <label className={FIELD}>Meeting title<input className={INPUT} placeholder="e.g. Delivery schedule review" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
            <div className="flex items-center justify-between gap-3">
              <div><div className="text-ink">How many people</div><div className="text-[13px] text-ink-muted">Including you and any visitors</div></div>
              <div className="flex h-12 items-center rounded-xl border border-border">
                <button type="button" aria-label="Fewer people" className="h-full w-12 text-[20px]" onClick={() => setF({ ...f, people: Math.max(1, f.people - 1) })}>−</button>
                <output className="min-w-[40px] text-center text-[17px] font-semibold tabular-nums">{f.people}</output>
                <button type="button" aria-label="More people" className="h-full w-12 text-[20px]" onClick={() => setF({ ...f, people: Math.min(200, f.people + 1) })}>+</button>
              </div>
            </div>
          </section>

          {formError && <p className="rounded-xl bg-warning-bg px-3.5 py-2.5 text-warning-text">{formError}</p>}
          <div className="hidden flex-col gap-2 lg:flex">
            <button type="button" disabled={!ready || sending} onClick={() => void book()} className="h-14 rounded-xl bg-primary text-[16px] font-bold text-white disabled:opacity-50">{sending ? "Booking..." : "Book room"}</button>
            <p className="text-center text-[13.5px] text-ink-muted">{summary}</p>
          </div>
        </div>

        <aside className={`${CARD} sticky top-4 hidden lg:flex`} aria-label="Preview">
          <div><div className={STEP}>Preview</div><div className="text-[19px] font-bold">Your booking</div></div>
          <div className="flex flex-col gap-1.5">
            <div className="text-[13px] text-ink-muted">{filled} of 9 filled</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-primary transition-[width]" style={{ width: `${(filled / 9) * 100}%` }} /></div>
          </div>
          {preview.map(([group, rows]) => (
            <div key={group} className="flex flex-col gap-1 border-t border-border/60 pt-3">
              <b>{group}</b>
              {rows.map(([k, v]) => <div key={k} className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 text-[14px]"><span className="text-ink-muted">{k}</span><span className={v ? "break-words" : "text-ink-muted"}>{v || "Not filled yet"}</span></div>)}
            </div>
          ))}
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t border-border bg-surface px-4 pb-[calc(10px+env(safe-area-inset-bottom,0px))] pt-2.5 lg:hidden">
        <div className="min-w-0 flex-1 text-[13px] text-ink-secondary"><b className="block truncate text-[14.5px] text-ink">{ready ? room?.name : "Not ready yet"}</b><span className="block truncate">{summary}</span></div>
        <button type="button" disabled={!ready || sending} onClick={() => void book()} className="h-12 shrink-0 rounded-xl bg-primary px-5 font-bold text-white disabled:opacity-50">{sending ? "Booking..." : "Book"}</button>
      </div>
    </>,
    true,
  );
}
