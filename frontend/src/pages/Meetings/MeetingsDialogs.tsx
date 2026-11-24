import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Calendar, MapPin, Paperclip, Pencil, Repeat, StickyNote, Trash2, Users, Video, Bell, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";
import {
  DAY, DAY_NAMES, HOUR, MIN, REMINDER_OPTIONS, addDays, atHour, busySentences, directoryTree, fmtDay, fmtDayLong, fmtRange, fmtTime,
  hhmm, inUsualHours, isoDay, minutesOfDay, ms, peopleOf, personLine, personName, remLabel, snapMinutes, startOfDay, withTime,
  type ConflictReply, type Draft, type Meeting, type Person, type Room, bestRoom } from "../../lib/meetings";

/* The Meetings page's dialogs: a meeting's details, quick booking, the full editor
   (people picker and Find a time), the conflict dialog and the repeat-scope question. */

export const CONTROL =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none";
export const LABEL = "flex flex-col gap-1 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted";
const BTN = "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface px-3.5 text-[13px] font-medium text-ink hover:bg-surface-2 disabled:opacity-50";
const PRI = "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-4 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50";
const CHIP = "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium";
export const chip = (on: boolean) => cn(CHIP, on ? "border-primary bg-primary-soft text-primary-ink" : "border-border bg-surface text-ink");
export { BTN, PRI };

export function Veil({ onClose, children, label, wide }: { onClose: () => void; children: ReactNode; label: string; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={label} className={cn("max-h-full w-full overflow-auto rounded-2xl bg-surface shadow-xl", wide ? "max-w-[1100px]" : "max-w-[540px] p-5")}>{children}</div>
    </div>
  );
}

/** Where a popover sits next to the click; a bottom sheet on a phone. */
function popStyle(x: number, y: number, w = 440, h = 470): CSSProperties {
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (W < 640) return { left: 12, right: 12, bottom: 12 };
  let l = x + 12;
  if (l + w > W - 12) l = Math.max(12, x - w - 12);
  return { left: l, top: Math.min(Math.max(12, y - 60), Math.max(12, H - h - 12)), width: w };
}

