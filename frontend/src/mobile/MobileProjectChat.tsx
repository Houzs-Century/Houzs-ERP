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
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { relativeTime } from "../lib/utils";

type NoteActivity = {
  id: number;
  action: string;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
};

type ActivityResponse = { data: NoteActivity[] };

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
  onPosted: () => void;
}) {
  const { user, can } = useAuth();
  const canPost = can("projects.write") || can("projects.chat");
  const qc = useQueryClient();
  const queryKey = ["mobile-project-chat", projectId] as const;

  const { data: activityResponse, isLoading, error: loadError } = useQuery({
    queryKey,
    queryFn: () => api.get<ActivityResponse>(`/api/projects/${projectId}/activity`),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

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
      setNotice(null);
    },
    onSuccess: async (_data, { localId, note }) => {
      // Owner 2026-11-19 ("why everytime sales person update sales report in
      // chat in become disappear?"). Zack (user 31) sent the same paste FIVE
      // times to project 364 in 2 minutes on 2026-11-17 — the server stored
      // every copy, so the client was clearing the "Sending..." bubble before
      // its own refetch had seen the note, leaving a blank chat and making the
      // sender re-send. Keep the bubble until the new note is actually in the
      // list; poll up to ~2.5s if the first refetch misses it (a cold Worker
      // or a replica lag can drop one check and recover on the next).
      const trimmed = note.trim();
      let landed = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        await qc.invalidateQueries({ queryKey });
        const fresh = qc.getQueryData<ActivityResponse>(queryKey);
        landed = (fresh?.data ?? []).some(
          (a) => a.action === "note" && (a.note ?? "").trim() === trimmed,
        );
        if (landed) break;
        if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
      }
      setPending((prev) => prev.filter((p) => p.id !== localId));
      if (!landed) {
        setNotice("Saved — the chat will refresh in a moment. Don't send again.");
      }
      onPosted();
    },
    onError: (e, { localId, note }) => {
      setPending((prev) => prev.filter((p) => p.id !== localId));
      setDraft((cur) => (cur ? cur : note));
      setFailed(e instanceof Error ? e.message : "Couldn't send. Try again.");
    },
  });

  const notes = (activityResponse?.data ?? []).filter((a) => a.action === "note");
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [notes.length, pending.length]);
  const noticeAtCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (notice && noticeAtCountRef.current == null) {
      noticeAtCountRef.current = notes.length;
      return;
    }
    if (!notice) {
      noticeAtCountRef.current = null;
      return;
    }
    if (noticeAtCountRef.current != null && notes.length > noticeAtCountRef.current) {
      setNotice(null);
      noticeAtCountRef.current = null;
    }
  }, [notice, notes.length]);

  const send = () => {
    const trimmed = draft.trim();
    if (!trimmed || post.isPending) return;
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
          ) : loadError && notes.length === 0 && pending.length === 0 ? (
            <div role="alert" style={{ padding: 12, fontSize: 12, color: "var(--hz-c-err)" }}>
              Couldn't load the chat ({loadError.message}). A message you sent may already be saved, so reload before sending it again.
            </div>
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

        {canPost && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
            <textarea
              ref={taRef}
              className="fld-i"
              value={draft}
              disabled={post.isPending}
              onChange={(e) => { setDraft(e.target.value); setFailed(null); setNotice(null); }}
              onKeyDown={(e) => {
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
        {notice && !failed && (
          <div style={{ fontSize: 11, color: "#8a4e0e", marginTop: 6 }}>{notice}</div>
        )}
      </div>
    </details>
  );
}

