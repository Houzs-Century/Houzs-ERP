// ---------------------------------------------------------------------------
// MobileAssistant — the phone-native Assistant: a floating robot disc that opens
// a bottom SHEET chat (the mobile idiom for the desktop's floating panel; a small
// side window makes no sense on a phone). It shares the ONE chat logic layer
// (useAssistantChat) with the desktop page + panel — only the presentation is
// mobile (mobile.css sheet classes + the mobile palette, NOT Tailwind), per the
// owner rule that desktop and mobile are one product with one shared logic layer.
//
// Gated by canUseAssistant (mirrors the backend 403 + the desktop launcher), and
// mounted ONCE in the shell (sibling of MobileAppInner) so it rides every screen
// and its state survives tab/overlay navigation. READ-ONLY, like every surface.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../auth/AuthContext";
import { canUseAssistant } from "../auth/assistantAccess";
import { useAssistantChat, ASSISTANT_SUGGESTIONS, ASSISTANT_ACCEPT } from "../components/useAssistantChat";
import { fmtDateTime } from "../vendor/shared/format";

const PETROL = "#1e8071";

/* Was `toLocaleDateString(undefined, …)` — the viewer's OS locale, a month
   NAME, and no year at all. Three ways to disagree with every other date in
   the app. */
const shortWhen = fmtDateTime;

export function MobileAssistant() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Denied positions (field crew + sales) see no disc — mirrors the backend 403.
  if (!user || !canUseAssistant(user)) return null;
  if (typeof document === "undefined") return null;

  const headBtn = (onClick: () => void, label: string, path: string) => (
    <button className="sheet-x" onClick={onClick} aria-label={label} title={label}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {path.split("|").map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    </button>
  );

  const launcher = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open Assistant"
      style={{
        position: "fixed",
        right: 16,
        bottom: "calc(env(safe-area-inset-bottom) + 86px)",
        zIndex: 35,
        width: 52,
        height: 52,
        borderRadius: "50%",
        border: "1px solid rgba(17,24,16,.08)",
        background: "#fff",
        boxShadow: "0 12px 28px -8px rgba(18,87,78,.5),0 2px 6px rgba(17,24,16,.18)",
        display: open ? "none" : "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      <img src="/assistant-bot.png" alt="" draggable={false} style={{ width: 38, height: 38 }} />
    </button>
  );

  const sheet = open ? (
    <div
      className="sheet-bd"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="sheet" style={{ height: "80%", maxHeight: "88%" }}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: PETROL }}>Assistant</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>
              {historyView ? "Past chats" : "Ask about your ops"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {headBtn(newChat, "New chat", "M12 5v14|M5 12h14")}
            {historyView
              ? headBtn(closeHistory, "Back to chat", "M19 12H5|M12 19l-7-7 7-7")
              : headBtn(openHistory, "History", "M12 8v4l3 2|M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7 3.3M3 4v4h4")}
            {headBtn(() => setOpen(false), "Close assistant", "M6 6l12 12|M18 6 6 18")}
          </div>
        </div>

        {historyView ? (
          <div className="sheet-scroll" style={{ flex: 1 }}>
            {loadingHistory && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "20px 0" }}>Loading…</div>}
            {!loadingHistory && conversations.length === 0 && (
              <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "20px 0" }}>No past conversations yet.</div>
            )}
            {conversations.map((c) => (
              <div
                key={c.id}
                style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #e3e6e0", borderRadius: 12, padding: "10px 12px", background: "#fff" }}
              >
                <button type="button" onClick={() => openConversation(c.id)} style={{ minWidth: 0, flex: 1, textAlign: "left", background: "none", border: "none", padding: 0 }}>
                  <div style={{ fontSize: 13.5, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title || "Untitled chat"}</div>
                  <div style={{ fontSize: 11, color: "#9aa093", marginTop: 1 }}>
                    {c.message_count} message{c.message_count === 1 ? "" : "s"} · {shortWhen(c.updated_at)}
                  </div>
                </button>
                <button type="button" onClick={() => deleteConversation(c.id)} aria-label="Delete conversation" style={{ flex: "none", background: "none", border: "none", color: "#b0b5aa", padding: 4 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="sheet-scroll" style={{ flex: 1 }}>
            {msgs.length === 0 && (
              <div style={{ textAlign: "center", color: "#9aa093", fontSize: 13, padding: "16px 6px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div>Ask a question — it routes to the right agent.</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                  {ASSISTANT_SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      style={{ border: "1px solid #d6d9d2", borderRadius: 999, padding: "6px 11px", fontSize: 12, color: "#4a4f45", background: "#fff" }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {msgs.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div
                  style={{
                    maxWidth: "86%",
                    borderRadius: 14,
                    padding: "9px 12px",
                    fontSize: 13.5,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    background: m.role === "user" ? PETROL : "#f2f4ef",
                    color: m.role === "user" ? "#fff" : "#11140f",
                    border: m.role === "user" ? "none" : "1px solid #e3e6e0",
                  }}
                >
                  {m.role === "bot" && m.agents && m.agents.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center", borderBottom: "1px solid #e3e6e0", paddingBottom: 6, marginBottom: 6 }}>
                      <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "#9aa093" }}>Asked</span>
                      {m.agents.map((a) => (
                        <span key={a.key} style={{ fontSize: 10.5, background: "#fff", border: "1px solid #d6d9d2", borderRadius: 6, padding: "1px 6px", color: "#4a4f45" }}>
                          {a.label}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.text}
                  {m.degraded && <div style={{ marginTop: 5, fontSize: 11, color: "#9aa093" }}>Answered without the AI service.</div>}
                </div>
              </div>
            ))}

            {busy && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div style={{ background: "#f2f4ef", border: "1px solid #e3e6e0", borderRadius: 14, padding: "9px 12px", fontSize: 13, color: "#9aa093" }}>Asking the agents…</div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}

        {!historyView && (
          <div className="sheet-foot" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            {attachment && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, alignSelf: "flex-start", border: "1px solid #d6d9d2", borderRadius: 8, padding: "4px 8px", fontSize: 12, color: "#4a4f45", background: "#fff" }}>
                <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.name}</span>
                <button type="button" onClick={() => setAttachment(null)} aria-label="Remove file" style={{ background: "none", border: "none", color: "#9aa093", padding: 0, display: "flex" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                ref={fileRef}
                type="file"
                accept={ASSISTANT_ACCEPT}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setAttachment(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach image or PDF"
                style={{ width: 38, height: 38, flex: "none", borderRadius: 10, border: "1px solid #d6d9d2", background: "#fff", color: "#4a4f45", display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <input
                style={{ flex: 1, border: "1px solid #d6d9d2", borderRadius: 10, padding: "9px 12px", fontSize: 13, color: "#11140f", outline: "none", background: "#fff" }}
                placeholder="Ask something…"
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
                style={{
                  width: 38,
                  height: 38,
                  flex: "none",
                  borderRadius: 10,
                  border: "none",
                  background: PETROL,
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: busy || (!draft.trim() && !attachment) ? 0.4 : 1,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 2-7 20-4-9-9-4Z" />
                  <path d="M22 2 11 13" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  ) : null;

  return createPortal(
    <>
      {launcher}
      {sheet}
    </>,
    document.body,
  );
}

export default MobileAssistant;
