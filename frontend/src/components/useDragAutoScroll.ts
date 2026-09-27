import { useEffect, useRef } from "react";

/** Edge auto-scroll for a drag (owner 2026-09-27). While a drag is in flight,
 *  call `at(clientY)` on each dragover; a stationary hover within `edge`px of the
 *  scroller's top or bottom keeps scrolling on a timer — dragover stops firing
 *  when the cursor is still, so a plain handler cannot carry a row past the
 *  visible window. Call `stop()` on drop / dragend; the timer is also cleared on
 *  unmount. `getScroller` is read lazily (at drag time), so the caller may pass a
 *  ref that is declared after this hook runs. */
export function useDragAutoScroll(
  getScroller: () => HTMLElement | null,
  edge = 56,
  step = 14,
) {
  const ref = useRef<{ dir: -1 | 0 | 1; timer: number | null }>({ dir: 0, timer: null });
  const stop = () => {
    if (ref.current.timer != null) window.clearInterval(ref.current.timer);
    ref.current = { dir: 0, timer: null };
  };
  const at = (clientY: number) => {
    const wrap = getScroller();
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const dir: -1 | 0 | 1 = clientY < rect.top + edge ? -1 : clientY > rect.bottom - edge ? 1 : 0;
    if (dir === ref.current.dir) return;
    stop();
    if (dir !== 0) ref.current = { dir, timer: window.setInterval(() => { wrap.scrollTop += dir * step; }, 16) };
  };
  useEffect(() => () => { if (ref.current.timer != null) window.clearInterval(ref.current.timer); }, []);
  return { at, stop };
}
