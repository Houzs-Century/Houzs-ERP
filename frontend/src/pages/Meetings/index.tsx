import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, ChevronLeft, ChevronRight, Link2, Search } from "lucide-react";
import { api } from "../../api/client";
import { TabStrip } from "../../components/TabStrip";
import { useRefreshMeetingsUnread } from "../../hooks/useAmendmentApprovals";
import { openLoadedTab } from "../../lib/openLoadedTab";
import { canPreviewType } from "../MailCenter/mail-attach-preview";
import { cn } from "../../lib/utils";
import {
  DAY, MONTH_NAMES, addDays, atHour, draftBody, draftFrom, emptyDraft, fmtDayLong, isMeetingsTab, isoDay, isView, VIEWS, ms, nextStart, peopleOf, readConflict, startOfDay, startOfWeek,
  companyColor, meetingColor, type Bootstrap, type CalView, type ColorBy, type ConflictReply, type Draft, type GuestLink, type Meeting, type MeetingsTab, type Notice, type Room, bestRoom } from "../../lib/meetings";
import { ListView, MiniMonth, MonthView, RoomsTimeline, TimeGrid } from "./MeetingsCalendar";
import { BTN, ConflictDialog, MeetingDetail, MeetingEditor, PersonSearch, PRI, QuickBook, ScopeQuestion, type MeetingFile } from "./MeetingsDialogs";
import { EmailPage, LinkDialog, LinksPage, LogPage, MyMeetings, RoomDialog, RoomsPage, roomForm, type LinkForm, type RoomForm } from "./MeetingsAdmin";


const POLL_MS = 60_000;
const COLOR_KEY = "meetings.colorBy";
const fresh = <T,>(path: string) => api.get<T>(path, { signal: new AbortController().signal });
const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

function rangeFor(view: CalView, anchor: number): [number, number] {
  if (view === "day" || view === "rooms") return [startOfDay(anchor), startOfDay(anchor) + DAY];
  if (view === "week") return [startOfWeek(anchor), startOfWeek(anchor) + 7 * DAY];
  if (view === "list") return [startOfDay(anchor) - 7 * DAY, startOfDay(anchor) + 49 * DAY];
  const a = new Date(anchor);
  const first = startOfWeek(new Date(a.getFullYear(), a.getMonth(), 1).getTime());
  return [first, first + 35 * DAY];
}

