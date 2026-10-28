import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps hover entry/exit immediate while limiting pointer-move state updates to
 * one per animation frame. The latest move wins, and pending work is cancelled
 * when the pointer leaves or the consumer unmounts.
 */
export function useRafCoalescedHover<T>() {
  const [hover, setHover] = useState<T | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<T | null>(null);

  const cancelPendingFrame = useCallback(() => {
    pendingRef.current = null;
    if (frameRef.current != null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const enter = useCallback(
    (next: T) => {
      cancelPendingFrame();
      setHover(next);
    },
    [cancelPendingFrame],
  );

  const move = useCallback((next: T) => {
    pendingRef.current = next;
    if (frameRef.current != null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending != null) setHover(pending);
    });
  }, []);

  const leave = useCallback(() => {
    cancelPendingFrame();
    setHover(null);
  }, [cancelPendingFrame]);

  useEffect(() => cancelPendingFrame, [cancelPendingFrame]);

  return { hover, enter, move, leave };
}
