import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  DAY_NAMES, ROOM_COLORS, addDays, daysLabel, fmtDay, fmtDayLong, fmtTime, guestLinkUrl, isoDay, ms, occupancy, personName, startOfDay, startOfWeek,
  type Closure, type GuestLink, type Meeting, type Notice, type Person, type Room,
} from "../../lib/meetings";
import { BTN, CONTROL, LABEL, PRI, Veil, chip, copyText } from "./MeetingsDialogs";
import { DateField } from "../../vendor/scm/components/DateField";

/* The Meetings page's other subpages: My meetings, Rooms (cards and the edit dialog),
   Guest links, Email and WhatsApp, and the Change log. */

const EQUIPMENT = ["TV", "Video call", "Whiteboard", "Projector", "Speakerphone"];
const CARD = "overflow-hidden rounded-2xl border border-border bg-surface";

export function MyMeetings({ meetings, notices, rooms, people, me, now, onOpen, error }: {
  meetings: Meeting[] | null; notices: Notice[]; rooms: Room[]; people: Map<string, Person>; me: string; now: number; onOpen: (m: Meeting) => void; error: string | null;
}) {
  let last: number | null = null;
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className={CARD} aria-label="Upcoming">
        {error && <p className="p-5 text-err">{error}</p>}
        {meetings && meetings.length === 0 && <p className="p-5 text-ink-muted">Nothing booked with you yet.</p>}
        {!meetings && !error && <p className="p-5 text-ink-muted">Loading...</p>}
        {meetings?.map((m) => {
          const d = startOfDay(ms(m.start));
          const head = d !== last;
          last = d;
          const r = rooms.find((x) => x.id === m.roomId);
          const mine = m.organizer === me || m.bookedBy === me;
          return (
            <div key={m.id}>
              {head && <div className="bg-surface-2 px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">{d === startOfDay(now) ? "Today · " : ""}{fmtDayLong(d)}</div>}
              <button type="button" onClick={() => onOpen(m)} className={cn("grid w-full grid-cols-[70px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border/60 px-4 py-3 text-left", m.status === "ended" && "opacity-60")}>
                <span className="tabular-nums"><b className="block text-[15px]">{fmtTime(ms(m.start))}</b><span className="text-[12.5px] text-ink-muted">{fmtTime(ms(m.end))}</span></span>
                <span className="min-w-0"><b>{m.title}</b><br /><span className="text-[13px] text-ink-secondary">{r ? r.name : "No room"} · {mine ? "You organise" : `By ${personName(m.organizer, people)}`}{m.video.url ? " · video" : ""}</span></span>
                <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold", m.status === "live" ? "bg-synced-bg text-synced" : m.status === "ended" ? "bg-surface-2 text-ink-secondary" : mine ? "bg-primary-soft text-primary-ink" : "bg-surface-2 text-ink")}>
                  {m.status === "live" ? "Live" : m.status === "ended" ? "Ended" : mine ? "Organiser" : "Invited"}
                </span>
              </button>
            </div>
          );
        })}
      </section>
      <section className={CARD} aria-label="Notifications">
        <div className="px-4 py-3.5 font-bold">Notifications</div>
        {notices.length === 0 && <p className="px-4 pb-4 text-ink-muted">No notifications yet.</p>}
        {notices.map((n) => (
          <div key={n.id} className={cn("border-t border-border/60 px-4 py-2.5 text-[13.5px] leading-5", !n.read && "bg-primary-soft/40")}>
            {n.text}<div className="mt-0.5 text-[12px] text-ink-muted">{fmtDay(ms(n.at))} {fmtTime(ms(n.at))}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

export function RoomsPage({ rooms, meetings, now, canManage, onEdit, onAdd, onBook }: {
  rooms: Room[]; meetings: Meeting[]; now: number; canManage: boolean; onEdit: (r: Room) => void; onAdd: () => void; onBook: (r: Room) => void;
}) {
  const locs = [...new Set(rooms.map((r) => r.location || "No location"))];
  const today = startOfDay(now);
  const ws = startOfWeek(now);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <p className="min-w-[240px] flex-1 text-ink-secondary">
          {canManage ? "Shared by every company. To set a room's seats, location, equipment or opening hours, press Edit on its card." : "Shared by every company. Only people with Manage meeting rooms can add or change rooms."}
        </p>
        {canManage && <button type="button" className={PRI} onClick={onAdd}>+ Add room</button>}
      </div>
      {rooms.length === 0 && <p className="rounded-2xl border border-dashed border-border p-8 text-center text-ink-muted">No rooms yet.{canManage ? " Press Add room to set up the first one." : ""}</p>}
      {locs.map((loc) => (
        <div key={loc}>
          <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">{loc} · {rooms.filter((r) => (r.location || "No location") === loc).length} rooms</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,290px),1fr))] gap-3.5">
            {rooms.filter((r) => (r.location || "No location") === loc).map((r) => {
              const occ = occupancy(r, meetings, ws);
              const todays = meetings.filter((m) => m.roomId === r.id && startOfDay(ms(m.start)) === today);
              const cur = todays.find((m) => m.status === "live");
              const next = todays.filter((m) => ms(m.start) > now).sort((a, b) => ms(a.start) - ms(b.start)).at(0);
              const pc = (t: number) => Math.max(0, Math.min(100, ((new Date(t).getHours() * 60 + new Date(t).getMinutes() - r.open_from * 60) / ((r.open_to - r.open_from) * 60)) * 100));
              return (
                <article key={r.id} className={cn(CARD, "flex flex-col", !r.active && "opacity-60")}>
                  <div className="h-1.5" style={{ background: r.color }} />
                  <div className="flex flex-col gap-2.5 p-4">
                    <div className="flex items-start">
                      <div className="flex-1"><div className="text-[17px] font-bold">{r.name}</div><div className="text-[13px] text-ink-secondary">{r.floor || "No floor set"}</div></div>
                      <div className="text-right"><div className="text-[22px] font-bold leading-none">{r.seats}</div><div className="text-[11.5px] text-ink-muted">seats</div></div>
                    </div>
                    {r.closures.filter((c) => c.to >= isoDay(now)).map((c, i) => <span key={i} className="self-start rounded-full bg-warning-bg px-2 py-0.5 text-[11.5px] font-semibold text-warning-text">Closed {c.from === c.to ? c.from : `${c.from} to ${c.to}`}{c.reason ? ` · ${c.reason}` : ""}</span>)}
                    <div className="flex flex-wrap gap-1.5">{r.equipment.length ? r.equipment.map((q) => <span key={q} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-semibold">{q}</span>) : <span className="text-[12.5px] text-ink-muted">No equipment</span>}</div>
                    <div className="text-[13px]">
                      {!r.active ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-semibold">Closed for booking</span>
                        : cur ? <><span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11.5px] font-semibold text-primary-ink">In use</span> until {fmtTime(ms(cur.end))}</>
                        : <><span className="rounded-full bg-synced-bg px-2 py-0.5 text-[11.5px] font-semibold text-synced">Free now</span>{next ? ` next ${fmtTime(ms(next.start))}` : " rest of today"}</>}
                    </div>
                    <div>
                      <div className="relative h-4 overflow-hidden rounded bg-surface-2">{todays.map((m) => <div key={m.id} title={m.title} className="absolute inset-y-0 opacity-85" style={{ left: `${pc(ms(m.start))}%`, width: `${Math.max(1, pc(ms(m.end)) - pc(ms(m.start)))}%`, background: r.color }} />)}</div>
                      <div className="mt-0.5 flex justify-between text-[11px] text-ink-muted"><span>Today {r.open_from}:00</span><span>{r.open_to}:00</span></div>
                    </div>
                    <div className="flex flex-wrap justify-between gap-1 text-[12.5px] text-ink-secondary">
                      <span>{daysLabel(r.open_days)}, {r.open_from}:00 - {r.open_to}:00</span>
                      <span>This week <b className="text-ink">{occ.percent}%</b> used{occ.afterHours ? ` · ${occ.afterHours} h after hours` : ""}</span>
                    </div>
                    <div className="flex gap-2">
                      {canManage && <button type="button" className={cn(BTN, "h-8")} onClick={() => onEdit(r)}>Edit</button>}
                      {r.active && <button type="button" className={cn(PRI, "h-8")} onClick={() => onBook(r)}>Book this room</button>}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[12.5px] text-ink-muted">Used = hours booked inside the room's usual hours, divided by those hours this week. Rooms can still be booked outside usual hours (overtime meetings); that time is shown separately as after hours.</p>
    </div>
  );
}

export type RoomForm = {
  id: number | null; name: string; location: string; floor: string; seats: number; equipment: string[]; days: number[]; openFrom: number; openTo: number;
  color: string; bufferMin: number; maxHours: number; advanceDays: number; active: boolean; closures: Closure[];
};
export const roomForm = (r: Room | null, count: number): RoomForm =>
  r
    ? { id: r.id, name: r.name, location: r.location, floor: r.floor, seats: r.seats, equipment: r.equipment, days: r.open_days, openFrom: r.open_from, openTo: r.open_to, color: r.color, bufferMin: r.buffer_min, maxHours: r.max_hours, advanceDays: r.advance_days, active: r.active, closures: r.closures }
    : { id: null, name: "", location: "Head office", floor: "", seats: 6, equipment: [], days: [1, 2, 3, 4, 5], openFrom: 9, openTo: 18, color: ROOM_COLORS[count % ROOM_COLORS.length], bufferMin: 0, maxHours: 0, advanceDays: 0, active: true, closures: [] };

export function RoomDialog({ initial, locations, futureBookings, saving, error, onClose, onSave }: {
  initial: RoomForm; locations: string[]; futureBookings: number; saving: boolean; error: string | null; onClose: () => void; onSave: (r: RoomForm) => void;
}) {
  const [x, setX] = useState(initial);
  const [cl, setCl] = useState({ from: "", to: "", reason: "" });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((a) => a !== v) : [...list, v]);
  return (
    <Veil onClose={onClose} label="Room">
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (x.name.trim()) onSave({ ...x, seats: Math.max(1, Number(x.seats) || 1) }); }}>
        <h3 className="text-[18px] font-bold">{x.id ? `Edit ${initial.name}` : "Add a room"}</h3>
        <label className={LABEL}>Room name<input required className={CONTROL} value={x.name} placeholder="Boardroom" onChange={(e) => setX({ ...x, name: e.target.value })} /></label>
        <div className="grid grid-cols-[1.5fr_1fr] gap-2.5">
          <label className={LABEL}>Location<input className={CONTROL} list="meeting-locations" value={x.location} onChange={(e) => setX({ ...x, location: e.target.value })} /><datalist id="meeting-locations">{locations.map((l) => <option key={l} value={l} />)}</datalist></label>
          <label className={LABEL}>Floor / area<input className={CONTROL} value={x.floor} placeholder="Level 2" onChange={(e) => setX({ ...x, floor: e.target.value })} /></label>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <label className={LABEL}>How many people<input type="number" min={1} max={500} className={CONTROL} value={x.seats} onChange={(e) => setX({ ...x, seats: Number(e.target.value) })} /></label>
          <label className={LABEL}>Opens<select className={CONTROL} value={x.openFrom} onChange={(e) => setX({ ...x, openFrom: Number(e.target.value) })}>{[6, 7, 8, 9, 10].map((h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
          <label className={LABEL}>Closes<select className={CONTROL} value={x.openTo} onChange={(e) => setX({ ...x, openTo: Number(e.target.value) })}>{[16, 17, 18, 19, 20, 21, 22, 23, 24].map((h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
        </div>
        <div className={LABEL}>Open days<div className="flex flex-wrap gap-1.5">{DAY_NAMES.map((d, i) => <button key={d} type="button" className={chip(x.days.includes(i))} onClick={() => setX({ ...x, days: toggle(x.days, i) })}>{d}</button>)}</div></div>
        <div className={LABEL}>Equipment<div className="flex flex-wrap gap-1.5">{EQUIPMENT.map((q) => <button key={q} type="button" className={chip(x.equipment.includes(q))} onClick={() => setX({ ...x, equipment: toggle(x.equipment, q) })}>{q}</button>)}</div></div>
        <div className={LABEL}>Colour in the calendar<div className="flex flex-wrap gap-2">{ROOM_COLORS.map((c) => <button key={c} type="button" aria-label={`Colour ${c}`} onClick={() => setX({ ...x, color: c })} className="h-7 w-7 rounded-full" style={{ background: c, boxShadow: x.color === c ? `0 0 0 2px rgb(var(--hz-surface)), 0 0 0 4px ${c}` : undefined }} />)}</div></div>
        <div className="grid grid-cols-3 gap-2.5">
          <label className={LABEL}>Gap between meetings<select className={CONTROL} value={x.bufferMin} onChange={(e) => setX({ ...x, bufferMin: Number(e.target.value) })}>{[[0, "None"], [10, "10 min"], [15, "15 min"], [30, "30 min"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className={LABEL}>Longest booking<select className={CONTROL} value={x.maxHours} onChange={(e) => setX({ ...x, maxHours: Number(e.target.value) })}>{[[0, "No limit"], [1, "1 hour"], [2, "2 hours"], [3, "3 hours"], [4, "4 hours"], [8, "8 hours"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className={LABEL}>Book ahead up to<select className={CONTROL} value={x.advanceDays} onChange={(e) => setX({ ...x, advanceDays: Number(e.target.value) })}>{[[0, "No limit"], [30, "30 days"], [60, "60 days"], [90, "90 days"], [180, "6 months"], [365, "1 year"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </div>
        <div className={LABEL}>Closed dates (repairs, events, holidays)
          {x.closures.map((c, i) => (
            <div key={i} className="flex items-center gap-2 font-normal normal-case tracking-normal text-ink">
              <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11.5px] font-semibold text-warning-text">{c.from === c.to ? c.from : `${c.from} to ${c.to}`}</span>{c.reason}
              <button type="button" aria-label="Remove closed dates" className="rounded-full p-1 hover:bg-surface-2" onClick={() => setX({ ...x, closures: x.closures.filter((_, j) => j !== i) })}><X size={14} /></button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 font-normal normal-case tracking-normal">
            <DateField aria-label="Closed from" value={cl.from} onChange={(v) => setCl({ ...cl, from: v })} />
            <span className="text-ink">to</span>
            <DateField aria-label="Closed to" value={cl.to} onChange={(v) => setCl({ ...cl, to: v })} />
            <input aria-label="Reason" className={cn(CONTROL, "w-auto flex-1")} placeholder="Reason" value={cl.reason} onChange={(e) => setCl({ ...cl, reason: e.target.value })} />
            <button type="button" className={cn(BTN, "h-8")} disabled={!cl.from} onClick={() => { setX({ ...x, closures: [...x.closures, { from: cl.from, to: cl.to && cl.to >= cl.from ? cl.to : cl.from, reason: cl.reason }] }); setCl({ from: "", to: "", reason: "" }); }}>Add</button>
          </div>
        </div>
        <label className="flex items-center gap-2.5"><input type="checkbox" className="accent-[rgb(var(--hz-primary))]" checked={x.active} onChange={(e) => setX({ ...x, active: e.target.checked })} />Open for booking</label>
        {!x.active && futureBookings > 0 && <div className="rounded-lg bg-warning-bg px-3 py-2 text-[13px] text-warning-text">{futureBookings} meeting{futureBookings === 1 ? " is" : "s are"} still booked in this room. They stay booked; tell the organisers to move them, or add closed dates instead so only those days are blocked.</div>}
        {error && <div className="text-err">{error}</div>}
        <div className="flex justify-end gap-2"><button type="button" className={BTN} onClick={onClose}>Cancel</button><button className={PRI} disabled={saving}>{saving ? "Saving..." : "Save room"}</button></div>
      </form>
    </Veil>
  );
}

export function LinksPage({ links, rooms, people, origin, onCreate, onToggle, flash }: {
  links: GuestLink[] | null; rooms: Room[]; people: Map<string, Person>; origin: string; onCreate: () => void; onToggle: (l: GuestLink) => void; flash: (t: string) => void;
}) {
  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-[240px] flex-1"><b>Guest booking links</b><div className="text-[13px] text-ink-secondary">Send one to a customer or supplier. They pick a day, a room and a time without logging in, and it is confirmed straight away. The link uses this ERP's address ({origin.replace(/^https?:\/\//, "")}).</div></div>
        <button type="button" className={PRI} onClick={onCreate}>+ Create link</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead><tr className="bg-surface-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">{["Link", "Rooms", "Longest", "Told", "Open", "Booked", "Status", ""].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2.5">{h}</th>)}</tr></thead>
          <tbody>
            {links?.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-ink-muted">No links yet.</td></tr>}
            {links?.map((l) => {
              const url = guestLinkUrl(origin, l.code);
              return (
                <tr key={l.id} className="border-t border-border/60 align-middle">
                  <td className="px-3 py-2.5"><b>{l.name}</b><br /><span className="select-all font-mono text-[12px] text-ink-secondary">{url}</span></td>
                  <td className="px-3 py-2.5">{l.rooms.map((id) => rooms.find((r) => r.id === id)?.name ?? `#${id}`).join(", ")}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">up to {l.length < 60 ? `${l.length} min` : `${l.length / 60} h`}{l.audience === "staff" ? <><br /><span className="text-[12px] text-ink-muted">staff only</span></> : null}</td>
                  <td className="px-3 py-2.5">{l.hosts.length ? l.hosts.map((h) => personName(h, people)).join(", ") : <span className="text-ink-muted">Nobody</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{daysLabel(l.days)}, {l.from}:00 - {l.to}:00<br /><span className="text-[12px] text-ink-muted">{l.until ? `until ${l.until}` : "no end date"}</span></td>
                  <td className="px-3 py-2.5">{l.booked}</td>
                  <td className="px-3 py-2.5"><span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-semibold", l.active ? "bg-synced-bg text-synced" : "bg-surface-2")}>{l.active ? "Active" : "Off"}</span></td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <button type="button" className={cn(BTN, "h-8")} onClick={async () => flash((await copyText(url)) ? "Link copied" : "Copy is blocked here. Select the link text instead.")}>Copy</button>{" "}
                    <a className={cn(BTN, "h-8 no-underline")} href={url} target="_blank" rel="noopener noreferrer">Open</a>{" "}
                    <button type="button" className={cn(BTN, "h-8")} onClick={() => onToggle(l)}>{l.active ? "Turn off" : "Turn on"}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export type LinkForm = { name: string; rooms: number[]; length: number; days: number[]; from: number; to: number; until: string | null; hosts: string[]; audience: "anyone" | "staff" };

/** The person with the link picks the room and the time range (owner, 2026-11-23); `length` is the longest booking. */
export function LinkDialog({ rooms, people, me, saving, error, onClose, onSave }: {
  rooms: Room[]; people: Person[]; me: string; saving: boolean; error: string | null; onClose: () => void; onSave: (l: LinkForm) => void;
}) {
  const open = rooms.filter((r) => r.active);
  const [x, setX] = useState<LinkForm>({ name: "", rooms: open.map((r) => r.id), length: 120, days: [1, 2, 3, 4, 5], from: 9, to: 18, until: isoDay(addDays(Date.now(), 30)), hosts: me ? [me] : [], audience: "anyone" });
  const [q, setQ] = useState("");
  const [co, setCo] = useState("");
  const [dep, setDep] = useState("");
  const companies = [...new Set(people.map((p) => p.company).filter(Boolean))].sort();
  const deps = [...new Set(people.filter((p) => !co || p.company === co).map((p) => p.department).filter(Boolean))].sort();
  const needle = q.trim().toLowerCase();
  const pool = people
    .filter((p) => (needle ? `${p.name} ${p.company} ${p.department}`.toLowerCase().includes(needle) : (!co || p.company === co) && (!dep || p.department === dep)))
    .slice(0, 200);
  const byKey = new Map(people.map((p) => [p.key, p]));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((a) => a !== v) : [...list, v]);
  const missing = [!x.name.trim() && "a link name", !x.rooms.length && "at least one room", !x.days.length && "at least one day", x.from >= x.to && "an end hour after the start"].filter(Boolean) as string[];
  const ok = missing.length === 0;
  return (
    <Veil onClose={onClose} label="Guest link">
      <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(x); }}>
        <div>
          <h3 className="text-[18px] font-bold">Create a booking link</h3>
          <p className="text-[13px] text-ink-secondary">Anyone you send it to picks a day, a room and a time themselves. No login. Confirmed straight away.</p>
        </div>
        <label className={LABEL}>Link name (only staff see it)<input className={CONTROL} value={x.name} placeholder="Type a name, e.g. Supplier visits" onChange={(e) => setX({ ...x, name: e.target.value })} /></label>
        <div className={LABEL}>Rooms they can book
          <div className="flex flex-wrap gap-1.5">{open.map((r) => <button key={r.id} type="button" className={chip(x.rooms.includes(r.id))} onClick={() => setX({ ...x, rooms: toggle(x.rooms, r.id) })}>{r.name}{r.seats ? ` · ${r.seats}` : ""}</button>)}</div>
          {open.length === 0 && <span className="font-normal normal-case tracking-normal text-err">No rooms yet. Add one under Rooms first.</span>}
        </div>
        <div className={LABEL}>Open days<div className="flex flex-wrap gap-1.5">{DAY_NAMES.map((d, i) => <button key={d} type="button" className={chip(x.days.includes(i))} onClick={() => setX({ ...x, days: toggle(x.days, i) })}>{d}</button>)}</div></div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <label className={LABEL}>From<select className={CONTROL} value={x.from} onChange={(e) => setX({ ...x, from: Number(e.target.value) })}>{[6, 7, 8, 9, 10, 11, 12, 13, 14].map((h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
          <label className={LABEL}>To<select className={CONTROL} value={x.to} onChange={(e) => setX({ ...x, to: Number(e.target.value) })}>{[12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map((h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
          <label className={LABEL}>Longest booking<select className={CONTROL} value={x.length} onChange={(e) => setX({ ...x, length: Number(e.target.value) })}>{[[30, "30 min"], [60, "1 hour"], [120, "2 hours"], [180, "3 hours"], [240, "4 hours"], [480, "8 hours"]].map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        </div>
        <div className={LABEL}>Works until
          <div className="flex flex-wrap items-center gap-3">
            {x.until ? <div className="min-w-[180px] flex-1"><DateField aria-label="Works until" fullWidth value={x.until} onChange={(v) => setX({ ...x, until: v || null })} /></div> : <span className={cn(CONTROL, "flex min-w-[180px] flex-1 items-center bg-surface-2")}>No end date</span>}
            <span className="flex items-center gap-1.5 font-normal normal-case tracking-normal text-ink"><input type="checkbox" checked={!x.until} onChange={(e) => setX({ ...x, until: e.target.checked ? null : isoDay(addDays(Date.now(), 30)) })} />No end date</span>
          </div>
        </div>
        <div className={LABEL}>Who can use it
          <div className="grid gap-2 sm:grid-cols-2">
            {([["anyone", "Anyone with the link", "Visitors type their own company; staff pick ours"], ["staff", "Our staff only", "Company must be one of ours (staff without an ERP login)"]] as const).map(([v, t, d]) => (
              <button key={v} type="button" aria-pressed={x.audience === v} onClick={() => setX({ ...x, audience: v })}
                className={cn("flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left normal-case tracking-normal", x.audience === v ? "border-primary bg-primary-soft" : "border-border bg-surface")}>
                <b className="text-[13.5px] text-ink">{t}</b><span className="text-[12px] font-normal text-ink-secondary">{d}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={LABEL}>Who gets told about each booking (optional)
          <div className="flex flex-wrap gap-1.5 normal-case tracking-normal">
            {x.hosts.length === 0 && <span className="font-normal text-ink-muted">Nobody. Bookings still show on everyone's calendar.</span>}
            {x.hosts.map((k) => { const p = byKey.get(k); return (
              <span key={k} className="inline-flex items-center gap-1 rounded-full bg-primary-soft py-1 pl-2.5 pr-1 text-[12.5px] font-medium text-primary-ink">
                {p?.name ?? k}{p?.company ? ` · ${p.company}` : ""}
                <button type="button" aria-label={`Remove ${p?.name ?? k}`} className="rounded-full p-0.5 hover:bg-surface" onClick={() => setX({ ...x, hosts: x.hosts.filter((h) => h !== k) })}><X size={13} /></button>
              </span>
            ); })}
          </div>
          <input className={CONTROL} placeholder="Search anyone, in any company" value={q} onChange={(e) => setQ(e.target.value)} />
          {!needle && (
            <div className="grid grid-cols-2 gap-2">
              <select className={CONTROL} value={co} onChange={(e) => { setCo(e.target.value); setDep(""); }}><option value="">All companies</option>{companies.map((c) => <option key={c}>{c}</option>)}</select>
              <select className={CONTROL} value={dep} onChange={(e) => setDep(e.target.value)}><option value="">All departments</option>{deps.map((d) => <option key={d}>{d}</option>)}</select>
            </div>
          )}
          <div className="max-h-48 overflow-auto rounded-xl border border-border normal-case tracking-normal">
            {pool.length === 0 && <div className="px-3 py-3 font-normal text-ink-muted">Nobody matches.</div>}
            {pool.map((p) => (
              <label key={p.key} className="flex cursor-pointer items-center gap-2.5 border-t border-border/60 px-3 py-2 text-[13.5px] font-normal text-ink first:border-t-0">
                <input type="checkbox" checked={x.hosts.includes(p.key)} onChange={() => setX({ ...x, hosts: toggle(x.hosts, p.key) })} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-[12px] text-ink-muted">{[p.company, p.department].filter(Boolean).join(" · ")}</span>
              </label>
            ))}
          </div>
        </div>
        {error && <div className="text-err">{error}</div>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!ok && <span className="mr-auto text-[12.5px] text-ink-muted">Still needed: {missing.join(", ")}</span>}
          <button type="button" className={BTN} onClick={onClose}>Cancel</button>
          <button className={PRI} disabled={!ok || saving}>{saving ? "Creating..." : "Create link"}</button>
        </div>
      </form>
    </Veil>
  );
}

export function EmailPage({ erpName }: { erpName: string }) {
  return (
    <section className={cn(CARD, "p-5")}>
      <b>Email and WhatsApp for {erpName}</b>
      <p className="mt-2 text-ink-secondary">Not connected yet. Meeting invitations, changes and reminders reach people as the bell notification in their own ERP and in My meetings.</p>
      <p className="mt-2 text-ink-secondary">Sending them by email from this ERP's Gmail, and reminders by WhatsApp through Houzs Connect, is switched on here once the Google setup for the company mailboxes is finished. Each ERP sets its own sending address.</p>
    </section>
  );
}

export function LogPage({ log, people, error }: { log: { at: string; who: string; text: string }[] | null; people: Map<string, Person>; error: string | null }) {
  return (
    <section className={CARD}>
      {error && <p className="p-4 text-err">{error}</p>}
      {log?.length === 0 && <p className="p-4 text-ink-muted">No room or link changes yet.</p>}
      {log?.map((l, i) => <div key={i} className="border-t border-border/60 px-4 py-2.5 text-[13.5px] first:border-t-0"><b>{personName(l.who, people)}</b> {l.text}<span className="text-ink-muted"> · {fmtDay(ms(l.at))} {fmtTime(ms(l.at))}</span></div>)}
    </section>
  );
}

