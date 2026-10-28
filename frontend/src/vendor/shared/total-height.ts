// Bedframe Total Height — Divan + Leg + Gap, and what is written when all
// three are blank.
//
// ONE RULE, SIXTEEN HOMES. Before this module, `parseInches` was defined
// sixteen times across `frontend/src` and imported zero times, and the
// arithmetic beside it decided the same business question sixteen times over.
// Nobody was careless: the rule is authored on the CLIENT, because there is no
// Total Height input on any form — the value is derived from three pickers and
// sent with the line — so every new screen that grew a bedframe variant editor
// had to write it again, and each one wrote it from whatever screen was open
// at the time.
//
// The copies had ALREADY DRIFTED into three different answers to the second
// half of the question — "what is written when divan/leg/gap are blank?":
//
//   GROUP A (14 purchasing screens, byte-identical)
//     variants.totalHeight = (d === 0 && lg === 0 && g === 0) ? '' : `${...}"`
//     ALWAYS assigns, so blanking the parts CLEARS the stored total.
//
//   GROUP B (SoLineCard) computed the same '' and then threw it away: the
//     writer effect began `if (!computedTotalHeight) return;`. Blanking
//     divan/leg/gap on a Sales Order line that already carried a Total Height
//     LEFT THE OLD VALUE in the draft, and that stale value was saved.
//
//   GROUP C (MobileNewSO.buildVariants) wrote `if (th > 0)`, which both leaves
//     the same stale value behind AND omits the key entirely on a fresh line —
//     a third rule, differing from A whenever the parts sum to <= 0.
//
// GROUP A'S ANSWER IS THE ONE KEPT, and it is kept because clearing is what
// keeps the stored value honest: a line reading `T.Heights 21"` with no divan,
// no leg and no gap is a number the paperwork cannot justify. The '' is safe
// downstream, verified against each consumer rather than assumed:
//
//   · mfg-pricing.ts `lookupSelling`/`lookupCost` both open `if (!pool ||
//     !value) return 0;` — an empty height contributes NO surcharge instead of
//     missing a pool lookup.
//   · allowed-options-check.ts short-circuits on `if (v.totalHeight && ...)`,
//     so '' SKIPS the gate rather than tripping `variant_not_allowed`.
//   · variant-key.ts `computeVariantKey` runs every axis through
//     `norm()` and then `if (val) parts.push(...)` — '' and an ABSENT key
//     produce byte-identical stock-bucket keys, which is what makes Group C's
//     "omit the key" and this module's "write ''" interchangeable.
//   · variant-summary.ts `buildVariantSummary` guards `if (total)`, so the
//     `T.Heights` segment simply does not render.
//   · so-amendment-line-diff.ts `hasAxis`/`unrenderedVariantAxes` both test
//     `bag[k] != null && String(bag[k]).trim() !== ''`, so '' reads as absent
//     there too.
//
// WHY THE VALUE IS WORTH A SHARED MODULE AT ALL. It is money and it is a
// refusal. `mfg-pricing.ts` prices a selling surcharge off `totalHeight`, and
// `allowed-options-check.ts` REFUSES the line with `variant_not_allowed` /
// field `total_height` when it is not in the Model's pool — a refusal naming a
// field the operator has no box to correct. That is the same shape as the
// curly-inch bug: a value the client alone authors, validated by a server that
// assumes the client got it right.
//
// THIS FILE IS MIRRORED, byte for byte, to
// `frontend/src/vendor/shared/total-height.ts`, and
// `total-height.canonical.test.ts` beside the copy is the referee. The mirror
// exists because the frontend cannot import from `backend/src` — which is the
// very reason sixteen private copies were born, so the drift test is the part
// that must not be skipped. Keep this module free of imports and of anything
// server-only so the two files can stay identical.

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
