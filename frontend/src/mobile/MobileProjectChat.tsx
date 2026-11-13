/* The project chat on the mobile PMS (owner 2026-11-09: "i saw no chat box on
 * mobile version. add on chat box for mobile"). Pasted sales reports land here
 * and the server-side parser counts them (routes/project-sales-bills.ts), so
 * posting from the phone is the whole point — the Save button on the desktop
 * chat is NOT reproduced here. The gate is the same two-key check the server
 * enforces on POST /api/projects/:id/notes (projects.write OR projects.chat);
 * backend/src/routes/projects.ts:2553 is the authority.
 *
 * Notes-only view: system rows (stage_change, finance_edit, document_upload…)
 * come through the same /activity feed but we filter to action === "note" so
 * the mobile card stays a chat thread. The project detail already surfaces the
 * system rows elsewhere. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { relativeTime } from "../lib/utils";
import { salesReportFormatIssues, type SalesReportFormatIssue } from "../lib/salesReportFormatIssues";

type NoteActivity = {
  id: number;
  action: string;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
};

type ActivityResponse = { activity: NoteActivity[] };

/** DOM id of the collapsible Chat section — the floating "Chat" FAB in
 *  ProjectDetailView uses it to scroll the page to the panel and pop it open
 *  without the user having to scroll past everything above it (owner 2026-11-09). */
export const MOBILE_PROJECT_CHAT_ID = "mobile-project-chat-section";

/** The chat section mounted inside ProjectDetailView. Open by default so the
 *  floor sees it immediately after the Chat FAB scrolls them here. Shows the
 *  message list and (when allowed) a textarea + send button; any sales-report
 *  parsing runs server-side, so the post is a single POST and the effect shows
 *  up in the panel above after the detail reload. */