export function Meetings({ erpName = "Houzs ERP", embedded = false }: { erpName?: string; embedded?: boolean }) {
  const [params, setParams] = useSearchParams();
  const refreshUnread = useRefreshMeetingsUnread();
  const tab: MeetingsTab = isMeetingsTab(params.get("tab")) ? (params.get("tab") as MeetingsTab) : "calendar";
  const narrow = typeof window !== "undefined" && window.innerWidth < 768;
  const view: CalView = isView(params.get("view")) ? (params.get("view") as CalView) : narrow ? "day" : "week";
  const dateParam = params.get("date");
  const anchor = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? new Date(`${dateParam}T00:00:00`).getTime() : startOfDay(Date.now());
  const patch = useCallback((p: Record<string, string | null>) => {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(p)) { if (v === null) n.delete(k); else n.set(k, v); }
      return n;
    }, { replace: true });
  }, [setParams]);
  const setAnchor = (t: number) => patch({ date: isoDay(t) });

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [calError, setCalError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [tick, setTick] = useState(0);
  const [colorBy, setColorBy] = useState<ColorBy>(() => { try { return (localStorage.getItem(COLOR_KEY) ?? "room") as ColorBy; } catch { return "room"; } });
  const [roomFilter, setRoomFilter] = useState<Record<number, boolean>>({});
  const [onlyMine, setOnlyMine] = useState(false);
  const [overlay, setOverlay] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<{ m: Meeting; x: number; y: number; history: { at: string; who: string; text: string }[] | null; files: MeetingFile[] } | null>(null);
  const [quick, setQuick] = useState<Draft | null>(null);
  const [editor, setEditor] = useState<{ draft: Draft; isNew: boolean } | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [conflict, setConflict] = useState<{ reply: ConflictReply; draft: Draft; isNew: boolean } | null>(null);
  const [scopeAsk, setScopeAsk] = useState<{ act: "save" | "cancel"; draft: Draft; m: Meeting } | null>(null);
  const [mine, setMine] = useState<{ meetings: Meeting[]; notifications: Notice[] } | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [links, setLinks] = useState<GuestLink[] | null>(null);
  const [log, setLog] = useState<{ at: string; who: string; text: string }[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [roomEdit, setRoomEdit] = useState<{ form: RoomForm; future: number } | null>(null);
  const [linkEdit, setLinkEdit] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const flash = useCallback((t: string) => setToast(t), []);
  const showError = useCallback((e: unknown) => setToast(message(e)), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 8000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { try { localStorage.setItem(COLOR_KEY, colorBy); } catch { } }, [colorBy]);
  useEffect(() => { const t = setInterval(() => { setNow(Date.now()); setTick((n) => n + 1); }, POLL_MS); return () => clearInterval(t); }, []);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    fresh<Bootstrap>("/api/meetings/bootstrap").then((b) => { if (live) { setBoot(b); setBootError(null); } }).catch((e) => live && setBootError(message(e)));
    return () => { live = false; };
  }, [tick]);

  const [from, to] = rangeFor(view, anchor);
  useEffect(() => {
    let live = true;
    const qs = `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
    fresh<{ meetings: Meeting[] }>(`/api/meetings/calendar?${qs}`).then((r) => { if (live) { setMeetings(r.meetings); setCalError(null); } }).catch((e) => live && setCalError(message(e)));
    return () => { live = false; };
  }, [from, to, tick]);

  useEffect(() => {
    if (tab !== "mine") return;
    let live = true;
    fresh<{ meetings: Meeting[]; notifications: Notice[] }>("/api/meetings/mine")
      .then((r) => { if (!live) return; setMine(r); setMineError(null); if (r.notifications.some((n) => !n.read)) api.post("/api/meetings/notifications/read").then(refreshUnread).catch((e) => console.warn("[meetings] could not mark notifications read", e)); })
      .catch((e) => live && setMineError(message(e)));
    return () => { live = false; };
  }, [tab, tick, refreshUnread]);
  useEffect(() => {
    if (tab !== "links") return;
    fresh<{ links: GuestLink[] }>("/api/meetings/links").then((r) => setLinks(r.links)).catch((e) => showError(e));
  }, [tab, tick, flash]);
  useEffect(() => {
    if (tab !== "log" || !boot?.canManage) return;
    fresh<{ log: { at: string; who: string; text: string }[] }>("/api/meetings/log").then((r) => { setLog(r.log); setLogError(null); }).catch((e) => setLogError(message(e)));
  }, [tab, tick, boot?.canManage]);

  const me = boot?.me ?? "";
  const rooms: Room[] = boot?.rooms ?? [];
  const people = useMemo(() => new Map((boot?.people ?? []).map((p) => [p.key, p])), [boot]);
  const companies = useMemo(() => [...new Set((boot?.people ?? []).map((p) => p.company).filter(Boolean))].sort(), [boot]);
  const colorOf = useCallback((m: Meeting) => meetingColor(m, colorBy, me, rooms, people, companies), [colorBy, me, rooms, people, companies]);
  const canChange = useCallback((m: Meeting) => m.organizer === me || m.bookedBy === me, [me]);
  const shown = meetings.filter((m) => {
    if (m.roomId && roomFilter[m.roomId] === false) return false;
    if (onlyMine && !peopleOf(m).includes(me) && !overlay.some((o) => peopleOf(m).includes(o))) return false;
    if (query) {
      const hay = `${m.title} ${peopleOf(m).map((k) => people.get(k)?.name ?? k).join(" ")} ${rooms.find((r) => r.id === m.roomId)?.name ?? ""} ${m.guest?.name ?? ""}`.toLowerCase();
      if (!hay.includes(query.toLowerCase())) return false;
    }
    return true;
  });
  const busyRoomsFor = (d: Draft) => new Set(meetings.filter((m) => m.id !== d.id && m.roomId && m.status !== "ended" && ms(m.start) < d.end && d.start < ms(m.end)).map((m) => m.roomId as number));
  const freeRoomFor = (s: number, e: number) =>
    bestRoom(rooms, 1, new Set(meetings.filter((m) => m.roomId && m.status !== "ended" && ms(m.start) < e && s < ms(m.end)).map((m) => m.roomId as number)))?.id ?? null;

  const uploadFiles = async (meetingId: number) => {
    if (!pendingFiles.length) return;
    const form = new FormData();
    for (const f of pendingFiles) form.append("files", f, f.name);
    await api.postForm(`/api/meetings/meetings/${meetingId}/files`, form);
    setPendingFiles([]);
  };

  const save = async (d: Draft, isNew: boolean, scope: "one" | "following" = "one") => {
    setSaving(true);
    try {
      if (isNew) {
        const r = await api.post<{ ids: number[]; created: number; skipped: number }>("/api/meetings/meetings", draftBody(d));
        if (r.ids[0]) await uploadFiles(r.ids[0]).catch((e) => flash(`Booked, but the files did not upload: ${message(e)}`));
        flash(r.created > 1 ? `Booked ${r.created} meetings${r.skipped ? `; ${r.skipped} skipped because a room or person was busy` : ""}` : `Booked ${d.title || "(No title)"}`);
      } else {
        const r = await api.patch<{ changed: number; skipped: number }>(`/api/meetings/meetings/${d.id}`, { ...draftBody(d), scope });
        if (d.id) await uploadFiles(d.id).catch((e) => flash(`Saved, but the files did not upload: ${message(e)}`));
        flash(r.skipped ? `Saved ${r.changed}; ${r.skipped} later meetings kept their time because someone was busy` : `Saved ${d.title}`);
      }
      setQuick(null);
      setEditor(null);
      setConflict(null);
      reload();
    } catch (e) {
      const c = readConflict(e);
      if (c) setConflict({ reply: c, draft: d, isNew });
      else showError(e);
    } finally {
      setSaving(false);
    }
  };

  const act = async (m: Meeting, what: "start" | "end" | "cancel", scope: "one" | "following" = "one") => {
    setSaving(true);
    try {
      await api.post(`/api/meetings/meetings/${m.id}/${what}`, what === "cancel" ? { scope } : {});
      flash(what === "start" ? `Started ${m.title}` : what === "end" ? `Ended ${m.title}. The room is free from now.` : `Cancelled ${m.title}. Everyone in it was told.`);
      setDetail(null);
      reload();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  };

  const openMeeting = async (m: Meeting, x: number, y: number) => {
    setDetail({ m, x, y, history: null, files: [] });
    try {
      const r = await fresh<{ meeting: Meeting; history: { at: string; who: string; text: string }[]; files: MeetingFile[] }>(`/api/meetings/meetings/${m.id}`);
      setDetail((cur) => (cur && cur.m.id === m.id ? { ...cur, m: r.meeting, history: r.history, files: r.files } : cur));
    } catch { }
  };

  const newDraft = (s?: number, e?: number, roomId?: number | null) => {
    const start = s ?? nextStart(Date.now(), anchor);
    const end = e ?? start + 3_600_000;
    return emptyDraft(me, start, end, roomId !== undefined ? roomId : freeRoomFor(start, end));
  };

  const saveRoom = async (f: RoomForm) => {
    setSaving(true);
    setDialogError(null);
    try {
      const body = { name: f.name, location: f.location, address: f.address, floor: f.floor, seats: f.seats, equipment: f.equipment, days: f.days, openFrom: f.openFrom, openTo: f.openTo, color: f.color, bufferMin: f.bufferMin, maxHours: f.maxHours, advanceDays: f.advanceDays, active: f.active, closures: f.closures };
      if (f.id) await api.patch(`/api/meetings/rooms/${f.id}`, body); else await api.post("/api/meetings/rooms", body);
      flash(`Saved room ${f.name}`);
      setRoomEdit(null);
      reload();
    } catch (e) { setDialogError(message(e)); } finally { setSaving(false); }
  };
  const saveLink = async (l: LinkForm) => {
    setSaving(true);
    setDialogError(null);
    try {
      await api.post("/api/meetings/links", l);
      flash("Link created. Copy it from the list below.");
      setLinkEdit(false);
      reload();
    } catch (e) { setDialogError(message(e)); } finally { setSaving(false); }
  };

  const unread = boot?.unread ?? 0;
  const tabs = [
    { value: "calendar" as const, label: "Calendar" },
    { value: "mine" as const, label: unread ? `My meetings · ${unread}` : "My meetings" },
    { value: "rooms" as const, label: `Rooms · ${rooms.filter((r) => r.active).length}` },
    { value: "links" as const, label: "Guest links" },
    { value: "email" as const, label: "Email and WhatsApp", show: !!boot?.canManage },
    { value: "log" as const, label: "Change log", show: !!boot?.canManage },
  ];
  const step = (dir: number) => {
    if (view === "month") { const d = new Date(anchor); d.setMonth(d.getMonth() + dir, 1); setAnchor(d.getTime()); }
    else setAnchor(addDays(anchor, dir * (view === "week" ? 7 : view === "list" ? 7 : 1)));
  };
  const title = view === "day" || view === "rooms" ? fmtDayLong(anchor) : `${MONTH_NAMES[new Date(view === "week" ? startOfWeek(anchor) + 3 * DAY : anchor).getMonth()]} ${new Date(anchor).getFullYear()}`;
  const days = view === "day" ? [startOfDay(anchor)] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  const cal = { meetings: shown, rooms, people, colorOf, now, onOpen: (m: Meeting, x: number, y: number) => void openMeeting(m, x, y) };

  if (bootError && !boot) {
    return <div className="p-6"><h1 className="mb-2 text-[22px] font-bold">Meetings</h1><p className="text-err">{bootError}</p><button type="button" className={cn(BTN, "mt-3")} onClick={reload}>Try again</button></div>;
  }

  return (
    <div className="flex min-h-0 flex-col" style={{ "--meet-mine": "rgb(var(--hz-primary))", height: embedded ? "100%" : "calc(100dvh - 64px)" } as CSSProperties}>
      <div className={cn("px-4 sm:px-6", embedded ? "pt-1" : "pt-4")}>
        {!embedded && <h1 className="text-[22px] font-bold text-ink">Meetings</h1>}
        {!embedded && <p className="mb-2 text-[13px] text-ink-secondary">Meeting rooms shared by every company. Book anyone from any company; they see it in their own ERP.</p>}
        <TabStrip value={tab} onChange={(v) => patch({ tab: v === "calendar" ? null : v })} options={tabs} className="mb-0" />
      </div>
      {tab === "calendar" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-2 sm:px-4">
            <button type="button" className={BTN} onClick={() => setAnchor(startOfDay(Date.now()))}>Today</button>
            <button type="button" aria-label="Previous" className="rounded-full p-2 text-ink-secondary hover:bg-surface-2" onClick={() => step(-1)}><ChevronLeft size={18} /></button>
            <button type="button" aria-label="Next" className="rounded-full p-2 text-ink-secondary hover:bg-surface-2" onClick={() => step(1)}><ChevronRight size={18} /></button>
            <h2 className="ml-1 whitespace-nowrap text-[18px] font-medium text-ink">{title}</h2>
            <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
              <label className="relative hidden sm:block"><Search size={15} className="absolute left-3 top-2.5 text-ink-muted" />
                <input aria-label="Search meetings" placeholder="Search meetings, people, rooms" className="h-9 w-56 rounded-full border border-border bg-surface-2 pl-8 pr-3 text-[13px]" value={query} onChange={(e) => { setQuery(e.target.value); if (e.target.value) patch({ view: "list" }); }} />
              </label>
              <div className="flex overflow-hidden rounded-full border border-border" role="group" aria-label="View">
                {VIEWS.map((v) => (
                  <button key={v} type="button" onClick={() => patch({ view: v })} className={cn("h-9 px-3 text-[13px] font-medium capitalize", view === v ? "bg-primary-soft font-semibold text-primary-ink" : "bg-surface text-ink")}>{v}</button>
                ))}
              </div>
              <button type="button" aria-label={`My meetings, ${unread} unread`} className="relative rounded-full p-2 text-ink-secondary hover:bg-surface-2" onClick={() => patch({ tab: "mine" })}>
                <Bell size={18} />{unread > 0 && <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ea4335] px-1 text-[10px] font-bold text-white">{unread}</span>}
              </button>
            </div>
          </div>
          {calError && <div className="bg-err-bg px-4 py-2 text-[13px] text-err">The calendar could not be loaded: {calError}</div>}
          <div className="flex min-h-0 flex-1">
            <aside className="hidden w-[248px] flex-none flex-col gap-3.5 overflow-auto border-r border-border bg-surface p-3.5 lg:flex">
              <button type="button" onClick={() => setEditor({ draft: newDraft(), isNew: true })} className="flex h-[52px] items-center gap-2.5 self-start rounded-2xl bg-primary-soft pl-4 pr-5 font-semibold text-primary-ink shadow-md">
                <span className="text-[24px] leading-none" aria-hidden="true">+</span>Book a room
              </button>
              <MiniMonth anchor={anchor} week={view === "week"} onPick={setAnchor} />
              <div>
                <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">Rooms</div>
                {rooms.filter((r) => r.active).map((r) => (
                  <label key={r.id} className="flex min-h-[30px] cursor-pointer items-center gap-2.5 text-[13px]">
                    <input type="checkbox" checked={roomFilter[r.id] !== false} onChange={(e) => setRoomFilter({ ...roomFilter, [r.id]: e.target.checked })} style={{ accentColor: r.color }} />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />{r.name} · {r.seats}
                  </label>
                ))}
                {rooms.length === 0 && <p className="text-[12.5px] text-ink-muted">No rooms yet.</p>}
              </div>
              <div>
                <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">Colours show</div>
                <div className="flex overflow-hidden rounded-full border border-border">
                  {([["room", "Room"], ["company", "Company"], ["me", "Me"]] as const).map(([k, l]) => <button key={k} type="button" onClick={() => setColorBy(k)} className={cn("h-8 flex-1 text-[12.5px]", colorBy === k ? "bg-primary-soft font-semibold text-primary-ink" : "bg-surface")}>{l}</button>)}
                </div>
                {colorBy === "me" && <div className="mt-1.5 flex flex-col gap-0.5 text-[12.5px]"><span><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-primary" />I organise</span><span><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-[#039be5]" />I'm invited</span><span><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-[#9aa0a6]" />Others (room taken)</span></div>}
                {colorBy === "company" && <div className="mt-1.5 flex flex-col gap-0.5 text-[12.5px]">{companies.map((c) => <span key={c}><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: companyColor(c, companies) }} />{c}</span>)}</div>}
              </div>
              <div>
                <div className="mb-1 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">Show</div>
                <label className="flex min-h-[30px] cursor-pointer items-center gap-2.5 text-[13px]"><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />Only my meetings</label>
                {overlay.map((o) => <label key={o} className="flex min-h-[30px] cursor-pointer items-center gap-2.5 text-[13px]"><input type="checkbox" checked onChange={() => setOverlay(overlay.filter((x) => x !== o))} />{people.get(o)?.name ?? o}'s meetings</label>)}
                <PersonSearch people={boot?.people ?? []} exclude={[me, ...overlay]} placeholder="Add a colleague's calendar" onPick={(k) => { setOverlay([...overlay, k]); setOnlyMine(true); }} />
              </div>
              <button type="button" className={cn(BTN, "justify-center")} onClick={() => patch({ tab: "links" })}><Link2 size={15} />Make a guest booking link</button>
              <p className="text-[12px] leading-[17px] text-ink-muted">Drag across empty time to book. Drag a meeting to move it, drag its bottom edge to change the length.</p>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col bg-surface" aria-label="Calendar">
              {(view === "day" || view === "week") && (
                <TimeGrid {...cal} days={days} me={me} canChange={canChange}
                  onCreate={(s, e) => setQuick(newDraft(s, e))}
                  onMove={(m, s, e) => void save({ ...draftFrom(m), start: s, end: e }, false)} />
              )}
              {view === "month" && <MonthView {...cal} anchor={anchor} onDay={(d) => { setAnchor(d); patch({ view: "day" }); }} onCreate={(d) => setEditor({ draft: newDraft(atHour(d, 10), atHour(d, 11)), isNew: true })} />}
              {view === "rooms" && <RoomsTimeline {...cal} day={startOfDay(anchor)} onCreate={(s, e, rid) => setQuick(newDraft(s, e, rid))} />}
              {view === "list" && <ListView {...cal} query={query} />}
            </section>
          </div>
          <button type="button" onClick={() => setEditor({ draft: newDraft(), isNew: true })} className={cn(PRI, "fixed bottom-5 right-4 z-30 h-12 shadow-lg lg:hidden")}>+ Book a room</button>
        </div>
      )}
      {tab !== "calendar" && (
        <div className="flex-1 overflow-auto px-4 pb-10 pt-4 sm:px-6">
          {tab === "mine" && <MyMeetings meetings={mine?.meetings ?? null} notices={mine?.notifications ?? []} rooms={rooms} people={people} me={me} now={now} error={mineError}
            onOpen={(m) => { patch({ tab: null, view: "week", date: new Date(ms(m.start)).toISOString().slice(0, 10) }); void openMeeting(m, window.innerWidth / 2, 200); }} />}
          {tab === "rooms" && <RoomsPage rooms={rooms} meetings={meetings} now={now} canManage={!!boot?.canManage}
            onAdd={() => { setDialogError(null); setRoomEdit({ form: roomForm(null, rooms.length), future: 0 }); }}
            onEdit={(r) => { setDialogError(null); setRoomEdit({ form: roomForm(r, rooms.length), future: meetings.filter((m) => m.roomId === r.id && ms(m.start) > now).length }); }}
            onBook={(r) => { patch({ tab: null, view: "rooms" }); setEditor({ draft: newDraft(undefined, undefined, r.id), isNew: true }); }} />}
          {tab === "links" && <LinksPage links={links} rooms={rooms} people={people} origin={window.location.origin} flash={flash}
            onCreate={() => { setDialogError(null); setLinkEdit(true); }}
            onToggle={async (l) => { try { await api.patch(`/api/meetings/links/${l.id}`, { active: !l.active }); reload(); } catch (e) { showError(e); } }} />}
          {tab === "email" && <EmailPage erpName={erpName} />}
          {tab === "log" && <LogPage log={log} people={people} error={logError} />}
        </div>
      )}

      {detail && (
        <MeetingDetail m={detail.m} rooms={rooms} people={people} me={me} x={detail.x} y={detail.y} color={colorOf(detail.m)} history={detail.history} files={detail.files}
          canChange={canChange(detail.m)} busy={saving} onClose={() => setDetail(null)}
          onFile={(f) => { const path = `/api/meetings/meetings/${detail.m.id}/files/${f.id}`; (canPreviewType(f.mime_type ?? "") ? openLoadedTab(() => api.fetchBlobUrl(path, null), 60_000) : api.downloadFile(path, f.file_name)).catch((e) => showError(e)); }}
          onEdit={() => { setPendingFiles([]); setEditor({ draft: draftFrom(detail.m), isNew: false }); setDetail(null); }}
          onCancel={() => (detail.m.seriesId ? setScopeAsk({ act: "cancel", draft: draftFrom(detail.m), m: detail.m }) : void act(detail.m, "cancel"))}
          onStart={() => void act(detail.m, "start")} onEnd={() => void act(detail.m, "end")} />
      )}
      {quick && <QuickBook draft={quick} rooms={rooms} people={boot?.people ?? []} busyRooms={busyRoomsFor(quick)} saving={saving} onClose={() => setQuick(null)} onMore={(d) => { setQuick(null); setPendingFiles([]); setEditor({ draft: d, isNew: true }); }} onSave={(d) => void save(d, true)} />}
      {editor && (
        <MeetingEditor draft={editor.draft} isNew={editor.isNew} me={me} rooms={rooms} people={boot?.people ?? []} peopleMap={people} meetings={meetings} now={now}
          makeMeet={boot?.meetConnected ? () => api.post<{ url: string }>("/api/meetings/meet-link").then((r) => r.url) : null}
          busyRooms={busyRoomsFor(editor.draft)} saving={saving} pendingFiles={pendingFiles} onFiles={setPendingFiles} onClose={() => setEditor(null)}
          onSave={(d) => {
            const orig = meetings.find((m) => m.id === d.id);
            if (!editor.isNew && d.seriesId && orig) setScopeAsk({ act: "save", draft: d, m: orig });
            else void save(d, editor.isNew);
          }} />
      )}
      {conflict && <ConflictDialog reply={conflict.reply} draft={conflict.draft} rooms={rooms} people={people} onClose={() => setConflict(null)} onApply={(d) => void save(d, conflict.isNew)} />}
      {scopeAsk && (
        <ScopeQuestion title={scopeAsk.m.title} act={scopeAsk.act} onClose={() => setScopeAsk(null)}
          onPick={(scope) => { const a = scopeAsk; setScopeAsk(null); if (a.act === "cancel") void act(a.m, "cancel", scope); else void save(a.draft, false, scope); }} />
      )}
      {roomEdit && <RoomDialog initial={roomEdit.form} locations={[...new Set(rooms.map((r) => r.location).filter(Boolean))]} futureBookings={roomEdit.future} saving={saving} error={dialogError} onClose={() => setRoomEdit(null)} onSave={(f) => void saveRoom(f)} />}
      {linkEdit && <LinkDialog rooms={rooms} people={boot?.people ?? []} me={me} saving={saving} error={dialogError} onClose={() => setLinkEdit(false)} onSave={(l) => void saveLink(l)} />}
      {toast && <div role="status" className="fixed bottom-5 left-1/2 z-[60] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-[#2b2f2d] px-4 py-2.5 text-[13.5px] text-white shadow-lg">{toast}</div>}
    </div>
  );
}
