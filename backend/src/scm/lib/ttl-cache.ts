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
