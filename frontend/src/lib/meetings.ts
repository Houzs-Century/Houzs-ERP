
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** First and last hour the day and week grids draw (overtime meetings included). */
export const GRID_FROM = 7;
export const GRID_TO = 23;

export type Closure = { id?: number; from: string; to: string; reason: string };
export type Room = {
  id: number;
  name: string;
  location: string;
  address?: string;
  floor: string;
  seats: number;
  equipment: string[];
  open_days: number[];
  open_from: number;
  open_to: number;
  color: string;
  buffer_min: number;
  max_hours: number;
  advance_days: number;
  active: boolean;
  closures: Closure[];
};
export type Person = { key: string; name: string; email: string | null; company: string; department: string };
export type Reminder = { min: number; ch: ("erp" | "email" | "wa")[] };
export type Guest = { name: string; phone: string; email: string; company: string };
export type Meeting = {
  id: number;
  title: string;
  start: string;
  end: string;
  roomId: number | null;
  organizer: string;
  bookedBy: string;
  attendees: string[];
  notes: string;
  video: { type: "none" | "meet" | "zoom" | "link"; url: string };
  reminders: Reminder[] | null;
  status: "scheduled" | "live" | "ended";
  startedAt: string | null;
  endedAt: string | null;
  seriesId: string | null;
  createdIn: string;
  linkId: number | null;
  guest: Guest | null;
  guestEmails?: string[];
  emails?: { kind: string; to: string[]; sentAt: string | null; attempts: number; error: string | null }[];
};
export type Bootstrap = { me: string; canManage: boolean; rooms: Room[]; people: Person[]; unread: number; meetConnected?: boolean };
export type Notice = { id: number; meetingId: number | null; text: string; at: string; read: boolean };
export type GuestLink = {
  id: number;
  code: string;
  name: string;
  rooms: number[];
  length: number;
  days: number[];
  from: number;
  to: number;
  until: string | null;
  hosts: string[];
  createdIn: string;
  active: boolean;
  createdBy: string;
  booked: number;
  audience?: string;
};
export type Conflict = {
  room: { id: number; title: string; start: number; end: number; organizer: string } | null;
  people: { key: string; meeting: { id: number; title: string; start: number; end: number } }[];
  rules: string[];
};
export type ConflictReply = {
  conflict: Conflict;
  suggestTime: string | null;
  suggestRooms: { id: number; name: string; seats: number; floor: string; equipment: string[] }[];
};
/** What the editor holds before it is saved. Times are epoch ms. */
export type Draft = {
  id: number | null;
  title: string;
  start: number;
  end: number;
  roomId: number | null;
  organizer: string;
  attendees: string[];
  videoType: Meeting["video"]["type"];
  videoUrl: string;
  notes: string;
  guestEmails: string[];
  reminders: Reminder[];
  repeat: "none" | "daily" | "weekdays" | "weekly" | "monthly";
  repeatUntil: string | null;
  seriesId: string | null;
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const startOfWeek = (t: number) => {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
};
export const addDays = (t: number, n: number) => {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
export const atHour = (day: number, h: number, m = 0) => {
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
export const isoDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const fromIsoDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};
export const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const withTime = (dayIso: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return atHour(fromIsoDay(dayIso), h, m);
};
export const snapMinutes = (m: number, step = 15) => Math.round(m / step) * step;
export const minutesOfDay = (t: number) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};

/** 9am, 2:30pm */
export function fmtTime(t: number): string {
  const d = new Date(t);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`;
}
/** 9am - 10:30am */
export const fmtRange = (a: number, b: number) => `${fmtTime(a)} - ${fmtTime(b)}`;
/** Mon, 23 Nov */
export function fmtDay(t: number): string {
  const d = new Date(t);
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
}
/** Monday, 23 November */
export function fmtDayLong(t: number): string {
  const d = new Date(t);
  return `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}
export const ms = (iso: string) => Date.parse(iso);

export const peopleOf = (m: Pick<Meeting, "organizer" | "attendees">) => [m.organizer, ...m.attendees.filter((a) => a !== m.organizer)];

/** "Mon - Fri", "Mon - Sat", or the days listed. */
export function daysLabel(days: number[]): string {
  const s = [...days].sort((a, b) => a - b).join(",");
  if (s === "1,2,3,4,5") return "Mon - Fri";
  if (s === "1,2,3,4,5,6") return "Mon - Sat";
  if (days.length === 7) return "Every day";
  return [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(", ");
}

/** Inside the room's usual hours? Outside is allowed (overtime) but counted apart. */
export function inUsualHours(r: Room, start: number, end: number): boolean {
  const hs = new Date(start).getHours() + new Date(start).getMinutes() / 60;
  const he = new Date(end).getHours() + new Date(end).getMinutes() / 60 || 24;
  return r.open_days.includes(new Date(start).getDay()) && hs >= r.open_from && he <= r.open_to;
}

/** Share of a room's usual hours booked in the week starting `weekStart`, plus after-hours hours. */
export function occupancy(r: Room, meetings: Meeting[], weekStart: number) {
  const inWeek = meetings.filter((m) => m.roomId === r.id && ms(m.start) >= weekStart && ms(m.start) < weekStart + 7 * DAY);
  const openMin = r.open_days.length * (r.open_to - r.open_from) * 60;
  let used = 0;
  let after = 0;
  for (const m of inWeek) {
    const len = (ms(m.end) - ms(m.start)) / MIN;
    if (inUsualHours(r, ms(m.start), ms(m.end))) used += len;
    else after += len;
  }
  return { bookings: inWeek.length, percent: openMin ? Math.round((used / openMin) * 100) : 0, usedHours: Math.round(used / 6) / 10, openHours: openMin / 60, afterHours: Math.round(after / 6) / 10 };
}

/** Side-by-side lanes for overlapping meetings in one day column. */
export function layoutDay<T extends { start: number; end: number }>(items: T[]): { item: T; lane: number; lanes: number; cluster: number }[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: { item: T; lane: number; lanes: number; cluster: number }[] = [];
  let cluster: { item: T; lane: number }[] = [];
  let lanes: number[] = [];
  let clusterEnd = 0;
  let cid = 0;
  const flush = () => {
    cid++;
    for (const c of cluster) out.push({ ...c, lanes: lanes.length, cluster: cid });
    cluster = [];
    lanes = [];
  };
  for (const it of sorted) {
    if (cluster.length && it.start >= clusterEnd) {
      flush();
      clusterEnd = 0;
    }
    let lane = lanes.findIndex((end) => end <= it.start);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(it.end);
    } else lanes[lane] = it.end;
    cluster.push({ item: it, lane });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

export type ColorBy = "room" | "company" | "me";
/** The colours a room can take; companies reuse them in order (orange first, so Houzs green and the next company differ). */
export const ROOM_COLORS = ["#0b8043", "#3f51b5", "#f4511e", "#8e24aa", "#039be5", "#d81b60", "#616161", "#e67c00"];
const COMPANY_COLORS = [0, 7, 3, 1, 5, 4, 6].map((i) => ROOM_COLORS[i]);
/** A company's colour, stable for its name. */
export function companyColor(company: string, companies: string[]): string {
  const i = companies.indexOf(company);
  return i < 0 ? "#616161" : COMPANY_COLORS[i % COMPANY_COLORS.length];
}
export function meetingColor(m: Meeting, by: ColorBy, me: string, rooms: Room[], people: Map<string, Person>, companies: string[]): string {
  if (by === "company") return m.guest ? "#616161" : companyColor(people.get(m.organizer)?.company ?? "", companies);
  if (by === "me") return m.organizer === me || m.bookedBy === me ? "var(--meet-mine)" : peopleOf(m).includes(me) ? "#039be5" : "#9aa0a6";
  return rooms.find((r) => r.id === m.roomId)?.color ?? "#616161";
}

export const personName = (key: string, people: Map<string, Person>) => people.get(key)?.name ?? (key === "guest" ? "Guest" : key);
export const personLine = (key: string, people: Map<string, Person>) => {
  const p = people.get(key);
  return p ? [p.name, p.company, p.department].filter(Boolean).join(" · ") : key;
};

/** The next half hour inside working time: today, or tomorrow 9am after 6pm. */
export function nextStart(now: number, anchor: number): number {
  if (anchor > startOfDay(now)) return atHour(anchor, 9);
  const h = new Date(now).getHours();
  if (h < 8) return atHour(now, 9);
  if (h >= 18) return atHour(addDays(startOfDay(now), 1), 9);
  return Math.ceil(now / (30 * MIN)) * 30 * MIN;
}

/** The smallest free room that seats everyone (owner 2026-11-24: do not put two people in a 12-seat room). */
export function bestRoom(rooms: Room[], people: number, busy: Set<number>): Room | null {
  return rooms.filter((r) => r.active && !busy.has(r.id) && r.seats >= people).sort((a, b) => a.seats - b.seats || a.name.localeCompare(b.name))[0] ?? null;
}

export function emptyDraft(me: string, start: number, end: number, roomId: number | null): Draft {
  return { id: null, title: "", start, end, roomId, organizer: me, attendees: [], videoType: "none", videoUrl: "", notes: "", guestEmails: [], reminders: [{ min: 15, ch: ["erp", "email"] }], repeat: "none", repeatUntil: null, seriesId: null };
}

export function draftFrom(m: Meeting): Draft {
  return {
    id: m.id,
    title: m.title,
    start: ms(m.start),
    end: ms(m.end),
    roomId: m.roomId,
    organizer: m.organizer,
    attendees: m.attendees,
    videoType: m.video.type,
    videoUrl: m.video.url,
    notes: m.notes,
    guestEmails: m.guestEmails ?? [],
    reminders: m.reminders ?? [],
    repeat: "none",
    repeatUntil: null,
    seriesId: m.seriesId,
  };
}

/** The body the hub takes for a new or changed meeting. */
export function draftBody(d: Draft) {
  return {
    title: d.title.trim() || "(No title)",
    start: new Date(d.start).toISOString(),
    end: new Date(d.end).toISOString(),
    roomId: d.roomId,
    organizer: d.organizer,
    attendees: d.attendees.filter((a) => a !== d.organizer),
    videoType: d.videoType,
    videoUrl: d.videoType === "none" ? "" : d.videoUrl.trim(),
    notes: d.notes,
    guestEmails: d.guestEmails,
    reminders: d.reminders,
    repeat: d.repeat,
    repeatUntil: d.repeat === "none" ? null : d.repeatUntil,
  };
}

/** A 409 from the API, read as a booking conflict, or null when it is something else. */
export function readConflict(err: unknown): ConflictReply | null {
  const e = err as { status?: number; rawBody?: string } | null;
  if (e?.status !== 409 || !e.rawBody) return null;
  try {
    const j = JSON.parse(e.rawBody) as Partial<ConflictReply>;
    return j.conflict ? { conflict: j.conflict, suggestTime: j.suggestTime ?? null, suggestRooms: j.suggestRooms ?? [] } : null;
  } catch {
    return null;
  }
}

/** Busy people as sentences: "Adrian is in Supplier visit from 1:30pm to 3pm." */
export function busySentences(c: Conflict, people: Map<string, Person>): string[] {
  return c.people.map((p) => `${personName(p.key, people)} is in ${p.meeting.title} from ${fmtTime(p.meeting.start)} to ${fmtTime(p.meeting.end)}.`);
}

export const REMINDER_OPTIONS: [number, string][] = [
  [10, "10 minutes before"],
  [15, "15 minutes before"],
  [30, "30 minutes before"],
  [60, "1 hour before"],
  [1440, "1 day before"],
];
export const remLabel = (min: number) => REMINDER_OPTIONS.find(([v]) => v === min)?.[1] ?? `${min} minutes before`;

export const MEETINGS_TABS = ["calendar", "mine", "rooms", "links", "email", "log"] as const;
export type MeetingsTab = (typeof MEETINGS_TABS)[number];
export const isMeetingsTab = (v: string | null): v is MeetingsTab => !!v && (MEETINGS_TABS as readonly string[]).includes(v);
export const VIEWS = ["day", "week", "month", "rooms", "list"] as const;
export type CalView = (typeof VIEWS)[number];
export const isView = (v: string | null): v is CalView => !!v && (VIEWS as readonly string[]).includes(v);

/** Company -> department -> people, from the hub's directory. */
export function directoryTree(people: Person[]): { company: string; departments: { name: string; people: Person[] }[] }[] {
  const byCo = new Map<string, Map<string, Person[]>>();
  for (const p of people) {
    const co = p.company || "Other";
    const dep = p.department || "No department";
    if (!byCo.has(co)) byCo.set(co, new Map());
    const m = byCo.get(co)!;
    if (!m.has(dep)) m.set(dep, []);
    m.get(dep)!.push(p);
  }
  return [...byCo.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([company, deps]) => ({
      company,
      departments: [...deps.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, ps]) => ({ name, people: ps.sort((x, y) => x.name.localeCompare(y.name)) })),
    }));
}

export const guestLinkUrl = (origin: string, code: string) => `${origin.replace(/\/+$/, "")}/book/${code}`;
