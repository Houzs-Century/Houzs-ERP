
/** Make an operator's free-text safe inside a PostgREST `.or()` filter.
 *
 *  Each reserved grammar character (`,(){}`) becomes `_` — the LIKE
 *  single-character wildcard — so the term keeps its length and its positions
 *  and still matches the stored value. A term containing none of them is
 *  returned byte-for-byte unchanged, trimmed.
 *
 *  See the header for why this replaces the previous DELETE, and for the
 *  trade-off `_` carries. */
export function escapeForOr(search: string): string {
  return String(search ?? '').replace(/[,(){}]/g, '_').trim();
}

/** `phone.ilike` conditions (raw + E.164-normalised) for a list `.or()`.
 *  `escaped` is escapeForOr(raw); `raw` is the untouched query term. */
export function phoneSearchOrParts(escaped: string, raw: string, normalize: (s: string) => string | null): string[] {
  const parts = [`phone.ilike.%${escaped}%`];
  const pn = normalize(raw);
  const digits = pn ? pn.replace(/^\+/, '') : null;
  if (digits && !escaped.includes(digits)) parts.push(`phone.ilike.%${escapeForOr(digits)}%`);
  return parts;
}
