
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

type ChatResponse = { answer: string; agents: AgentRef[]; degraded: boolean; conversationId?: string | null };

/** Starter prompts shown on the empty state — shared so both surfaces suggest
 *  the same things. */
export const ASSISTANT_SUGGESTIONS = [
  "Which orders are blocked and why?",
  "Who owes us the most right now?",
  "How did sales and margin do this month?",
  "What stock shortages need a purchase order?",
];

/** What the file-attach control accepts (image + PDF; video is not supported). */
export const ASSISTANT_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

export interface AssistantChatController {
  msgs: Msg[];
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  send: (text: string) => void;
  endRef: React.MutableRefObject<HTMLDivElement | null>;
  attachment: File | null;
  setAttachment: (f: File | null) => void;
  conversationId: string | null;
  newChat: () => void;
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
  const [attachment, setAttachment] = useState<File | null>(null);
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
    const file = attachment;
    if ((!q && !file) || busy) return;
    setDraft("");
    setAttachment(null);
    setMsgs((m) => [...m, { role: "user", text: q || (file ? file.name : "") }]);
    setBusy(true);
    try {
      let d: ChatResponse;
      if (file) {
        const form = new FormData();
        form.append("message", q);
        if (conversationId) form.append("conversationId", conversationId);
        form.append("file", file);
        const res = await api.postForm<{ success: boolean; data: ChatResponse }>("/api/assistant/chat", form);
        d = res.data;
      } else {
        const res = await api.post<{ success: boolean; data: ChatResponse }>("/api/assistant/chat", {
          message: q,
          conversationId: conversationId ?? undefined,
        });
        d = res.data;
      }
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
    setAttachment(null);
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
      // silent-write-ok: OPTIMISTIC WITH RECONCILE. The row reappears the next
      // time history is opened if the delete never landed, so the list
      // self-corrects. Worth knowing: within THIS session it does not, and the
      // only feedback the delete button gives is the row vanishing.
    }
  }

  return {
    msgs,
    draft,
    setDraft,
    busy,
    send,
    endRef,
    attachment,
    setAttachment,
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
