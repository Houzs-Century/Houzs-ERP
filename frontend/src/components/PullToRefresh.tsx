import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowDown, RefreshCw } from "lucide-react";
import { useToast } from "../hooks/useToast";
import { cn } from "../lib/utils";

// ── Refresh guard ──────────────────────────────────────────────
//
// Pages with unsaved form state (e.g. an open Panel with a dirty
// draft) don't want a stray pull-to-refresh tearing down the page.
// `usePullToRefreshBlock(true)` registers a block; PullToRefresh
// notices and shows a toast instead of refreshing.
//
// Implementation is a refcount: many components can hold a block
// concurrently; refresh only fires when the count is zero.

interface GuardCtx {
  blocked: boolean;
  registerBlock: () => () => void;
}

const GuardContext = createContext<GuardCtx | null>(null);

export function PullToRefreshGuardProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const registerBlock = useCallback(() => {
    setCount((c) => c + 1);
    return () => setCount((c) => Math.max(0, c - 1));
  }, []);
  const value = useMemo<GuardCtx>(
    () => ({ blocked: count > 0, registerBlock }),
    [count, registerBlock],
  );
  return <GuardContext.Provider value={value}>{children}</GuardContext.Provider>;
}

/**
 * Block pull-to-refresh while `active` is true. Unblocks on unmount or
 * when `active` flips back to false. No-op if rendered outside a
 * `PullToRefreshGuardProvider`.
 */
export function usePullToRefreshBlock(active: boolean) {
  const ctx = useContext(GuardContext);
  useEffect(() => {
    if (!ctx) return;
    if (!active) return;
    return ctx.registerBlock();
  }, [ctx, active]);
}

function usePullToRefreshBlocked(): boolean {
  const ctx = useContext(GuardContext);
  return ctx?.blocked ?? false;
}

interface Props {
  /**
   * Called when the user pulls past the threshold and releases.
   * Defaults to `window.location.reload()` — a hard, F5-style refresh.
   */
  onRefresh?: () => Promise<unknown> | void;
  /** Optional extra padding above the indicator (e.g. when there's a sticky bar). */
  topOffset?: number;
  children: ReactNode;
  className?: string;
}

// Sensitivity tuning. The dead-zone lets the user scroll up casually
// without engaging the pull, and the resistance multiplier means the
// indicator only travels a fraction of the finger's distance — so a
// committed pull is required, not a flick.
const DEAD_ZONE = 14;
const RESISTANCE = 0.55;
const THRESHOLD = 80;
const MAX_PULL = 130;

