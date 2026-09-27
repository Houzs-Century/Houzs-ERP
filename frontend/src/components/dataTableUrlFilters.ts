/* The shape of a table's column filters in the address: a JSON object of
   column key to the allowed values. Only non-empty funnels are written; a
   hand-edited or truncated link reads as no filter rather than breaking the
   page. */
export type ColFilters = Record<string, string[]>;

export function serializeUrlColFilters(filters: ColFilters): string | null {
  const active = Object.entries(filters).filter(([, v]) => v.length > 0);
  return active.length > 0 ? JSON.stringify(Object.fromEntries(active)) : null;
}

export function parseUrlColFilters(raw: string | null): ColFilters | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: ColFilters = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) out[k] = v as string[];
  }
  return Object.keys(out).length > 0 ? out : null;
}
