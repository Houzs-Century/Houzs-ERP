import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Camera, Send } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import type { useToast } from "../hooks/useToast";
import { cn, relativeTime } from "../lib/utils";
import { Avatar } from "./Avatar";
import { useChatSalesReport } from "./projectChatSalesReport";

// ── Types ────────────────────────────────────────────────────
// Mirrors the ActivityRow shape that /api/projects/:id/activity
// returns. Kept in this module so consumers (project detail aside,
// floating chat widget) don't need to import a project-page-local
// type.

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
  /** Optional seed history. When omitted the component fetches the
   *  full activity once on mount. The project detail page passes the
   *  pre-loaded activity from its detail response so the chat renders
   *  instantly with no extra round-trip; the floating widget skips it
   *  and lets the component fetch its own. */
  activity?: ActivityRow[];
  canPost: boolean;
  /** Called after a successful send so the parent can reload its own
   *  data (e.g. detail panel rollups). Optional — no parent reload is
   *  needed in the floating widget. */
  onPosted?: () => void;
  toast: ReturnType<typeof useToast>;
  /** CSS height value applied to the outer container. Defaults to
   *  "440px" to match the original project-detail aside dimensions. */
  height?: string;
}

/** The box grows with what is typed, so a pasted report can be read before sending. */
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
  // OCR flow (owner 2026-11-25): a camera button on the composer opens the
  // image picker; the picked image goes to /sales-report-image/ocr, which
  // returns the transcribed text; we drop that text into the draft box so the
  // salesperson can preview, correct the model's misreads, and send through
  // the normal path. No image is stored — the note that ends up in the chat
  // carries the text, same as a typed paste.
  const [ocrBusy, setOcrBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Optimistic "Sending…" rows (owner 2026-11-19: "after salesman taip and
  // click send or save, tak ada show that sales report already inside"). The
  // desktop chat used to clear the textarea on Send and wait for the 3s
  // poller to pull the new note back, so for up to ~3 s nothing visibly
  // changed — same confusion that made Zack resend the same paste five times
  // on mobile. We now drop a pending bubble into the list the moment Send is
  // tapped, and clear it as soon as the real note with that text lands.
  const [pending, setPending] = useState<Array<{ id: string; note: string; at: string }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live-merged message list. Starts from the parent-passed `activity`
  // (or empty when the parent didn't seed) and accrues new rows from
  // the 3s poller. Using a map keyed on activity.id so duplicates
  // (server refetch + poll colliding) don't render twice.
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

  /* A voided message is archived server-side; the poller only fetches rows
     newer than the newest it holds, so it would never learn this one left. */
  function dropMessage(id: number) {
    const next = new Map(liveByIdRef.current);
    next.delete(id);
    liveByIdRef.current = next;
    setLiveById(next);
  }

  // Re-seed when the parent sends a fresh activity prop (e.g. after
  // a stage change triggers a full detail reload). New IDs get added;
  // existing ones replaced; nothing is dropped so locally-polled rows
  // that haven't made it into parent yet aren't lost.
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

  // "N new ↓" chip state — count of messages that arrived while the
  // user was scrolled away from the bottom.
  const [newCount, setNewCount] = useState(0);
  const wasAtBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Chat UIs read oldest-at-top; stable-sort by created_at then id.
  const messages = useMemo(() => {
    return Array.from(liveById.values()).sort((a, b) => {
      const t = (a.created_at ?? "").localeCompare(b.created_at ?? "");
      return t !== 0 ? t : a.id - b.id;
    });
  }, [liveById]);

  // Clear any pending bubble whose text is now in the server-side list — the
  // poller found it, so the optimistic placeholder is no longer needed.
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

  // POST /read when the chat mounts — marks this project as caught up
  // so the notification bell clears its dot. Also ping the notifications
  // context to refetch immediately.
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

  // Fetch immediately, then poll every 3s while visible. An empty chat has no
  // cursor, so it retries the full-history endpoint until one exists.
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
    // Drop the paste into the list now, as a dashed "Sending…" bubble, so
    // the sender sees it is on its way. Cleared when the real note with the
    // same text comes back from the poll.
    setPending((prev) => [...prev, { id: localId, note, at }]);
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "";
    wasAtBottomRef.current = true;
    try {
      await api.post(`/api/projects/${projectId}/notes`, { note });
      onPosted?.();
      void salesReport.afterSend(note);
      // Mark as read right away — our own send shouldn't light up our bell.
      api.post(`/api/projects/${projectId}/read`, {}).catch(() => {});
      refreshRef.current();
    } catch (e: any) {
      // Lift the pending bubble, restore the draft so the sender can retry
      // without re-typing, and tell the toast what went wrong.
      setPending((prev) => prev.filter((p) => p.id !== localId));
      setDraft((cur) => cur || note);
      toast.error(e?.message || "Failed to send");
    } finally {
      setSending(false);
    }
  }

  async function onPickImage(file: File) {
    if (ocrBusy || sending) return;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      toast.error("Please attach a JPG, PNG, WEBP or GIF image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image is over 5MB. Please shoot or crop a smaller one.");
      return;
    }
    setOcrBusy(true);
    try {
      const data = await api.postBinary<{ text?: string }>(
        `/api/projects/${projectId}/sales-report-image/ocr`,
        file,
        file.type,
      );
      /* Prepend to whatever is already in the draft so a report half-typed
         isn't lost; most of the time the box is empty so it reads as a
         straight fill. Grow to fit so the whole transcription shows. */
      const incoming = String(data.text ?? "").trim();
      if (!incoming) {
        toast.error("The image didn't carry a readable sales report.");
        return;
      }
      setDraft((cur) => (cur.trim() ? `${incoming}\n\n${cur}` : incoming));
      /* Focus the textarea so the sender can edit right away. growToFit runs
         after the next paint; the ref is already set. */
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        growToFit(el);
      }, 0);
      toast.success("Image read. Please check and send.");
    } catch (e: any) {
      /* postBinary throws HttpError whose message carries the response body
         verbatim — our backend returns {"error":"..."} JSON for failures, so
         pull .error back out before showing it, or fall back to the whole
         message when it isn't JSON. */
      let msg: string = e?.message || "Couldn't read the image.";
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
          msg = parsed.error;
        }
      } catch { /* not JSON; keep as-is */ }
      toast.error(msg);
    } finally {
      setOcrBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setNewCount(0);
  }

  // Auto-scroll to bottom on new messages, but only if the user was
  // already near the bottom. Keeps reading-history scroll position
  // intact when bubbles arrive.
  const lastCount = useRef(messages.length);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    /* Read before this render: a report taller than the margin is already in the
       box here, so measuring now said "not at the bottom" and left it cut off. */
    const atBottom = wasAtBottomRef.current || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    wasAtBottomRef.current = atBottom;
    if (messages.length > lastCount.current && atBottom) {
      el.scrollTop = el.scrollHeight;
      setNewCount(0);
    } else if (lastCount.current === 0) {
      // First render — drop to the newest.
      el.scrollTop = el.scrollHeight;
    }
    lastCount.current = messages.length;
  }, [messages.length]);

  // Track scroll position so the poller's "N new" counter knows whether
  // the user is reading live or has scrolled up.
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
        {/* Optimistic Sending… rows for this session's un-acked sends. Dashed
            border + lowered opacity so the sender can see at a glance which
            bubble is the live one and which one is still in flight. */}
        {pending.map((p) => (
          <PendingChatBubble key={p.id} note={p.note} name={me?.name ?? "Me"} />
        ))}
      </div>

      {canPost ? (
        <div className="flex items-end gap-2 border-t border-border bg-surface px-2.5 py-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPickImage(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={ocrBusy || sending}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-bg text-ink-muted transition-all hover:border-primary hover:text-primary disabled:opacity-50"
            title="Attach a sales-report image"
            aria-label="Attach a sales-report image"
          >
            <Camera size={14} />
          </button>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); growToFit(e.target); }}
            onKeyDown={onKey}
            placeholder={ocrBusy ? "Reading the image…" : "Message…"}
            rows={1}
            disabled={ocrBusy}
            className="min-h-[36px] max-h-[160px] flex-1 resize-none rounded-2xl border border-border bg-bg px-3.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          />
          <button
            onClick={send}
            disabled={sending || ocrBusy || !draft.trim()}
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

// ── Chat row components ─────────────────────────────────────

/** A "Sending…" bubble shown in the sender's own chat the moment they tap
 *  Send, so they see the paste land instead of the textarea just going
 *  empty. Cleared when the poller brings back a real note with the same
 *  text. */
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
        {/* Removal — from_value with no to_value. Without this branch an
            unassignment (PIC cleared, rep removed) rendered its label with no
            subject at all, so the trail recorded that something was removed
            but never what. */}
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
  /** An action drawn under the bubble — today the Save as sales report button. */
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
