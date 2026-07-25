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

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../auth/AuthContext";
import { canUseAssistant } from "../auth/assistantAccess";
import { useAssistantChat, ASSISTANT_SUGGESTIONS } from "../components/useAssistantChat";

export function MobileAssistant() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const { msgs, draft, setDraft, busy, send, endRef } = useAssistantChat();

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
            <div className="ey" style={{ color: "#1e8071" }}>Assistant</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Ask about your ops</div>
          </div>
          <button className="sheet-x" onClick={() => setOpen(false)} aria-label="Close assistant">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

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
                  background: m.role === "user" ? "#1e8071" : "#f2f4ef",
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

        <div className="sheet-foot">
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
            disabled={busy || !draft.trim()}
            aria-label="Send"
            style={{
              width: 38,
              height: 38,
              flex: "none",
              borderRadius: 10,
              border: "none",
              background: "#1e8071",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: busy || !draft.trim() ? 0.4 : 1,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
          </button>
        </div>
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