export function PersonSearch({ people, exclude, onPick, placeholder }: { people: Person[]; exclude: string[]; onPick: (key: string) => void; placeholder: string }) {
  const [t, setT] = useState("");
  const hits = t ? people.filter((p) => !exclude.includes(p.key) && `${p.name} ${p.company} ${p.department} ${p.email ?? ""}`.toLowerCase().includes(t.toLowerCase())).slice(0, 8) : [];
  return (
    <div className="relative">
      <input className={cn(CONTROL, "border-0 bg-surface-2")} placeholder={placeholder} aria-label={placeholder} value={t} onChange={(e) => setT(e.target.value)} />
      {hits.length > 0 && (
        <div className="absolute inset-x-0 top-11 z-30 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          {hits.map((p) => (
            <button key={p.key} type="button" className="block w-full px-3 py-2 text-left hover:bg-surface-2" onClick={() => { onPick(p.key); setT(""); }}>
              <b>{p.name}</b> <span className="text-[12.5px] text-ink-muted">{[p.company, p.department].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export type MeetingFile = { id: number; file_name: string; size_bytes: number; mime_type?: string };

export function MeetingDetail(p: {
  m: Meeting; rooms: Room[]; people: Map<string, Person>; me: string; x: number; y: number; color: string;
  history: { at: string; who: string; text: string }[] | null; files: MeetingFile[];
  canChange: boolean; busy: boolean;
  onClose: () => void; onEdit: () => void; onCancel: () => void; onStart: () => void; onEnd: () => void; onFile: (f: MeetingFile) => void;
}) {
  const { m, people } = p;
  const r = p.rooms.find((z) => z.id === m.roomId);
  const org = people.get(m.organizer);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [p]);
  const row = (icon: ReactNode, body: ReactNode) => (<><span className="mt-0.5 text-ink-secondary">{icon}</span><div className="min-w-0">{body}</div></>);
  return (
    <>
      <div className="fixed inset-0 z-[39]" onPointerDown={p.onClose} />
      <div role="dialog" aria-label="Meeting details" className="fixed z-40 max-h-[calc(100vh-24px)] overflow-auto rounded-[20px] bg-surface p-4 pt-3 shadow-2xl" style={popStyle(p.x, p.y)}>
        <div className="flex justify-end gap-0.5">
          {p.canChange && m.status !== "ended" && !m.guest && <button type="button" aria-label="Edit" className="rounded-full p-2 text-ink-secondary hover:bg-surface-2" onClick={p.onEdit}><Pencil size={17} /></button>}
          {p.canChange && m.status !== "ended" && <button type="button" aria-label="Cancel meeting" className="rounded-full p-2 text-ink-secondary hover:bg-surface-2" onClick={p.onCancel}><Trash2 size={17} /></button>}
          <button type="button" aria-label="Close" className="rounded-full p-2 text-ink-secondary hover:bg-surface-2" onClick={p.onClose}><X size={17} /></button>
        </div>
        <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-3.5 gap-y-3 text-[13.5px]">
          <span className="mt-1.5 h-3.5 w-3.5 rounded" style={{ background: p.color }} />
          <div>
            <div className="text-[20px] leading-7 text-ink">{m.title || "(No title)"}</div>
            <div className="text-ink-secondary">{fmtDayLong(ms(m.start))} · {fmtRange(ms(m.start), ms(m.end))}{m.seriesId ? " · repeats" : ""}</div>
            <div className="mt-1.5">
              {m.status === "live" ? <span className="rounded-full bg-synced-bg px-2 py-0.5 text-[11.5px] font-semibold text-synced">In progress{m.startedAt ? ` · started ${fmtTime(ms(m.startedAt))}` : ""}</span>
                : m.status === "ended" ? <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] font-semibold text-ink-secondary">Ended{m.endedAt ? ` ${fmtTime(ms(m.endedAt))}` : ""}</span>
                : <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11.5px] font-semibold text-primary-ink">Coming up</span>}
            </div>
          </div>
          {row(<MapPin size={17} />, r ? [r.name, r.floor, `${r.seats} seats`].filter(Boolean).join(" · ") : "No room")}
          {m.video.url && row(<Video size={17} />, <>
            <a href={m.video.url} target="_blank" rel="noopener noreferrer" className={cn(PRI, "h-8 no-underline")}>Join {m.video.type === "meet" ? "Google Meet" : m.video.type === "zoom" ? "Zoom" : "video call"}</a>
            <div className="mt-1 break-all text-[12px] text-ink-muted">{m.video.url}</div>
          </>)}
          {row(<Calendar size={17} />, m.guest
            ? <>Guest booking through a link, confirmed automatically<br /><span className="text-ink-secondary">Host: {personLine(m.organizer, people)}</span></>
            : <>Booked by <b>{org?.name ?? m.organizer}</b>{m.bookedBy !== m.organizer ? ` (by ${personName(m.bookedBy, people)})` : ""}<br /><span className="text-ink-secondary">{[org?.company, org?.department].filter(Boolean).join(" · ")}</span></>)}
          {m.guest && row(<Users size={17} />, <><b>{m.guest.name}</b>{m.guest.company ? ` · ${m.guest.company}` : ""}<br /><span className="text-[13px] text-ink-secondary">{m.guest.phone} · {m.guest.email}</span></>)}
          {row(<Users size={17} />, <>
            <b className="font-medium">{peopleOf(m).length} {peopleOf(m).length === 1 ? "person" : "people"}</b>
            <div className="mt-1 flex flex-col gap-1 text-[13px]">
              {peopleOf(m).map((k) => <div key={k}>{personName(k, people)}{k === m.organizer ? " (organiser)" : ""}{k === p.me ? " (you)" : ""} <span className="text-ink-muted">· {[people.get(k)?.company, people.get(k)?.department].filter(Boolean).join(" · ")}</span></div>)}
            </div>
          </>)}
          {m.notes && row(<StickyNote size={17} />, <span className="whitespace-pre-wrap text-ink-secondary">{m.notes}</span>)}
          {p.files.length > 0 && row(<Paperclip size={17} />, <div className="flex flex-wrap gap-1.5">{p.files.map((f) => <button key={f.id} type="button" onClick={() => p.onFile(f)} className={cn(CHIP, "border-border")}>{f.file_name}</button>)}</div>)}
          {m.reminders && m.reminders.length > 0 && row(<Bell size={17} />, <span className="text-[13px] text-ink-secondary">{m.reminders.map((rm) => `${remLabel(rm.min)} in the ERP`).join("; ")}</span>)}
          {p.history && p.history.length > 0 && row(<Repeat size={17} />, (
            <details className="text-[13px] text-ink-secondary"><summary className="cursor-pointer">History · {p.history.length}</summary>
              {p.history.map((h, i) => <div key={i} className="mt-1">{fmtDay(ms(h.at))} {fmtTime(ms(h.at))} · <b className="text-ink">{personName(h.who, people)}</b> {h.text}</div>)}
            </details>
          ))}
        </div>
        {m.status !== "ended" && (
          <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {p.canChange && <>
              {m.status === "scheduled" && <button type="button" className={PRI} disabled={p.busy} onClick={p.onStart}>Start meeting</button>}
              <button type="button" className={BTN} disabled={p.busy} onClick={p.onEnd}>End meeting</button>
            </>}
            <span className="min-w-[160px] flex-1 text-[12px] text-ink-secondary">
              {p.canChange ? `Not pressed? It starts at ${fmtTime(ms(m.start))} and ends at ${fmtTime(ms(m.end))} by itself.` : `Only ${org?.name ?? "the organiser"} can start or end it. It starts and ends by itself on time.`}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

const REPEAT_OPTIONS = (start: number): [Draft["repeat"], string][] => [
  ["none", "Does not repeat"], ["daily", "Every day"], ["weekdays", "Every weekday (Mon - Fri)"], ["weekly", `Every week on ${DAY_NAMES[new Date(start).getDay()]}`], ["monthly", "Every 4 weeks"],
];

/** In person (pick a room, best fit first) or Online (no room, private to the people in it). Over-full rooms warn but still book. */
function RoomPicker({ rooms, d, busyRooms, onRoom, compact }: { rooms: Room[]; d: Draft; busyRooms: Set<number>; onRoom: (id: number | null) => void; compact: boolean }) {
  const [online, setOnline] = useState(d.roomId === null && d.id !== null);
  const count = 1 + d.attendees.length;
  const best = bestRoom(rooms, count, busyRooms);
  const room = rooms.find((r) => r.id === d.roomId);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={chip(!online)} onClick={() => { setOnline(false); if (d.roomId === null) onRoom(best?.id ?? null); }}>In person</button>
        <button type="button" className={chip(online)} onClick={() => { setOnline(true); onRoom(null); }}>Online</button>
      </div>
      {online ? (
        <div className="text-[12.5px] text-ink-secondary">No room. Only you and the people you add can see this meeting.</div>
      ) : (
        <>
          <select aria-label="Room" className={CONTROL} value={d.roomId ?? ""} onChange={(e) => onRoom(e.target.value ? Number(e.target.value) : null)}>
            <option value="" disabled>Pick a room</option>
            {rooms.filter((r) => r.active).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.seats} seats{busyRooms.has(r.id) ? " · taken" : " · free"}{best?.id === r.id ? " · best fit" : ""}{inUsualHours(r, d.start, d.end) ? "" : " · after hours"}
              </option>
            ))}
          </select>
          {!room && <div className="text-[12.5px] text-warning-text">Pick a room, or choose Online.</div>}
          {room && room.seats < count && (
            <div className="text-[12.5px] text-warning-text">
              {count} people, but {room.name} seats {room.seats}. You can still book it.
              {best && best.id !== room.id && <> <button type="button" className="font-semibold underline" onClick={() => onRoom(best.id)}>Use {best.name} ({best.seats} seats)</button></>}
            </div>
          )}
          {room && room.seats >= count && best && best.id !== room.id && room.seats > best.seats * 2 && !compact && (
            <div className="text-[12.5px] text-ink-secondary">
              {room.name} is large for {count}. <button type="button" className="font-semibold underline" onClick={() => onRoom(best.id)}>Use {best.name} ({best.seats} seats)</button>
            </div>
          )}
          {room && !inUsualHours(room, d.start, d.end) && <div className="text-[12.5px] text-warning-text">Outside this room's usual hours ({room.open_from}:00 - {room.open_to}:00). You can still book it; it counts as after hours.</div>}
        </>
      )}
    </div>
  );
}

export function QuickBook(p: {
  draft: Draft; rooms: Room[]; people: Person[]; busyRooms: Set<number>; saving: boolean;
  onClose: () => void; onMore: (d: Draft) => void; onSave: (d: Draft) => void;
}) {
  const [d, setD] = useState(p.draft);
  return (
    <>
      <div className="fixed inset-0 z-[39]" onPointerDown={p.onClose} />
      <form role="dialog" aria-label="Quick booking" className="fixed z-40 max-h-[calc(100vh-24px)] overflow-auto rounded-[20px] bg-surface p-4 shadow-2xl"
        style={popStyle(window.innerWidth / 2 - 220, window.innerHeight / 2 - 160)} onSubmit={(e) => { e.preventDefault(); p.onSave(d); }}>
        <div className="flex justify-end"><button type="button" aria-label="Close" className="rounded-full p-2 text-ink-secondary hover:bg-surface-2" onClick={p.onClose}><X size={17} /></button></div>
        <input autoFocus className="h-11 w-full border-0 border-b-2 border-primary bg-transparent px-0.5 text-[21px] text-ink outline-none" placeholder="Add title" aria-label="Title" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
        <div className="my-3 text-ink-secondary">{fmtDayLong(d.start)} · <b className="text-ink">{fmtRange(d.start, d.end)}</b></div>
        <div className={cn(LABEL, "mb-1")}>Where</div>
        <RoomPicker rooms={p.rooms} d={d} busyRooms={p.busyRooms} onRoom={(id) => setD({ ...d, roomId: id })} compact />
        <label className={cn(LABEL, "mt-2.5")}>Repeat
          <select className={CONTROL} value={d.repeat} onChange={(e) => setD({ ...d, repeat: e.target.value as Draft["repeat"], repeatUntil: d.repeatUntil ?? isoDay(addDays(d.start, 56)) })}>
            {REPEAT_OPTIONS(d.start).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {d.repeat !== "none" && <label className={cn(LABEL, "mt-2")}>Repeat until<DateField aria-label="Repeat until" fullWidth value={d.repeatUntil ?? ""} onChange={(v) => setD({ ...d, repeatUntil: v || null })} /></label>}
        <div className="mt-2.5">
          <div className={cn(LABEL, "mb-1")}>People</div>
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {d.attendees.map((k) => <span key={k} className="inline-flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-2.5 pr-1 text-[12.5px] text-primary-ink">{p.people.find((x) => x.key === k)?.name ?? k}<button type="button" aria-label={`Remove ${k}`} className="rounded-full p-0.5" onClick={() => setD({ ...d, attendees: d.attendees.filter((a) => a !== k) })}><X size={13} /></button></span>)}
          </div>
          <PersonSearch people={p.people} exclude={[d.organizer, ...d.attendees]} placeholder="Add people by name" onPick={(k) => setD({ ...d, attendees: [...d.attendees, k] })} />
        </div>
        <div className="mt-3.5 flex justify-end gap-2">
          <button type="button" className={cn(BTN, "border-transparent text-primary")} onClick={() => p.onMore(d)}>More options</button>
          <button className={PRI} disabled={p.saving}>{p.saving ? "Saving..." : "Save"}</button>
        </div>
      </form>
    </>
  );
}

export function ConflictDialog(p: {
  reply: ConflictReply; draft: Draft; rooms: Room[]; people: Map<string, Person>;
  onClose: () => void; onApply: (d: Draft) => void;
}) {
  const { conflict, suggestTime, suggestRooms } = p.reply;
  const d = p.draft;
  const r = p.rooms.find((x) => x.id === d.roomId);
  const len = d.end - d.start;
  const t = suggestTime ? ms(suggestTime) : null;
  return (
    <Veil onClose={p.onClose} label="Can't book">
      {conflict.rules.length > 0 && (
        <Alert tone="warn" title="This room's rules don't allow it">{conflict.rules.map((x, i) => <p key={i} className="my-1 text-ink-secondary">{x}</p>)}</Alert>
      )}
      {conflict.people.length > 0 && (
        <Alert tone="err" title={conflict.people.length === 1 ? `${personName(conflict.people[0].key, p.people)} is already booked` : `${conflict.people.length} people are already booked`}>
          {busySentences(conflict, p.people).map((s, i) => <p key={i} className="my-1 text-ink-secondary">{s}</p>)}
          <p className="mt-1.5 text-ink-secondary">You cannot book {conflict.people.length === 1 ? personName(conflict.people[0].key, p.people) : "them"} for {fmtRange(d.start, d.end)}.</p>
        </Alert>
      )}
      {conflict.room && (
        <Alert tone="warn" title={`${r?.name ?? "The room"} is taken at that time`}>
          <p className="my-1 text-ink-secondary"><b className="text-ink">{conflict.room.title}</b> has it from {fmtTime(conflict.room.start)} to {fmtTime(conflict.room.end)}{r?.buffer_min ? `, and this room keeps ${r.buffer_min} minutes free between meetings` : ""}.</p>
        </Alert>
      )}
      {(conflict.room || conflict.rules.length > 0) && (suggestRooms.length > 0
        ? <>
          <div className="mb-1.5 mt-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">Free at the same time</div>
          <div className="flex flex-col gap-2">
            {suggestRooms.map((a, i) => (
              <div key={a.id} className={cn("flex items-center gap-3 rounded-xl border p-3", i === 0 ? "border-primary bg-primary-soft/40" : "border-border")}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.rooms.find((x) => x.id === a.id)?.color }} />
                <div className="flex-1"><b>{a.name}</b>{i === 0 && <span className="ml-1.5 rounded-full bg-synced-bg px-2 py-0.5 text-[11px] font-semibold text-synced">Best fit</span>}
                  <div className="text-[12.5px] text-ink-secondary">{[`${a.seats} seats`, a.equipment.join(", ") || "No equipment", a.floor].filter(Boolean).join(" · ")}</div></div>
                <button type="button" className={i === 0 ? PRI : BTN} onClick={() => p.onApply({ ...d, roomId: a.id })}>Use {a.name}</button>
              </div>
            ))}
          </div>
        </>
        : <p className="text-ink-secondary">No other room with enough seats is free then.</p>)}
      {t !== null ? (
        <>
          <div className="mb-1.5 mt-3.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">{conflict.people.length ? "Everyone is free from" : "Or keep this room"}</div>
          <div className="flex items-center gap-3 rounded-xl border border-border p-3">
            <div className="flex-1"><b>{fmtDay(t)}, {fmtRange(t, t + len)}</b><div className="text-[12.5px] text-ink-secondary">{r ? `${r.name} is free then too` : "Everyone you picked is free"}</div></div>
            <button type="button" className={PRI} onClick={() => p.onApply({ ...d, start: t, end: t + len })}>Move to {fmtTime(t)}</button>
          </div>
        </>
      ) : <p className="mt-3 text-ink-secondary">No common free time left that day. Pick another day.</p>}
      <div className="mt-4 flex justify-end"><button type="button" className={BTN} onClick={p.onClose}>Back to editing</button></div>
      {conflict.people.length > 0 && <p className="mt-2.5 text-[12.5px] text-ink-muted">To go ahead without someone, remove them yourself in the People list. The system never drops anyone for you.</p>}
    </Veil>
  );
}

function Alert({ tone, title, children }: { tone: "warn" | "err"; title: string; children: ReactNode }) {
  return (
    <div className="mb-3.5 flex items-start gap-3">
      <span className={cn("flex h-8 w-8 flex-none items-center justify-center rounded-full font-bold", tone === "err" ? "bg-err-bg text-err" : "bg-warning-bg text-warning-text")}>!</span>
      <div className="flex-1"><h3 className="text-[17px] font-bold text-ink">{title}</h3>{children}</div>
    </div>
  );
}

export function ScopeQuestion({ title, act, onClose, onPick }: { title: string; act: "save" | "cancel"; onClose: () => void; onPick: (scope: "one" | "following") => void }) {
  return (
    <Veil onClose={onClose} label="Repeating meeting">
      <h3 className="text-[18px] font-bold">{act === "cancel" ? "Cancel repeating meeting" : "Change repeating meeting"}</h3>
      <p className="my-2 text-ink-secondary">{title} repeats. Which ones?</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={BTN} onClick={onClose}>Back</button>
        <button type="button" className={BTN} onClick={() => onPick("one")}>This meeting</button>
        <button type="button" className={PRI} onClick={() => onPick("following")}>This and following</button>
      </div>
    </Veil>
  );
}

export function PeoplePicker({ people, value, exclude, onChange }: { people: Person[]; value: string[]; exclude: string; onChange: (v: string[]) => void }) {
  const tree = useMemo(() => directoryTree(people.filter((p) => p.key !== exclude)), [people, exclude]);
  // Open on the organiser's own company and department (owner 2026-11-24).
  const own = people.find((x) => x.key === exclude);
  const [co, setCo] = useState(() => (own && tree.some((t) => t.company === own.company) ? own.company : tree[0]?.company ?? ""));
  const comp = tree.find((t) => t.company === co) ?? tree.at(0);
  const [dept, setDept] = useState(() => own?.department ?? "");
  const dep = comp?.departments.find((x) => x.name === dept) ?? comp?.departments.at(0);
  if (!comp) return <p className="text-ink-muted">No one in the staff list yet.</p>;
  const inDept = dep?.people ?? [];
  const allOn = inDept.length > 0 && inDept.every((p) => value.includes(p.key));
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  return (
    <div className="flex flex-col gap-2.5">
      <PersonSearch people={people} exclude={[exclude, ...value]} placeholder="Search a name in any company or department" onPick={(k) => onChange([...value, k])} />
      <div className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">1. Company</div>
      {tree.length > 6
        ? <select className={CONTROL} value={comp.company} onChange={(e) => { setCo(e.target.value); setDept(""); }} aria-label="Company">{tree.map((t) => <option key={t.company}>{t.company}</option>)}</select>
        : <div className="flex flex-wrap gap-1.5">{tree.map((t) => <button key={t.company} type="button" className={chip(t.company === comp.company)} onClick={() => { setCo(t.company); setDept(""); }}>{t.company}</button>)}</div>}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div>
          <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">2. Department</div>
          <div className="overflow-hidden rounded-lg border border-border">
            {comp.departments.map((x) => {
              const n = x.people.filter((p) => value.includes(p.key)).length;
              return (
                <button key={x.name} type="button" onClick={() => setDept(x.name)} className={cn("flex w-full border-b border-border/60 px-3 py-2 text-left text-[13px]", x === dep ? "bg-primary-soft font-semibold" : "bg-surface")}>
                  {x.name}<span className={cn("ml-auto text-[12px]", n ? "text-synced" : "text-ink-muted")}>{n ? (n === x.people.length ? `All ${n}` : `${n} of ${x.people.length}`) : x.people.length}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">3. People in {dep?.name}</div>
          <div className="overflow-hidden rounded-lg border border-border">
            <label className="flex cursor-pointer items-center gap-2.5 bg-surface-2 px-3 py-1.5 font-semibold">
              <input type="checkbox" className="accent-[rgb(var(--hz-primary))]" checked={allOn} onChange={() => onChange(allOn ? value.filter((v) => !inDept.some((p) => p.key === v)) : [...new Set([...value, ...inDept.map((p) => p.key)])])} />Whole department
            </label>
            {inDept.map((p) => (
              <label key={p.key} className="flex cursor-pointer items-center gap-2.5 border-t border-border/60 px-3 py-1.5">
                <input type="checkbox" className="accent-[rgb(var(--hz-primary))]" checked={value.includes(p.key)} onChange={() => toggle(p.key)} />{p.name}
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

type Busy = { title: string; start: number; end: number; people: string[]; roomId: number | null; id: number };

export function FindTime({ d, rooms, people, meetings, now, onPick }: { d: Draft; rooms: Room[]; people: Map<string, Person>; meetings: Meeting[]; now: number; onPick: (s: number, e: number, roomId?: number | null) => void }) {
  const base = Math.max(startOfDay(d.start), startOfDay(now));
  const [from, setFrom] = useState(isoDay(base));
  const [to, setTo] = useState(isoDay(addDays(base, 6)));
  const [len, setLen] = useState(Math.round((d.end - d.start) / MIN));
  const [open, setOpen] = useState<number | null>(null);
  const who = [d.organizer, ...d.attendees.filter((a) => a !== d.organizer)];
  const busy: Busy[] = meetings.filter((m) => m.id !== d.id && m.status !== "ended").map((m) => ({ id: m.id, title: m.title, start: ms(m.start), end: ms(m.end), people: peopleOf(m), roomId: m.roomId }));
  const L = len * MIN;
  const days: number[] = [];
  for (let t = withTime(from, "00:00"); t <= withTime(to, "00:00") && days.length < 31; t = addDays(t, 1)) days.push(t);
  const freeRoomsAt = (s: number) => rooms.filter((r) => r.active && r.seats >= who.length && !busy.some((b) => b.roomId === r.id && b.start < s + L + r.buffer_min * MIN && s - r.buffer_min * MIN < b.end) && !r.closures.some((c) => s < withTime(c.to, "00:00") + DAY && withTime(c.from, "00:00") < s + L));
  const result = days.map((day) => {
    const slots: { t: number; rooms: Room[] }[] = [];
    for (let t = atHour(day, 8); t + L <= atHour(day, 21); t += 30 * MIN) {
      if (t < now) continue;
      if (!who.every((k) => !busy.some((b) => b.people.includes(k) && b.start < t + L && t < b.end))) continue;
      const rs = freeRoomsAt(t);
      if (rs.length || d.roomId === null) slots.push({ t, rooms: rs });
    }
    return { day, slots };
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <label className={LABEL}>From<DateField aria-label="From" fullWidth value={from} onChange={(v) => { if (v) setFrom(v); }} /></label>
        <label className={LABEL}>To<DateField aria-label="To" fullWidth value={to} onChange={(v) => { if (v) setTo(v); }} /></label>
        <label className={LABEL}>Length<select className={CONTROL} value={len} onChange={(e) => setLen(Number(e.target.value))}>{[30, 45, 60, 90, 120, 180].map((v) => <option key={v} value={v}>{v < 60 ? `${v} min` : `${v / 60} h`}</option>)}</select></label>
      </div>
      <div className="text-[13px] text-ink-secondary">{who.length} {who.length === 1 ? "person" : "people"} · times when everyone is free and a room with {who.length}+ seats is open.</div>
      {result.map(({ day, slots }) => (
        <div key={day}>
          <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">{fmtDay(day)}{slots.length ? "" : " · no common time"}</div>
          {slots.length ? (
            <div className="flex flex-wrap gap-1.5">
              {slots.slice(0, open === day ? 99 : 6).map((s) => (
                <button key={s.t} type="button" title={s.rooms.map((r) => r.name).join(", ")} className={chip(s.t === d.start)}
                  onClick={() => onPick(s.t, s.t + L, (s.rooms.find((r) => r.id === d.roomId) ?? s.rooms.at(0))?.id ?? null)}>
                  {fmtRange(s.t, s.t + L)} <span className="font-normal text-ink-muted">· {s.rooms.length ? `${s.rooms.slice(0, 2).map((r) => r.name).join(", ")}${s.rooms.length > 2 ? ` +${s.rooms.length - 2}` : ""}` : "no room"}</span>
                </button>
              ))}
              {slots.length > 6 && open !== day && <button type="button" className="text-[12.5px] font-semibold text-primary" onClick={() => setOpen(day)}>{slots.length - 6} more</button>}
            </div>
          ) : <div className="text-[12.5px] text-ink-muted">Someone is busy all day, or no room fits.</div>}
        </div>
      ))}
      <div className="mt-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">People and rooms on {fmtDay(d.start)}</div>
      <DayColumns d={d} rooms={rooms} people={people} busy={busy} who={who} onPick={onPick} />
    </div>
  );
}

function DayColumns({ d, rooms, people, busy, who, onPick }: { d: Draft; rooms: Room[]; people: Map<string, Person>; busy: Busy[]; who: string[]; onPick: (s: number, e: number, roomId?: number | null) => void }) {
  const day = startOfDay(d.start);
  const h = 34;
  const len = d.end - d.start;
  const cols = [
    ...who.map((k) => ({ key: k, label: personName(k, people), sub: people.get(k)?.department ?? "", room: null as Room | null, items: busy.filter((b) => b.people.includes(k) && startOfDay(b.start) === day) })),
    ...rooms.filter((r) => r.active).map((r) => ({ key: `r${r.id}`, label: r.name, sub: `${r.seats} seats${r.seats < who.length ? " (small)" : ""}`, room: r as Room | null, items: busy.filter((b) => b.roomId === r.id && startOfDay(b.start) === day) })),
  ];
  const top = (t: number) => ((minutesOfDay(t) - 8 * 60) / 60) * h;
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: cols.length * 70 + 44 }}>
        <div className="grid border-b border-border text-[11px] text-ink-secondary" style={{ gridTemplateColumns: `44px repeat(${cols.length}, minmax(64px, 1fr))` }}>
          <span />{cols.map((c) => <span key={c.key} className={cn("px-0.5 py-1 text-center", c.room && "bg-surface-2")}><b style={{ color: c.room?.color }} className={c.room ? "" : "text-ink"}>{c.label}</b><br />{c.sub}</span>)}
        </div>
        <div className="relative grid" style={{ gridTemplateColumns: `44px repeat(${cols.length}, minmax(64px, 1fr))`, height: 13 * h, backgroundImage: `repeating-linear-gradient(to bottom, rgb(var(--hz-border) / 0.6) 0, rgb(var(--hz-border) / 0.6) 1px, transparent 1px, transparent ${h}px)` }}>
          <div className="pr-1.5 text-right text-[10px] text-ink-muted">{Array.from({ length: 13 }, (_, i) => <div key={i} style={{ height: h, transform: "translateY(-6px)" }}>{i ? `${(8 + i) % 12 || 12}${8 + i < 12 ? "a" : "p"}` : ""}</div>)}</div>
          {cols.map((c) => (
            <div key={c.key} className={cn("relative border-l border-border/60", c.room && "cursor-pointer")}
              onClick={(e) => { if (!c.room) return; const r = e.currentTarget.getBoundingClientRect(); const s = atHour(day, 0) + snapMinutes(8 * 60 + ((e.clientY - r.top) / h) * 60, 30) * MIN; onPick(s, s + len, c.room.id); }}>
              {c.items.map((b) => <div key={b.id} className="absolute inset-x-0.5 overflow-hidden rounded bg-surface-2 px-1 text-[10.5px] text-ink-secondary" style={{ top: top(b.start), height: ((b.end - b.start) / HOUR) * h - 2 }}>{b.title}</div>)}
              {(!c.room || c.room.id === d.roomId) && <div className="pointer-events-none absolute inset-x-0.5 rounded border-2 border-primary bg-primary/10" style={{ top: top(d.start), height: (len / HOUR) * h }} />}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1.5 text-[12px] text-ink-muted">Grey is busy. Click inside a room's column to take that room at that time.</div>
    </div>
  );
}

export function MeetingEditor(p: {
  draft: Draft; isNew: boolean; me: string; rooms: Room[]; people: Person[]; peopleMap: Map<string, Person>; meetings: Meeting[]; now: number;
  busyRooms: Set<number>; saving: boolean; pendingFiles: File[]; onFiles: (f: File[]) => void;
  onClose: () => void; onSave: (d: Draft) => void;
}) {
  const [d, setD] = useState<Draft>(p.draft);
  const [tab, setTab] = useState<"people" | "find">("people");
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (x: Partial<Draft>) => setD((v) => ({ ...v, ...x }));
  const day = isoDay(d.start);
  const addFiles = (list: FileList | File[]) => {
    const ok = [...list].filter((f) => f.size <= 25 * 1024 * 1024);
    p.onFiles([...p.pendingFiles, ...ok].slice(0, 10));
  };
  return (
    <Veil onClose={p.onClose} label="Meeting" wide>
      <form onSubmit={(e) => { e.preventDefault(); p.onSave(d); }}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <button type="button" aria-label="Close" className="rounded-full p-2 text-ink-secondary hover:bg-surface-2" onClick={p.onClose}><X size={18} /></button>
          <input className="h-11 flex-1 border-0 border-b-2 border-primary bg-transparent px-0.5 text-[21px] text-ink outline-none" placeholder="Add title" aria-label="Title" value={d.title} onChange={(e) => set({ title: e.target.value })} />
          <button className={PRI} disabled={p.saving}>{p.saving ? "Saving..." : "Save"}</button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          <div className="flex min-w-0 flex-col gap-3.5 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <DateField aria-label="Date" value={day} onChange={(v) => { if (!v) return; set({ start: withTime(v, hhmm(d.start)), end: withTime(v, hhmm(d.end)) }); }} />
              <input type="time" step={900} aria-label="Start" className={cn(CONTROL, "w-auto")} value={hhmm(d.start)} onChange={(e) => { const s = withTime(day, e.target.value); set({ start: s, end: s + (d.end - d.start) }); }} />
              <span>to</span>
              <input type="time" step={900} aria-label="End" className={cn(CONTROL, "w-auto")} value={hhmm(d.end)} onChange={(e) => { const en = withTime(day, e.target.value); if (en > d.start) set({ end: en }); }} />
              {p.isNew && (
                <select aria-label="Repeat" className={cn(CONTROL, "w-auto")} value={d.repeat} onChange={(e) => set({ repeat: e.target.value as Draft["repeat"], repeatUntil: d.repeatUntil ?? isoDay(addDays(d.start, 56)) })}>
                  {REPEAT_OPTIONS(d.start).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              )}
              {p.isNew && d.repeat !== "none" && <label className="flex items-center gap-1.5 text-[13px]">until<DateField aria-label="Repeat until" value={d.repeatUntil ?? ""} onChange={(v) => set({ repeatUntil: v || null })} /></label>}
              {!p.isNew && d.seriesId && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[12px] font-semibold">Repeating</span>}
            </div>
            <div className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-3">
              <span className="mt-2.5 text-ink-secondary"><MapPin size={18} /></span>
              <div>
                <RoomPicker rooms={p.rooms} d={d} busyRooms={p.busyRooms} onRoom={(id) => set({ roomId: id })} compact={false} />
              </div>
              <span className="mt-1.5 text-ink-secondary"><Video size={18} /></span>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {([["meet", "Google Meet"], ["zoom", "Zoom"], ["link", "Paste a link"], ["none", "None"]] as const).map(([k, l]) => <button key={k} type="button" className={chip(d.videoType === k)} onClick={() => set({ videoType: k })}>{l}</button>)}
                </div>
                {d.videoType !== "none" && <input className={CONTROL} aria-label="Video link" placeholder={d.videoType === "zoom" ? "https://zoom.us/j/..." : d.videoType === "meet" ? "https://meet.google.com/..." : "https://..."} value={d.videoUrl} onChange={(e) => set({ videoUrl: e.target.value })} />}
                {d.videoType !== "none" && <div className="text-[12px] text-ink-muted">Paste the link from {d.videoType === "meet" ? "Google Meet" : d.videoType === "zoom" ? "Zoom" : "your video app"}. You can also add it later; everyone in the meeting is told. Creating the link automatically comes when Google is connected.</div>}
              </div>
              <span className="mt-1.5 text-ink-secondary"><Bell size={18} /></span>
              <div className="flex flex-col gap-2">
                {d.reminders.map((rm, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <select aria-label="Reminder time" className={cn(CONTROL, "w-auto")} value={rm.min} onChange={(e) => set({ reminders: d.reminders.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) } : x)) })}>
                      {REMINDER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <span className={chip(true)}>ERP</span>
                    <span className={cn(chip(false), "opacity-60")} title="Comes when Gmail is connected">Email</span>
                    <span className={cn(chip(false), "opacity-60")} title="Comes when WhatsApp is connected">WhatsApp</span>
                    <button type="button" aria-label="Remove reminder" className="rounded-full p-1.5 text-ink-secondary hover:bg-surface-2" onClick={() => set({ reminders: d.reminders.filter((_, j) => j !== i) })}><X size={15} /></button>
                  </div>
                ))}
                <button type="button" className="self-start text-[12.5px] font-semibold text-primary" onClick={() => set({ reminders: [...d.reminders, { min: 1440, ch: ["erp"] }] })}>+ Add reminder</button>
                <div className="text-[12px] text-ink-muted">Reminders show in the ERP. Email and WhatsApp reminders come when Gmail and WhatsApp are connected.</div>
              </div>
              <span className="mt-2.5 text-ink-secondary"><StickyNote size={18} /></span>
              <textarea aria-label="Notes" className={cn(CONTROL, "h-20")} placeholder="Agenda, what to prepare" value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
              <span className="mt-1.5 text-ink-secondary"><Paperclip size={18} /></span>
              <div className="flex flex-col gap-2">
                {p.pendingFiles.length > 0 && <div className="flex flex-wrap gap-1.5">{p.pendingFiles.map((f, i) => <span key={i} className="inline-flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-2.5 pr-1 text-[12.5px] text-primary-ink">{f.name}<button type="button" aria-label={`Remove ${f.name}`} className="rounded-full p-0.5" onClick={() => p.onFiles(p.pendingFiles.filter((_, j) => j !== i))}><X size={13} /></button></span>)}</div>}
                <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
                <button type="button" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
                  className="rounded-lg border-[1.5px] border-dashed border-border bg-surface-2 p-3 text-left text-[13px] text-ink-secondary">
                  <b className="text-primary">+ Attach files</b> or drop them here. Any type: PDF, photos (JPG, PNG), Word, Excel, slides, videos. Up to 25 MB each.
                </button>
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-col border-t border-border lg:border-l lg:border-t-0">
            <div className="flex gap-1 border-b border-border px-3">
              {(["people", "find"] as const).map((k) => <button key={k} type="button" onClick={() => setTab(k)} className={cn("h-10 border-b-2 px-3.5 text-[13.5px]", tab === k ? "border-primary font-semibold text-primary" : "border-transparent text-ink-secondary")}>{k === "people" ? `People · ${1 + d.attendees.filter((a) => a !== d.organizer).length}` : "Find a time"}</button>)}
            </div>
            <div className="max-h-[62vh] overflow-auto p-4">
              {tab === "people" ? (
                <>
                  {p.isNew && (
                    <label className={cn(LABEL, "mb-2.5")}>Organiser (book on someone's behalf)
                      <select className={CONTROL} value={d.organizer} onChange={(e) => set({ organizer: e.target.value, attendees: d.attendees.filter((a) => a !== e.target.value) })}>
                        {p.people.map((x) => <option key={x.key} value={x.key}>{x.key === p.me ? "Me" : x.name} · {[x.company, x.department].filter(Boolean).join(" · ")}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="mb-2.5 flex flex-wrap gap-1.5">
                    <span className="inline-flex h-7 items-center rounded-full bg-primary-soft px-2.5 text-[12.5px] text-primary-ink">{personName(d.organizer, p.peopleMap)} (organiser)</span>
                    {d.attendees.filter((a) => a !== d.organizer).map((k) => <span key={k} className="inline-flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-2.5 pr-1 text-[12.5px] text-primary-ink">{personName(k, p.peopleMap)}<button type="button" aria-label={`Remove ${personName(k, p.peopleMap)}`} className="rounded-full p-0.5" onClick={() => set({ attendees: d.attendees.filter((x) => x !== k) })}><X size={13} /></button></span>)}
                  </div>
                  <PeoplePicker people={p.people} value={d.attendees} exclude={d.organizer} onChange={(v) => set({ attendees: v })} />
                </>
              ) : (
                <FindTime d={d} rooms={p.rooms} people={p.peopleMap} meetings={p.meetings} now={p.now} onPick={(s, e, rid) => set({ start: s, end: e, ...(rid !== undefined ? { roomId: rid } : {}) })} />
              )}
            </div>
          </div>
        </div>
      </form>
    </Veil>
  );
}

/** A small "copied" helper used by guest links; falls back to selecting the text. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

