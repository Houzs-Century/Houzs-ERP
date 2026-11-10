// leaveGuard — "this page holds typing that leaving would throw away; ask first".
//
// Forms hold a guard while they are dirty (hooks/useLeaveGuard). ONE bridge
// (components/LeaveGuardBridge) consults the holders on every way out of a page:
// in-app navigation (the router's navigator is wrapped, because this app mounts a
// plain BrowserRouter and react-router 6 offers `useBlocker` only on a DATA
// router), the browser's / phone's Back (popstate), and a reload or closed tab
// (beforeunload). Same approach as Conts-ERP's useLeaveGuard, made a registry so
// two guarded parts of one screen cannot leave a dead wrapper on the navigator.

// Each holder may name query parameters that address its form (`?form=new` on a
// list page): a change to one of those is leaving too.
const holders = new Map<symbol, readonly string[]>();

type Asker = () => Promise<boolean>;
let asker: Asker | null = null;
let pending: Promise<boolean> | null = null;
let unloadAllowed = false;

/** Hold the guard until the returned release runs. Idempotent release. */
export function holdLeaveGuard(params: readonly string[] = []): () => void {
  const token = Symbol("leave-guard");
  holders.set(token, params);
  return () => {
    holders.delete(token);
  };
}

export function leaveGuardActive(): boolean {
  return holders.size > 0;
}

/** The bridge registers how to ask (the app's confirm dialog). */
export function setLeaveGuardAsker(fn: Asker | null): void {
  asker = fn;
}

/**
 * True when nothing is unsaved or the person chose to leave. Choosing to leave
 * drops every holder, so the move that follows is not asked about a second time.
 * Concurrent callers share one dialog. With no bridge mounted there is nobody
 * to ask, so the move goes through rather than hanging.
 */
export async function confirmLeaving(): Promise<boolean> {
  if (holders.size === 0 || asker === null) return true;
  pending ??= asker().finally(() => {
    pending = null;
  });
  const leave = await pending;
  if (leave) holders.clear();
  return leave;
}

/** A reload the app is about to do on purpose, after asking in its own words
 *  (the company switch). Stops the browser asking a second time. */
export function allowNextUnload(): void {
  unloadAllowed = true;
}

export function shouldBlockUnload(): boolean {
  return holders.size > 0 && !unloadAllowed;
}

/** The query parameters each current holder named (lib/leaveGuardPlace.ts). */
export function heldPlaceParams(): Iterable<readonly string[]> {
  return holders.values();
}

export function resetLeaveGuardForTests(): void {
  holders.clear();
  asker = null;
  pending = null;
  unloadAllowed = false;
}
