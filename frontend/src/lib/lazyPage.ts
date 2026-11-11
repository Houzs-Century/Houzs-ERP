import { lazy, isValidElement, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";

/**
 * `React.lazy` that can be told to start downloading BEFORE it renders.
 *
 * Why: a lazy route nested inside another lazy wrapper is a waterfall. React
 * cannot render `<Page/>` until `<Scm2990Shell>` (itself lazy) has arrived, so
 * the page chunk used to start only after the shell chunk finished — measured
 * on production 2026-11-11 as two back-to-back ~3 s chunk waves before the
 * Delivery Planning board could even ask for its data. `preload()` lets the
 * wrapper (and the boot code in main.tsx) start both at once.
 *
 * `preload()` and React's own render call share ONE promise, so the chunk is
 * fetched once. A failed load clears the memo, so a later render or preload
 * retries instead of replaying a stale-chunk rejection; the failure itself still
 * reaches React through the lazy component and the existing ChunkReloadBoundary
 * ladder, exactly as before.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint React.lazy itself uses
export type PreloadableLazy<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  preload: () => Promise<unknown>;
};

/* In-flight page-chunk loads (render or preload). Read by whenPageChunksSettled
   so the speculative idle prefetch waits for the landing page instead of racing
   it for bandwidth. */
let inFlight = 0;
const settledWaiters: Array<() => void> = [];

function settle(): void {
  inFlight -= 1;
  if (inFlight > 0) return;
  // A macrotask, not a microtask: the chunk that just arrived renders, and that
  // render can start the next lazy load (a nested route). Give it the chance.
  setTimeout(() => {
    if (inFlight > 0) return;
    for (const resolve of settledWaiters.splice(0)) resolve();
  }, 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint React.lazy itself uses
export function lazyPage<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): PreloadableLazy<T> {
  let pending: Promise<{ default: T }> | null = null;
  const load = (): Promise<{ default: T }> => {
    if (pending) return pending;
    inFlight += 1;
    const p = factory();
    pending = p;
    p.then(settle, () => {
      settle();
      if (pending === p) pending = null;
    });
    return p;
  };
  return Object.assign(lazy(load), { preload: load });
}

/** Resolves once no page chunk is loading (next macrotask when none is), or
 *  after `maxWaitMs` regardless: a request that hangs must delay the
 *  speculative warm list, not cancel it for the whole session. */
export function whenPageChunksSettled(maxWaitMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    if (inFlight === 0) {
      setTimeout(resolve, 0);
      return;
    }
    settledWaiters.push(resolve);
    setTimeout(resolve, maxWaitMs);
  });
}

/** The rejection handler for a head start (a preload, a primed request). The
 *  failure is not lost: whoever really needs the result awaits the same
 *  promise and handles it there (React.lazy -> ChunkReloadBoundary, fetchMe's
 *  retry loop), and a chunk failure is also recorded by staleBuild's
 *  vite:preloadError listener. This only keeps the speculative copy from
 *  surfacing as an unhandled rejection. */
export function headStartFailed(_error: unknown): void {
  // Intentionally nothing; see above.
}

type WithPreload = { preload?: unknown };

/**
 * Start every preloadable lazy component found in an element tree — the
 * element itself, then its `children`, recursively. Used for a route's
 * `element` (`<ScmGuard><Scm2990Shell><Page/></Scm2990Shell></ScmGuard>`):
 * guards and wrappers are walked through, lazies are started. Components that
 * pick a page inside their own body are invisible here and keep loading on
 * render, as before. Never throws, never rejects.
 */
export function preloadElementChunks(node: ReactNode, depth = 0): void {
  if (depth > 12 || node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) preloadElementChunks(child, depth + 1);
    return;
  }
  if (!isValidElement(node)) return;
  const type: unknown = node.type;
  const preload = typeof type === "object" || typeof type === "function" ? (type as WithPreload | null)?.preload : undefined;
  if (typeof preload === "function") {
    try {
      void (preload as () => Promise<unknown>)().catch(headStartFailed);
    } catch {
      // A preload is only ever a head start; the render path owns the real load.
    }
  }
  preloadElementChunks((node.props as { children?: ReactNode }).children, depth + 1);
}
