// ---------------------------------------------------------------------------
// AssistantChat — the DESKTOP chat body (toolbar + stream + composer, or the
// past-conversations list), used by both the Assistant page and the floating
// AssistantPanel. Logic comes from the shared useAssistantChat hook (the same
// hook the mobile sheet uses), so this file is presentation only. Chrome-free:
// it fills its parent's height; each host frames it (the page in a card, the
// panel in a floating shell).
//
// READ-ONLY, like the page it was lifted from: it POSTs a question and renders
// the grounded answer + the routing trace. It never writes a business row.
// ---------------------------------------------------------------------------

import { useRef } from "react";
import { ArrowLeft, Bot, History, Paperclip, Plus, Send, Trash2, User, X } from "lucide-react";
import { Badge } from "./Badge";
import { cn } from "../lib/utils";
import { useAssistantChat, ASSISTANT_SUGGESTIONS, ASSISTANT_ACCEPT } from "./useAssistantChat";
import { fmtDateTime } from "@2990s/shared";

export type { AgentRef, Msg } from "./useAssistantChat";

/* Was `toLocaleDateString(undefined, …)` — the viewer's OS locale, a month
   NAME, and no year at all. Three ways to disagree with every other date in
   the app. */
const shortWhen = fmtDateTime;

export function AssistantChat({ className }: { className?: string }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const {
    msgs,
    draft,
    setDraft,
    busy,
    send,
    endRef,
    attachment,
    setAttachment,
    newChat,
    historyView,
    conversations,
    loadingHistory,
    openHistory,
    closeHistory,
    openConversation,
    deleteConversation,
  } = useAssistantChat();

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* toolbar — new chat + history toggle */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={newChat}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-surface-dim hover:text-ink"
        >
          <Plus size={14} /> New chat
        </button>
        <button
          type="button"
          onClick={historyView ? closeHistory : openHistory}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-surface-dim hover:text-ink"
        >
          {historyView ? (
            <>
              <ArrowLeft size={14} /> Back
            </>
          ) : (
            <>
              <History size={14} /> History
            </>
          )}
        </button>
      </div>

      {historyView ? (
        <div className="flex-1 overflow-y-auto p-3">
          {loadingHistory && <div className="py-8 text-center text-[12px] text-ink-muted">Loading…</div>}
          {!loadingHistory && conversations.length === 0 && (
            <div className="py-8 text-center text-[12px] text-ink-muted">No past conversations yet.</div>
          )}
          <div className="flex flex-col gap-1">
            {conversations.map((c) => (
              <div
                key={c.id}
                className="group flex items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-surface-dim"
              >
                <button type="button" onClick={() => openConversation(c.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[13px] text-ink">{c.title || "Untitled chat"}</div>
                  <div className="text-[11px] text-ink-muted">
                    {c.message_count} message{c.message_count === 1 ? "" : "s"} · {shortWhen(c.updated_at)}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => deleteConversation(c.id)}
                  aria-label="Delete conversation"
                  className="flex-none rounded-md p-1 text-ink-muted opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* stream */}
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
            {msgs.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                <Bot size={28} className="text-ink-muted" />
                <p className="text-[13px] text-ink-secondary">
                  Ask a question — the assistant routes it to the right agent.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {ASSISTANT_SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className="rounded-full border border-border px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-surface-dim"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {msgs.map((m, i) => (
              <div key={i} className={cn("flex gap-2.5", m.role === "user" ? "flex-row-reverse" : "")}>
                <div
                  className={cn(
                    "mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg",
                    m.role === "user" ? "bg-surface-dim text-ink-secondary" : "bg-accent/10 text-accent",
                  )}
                >
                  {m.role === "user" ? <User size={14} /> : <Bot size={14} />}
                </div>
                <div
                  className={cn(
                    "max-w-[85%] rounded-xl px-3.5 py-2.5 text-[13.5px] leading-relaxed",
                    m.role === "user"
                      ? "bg-accent text-white"
                      : "border border-border bg-surface-dim text-ink",
                  )}
                >
                  {/* Routing trace — who answered. Only on replies that consulted someone. */}
                  {m.role === "bot" && m.agents && m.agents.length > 0 && (
                    <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-border pb-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Asked</span>
                      {m.agents.map((a) => (
                        <Badge key={a.key} tone="neutral" caseless>
                          {a.label}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <p className="whitespace-pre-wrap">{m.text}</p>
                  {m.degraded && (
                    <p className="mt-1.5 text-[11px] text-ink-muted">
                      Answered without the AI service — the agent console has the raw findings.
                    </p>
                  )}
                </div>
              </div>
            ))}

            {busy && (
              <div className="flex gap-2.5">
                <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Bot size={14} />
                </div>
                <div className="rounded-xl border border-border bg-surface-dim px-3.5 py-2.5 text-[13px] text-ink-muted">
                  Asking the agents…
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* composer */}
          <div className="flex flex-col gap-2 border-t border-border bg-surface-dim p-3">
            {attachment && (
              <div className="flex items-center gap-2 self-start rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-ink-secondary">
                <Paperclip size={13} />
                <span className="max-w-[220px] truncate">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => setAttachment(null)}
                  aria-label="Remove file"
                  className="text-ink-muted hover:text-err"
                >
                  <X size={13} />
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept={ASSISTANT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setAttachment(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach an image or PDF"
                title="Attach an image or PDF"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-border text-ink-secondary hover:bg-surface"
              >
                <Paperclip size={15} />
              </button>
              <input
                className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                placeholder="Ask something… (e.g. why is SO-2607-041 not delivered?)"
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void send(draft)}
                disabled={busy || (!draft.trim() && !attachment)}
                aria-label="Send"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-accent text-white disabled:opacity-40"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default AssistantChat;