export function MobileProjectChat({
  projectId,
  onPosted,
}: {
  projectId: number;
  /** Called after a successful send — the parent reloads so the sales panel
   *  picks up any bill the chat parser recognised. */
  onPosted: () => void;
}) {
  const { user, can } = useAuth();
  const canPost = can("projects.write") || can("projects.chat");
  const qc = useQueryClient();
  const queryKey = ["mobile-project-chat", projectId] as const;

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => api.get<ActivityResponse>(`/api/projects/${projectId}/activity`),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Textarea grows with pasted content so the whole sales report is readable
  // before sending. Resets to one row after a successful send.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  /* Pending-message list shown ABOVE the server activity while a post is in
   *  flight (owner 2026-11-13 on the Akemi Spice Arena mobile chat: "once
   *  sales person update sales report in chat, after update didnt show
   *  anything. need to show they alr update so that they can no error or not").
   *  Each row gets a client-side id so a slow send and a quick one can both be
   *  tracked separately, cleared as soon as the server sees the post. */
  const [pending, setPending] = useState<Array<{ id: string; note: string }>>([]);

  const post = useMutation({
    mutationFn: ({ note }: { localId: string; note: string }) =>
      api.post(`/api/projects/${projectId}/notes`, { note }),
    onMutate: ({ localId, note }) => {
      setPending((prev) => [...prev, { id: localId, note }]);
      setDraft("");
      setFailed(null);
    },
    onSuccess: (_data, { localId }) => {
      setPending((prev) => prev.filter((p) => p.id !== localId));
      void qc.invalidateQueries({ queryKey });
      onPosted();
    },
    onError: (e, { localId, note }) => {
      // Restore the draft so the sender can retry without re-typing, and lift
      // the pending bubble so they don't see a phantom unsent message.
      setPending((prev) => prev.filter((p) => p.id !== localId));
      setDraft((cur) => (cur ? cur : note));
      setFailed(e instanceof Error ? e.message : "Couldn't send. Try again.");
    },
  });

  const notes = (data?.activity ?? []).filter((a) => a.action === "note");
  const listRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll to the newest message every time the count changes — fires for
  // both the optimistic "sending" row and the real one that replaces it, so
  // the floor sees their paste land without hunting for it in the scroller.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [notes.length, pending.length]);

  const send = () => {
    const trimmed = draft.trim();
    if (!trimmed || post.isPending) return;
    // Client-side id so the optimistic row can be cleared on the matching
    // response — Date.now is unique enough on a phone (no sub-ms sends) and
    // keeps the id stable across React re-renders.
    const localId = `local-${Date.now()}`;
    post.mutate({ localId, note: trimmed });
  };

  return (
    <details id={MOBILE_PROJECT_CHAT_ID} className="pacc" open>
      <summary>
        <span className="psec-t">Chat ({notes.length})</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </summary>
      <div className="pbody">
        {/* Message list — tallest card on the phone is the P&L above us, so cap
            the chat at ~60vh and let it scroll on its own. Newest at bottom to
            match every chat app the floor already uses. */}
        <div
          ref={listRef}
          style={{
            border: "1px solid var(--hz-dk-border-subtle, #eceee9)",
            borderRadius: 10,
            overflow: "hidden",
            maxHeight: "60vh",
            overflowY: "auto",
            background: "var(--hz-dk-surface-2, #fafbf8)",
          }}
        >
          {isLoading ? (
            <div style={{ padding: 12, fontSize: 12, color: "var(--hz-c-ink-soft)" }}>Loading…</div>
          ) : notes.length === 0 && pending.length === 0 ? (
            <div style={{ padding: 12, fontSize: 12, color: "var(--hz-c-ink-soft)" }}>No messages yet.</div>
          ) : (
            notes.map((n, i) => {
              const mine = user?.id != null && n.user_id === user.id;
              return (
                <div
                  key={n.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    padding: "10px 12px",
                    borderTop: i === 0 ? "none" : "1px solid #eceee9",
                    alignItems: mine ? "flex-end" : "flex-start",
                  }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 10.5, color: "var(--hz-c-ink-muted)" }}>
                    <span style={{ fontWeight: 700, color: "var(--hz-c-ink-secondary)" }}>{n.user_name || "Unknown"}</span>
                    <span>{relativeTime(n.created_at)}</span>
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: "var(--hz-c-ink)",
                      background: mine ? "var(--hz-dk-synced-bg, #e5f4ec)" : "var(--hz-c-surface)",
                      border: "1px solid var(--hz-dk-border-subtle, #eceee9)",
                      borderRadius: 10,
                      padding: "8px 11px",
                      maxWidth: "88%",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      lineHeight: 1.4,
                    }}
                  >
                    {n.note ?? ""}
                  </div>
                  {/* Format hints (owner 2026-11-10 "bagi warning kalau sales
                      person kurang satu format or salah format"). Shared helper
                      with the desktop ProjectChat so both surfaces read a paste
                      the same way. Hidden entirely for regular chat. */}
                  <FormatHints note={n.note} align={mine ? "end" : "start"} />
                </div>
              );
            })
          )}
          {/* Pending rows — the just-sent paste, shown as "Sending…" until the
              server confirms (owner 2026-11-13). Lives below the real notes so
              a pending message takes the newest spot without re-ordering the
              history once it lands. */}
          {pending.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                padding: "10px 12px",
                borderTop: "1px solid var(--hz-dk-border-subtle, #eceee9)",
                alignItems: "flex-end",
                opacity: 0.72,
              }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 10.5, color: "var(--hz-c-ink-muted)" }}>
                <span style={{ fontWeight: 700, color: "var(--hz-c-ink-secondary)" }}>{user?.name ?? "Me"}</span>
                <span>Sending…</span>
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--hz-c-ink)",
                  background: "var(--hz-dk-synced-bg, #e5f4ec)",
                  border: "1px dashed #bcdcd7",
                  borderRadius: 10,
                  padding: "8px 11px",
                  maxWidth: "88%",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  lineHeight: 1.4,
                }}
              >
                {p.note}
              </div>
            </div>
          ))}
        </div>

        {/* Compose row — only when the user holds the chat permission. The
            server runs the same gate (requireAnyPermission on
            [projects.write, projects.chat]) so a stale frontend never writes. */}
        {canPost && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
            <textarea
              ref={taRef}
              className="fld-i"
              value={draft}
              disabled={post.isPending}
              onChange={(e) => { setDraft(e.target.value); setFailed(null); }}
              onKeyDown={(e) => {
                /* Enter-to-send on the phone soft keyboard is unreliable (Go/Done
                   often inserts a newline instead), so the Send button is the
                   authoritative action; this shortcut only helps a hardware kb. */
                if (e.key === "Enter" && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Type a message or paste the evening report…"
              style={{ flex: 1, fontSize: 13, padding: "8px 10px", resize: "none", lineHeight: 1.4, minHeight: 40 }}
            />
            <button
              type="button"
              className="tinybtn"
              disabled={post.isPending || !draft.trim()}
              onClick={send}
              aria-label="Send"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 40,
                height: 40,
                padding: 0,
                borderRadius: 10,
                color: "var(--hz-c-primary)",
                borderColor: "#bcdcd7",
              }}
            >
              <Send size={16} />
            </button>
          </div>
        )}

        {failed && (
          <div style={{ fontSize: 11, color: "var(--hz-c-err)", marginTop: 6 }}>{failed}</div>
        )}
      </div>
    </details>
  );
}

/** Inline format hints under a sales-report message — the mobile mirror of
 *  the desktop ChatBubble's FormatHints, keyed to the paste through the
 *  shared `salesReportFormatIssues` helper so both surfaces say the same
 *  thing about the same text. */
function FormatHints({ note, align }: { note: string | null; align: "start" | "end" }) {
  const issues: SalesReportFormatIssue[] = useMemo(() => salesReportFormatIssues(note), [note]);
  if (issues.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        marginTop: 4,
        maxWidth: "88%",
        alignSelf: align === "end" ? "flex-end" : "flex-start",
      }}
    >
      {issues.map((it, i) => (
        <div
          key={i}
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            padding: "5px 8px",
            borderRadius: 7,
            border: it.tone === "warn" ? "1px solid #f4d9a8" : "1px solid #dde1d8",
            background: it.tone === "warn" ? "#fdf5e4" : "#f3f5f0",
            color: it.tone === "warn" ? "#8a4e0e" : "var(--hz-c-ink-secondary)",
          }}
        >
          {it.message}
        </div>
      ))}
    </div>
  );
}
