
const TTL_MS = 15_000;

const NEVER_CACHE = [
  /^\/api\/auth\//,
  /\/activity(\?|$)/,
  /^\/api\/presence/,
  /^\/api\/admin\/health/,
  /^\/api\/badge-counts/,
];

type Entry = { at: number; data: unknown };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

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
  bc = null;
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
  p.finally(() => { if (inflight.get(path) === p) inflight.delete(path); }).catch(() => {});
}

function invalidateLocal(prefix: string): void {
  invalEpoch += 1;
  invalidatedAt.set(prefix, invalEpoch);
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
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

const ALSO_INVALIDATES: Record<string, string> = { "/api/project-sales-bills": "/api/projects" };

const writeListeners = new Set<(path: string) => void>();
export function onApiWrite(fn: (path: string) => void): () => void {
  writeListeners.add(fn);
  return () => { writeListeners.delete(fn); };
}

/** A mutation on `/api/<resource>/...` invalidates that whole resource. */
export function invalidateForMutation(path: string): void {
  const m = path.match(/^(\/api\/[^/?]+)/);
  if (!m) return;
  invalidate(m[1]);
  const also = ALSO_INVALIDATES[m[1]];
  if (also) invalidate(also);
  for (const fn of writeListeners) fn(path);
}