function findScrollAncestor(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Mobile pull-to-refresh wrapper. Listens for touch on its own element,
 * walks up to find the nearest scrollable ancestor, and only engages
 * when scrollTop === 0. No-op on desktop because we only attach touch
 * listeners.
 */
export function PullToRefresh({
  onRefresh,
  topOffset = 0,
  children,
  className,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const startYRef = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const blocked = usePullToRefreshBlocked();
  const toast = useToast();
  // Mirror `blocked` into a ref so the touchend handler can read the
  // latest value without re-binding listeners every time it flips.
  const blockedRef = useRef(blocked);
  useEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);

  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    scrollRef.current = findScrollAncestor(wrap) ?? document.documentElement;
  }, []);

  // Track the user's "reduce motion" OS preference. When set, the
  // pull-to-refresh gesture still triggers the refresh, but the visual
  // translation of indicator + content is suppressed so the page
  // doesn't jolt downward as the user pulls.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;

    function getScrollTop() {
      const el = scrollRef.current;
      if (!el) return 0;
      return el === document.documentElement ? window.scrollY : el.scrollTop;
    }

    function handleStart(e: TouchEvent) {
      if (refreshing) return;
      if (getScrollTop() > 0) {
        startYRef.current = null;
        return;
      }
      startYRef.current = e.touches[0].clientY;
    }

    function handleMove(e: TouchEvent) {
      if (refreshing || startYRef.current == null) return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy <= DEAD_ZONE) {
        // dead zone — finger hasn't committed to a pull yet. Casual
        // scroll-up jitter falls in here and never engages.
        setPull(0);
        return;
      }
      // Constant resistance the whole way: the indicator travels at
      // 0.55 of the finger's distance past the dead zone.
      const resisted = (dy - DEAD_ZONE) * RESISTANCE;
      setPull(Math.min(resisted, MAX_PULL));
      // Once we're past the dead zone we own the gesture — block the
      // browser's own pull-to-refresh / overscroll.
      if (e.cancelable) e.preventDefault();
    }

    async function handleEnd() {
      const start = startYRef.current;
      startYRef.current = null;
      if (start == null) {
        setPull(0);
        return;
      }
      if (pull >= THRESHOLD && !refreshing) {
        // Honour any registered block — typically a Panel with unsaved
        // changes. Snap the indicator back, surface a toast, and skip
        // the refresh entirely so the user's draft survives.
        if (blockedRef.current) {
          setPull(0);
          toast.error(
            "You have unsaved changes. Save or discard before refreshing.",
          );
          return;
        }
        setRefreshing(true);
        setPull(THRESHOLD);
        try {
          if (onRefresh) {
            await onRefresh();
          } else {
            // F5-style hard reload — never returns, no need to clear
            // refreshing state (the page is being torn down).
            window.location.reload();
            return;
          }
        } catch {
          // swallow — onRefresh's own error handling owns the toast
        } finally {
          setRefreshing(false);
          setPull(0);
        }
      } else {
        setPull(0);
      }
    }

    wrap.addEventListener("touchstart", handleStart, { passive: true });
    wrap.addEventListener("touchmove", handleMove, { passive: false });
    wrap.addEventListener("touchend", handleEnd);
    wrap.addEventListener("touchcancel", handleEnd);
    return () => {
      wrap.removeEventListener("touchstart", handleStart);
      wrap.removeEventListener("touchmove", handleMove);
      wrap.removeEventListener("touchend", handleEnd);
      wrap.removeEventListener("touchcancel", handleEnd);
    };
  }, [pull, refreshing, onRefresh]);

  const armed = pull >= THRESHOLD;
  const opacity = Math.min(pull / 20, 1);
  const rotate = Math.min((pull / THRESHOLD) * 180, 180);
  const label = refreshing
    ? "Refreshing…"
    : armed
    ? "Release to refresh"
    : "Pull down to refresh";

  // Under reduced-motion: indicator stays parked at its top-offset slot
  // (revealed by opacity only), and the content doesn't translate. The
  // refresh action itself still fires when the gesture commits.
  const indicatorTranslate = reducedMotion ? 0 : pull - 56;
  const arrowRotate = reducedMotion ? 0 : rotate;
  const contentTranslate = reducedMotion ? 0 : pull * 0.45;

  return (
    <div ref={wrapperRef} className="relative">
      <div
        aria-hidden={!refreshing && pull === 0}
        className="pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-1.5"
        style={{
          top: topOffset,
          transform: `translateY(${indicatorTranslate}px)`,
          opacity,
          transition: refreshing || pull === 0 ? "transform 200ms ease-out, opacity 200ms ease-out" : "none",
        }}
      >
        <div
          className={cn(
            "grid h-9 w-9 place-items-center rounded-full border border-border bg-surface shadow-stone",
            armed && "border-accent/60",
          )}
        >
          {refreshing ? (
            <RefreshCw size={14} className="animate-spin text-accent" />
          ) : (
            <ArrowDown
              size={14}
              className={cn(
                "transition-colors",
                armed ? "text-accent" : "text-ink-muted",
              )}
              style={{
                transform: `rotate(${arrowRotate}deg)`,
                transition: "transform 80ms linear",
              }}
            />
          )}
        </div>
        <span
          className={cn(
            "rounded-full bg-surface/95 px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand shadow-stone backdrop-blur-sm transition-colors",
            armed || refreshing ? "text-accent" : "text-ink-muted",
          )}
        >
          {label}
        </span>
      </div>
      {/* At rest this div must carry NO transform. `translateY(0px)` is not
          `none`, and any transform other than `none` makes an element the
          containing block for its `position: fixed` descendants — this div wraps
          every page in the app, so an always-on identity transform silently
          anchored page-level drawers/dialogs to the content box instead of the
          viewport (BUG-HISTORY 2026-07-16, SO History drawer). Set it only while
          the finger is actually pulling; `none` → `translateY(Npx)` still
          transitions (browsers interpolate `none` as the identity matrix). */}
      <div
        className={className}
        style={{
          transform: contentTranslate ? `translateY(${contentTranslate}px)` : undefined,
          transition: refreshing || pull === 0 ? "transform 200ms ease-out" : "none",
        }}
      >
        {children}
      </div>
    </div>
  );
}
