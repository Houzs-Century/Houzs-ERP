import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Send } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import type { useToast } from "../hooks/useToast";
import { cn, relativeTime } from "../lib/utils";
import { Avatar } from "./Avatar";
import { useChatSalesReport } from "./projectChatSalesReport";


export interface ActivityRow {
  id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  user_email?: string | null;
  user_profile_pic_r2_key?: string | null;
  created_at: string;
}

interface ProjectChatProps {
  projectId: number;
  activity?: ActivityRow[];
  canPost: boolean;
  onPosted?: () => void;
  toast: ReturnType<typeof useToast>;
  height?: string;
}

function growToFit(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function ProjectChat({
  projectId,
  activity,
  canPost,
  onPosted,
  toast,
  height = "440px",
}: ProjectChatProps) {
  const { user: me } = useAuth();
  const notifs = useNotifications();
  // The sales report the chat carries (owner 2026-10-14) — what each message
  // counts for, voiding a wrong paste, Total Sales from a summary:
  // projectChatSalesReport.tsx.
  const salesReport = useChatSalesReport({
    projectId,
    toast,
    onTotalSet: () => onPosted?.(),
    onVoided: (id) => dropMessage(id),
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Optimistic "Sending…" rows (owner 2026-11-19: "after salesman taip and
  // click send or save, tak ada show that sales report already inside"). The
  // desktop chat used to clear the textarea on Send and wait for the 3s
  // poller to pull the new note back, so for up to ~3 s nothing visibly
  // changed — same confusion that made Zack resend the same paste five times
  // on mobile. We now drop a pending bubble into the list the moment Send is
  // tapped, and clear it as soon as the real note with that text lands.
  const [pending, setPending] = useState<Array<{ id: string; note: string; at: string }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [liveById, setLiveById] = useState<Map<number, ActivityRow>>(
    () => new Map((activity ?? []).map((a) => [a.id, a]))
  );
  const liveByIdRef = useRef(liveById);
  const [bootstrapped, setBootstrapped] = useState<boolean>(
    () => activity !== undefined
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const projectIdRef = useRef(projectId);
  const requestGenerationRef = useRef(0);
  const refreshRef = useRef<() => void>(() => {});

  function dropMessage(id: number) {
    const next = new Map(liveByIdRef.current);
    next.delete(id);
    liveByIdRef.current = next;
    setLiveById(next);
  }

  useEffect(() => {
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId;
      const next = new Map((activity ?? []).map((a) => [a.id, a]));
      liveByIdRef.current = next;
      setLiveById(next);
      setBootstrapped(activity !== undefined);
      setLoadFailed(false);
      return;
    }
    if (activity === undefined) return;
    const next = new Map(liveByIdRef.current);
    for (const a of activity) next.set(a.id, a);
    liveByIdRef.current = next;
    setLiveById(next);
    setBootstrapped(true);
    setLoadFailed(false);
  }, [activity, projectId]);

  const [newCount, setNewCount] = useState(0);
  const wasAtBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const messages = useMemo(() => {
    return Array.from(liveById.values()).sort((a, b) => {
      const t = (a.created_at ?? "").localeCompare(b.created_at ?? "");
      return t !== 0 ? t : a.id - b.id;
    });
  }, [liveById]);

  useEffect(() => {
    if (pending.length === 0) return;
    const notesSeen = new Set(
      messages
        .filter((m) => m.action === "note" && m.note != null)
        .map((m) => m.note!.trim()),
    );
    const next = pending.filter((p) => !notesSeen.has(p.note.trim()));
    if (next.length !== pending.length) setPending(next);
  }, [messages, pending]);

  useEffect(() => {
    (async () => {
      try {
        await api.post(`/api/projects/${projectId}/read`, {});
        notifs.reload();
      } catch {
        // silent-write-ok: a read receipt. A failure only leaves the unread dot
        // up, which is the safe direction and claims nothing.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    async function tick() {
      if (cancelled || document.hidden || inFlight) return;
      inFlight = true;
      const generation = ++requestGenerationRef.current;
      controller = new AbortController();
      let maxTs = "";
      for (const row of liveByIdRef.current.values()) {
        if (row.created_at > maxTs) maxTs = row.created_at;
      }
      const path = maxTs
        ? `/api/projects/${projectId}/activity?since=${encodeURIComponent(maxTs)}`
        : `/api/projects/${projectId}/activity`;
      try {
        const r = await api.get<{ data: ActivityRow[] }>(
          path,
          { signal: controller.signal },
        );
        if (
          cancelled ||
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) return;
        const incoming = r.data ?? [];
        if (incoming.length > 0) {
          const previous = liveByIdRef.current;
          const next = new Map(previous);
          for (const a of incoming) next.set(a.id, a);
          const added = next.size - previous.size;
          liveByIdRef.current = next;
          setLiveById(next);
          if (maxTs && !wasAtBottomRef.current && added > 0) {
            setNewCount((c) => c + added);
          }
          if (added > 0) notifs.reload();
        }
        setBootstrapped(true);
        setLoadFailed(false);
      } catch {
        if (
          !cancelled &&
          !controller.signal.aborted &&
          generation === requestGenerationRef.current &&
          liveByIdRef.current.size === 0
        ) {
          setLoadFailed(true);
        }
      } finally {
        if (generation === requestGenerationRef.current) {
          inFlight = false;
          controller = null;
        }
      }
    }
    refreshRef.current = () => void tick();
    void tick();
    const id = window.setInterval(tick, 3000);
    function onVis() {
      if (!document.hidden) void tick();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      requestGenerationRef.current += 1;
      controller?.abort();
      refreshRef.current = () => {};
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function send() {
    const note = draft.trim();
    if (!note || sending) return;
    const localId = `local-${Date.now()}`;
    const at = new Date().toISOString();
    setSending(true);
    setPending((prev) => [...prev, { id: localId, note, at }]);
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "";
    wasAtBottomRef.current = true;
    try {
      await api.post(`/api/projects/${projectId}/notes`, { note });
      onPosted?.();
      void salesReport.afterSend(note);
      api.post(`/api/projects/${projectId}/read`, {}).catch(() => {});
      refreshRef.current();
    } catch (e: any) {
      setPending((prev) => prev.filter((p) => p.id !== localId));
      setDraft((cur) => cur || note);
      toast.error(e?.message || "Failed to send");
    } finally {
      setSending(false);
    }
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setNewCount(0);
  }

  const lastCount = useRef(messages.length);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = wasAtBottomRef.current || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    wasAtBottomRef.current = atBottom;
    if (messages.length > lastCount.current && atBottom) {
      el.scrollTop = el.scrollHeight;
      setNewCount(0);
    } else if (lastCount.current === 0) {
      el.scrollTop = el.scrollHeight;
    }
    lastCount.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      wasAtBottomRef.current = atBottom;
      if (atBottom) setNewCount(0);
    }
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-md border border-border bg-bg/30"
      style={{ height }}
    >
      {newCount > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[10.5px] font-semibold text-white shadow-slab transition-all hover:bg-primary-ink"
        >
          {newCount} new message{newCount === 1 ? "" : "s"} ↓
        </button>
      )}
      <div
        ref={scrollRef}
        className="thin-scroll flex-1 space-y-2 overflow-y-auto px-3 py-3"
      >
        {!bootstrapped && !loadFailed && (
          <div className="py-10 text-center text-[11px] text-ink-muted">
            Loading messages…
          </div>
        )}
        {!bootstrapped && loadFailed && (
          <div className="py-10 text-center text-[11px] text-ink-muted">
            Unable to load messages. Retrying…
          </div>
        )}
        {bootstrapped && messages.length === 0 && pending.length === 0 && (
          <div className="py-10 text-center text-[11px] text-ink-muted">
            No messages yet.
          </div>
        )}
        {messages.map((a, i) => {
          const prev = i > 0 ? messages[i - 1] : null;
          if (a.action !== "note") {
            return <ChatSystemRow key={a.id} a={a} />;
          }
          const isMine = !!me && a.user_id === me.id;
          const samePerson =
            prev && prev.action === "note" && prev.user_id === a.user_id;
          const withinWindow =
            prev &&
            Date.parse(a.created_at) - Date.parse(prev.created_at) <
              5 * 60 * 1000;
          const grouped = !!(samePerson && withinWindow);
          return (
            <ChatBubble key={a.id} a={a} isMine={isMine} grouped={grouped} footer={salesReport.footerFor(a)} />
          );
        })}
        {pending.map((p) => (
          <PendingChatBubble key={p.id} note={p.note} name={me?.name ?? "Me"} />
        ))}
      </div>

      {canPost ? (
        <div className="flex items-end gap-2 border-t border-border bg-surface px-2.5 py-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); growToFit(e.target); }}
            onKeyDown={onKey}
            placeholder="Message…"
            rows={1}
            className="min-h-[36px] max-h-[160px] flex-1 resize-none rounded-2xl border border-border bg-bg px-3.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <button
            onClick={send}
            disabled={sending || !draft.trim()}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-white shadow-stone transition-all hover:bg-primary-ink disabled:bg-surface-dim disabled:text-ink-muted disabled:shadow-none"
            title="Send (Enter) · Shift+Enter for new line"
          >
            <Send size={14} />
          </button>
        </div>
      ) : (
        <div className="border-t border-border bg-surface px-3 py-2 text-center text-[10.5px] text-ink-muted">
          Read-only
        </div>
      )}
    </div>
  );
}


function PendingChatBubble({ note, name }: { note: string; name: string }) {
  return (
    <div className="mt-2 flex w-full justify-end gap-2">
      <div className="flex max-w-[75%] flex-col items-end opacity-70">
        <div
          className="whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-dashed border-primary/50 bg-accent/80 px-3 py-1.5 text-[12.5px] leading-snug text-white shadow-stone"
          title="Sending — waiting for the chat to confirm"
        >
          {note}
        </div>
        <span className="mt-0.5 px-0.5 font-mono text-[9.5px] text-ink-muted">
          {name} · Sending…
        </span>
      </div>
    </div>
  );
}

function ChatSystemRow({ a }: { a: ActivityRow }) {
  return (
    <div className="my-3 flex justify-center">
      <div
        className="max-w-[80%] rounded-full bg-bg/80 px-3 py-1 text-center text-[10.5px] text-ink-muted ring-1 ring-border-subtle"
        title={a.created_at}
      >
        <span className="font-medium">{actionLabel(a.action)}</span>
        {a.from_value && a.to_value && a.from_value !== a.to_value && (
          <span className="ml-1">
            <span className="font-mono">{a.from_value}</span>
            <span className="mx-1 text-ink-muted/70">→</span>
            <span className="font-mono">{a.to_value}</span>
          </span>
        )}
        {a.to_value && !a.from_value && (
          <span className="ml-1 font-mono">{a.to_value}</span>
        )}
        {a.from_value && !a.to_value && (
          <span className="ml-1 font-mono">{a.from_value}</span>
        )}
        {a.note && <span className="ml-1">· {a.note}</span>}
        {a.user_name && (
          <span className="ml-1 text-ink-muted/80">· {a.user_name}</span>
        )}
        <span className="ml-1.5 font-mono text-ink-muted/70">
          {relativeTime(a.created_at)}
        </span>
      </div>
    </div>
  );
}

function ChatBubble({
  a,
  isMine,
  grouped,
  footer,
}: {
  a: ActivityRow;
  isMine: boolean;
  grouped: boolean;
  footer?: ReactNode;
}) {
  const name = a.user_name || "Unknown";
  return (
    <div
      className={cn(
        "flex w-full gap-2",
        isMine ? "justify-end" : "justify-start",
        grouped ? "mt-0.5" : "mt-2"
      )}
    >
      {!isMine && (
        <div className="w-8 shrink-0">
          {!grouped && (
            <Avatar
              userId={a.user_id}
              hasImage={a.user_profile_pic_r2_key}
              name={a.user_name}
              email={a.user_email}
              size={32}
            />
          )}
        </div>
      )}
      <div
        className={cn(
          "flex max-w-[75%] flex-col",
          isMine ? "items-end" : "items-start"
        )}
      >
        {!grouped && !isMine && (
          <span className="mb-0.5 px-0.5 text-[10.5px] font-semibold text-ink-secondary">
            {name}
          </span>
        )}
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[12.5px] leading-snug shadow-stone",
            isMine
              ? "rounded-br-sm bg-accent text-white"
              : "rounded-bl-sm bg-surface text-ink ring-1 ring-border-subtle"
          )}
        >
          {a.note}
        </div>
        {footer}
        <span
          className="mt-0.5 px-0.5 font-mono text-[9.5px] text-ink-muted"
          title={a.created_at}
        >
          {relativeTime(a.created_at)}
        </span>
      </div>
    </div>
  );
}

function actionLabel(action: string): string {
  switch (action) {
    case "created":
      return "Project created";
    case "stage_change":
      return "Stage changed";
    case "checklist_status":
      return "Checklist updated";
    case "document_upload":
      return "Document uploaded";
    case "checklist_add":
      return "Checklist item added";
    case "checklist_remove":
      return "Checklist item removed";
    case "finance_edit":
      return "Finance updated";
    case "pic_change":
      return "PIC changed";
    case "sales_attendee_add":
      return "Sales attending added";
    case "sales_attendee_remove":
      return "Sales attending removed";
    case "sales_report_voided":
      return "Message voided";
    case "books_gap_waived":
      return "Removed from Books not complete";
    case "archived":
      return "Archived";
    case "restored":
      return "Restored";
    case "note":
      return "Message";
    default:
      return action;
  }
}
