// ---------------------------------------------------------------------------
// useAssistantChat — the ONE Assistant chat logic layer behind every surface:
// the desktop page, the desktop floating panel, and the mobile bottom sheet.
// One send() path, one message model, one history browser, so a rule fixed on
// one surface can never be missed on another (owner rule: desktop and mobile are
// one product, one shared logic layer — the surfaces differ only in
// presentation). This hook is chrome-free; each host renders the msgs / composer
// / history list in its own idiom.
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
export interface ConversationSummary {
  id: string;
  title: string | null;
  message_count: number;
  updated_at: string;
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
  // ── history browsing ──
  /** Whether the host is showing the past-conversations list. */
  historyView: boolean;
  conversations: ConversationSummary[];
  loadingHistory: boolean;
  openHistory: () => void;
  closeHistory: () => void;
  openConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
}

export function useAssistantChat(): AssistantChatController {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!historyView) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy, historyView]);

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
    setHistoryView(false);
  }

  async function refreshHistory() {
    setLoadingHistory(true);
    try {
      const res = await api.get<{ success: boolean; data: { conversations: ConversationSummary[] } }>(
        "/api/assistant/conversations",
      );
      setConversations(res.data.conversations ?? []);
    } catch {
      // A history read failing must not break the chat — show an empty list.
      setConversations([]);
    } finally {
      setLoadingHistory(false);
    }
  }

  function openHistory() {
    setHistoryView(true);
    void refreshHistory();
  }
  function closeHistory() {
    setHistoryView(false);
  }

  async function openConversation(id: string) {
    setLoadingHistory(true);
    try {
      const res = await api.get<{
        success: boolean;
        data: { conversation: { id: string; title: string | null }; messages: Msg[] };
      }>(`/api/assistant/conversations/${id}/messages`);
      setConversationId(id);
      setMsgs((res.data.messages ?? []).map((m) => ({ role: m.role, text: m.text, agents: m.agents, degraded: m.degraded })));
      setHistoryView(false);
    } catch {
      // leave the current view untouched on a failed open
    } finally {
      setLoadingHistory(false);
    }
  }

  async function deleteConversation(id: string) {
    setConversations((cs) => cs.filter((c) => c.id !== id));
    if (conversationId === id) {
      setMsgs([]);
      setConversationId(null);
    }
    try {
      await api.del(`/api/assistant/conversations/${id}`);
    } catch {
      // best-effort; the row reappears on the next refresh if the delete failed
    }
  }

  return {
    msgs,
    draft,
    setDraft,
    busy,
    send,
    endRef,
    conversationId,
    newChat,
    historyView,
    conversations,
    loadingHistory,
    openHistory,
    closeHistory,
    openConversation,
    deleteConversation,
  };
}
