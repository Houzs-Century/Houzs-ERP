// ─────────────────────────────────────────────────────────────────────────
// postgrest-search.ts — make operator free-text safe inside a PostgREST
// `.or(...)` filter string.
//
// THE PROBLEM
//   Several list routes interpolate raw search text into a comma-separated
//   PostgREST `.or()` filter, e.g.
//     q.or(`code.ilike.%${search}%,name.ilike.%${search}%`)
//   The `.or()` grammar uses `,` to separate conditions and `()` to group
//   them. A sofa SKU like `BOOQIT-1A(LHF)` (or any term containing `,`, `(`,
//   `)`, `{`, `}`) therefore corrupts the filter — PostgREST either 400s or
//   returns the wrong rows.
//
// THE FIX, AND WHY THE FIRST ONE WAS WRONG
//   This used to DELETE the reserved characters, on the reasoning that "`ilike`
//   still matches via the surrounding `%...%` wildcards". That reasoning only
//   holds when the deleted character sits at an END of the term. Delete one
//   from the MIDDLE and the term is no longer a substring of the stored value,
//   so it matches NOTHING — and the header's own example, `BOOQIT-1A(LHF)`, is
//   exactly that case. Reproduced on production 2026-08-22, Houzs Century:
//
//     search            sent as             products found
//     2376-1A           %2376-1A%           6
//     2376-1A(          %2376-1A%           6     <- trailing, so deleting worked
//     2376-1A(RHF)      %2376-1ARHF%        0     <- the SKU exists
//
//   Every parenthesised sofa code in the catalogue was unfindable by its full
//   code in every list that searches — and `(LHF)` / `(RHF)` is how this
//   catalogue spells a left- or right-hand facing piece.
//
//   Now each reserved character becomes `_`, the LIKE single-character
//   wildcard, instead of vanishing. Position and length are preserved, so
//   `%2376-1A_RHF_%` matches `2376-1A(RHF)`.
//
//   THE TRADE, stated rather than buried: `_` matches ANY one character, so the
//   term is very slightly looser — it can also match a same-length string that
//   differs only at those positions. That is a bounded widening of a search
//   box, against a guaranteed zero result today. It is also consistent with
//   what this codebase already does: `%` and `_` typed by an operator are
//   already passed through as wildcards, so a character that cannot be sent
//   literally becoming a single-character wildcard is the existing rule, not a
//   new one.
//
//   NOT DONE HERE: the exact fix is PostgREST's double-quoted value
//   (`code.ilike."%2376-1A(RHF)%"`), inside which `,()` are literal. That needs
//   the QUOTES to wrap the whole pattern including the `%`, and all 43 call
//   sites build `%${s}%` themselves — so it is a separate, mechanical change
//   across 15 files, not a line in this one. Worth doing; not worth bundling
//   with the fix that stops the search returning nothing.
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
// phoneSearchOrParts — the PHONE half of a list's free-text `.or()`.
//
// Customer phones are stored canonical E.164 ("+60123456789"; see
// scm/shared/phone.ts). A term the user actually types — "012-345 6789",
// "012 345 6789", or the local "0123456789" — therefore never substring-
// matches the stored form via a raw ilike (leading 0 dropped, `60` prepended,
// separators removed). So we emit TWO predicates: the raw term (so typing an
// E.164 fragment like "60123" still works) AND the term run through the SAME
// normaliser the write path uses, reduced to bare digits so it matches inside
// the stored `+<digits>`. Reused by SO / DO / SI so the three lists can't drift.
// ─────────────────────────────────────────────────────────────────────────
/** `phone.ilike` conditions (raw + E.164-normalised) for a list `.or()`.
 *  `escaped` is escapeForOr(raw); `raw` is the untouched query term. */
export function phoneSearchOrParts(escaped: string, raw: string, normalize: (s: string) => string | null): string[] {
  const parts = [`phone.ilike.%${escaped}%`];
  const pn = normalize(raw);
  const digits = pn ? pn.replace(/^\+/, '') : null;
  // Skip the second predicate when the normaliser adds nothing new (already a
  // bare-digit substring of `escaped`), so an ordinary text search stays cheap.
  if (digits && !escaped.includes(digits)) parts.push(`phone.ilike.%${escapeForOr(digits)}%`);
  return parts;
}
