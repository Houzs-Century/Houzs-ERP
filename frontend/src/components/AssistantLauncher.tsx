// ---------------------------------------------------------------------------
// AssistantLauncher — floating, draggable launcher that opens the Assistant.
//
// Owner (2026-07-18): the in-app Assistant should sit at the BOTTOM-RIGHT and
// be draggable, exactly like the Hookka ERP launcher — a floating disc the user
// can grab and reposition anywhere on screen.
//
// Why a launcher at all: today the Assistant is only reachable from the sidebar
// nav (route /assistant). A corner disc puts it one tap away from every page,
// matching Hookka. This does NOT rebuild the Assistant — a tap just navigates to
// the existing /assistant page; the disc only owns its own position + gesture.
//
// Behaviour, and WHY each piece exists:
//   · Default anchor is the bottom-right AREA, parked just to the LEFT of the
//     existing "+" New-SO FAB (QuickActionsFAB owns the very corner at right-5).
//     Sitting on top of the "+" would bury one control under the other, so the
//     first-run default clears it; the user can still drag the disc onto the
//     corner and that choice sticks.
//   · Draggable via POINTER events, so one code path covers mouse, touch and pen
//     — the phone/tablet touch-drag is the same gesture as a desktop mouse-drag.
//   · CLAMPED to the viewport on every move AND on window resize, so the disc can
//     never be flung off-screen (or stranded off-screen when the window shrinks).
//   · Position PERSISTS in localStorage — a personal layout preference, the same
//     class of state this repo already keeps client-side (sticky filters, banner
//     acks). Stored as right/bottom OFFSETS, not left/top, so the disc keeps its
//     bottom-right meaning across viewport sizes.
//   · A small movement THRESHOLD separates a click (open) from a drag (reposition)
//     so nudging the disc a pixel while grabbing it doesn't fire navigation, and a
//     real drag doesn't accidentally open the Assistant on release.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { canUseAssistant } from "../auth/assistantAccess";
import { cn } from "../lib/utils";
import { useAssistantPanel } from "./AssistantPanelContext";
import {
  DISC_SIZE_PX,
  DRAG_THRESHOLD_PX,
  assistantLauncherStorageKey,
  clampOffset,
  readStoredOffset,
  type Offset,
} from "./assistantLauncherPosition";

