// ---------------------------------------------------------------------------
// AssistantPanel — the floating, resizable Assistant chat card (the owner's
// "like Facebook Messenger, a small window on the side" concept). The corner
// robot launcher TOGGLES it; it does NOT navigate away, so the operator keeps
// the page they were on. A drag handle at the top-left corner resizes it in
// both axes, and the chosen size persists per browser (a personal preference,
// the same class of client-side state as the launcher's position).
//
// No scrim: the app stays fully interactive behind the card, exactly like a
// docked chat window — you reference an order on the page while you ask about
// it. Escape and the close button dismiss it.
//
// The body is the shared <AssistantChat/>, so the panel and the /assistant page
// are ONE chat, not two implementations (owner rule: one shared logic layer).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bot, Maximize2, X } from "lucide-react";
import { AssistantChat } from "./AssistantChat";
import { useAssistantPanel } from "./AssistantPanelContext";

const W_KEY = "houzs:assistant-panel-w";
const H_KEY = "houzs:assistant-panel-h";
const DEFAULT_W = 400;
const MIN_W = 320;
const MAX_W = 680;
const DEFAULT_H = 560;
const MIN_H = 400;
const MAX_H = 860;

function readSize(key: string, def: number, min: number, max: number): number {
  if (typeof window === "undefined") return def;
  const v = Number(window.localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, min), max) : def;
}

export function AssistantPanel() {
  const { open, closePanel } = useAssistantPanel();
  const navigate = useNavigate();
  const [w, setW] = useState(() => readSize(W_KEY, DEFAULT_W, MIN_W, MAX_W));
  const [h, setH] = useState(() => readSize(H_KEY, DEFAULT_H, MIN_H, MAX_H));
  const drag = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  /* Top-left drag handle: moving the pointer UP/LEFT grows the card, so both
     dimensions increase by (start − current). Clamped to sane bounds AND the
     viewport (minus a gutter) so the card can't outgrow the screen. */
  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const capW = (typeof window !== "undefined" ? window.innerWidth : MAX_W) - 40;
    const capH = (typeof window !== "undefined" ? window.innerHeight : MAX_H) - 120;
    setW(Math.min(Math.max(d.startW + (d.startX - e.clientX), MIN_W), Math.min(MAX_W, capW)));
    setH(Math.min(Math.max(d.startH + (d.startY - e.clientY), MIN_H), Math.min(MAX_H, capH)));
  }, []);

  const onUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    // Persist via functional updater so we store the latest size, not a stale
    // closure value.
    setW((cur) => {
      try { window.localStorage.setItem(W_KEY, String(Math.round(cur))); } catch { /* private mode */ }
      return cur;
    });
    setH((cur) => {
      try { window.localStorage.setItem(H_KEY, String(Math.round(cur))); } catch { /* private mode */ }
      return cur;
    });
  }, [onMove]);

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    drag.current = { startX: e.clientX, startY: e.clientY, startW: w, startH: h };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /* Escape closes while open. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePanel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closePanel]);

  /* Belt-and-braces: drop any in-flight drag listeners on unmount. */
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    },
    [onMove, onUp],
  );

  if (!open || typeof document === "undefined") return null;

  const node = (
    <section
      role="dialog"
      aria-label="Assistant"
      style={{ width: w, height: h }}
      className="fixed bottom-24 right-5 z-[92] flex max-h-[calc(100vh-40px)] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-slab"
    >
      {/* top-left corner resize handle */}
      <div
        onPointerDown={startDrag}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize assistant"
        title="Drag to resize"
        className="group absolute left-0 top-0 z-10 flex h-5 w-5 cursor-nwse-resize items-start justify-start p-1"
      >
        <span className="h-2.5 w-2.5 rounded-tl-sm border-l-2 border-t-2 border-border-strong transition-colors group-hover:border-primary" />
      </div>

      {/* header */}
      <div className="flex h-12 shrink-0 items-center gap-2 bg-sidebar px-4 text-sidebar-ink">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-sidebar-ink/10">
          <Bot size={15} />
        </span>
        <div className="min-w-0 flex-1 truncate text-[13px] font-bold tracking-wide">Assistant</div>
        <button
          type="button"
          onClick={() => { closePanel(); navigate("/assistant"); }}
          aria-label="Open full page"
          title="Open full page"
          className="flex-none text-sidebar-ink-muted transition-colors hover:text-sidebar-ink"
        >
          <Maximize2 size={15} />
        </button>
        <button
          type="button"
          onClick={closePanel}
          aria-label="Close assistant"
          className="flex-none text-sidebar-ink-muted transition-colors hover:text-sidebar-ink"
        >
          <X size={16} />
        </button>
      </div>

      {/* shared chat body fills the remaining height */}
      <AssistantChat className="flex-1" />
    </section>
  );

  return createPortal(node, document.body);
}

export default AssistantPanel;
