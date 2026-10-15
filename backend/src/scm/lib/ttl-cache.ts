// Keeps a loaded value per key for ttlMs. Only the resolved value is stored, never
// the in-flight promise: a Worker promise must not be awaited from another request.
// A failed load, or one `keep` rejects (e.g. a degraded result), is not stored.
// Isolate-local: a new isolate starts empty.
export async function ttlCached<T>(
  store: Map<string, { at: number; v: T }>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  keep: (v: T) => boolean = () => true,
): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await load();
  if (keep(v)) store.set(key, { at: Date.now(), v });
  else store.delete(key);
  return v;
}
