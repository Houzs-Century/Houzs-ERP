// ---------------------------------------------------------------------------
// AssistantChat — the DESKTOP chat body (stream + composer), used by both the
// Assistant page and the floating AssistantPanel. Logic comes from the shared
// useAssistantChat hook (the same hook the mobile sheet uses), so this file is
// presentation only. Chrome-free: it fills its parent's height; each host frames
// it (the page in a card, the panel in a floating shell).
//
// READ-ONLY, like the page it was lifted from: it POSTs a question and renders
// the grounded answer + the routing trace. It never writes a business row.
// ---------------------------------------------------------------------------

import { Bot, Send, User } from "lucide-react";
import { Badge } from "./Badge";
import { cn } from "../lib/utils";
import { useAssistantChat, ASSISTANT_SUGGESTIONS } from "./useAssistantChat";

export type { AgentRef, Msg } from "./useAssistantChat";

export function AssistantChat({ className }: { className?: string }) {
  const { msgs, draft, setDraft, busy, send, endRef } = useAssistantChat();

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
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
      <div className="flex items-center gap-2 border-t border-border bg-surface-dim p-3">
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
          disabled={busy || !draft.trim()}
          aria-label="Send"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-accent text-white disabled:opacity-40"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

export default AssistantChat;
