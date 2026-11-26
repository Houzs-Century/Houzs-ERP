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
  onRefresh?: () => Promise<unknown> | void;
  topOffset?: number;
  children: ReactNode;
  className?: string;
}

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
  const blockedRef = useRef(blocked);
  useEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);

  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    scrollRef.current = findScrollAncestor(wrap) ?? document.documentElement;
  }, []);

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
        setPull(0);
        return;
      }
      const resisted = (dy - DEAD_ZONE) * RESISTANCE;
      setPull(Math.min(resisted, MAX_PULL));
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
            window.location.reload();
            return;
          }
        } catch {
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
