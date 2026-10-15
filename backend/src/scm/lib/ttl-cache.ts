// Keeps one in-flight/loaded promise per key for ttlMs. A rejected load is dropped
// so the next caller retries. Isolate-local: a new isolate starts empty.
export function ttlCached<T>(
  store: Map<string, { at: number; p: Promise<T> }>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const hit = store.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.p;
  const p = load();
  store.set(key, { at: now(), p });
  p.catch(() => { if (store.get(key)?.p === p) store.delete(key); });
  return p;
}
