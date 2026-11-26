//     !value) return 0;` — an empty height contributes NO surcharge instead of

/** The three variant axes Total Height is derived from, in display order. */
export const TOTAL_HEIGHT_PARTS = ['divanHeight', 'legHeight', 'gap'] as const;

/** Does changing this variant key require Total Height to be recomputed?
 *  Call sites used to spell the three names inline; a fourth part would
 *  otherwise have to be remembered in sixteen places. */
export const isTotalHeightPart = (key: unknown): boolean =>
  (TOTAL_HEIGHT_PARTS as readonly string[]).includes(String(key));

/** Which categories carry a Total Height. BEDFRAME only — a sofa has seat and
 *  leg but no divan and no total. Case-insensitive so the backend's 'BEDFRAME'
 *  and the client's 'bedframe' are the same answer; every existing call site
 *  passes lowercase, so this is a widening that changes no current caller. */
export const isTotalHeightCategory = (category: unknown): boolean =>
  String(category ?? '').trim().toLowerCase() === 'bedframe';

/** Leading signed number out of an inch-marked value: `10"` / `10` / `-2` → 10
 *  / 10 / -2. Anything unparseable, null or undefined is 0, which is what lets
 *  a half-filled bedframe still price. The inch mark may be ASCII or curly —
 *  the match ignores everything after the digits either way. */
export const parseInches = (s: unknown): number => {
  if (s == null) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
};

/**
 * The line's Total Height, as it should be STORED on the variants blob.
 *
 * Returns '' for a non-bedframe line and for a bedframe whose divan, leg and
 * gap are all blank or zero. '' is a real answer here, not a failure: writing
 * it is how a cleared spec clears the total. Callers assign the result
 * unconditionally — the emptiness decision lives here, not at the call site,
 * because that split is exactly what let two of the sixteen copies keep a
 * stale value.
 *
 * NOTE the emitted inch mark is always ASCII `"`. The Model pools on prod
 * contain both ASCII and typographic marks, which is why
 * `allowed-options-check.ts` folds quotes before comparing rather than this
 * function guessing which glyph a pool prefers.
 */
export function computeTotalHeight(
  category: unknown,
  variants: Record<string, unknown> | null | undefined,
): string {
  if (!isTotalHeightCategory(category)) return '';
  const v = variants ?? {};
  const d = parseInches(v.divanHeight);
  const l = parseInches(v.legHeight);
  const g = parseInches(v.gap);
  if (d === 0 && l === 0 && g === 0) return '';
  return `${d + l + g}"`;
}

/**
 * The WRITE decision for a surface that reconciles an existing variants blob:
 * the patch to apply, or null when nothing needs to change.
 *
 * THIS IS THE HALF THAT HAD THE BUG, so it is the half that most needed a home.
 * Computing the height correctly was never the problem — SoLineCard computed the
 * right '' and then declined to store it, because its effect guarded
 * `if (!computedTotalHeight) return;` and an empty answer reads as "no answer"
 * to a truthiness check. Returning null ONLY for "already equal" and never for
 * "the new value is empty" is the whole distinction, and keeping it here means a
 * caller cannot reintroduce the bug by writing the guard the natural way.
 *
 * Returns null for a non-bedframe so a sofa line never grows the key.
 */
export function totalHeightPatch(
  category: unknown,
  variants: Record<string, unknown> | null | undefined,
): { totalHeight: string } | null {
  if (!isTotalHeightCategory(category)) return null;
  const next = computeTotalHeight(category, variants);
  const current = String((variants ?? {}).totalHeight ?? '');
  return current === next ? null : { totalHeight: next };
}
