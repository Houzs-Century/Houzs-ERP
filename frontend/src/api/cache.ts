// Lightweight SWR-style cache for api.get(): short-TTL memory cache +
// in-flight request dedup + cross-tab invalidation. Pattern lifted from
// Hookka ERP's cached-fetch layer, trimmed to what Houzs needs today.
//
// Effect: navigating between pages re-renders instantly from cache instead
// of refetching every panel (the old useQuery refetched on every mount),
// and double-mounted components share one network request. Mutations
// (post/patch/put/del in client.ts) invalidate the whole resource family
// (`/api/projects/123/archive` clears every `/api/projects*` entry) in this
// tab and, via BroadcastChannel, in every other open tab.

const TTL_MS = 15_000;

// Never cache: auth probes (login state must always be live), the project
// chat/activity feed (polled every 3s — staleness would delay messages),
// and presence (who-is-online must stay live).
const NEVER_CACHE = [/^\/api\/auth\//, /\/activity(\?|$)/, /^\/api\/presence/, /^\/api\/admin\/health/];

type Entry = { at: number; data: unknown };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

// Monotonic invalidation clock. Each invalidate() bumps it and records the
// value per resource prefix. A GET captures the clock when it STARTS; if a
// covering mutation lands before that request resolves, the late response must
// NOT re-populate the cache with now-stale data (read-after-write safety —
// otherwise "save then the list shows the old value" can still happen even
// though the cache was cleared, because an already-in-flight read repopulates it).
let invalEpoch = 0;
const invalidatedAt = new Map<string, number>();

export function currentEpoch(): number {
  return invalEpoch;
}

/** True if a mutation invalidated a family covering `path` at/after `epoch`
 *  (the clock value captured when the request started). */
export function invalidatedSince(path: string, epoch: number): boolean {
  for (const [prefix, seq] of invalidatedAt) {
    if (seq > epoch && path.startsWith(prefix)) return true;
  }
  return false;
}

let bc: BroadcastChannel | null = null;
try {
  bc = new BroadcastChannel("houzs-api-cache");
  bc.onmessage = (e: MessageEvent) => {
    if (e.data && e.data.t === "inv") invalidateLocal(String(e.data.p));
  };
} catch {
  bc = null; // older browsers: cache still works, just not cross-tab
}

export function cacheable(path: string): boolean {
  return !NEVER_CACHE.some((r) => r.test(path));
}

export function getCached<T>(path: string): T | undefined {
  const e = store.get(path);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) {
    store.delete(path);
    return undefined;
  }
  return e.data as T;
}

export function setCached(path: string, data: unknown): void {
  store.set(path, { at: Date.now(), data });
}

export function getInflight<T>(path: string): Promise<T> | undefined {
  return inflight.get(path) as Promise<T> | undefined;
}

export function setInflight(path: string, p: Promise<unknown>): void {
  inflight.set(path, p);
  p.finally(() => inflight.delete(path)).catch(() => {});
}

function invalidateLocal(prefix: string): void {
  invalEpoch += 1;
  invalidatedAt.set(prefix, invalEpoch);
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
  // Drop in-flight reads for this family too: a GET that began before the
  // mutation must not be joined by a later read and then cache stale data.
  for (const k of inflight.keys()) if (k.startsWith(prefix)) inflight.delete(k);
}

/** Drop every cached GET whose path starts with `prefix`, in all tabs. */
export function invalidate(prefix: string): void {
  invalidateLocal(prefix);
  try {
    bc?.postMessage({ t: "inv", p: prefix });
  } catch {}
}

/** Company switch: drop EVERY cached GET + in-flight read (all families, all
 *  tabs). Without this the path-only `store` would serve the previous company's
 *  payload for up to TTL_MS after switching. Call before invalidateQueries(). */
export function clearAll(): void {
  invalidate("/api");
}

/** A mutation on `/api/<resource>/...` invalidates that whole resource. */
export function invalidateForMutation(path: string): void {
  const m = path.match(/^(\/api\/[^/?]+)/);
  if (m) invalidate(m[1]);
}
