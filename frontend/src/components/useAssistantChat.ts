// ---------------------------------------------------------------------------
// useAssistantChat — the ONE Assistant chat logic layer behind every surface:
// the desktop page, the desktop floating panel, and the mobile bottom sheet.
// One send() path and one message model, so a rule fixed on one surface can
// never be missed on another (owner rule: desktop and mobile are one product,
// one shared logic layer — the surfaces differ only in presentation). This hook
// is chrome-free; each host renders the msgs/composer in its own idiom.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

export interface AgentRef {
  key: string;
  label: string;
}
export interface Msg {
  role: "user" | "bot";
  text: string;
  agents?: AgentRef[];
  degraded?: boolean;
}

/** Starter prompts shown on the empty state — shared so both surfaces suggest
 *  the same things. */
export const ASSISTANT_SUGGESTIONS = [
  "Which orders are blocked and why?",
  "Who owes us the most right now?",
  "How did sales and margin do this month?",
  "What stock shortages need a purchase order?",
];

export interface AssistantChatController {
  msgs: Msg[];
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  send: (text: string) => void;
  endRef: React.MutableRefObject<HTMLDivElement | null>;
  /** The thread these messages belong to (null = a brand-new, unsaved chat). */
  conversationId: string | null;
  /** Clear the stream and start a fresh thread. */
  newChat: () => void;
  /** Hydrate the stream from a stored conversation (the history list opens one). */
  loadConversation: (id: string, messages: Msg[]) => void;
}

export function useAssistantChat(): AssistantChatController {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setDraft("");
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    try {
      const res = await api.post<{
        success: boolean;
        // conversationId threads follow-ups into one stored conversation.
        data: { answer: string; agents: AgentRef[]; degraded: boolean; conversationId?: string | null };
      }>("/api/assistant/chat", { message: q, conversationId: conversationId ?? undefined });
      const d = res.data;
      if (d.conversationId) setConversationId(d.conversationId);
      setMsgs((m) => [...m, { role: "bot", text: d.answer, agents: d.agents, degraded: d.degraded }]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        {
          role: "bot",
          text: `Couldn't reach the assistant: ${e instanceof Error ? e.message : "Something went wrong."}`,
          degraded: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    setMsgs([]);
    setConversationId(null);
    setDraft("");
  }

  function loadConversation(id: string, messages: Msg[]) {
    setConversationId(id);
    setMsgs(messages);
    setDraft("");
  }

  return { msgs, draft, setDraft, busy, send, endRef, conversationId, newChat, loadConversation };
}