export function AssistantLauncher() {
  const { user } = useAuth();
  const { toggle } = useAssistantPanel();
  const location = useLocation();

  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<Offset>(() =>
    clampOffset(
      readStoredOffset(),
      DISC_SIZE_PX,
      DISC_SIZE_PX,
      window.innerWidth,
      window.innerHeight,
    ),
  );
  // Mirror of `pos` for the pointerup handler to read the latest spot without a
  // stale closure — and without persisting from inside a state updater (which
  // StrictMode would double-invoke).
  const latestPos = useRef(pos);
  useEffect(() => {
    latestPos.current = pos;
  }, [pos]);

  // Live gesture bookkeeping. Refs (not state) so a pointermove doesn't queue a
  // re-render per frame just to remember where the grab started.
  const gesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    moved: boolean;
  } | null>(null);
  // Set on the pointerup that ENDED a drag, so the click that the browser
  // synthesises right after doesn't also open the Assistant.
  const suppressClick = useRef(false);

  const discSize = () => {
    const r = btnRef.current?.getBoundingClientRect();
    return { w: r?.width || DISC_SIZE_PX, h: r?.height || DISC_SIZE_PX };
  };

  // Re-clamp whenever the viewport changes, so shrinking the window (or rotating
  // a phone) can't leave the disc parked in dead space off-screen.
  useEffect(() => {
    const onResize = () => {
      const { w, h } = discSize();
      setPos((p) => clampOffset(p, w, h, window.innerWidth, window.innerHeight));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    // Only start a drag on the primary button / a touch — ignore right-click etc.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    // Clear any leftover suppression at the START of a fresh gesture. A touch
    // drag ends without a synthetic click, so the flag set on the last drag's
    // pointerup would otherwise linger and swallow the NEXT genuine tap.
    suppressClick.current = false;
    btnRef.current?.setPointerCapture(e.pointerId);
    gesture.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startRight: pos.right,
      startBottom: pos.bottom,
      moved: false,
    };
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    g.moved = true;
    // Right/bottom offsets grow as the pointer moves LEFT/UP, hence the minus.
    const { w, h } = discSize();
    setPos(
      clampOffset(
        { right: g.startRight - dx, bottom: g.startBottom - dy },
        w,
        h,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, []);

  const endGesture = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    try {
      btnRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be gone (e.g. pointercancel) — harmless
    }
    if (g.moved) {
      // A real drag ended: persist the new spot and swallow the trailing click.
      suppressClick.current = true;
      try {
        const key = assistantLauncherStorageKey();
        if (key) localStorage.setItem(key, JSON.stringify(latestPos.current));
      } catch {
        // quota / privacy mode — the disc simply won't remember; not fatal
      }
    }
    gesture.current = null;
  }, []);

  const onClick = useCallback(() => {
    // A drag just ended — this click is the browser's echo of the release, not an
    // intent to open. Consume it once and reset.
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    toggle();
  }, [toggle]);

  // Gate: hidden entirely for positions the Assistant denies (Driver/Helper/
  // Storekeeper) — mirrors the sidebar nav + the backend 403, so no one sees a
  // disc that would bounce them on tap.
  if (!user || !canUseAssistant(user)) return null;
  // The driver shell is a separate layout with no Assistant; keep the corner clear.
  if (location.pathname.startsWith("/driver")) return null;

  if (typeof document === "undefined") return null;

  const node = (
    <button
      ref={btnRef}
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onClick={onClick}
      aria-label="Open Assistant"
      title="Assistant — drag to reposition"
      // touch-action:none stops the browser from treating a touch-drag as a
      // page scroll/pan, so the disc actually follows the finger on mobile.
      style={{ right: pos.right, bottom: pos.bottom, touchAction: "none" }}
      className={cn(
        "fixed z-40 inline-flex h-14 w-14 items-center justify-center rounded-full",
        // Grey disc (owner 2026-07-23 v3: "背景换成灰色看一下") — quiet neutral
        // plate under the official bot artwork.
        "border border-border bg-surface-dim shadow-slab",
        "cursor-grab active:cursor-grabbing select-none touch-none",
        "transition-transform duration-200 hover:scale-105 hover:bg-border-subtle active:scale-95",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
      )}
    >
      {/* Official icons8 "Nolan" bot PNG (owner 2026-07-23: 一模一样 — the
          asset itself, per owner instruction). Licence RESOLVED (owner
          2026-07-29): stay on the FREE tier — the visible, clickable
          icons8.com credit in the Settings footer satisfies it. Do not
          remove that footer link while this PNG ships. The BLINK: the
          icon's face plate is white, so two white "eyelid" dots parked over
          the eyes simply flash opaque every ~4.2s. Guarded by
          prefers-reduced-motion. */}
      {/* 80% of the 56px disc (owner: icon可以大一点 填满圆形80%) — fixed px
          because the percentage box resolves against the border-box minus
          borders and lands at ~77%. */}
      <span className="pointer-events-none relative inline-flex h-[45px] w-[45px]">
        <img
          src="/assistant-bot.png"
          alt=""
          draggable={false}
          className="h-full w-full select-none"
        />
        {/* .hz-bot-lid + keyframes live in index.css — bundle-gate bytes. */}
        <span aria-hidden className="hz-bot-lid" style={{ left: "29.2%", top: "47.8%" }} />
        <span aria-hidden className="hz-bot-lid" style={{ left: "58.5%", top: "47.8%" }} />
      </span>
    </button>
  );

  return createPortal(node, document.body);
}

export default AssistantLauncher;
