// ----------------------------------------------------------------------------
// so-variant-cascade — the ONE master-follower rule for line variants.
//
// A Sales Order's FIRST line of a category is the MASTER. Every later line of
// that category is a FOLLOWER: it wears the master's fabric / seat size / leg
// height unless the operator has deliberately moved it since.
//
// Owner ruling 2026-08-21 — **the master's LATEST change always wins.** Asked
// what should happen to a follower he had already corrected by hand once line 1
// moves again, he answered: 「第一个沙发再改就拉回去」. That REPLACES the old
// `overriddenKeys` veto, under which a follower touched once was sticky
// forever and line 1 could never correct it again.
//
// PROVENANCE, because the first version of this comment got it wrong: the rule
// was written into the implementing agent's brief before the owner had been
// asked, and this header then reported it as a ruling he had already given. He
// gave it on 2026-08-21, after the fact. Do not attribute a rule to him here
// that he has not said in his own words — quote him, as above.
//
// "Latest" is why this module takes a SNAPSHOT of the previous masters and
// returns the next one. Without it the only two options are both wrong:
//   - cascade every key on every render  -> a follower can never be edited at
//     all, because the master stomps it back on the very next tick;
//   - cascade nothing already set        -> the owner's ruling never fires.
// Diffing against the snapshot separates the two: a key the MASTER just moved
// is forced onto the followers, a key it did not is only used to FILL a blank.
//
// Before this module the same rule existed as four hand-written copies with
// three different behaviours (SalesOrderNew, ConsignmentOrderNew, MobileNewSO,
// and DeliveryOrderNewV2 — which had no cascade at all). That is the bug class
// CLAUDE.md calls out: desktop and mobile are one product, with ONE shared
// logic layer.
//
// The first version of this header claimed all four had been converted. Two
// had: SalesOrderNew and MobileNewSO. ConsignmentOrderNew was converted on
// 2026-08-21, one merge later, still carrying all three drifts. **DeliveryOrder
// NewV2 is STILL not on this module** — it seeds a line's variants at pick time
// and never follows afterwards. Whether a delivery-order line should follow
// line 1 at all is an owner decision, not a defect to fix quietly, so it is
// named here rather than assumed.
// ----------------------------------------------------------------------------

/** Fabric IDENTITY keys — everything a colour pick writes together. They move
 *  as a set, and they are the only keys scoped to ONE physical sofa rather
 *  than to the category (see `differentSofa` below). */
export const FABRIC_IDENTITY_KEYS: readonly string[] = [
  'fabricCode', 'colourId', 'fabricId', 'fabricLabel', 'colourLabel', 'colourHex',
];

/** Keys that must NEVER travel from a master to a follower.
 *
 *  `remark` is per-line by nature: a sofa's compartments share a remark
 *  through the buildKey-scoped sync in the form, never category-wide across
 *  two unrelated sofas (owner via Loo 2026-06-09).
 *
 *  `buildKey` is IDENTITY, not a variant — it is written by the SO create path
 *  per physical build and nothing on the frontend mints one. Copying the
 *  master's onto a follower forges a compartment: the follower then counts as
 *  a module of the master's sofa for the free-gift trigger
 *  (backend/src/scm/shared/free-gift.ts) and prints inside its module row on
 *  the PDF (vendor/shared/so-line-display.ts). Both desktop and mobile copied
 *  it before this module existed.
 *
 *  `extraAddonNote` / `extraAddonAmountRM` / `specials` / `specialLabels` /
 *  `specialChoices` — the per-line SPECIAL ORDER payload (Custom-other free
 *  text and ticked add-on codes). Same shape as `remark`: a note the operator
 *  wrote on ONE line about ONE build, never a category-wide axis to align.
 *  Owner reported 2026-09-11 against HC-SO-007678: on the mobile SO he added
 *  a customize-drawer note to HILTON (a bedframe line) and saved; after
 *  reload FENRIR — a different bedframe line further down the same order —
 *  carried the identical text and would not let him remove it. Traced: this
 *  list only excluded `remark` and `buildKey`, so `cascadeMasterVariants`
 *  FORCED the master's extraAddonNote (and its four siblings) onto every
 *  follower of the same category, exactly like the "latest wins" rule for a
 *  sofa's fabric — appropriate for a fabric shared across compartments of
 *  one physical sofa, wrong for a per-line note. Adding the five keys here
 *  closes both DESKTOP and MOBILE (both surfaces import this module). */
export const NEVER_INHERITED_KEYS: readonly string[] = [
  'remark', 'buildKey',
  'extraAddonNote', 'extraAddonAmountRM',
  'specials', 'specialLabels', 'specialChoices',
];

/** The categories a master's variants may travel across AT ALL — owner ruling
 *  2026-09-09: 「主行改一次，全部跟着改 … 这个只限于 sofa item」.
 *
 *  A SOFA is one physical thing assembled from several lines: its modules share
 *  a fabric, a leg height and a seat depth by construction, so changing the
 *  master once and having the rest follow is the whole point.
 *
 *  A BEDFRAME is not. Three bedframes on one order are three beds, routinely
 *  different sizes with different add-ons, and the cascade's first rule is that
 *  the master's latest change FORCES the follower — so a rep who removed a
 *  drawer from beds 2 and 3 got it written back the next time she touched bed 1,
 *  and had to remove it once per master edit. Reported 2026-09-09 against
 *  HC-SO-012312: 「刚刚我改了两次 about 第二三不需要 drawer，结果还是有，remove
 *  三次才没有」.
 *
 *  BOTH surfaces import this. Mobile used to declare `["sofa","bedframe"]` and
 *  desktop passed `null` meaning EVERY category (a mattress line's specials
 *  included) — one rule with two different answers, which is the shape
 *  `audit:duplicated-decisions` exists to catch. */
export const CASCADE_CATEGORIES: ReadonlySet<string> = new Set(['sofa']);

/** One line, reduced to what the cascade decides on. `category` is '' for a
 *  line with no SKU picked yet — it neither masters nor follows. */
export type CascadeLine = {
  category: string;
  variants: Record<string, unknown>;
};

/** category -> that category's master variants at the last cascade. */
export type MasterVariantSnapshot = Readonly<Record<string, Record<string, unknown>>>;

export type CascadeResult = {
  /** One entry per input line, in order. The SAME object reference as the
   *  input's `variants` when that line must not change, so a caller can bail
   *  out of `setState` with `===` and never loop. */
  variants: Record<string, unknown>[];
  /** Feed back in as `previousMasters` on the next run. */
  masters: MasterVariantSnapshot;
};

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const buildKeyOf = (v: Record<string, unknown>): string =>
  typeof v.buildKey === 'string' ? v.buildKey : '';

/**
 * Per-category master variants, as the cascade sees them: the FIRST line of
 * each category, whether or not it has any variants yet.
 *
 * NOT the same question as `seedableMasterVariants` below, and conflating the
 * two is how a follower could be driven by line 3 while line 1 held the pen.
 */
export function masterVariantsByCategory(
  lines: readonly CascadeLine[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const l of lines) {
    if (!l.category) continue;
    if (l.category in out) continue;
    out[l.category] = l.variants;
  }
  return out;
}

/**
 * Per-category variants for the PICK-TIME seed: the first line of each
 * category that actually carries something. A brand-new line has nothing to
 * copy from an empty master, and the live cascade fills it in a tick later
 * anyway — this only removes the flash of an empty configurator.
 */
export function seedableMasterVariants(
  lines: readonly CascadeLine[],
  /* REQUIRED, and null means "every category" — the same parameter
     `cascadeMasterVariants` takes, because the seed and the live cascade must
     answer the SAME question. It is not optional: a call site that said nothing
     would silently keep the old every-category behaviour, which is the
     `optional-param-noop` class (docs/bugs/0098-*). Gating the SEED matters on
     its own — without it a new bedframe line still arrives pre-filled from bed
     1 and only stops being RE-forced afterwards, which fixes the second removal
     and not the first. The seed IS the "自动 duplicate" the rep reported. */
  categories: ReadonlySet<string> | null,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const l of lines) {
    if (!l.category) continue;
    if (categories && !categories.has(l.category)) continue;
    if (l.category in out) continue;
    if (Object.keys(l.variants).length > 0) out[l.category] = l.variants;
  }
  return out;
}

/**
 * The variants a NEW follower line starts life with, given its category's
 * seedable master. Strips the never-inherited keys — a fresh line must not
 * inherit another sofa's build identity or its remark.
 */
export function seedFollowerVariants(
  masterVariants: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!masterVariants) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(masterVariants)) {
    if (NEVER_INHERITED_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The variants ONE follower should now carry.
 *
 * Three outcomes per key, and the order is the whole rule:
 *  1. the master moved this key since `previousMaster` -> FORCE it (owner's
 *     latest-change-wins ruling; a hand-typed follower value loses here);
 *  2. otherwise the follower's own value is blank        -> FILL it (inherit);
 *  3. otherwise                                          -> LEAVE it, so an
 *     edit made after the master's last change stands until the master moves
 *     again.
 *
 * Returns the follower's own object unchanged when nothing applies.
 */
export function followerVariants(
  master: Record<string, unknown>,
  follower: Record<string, unknown>,
  previousMaster: Record<string, unknown> | undefined,
): Record<string, unknown> {
  /* Fabric COLOUR is scoped to one physical sofa. When the master and this
     follower each carry a buildKey and they DIFFER, they are two different
     sofas: the category master's fabric identity must not cross into this one.
     Every other axis (seat size, leg height, gap...) stays category-wide. */
  const masterBk = buildKeyOf(master);
  const followerBk = buildKeyOf(follower);
  const differentSofa = masterBk !== '' && followerBk !== '' && masterBk !== followerBk;

  const patch: Record<string, unknown> = {};
  let changed = false;
  for (const [k, masterVal] of Object.entries(master)) {
    if (NEVER_INHERITED_KEYS.includes(k)) continue;
    if (differentSofa && FABRIC_IDENTITY_KEYS.includes(k)) continue;
    if (isBlank(masterVal)) continue;
    const masterMoved = previousMaster !== undefined && previousMaster[k] !== masterVal;
    if (!masterMoved && !isBlank(follower[k])) continue;
    if (follower[k] === masterVal) continue;
    patch[k] = masterVal;
    changed = true;
  }
  return changed ? { ...follower, ...patch } : follower;
}

/**
 * Run the cascade over a whole document's lines.
 *
 * `cascadeCategories` is REQUIRED and may be null, because its absence
 * changes the answer and CLAUDE.md forbids hiding that in a default: desktop
 * passes null (every category cascades, including a mattress line's specials),
 * mobile passes the sofa/bedframe set its variant panels cover. Two surfaces
 * disagreeing is a decision somebody has to make in the open, not a default.
 *
 * `previousMasters` is the snapshot this function returned last time; pass
 * `{}` on the first run, which makes every key a FILL rather than a FORCE.
 */
export function cascadeMasterVariants(
  lines: readonly CascadeLine[],
  previousMasters: MasterVariantSnapshot,
  cascadeCategories: ReadonlySet<string> | null,
): CascadeResult {
  const masterIdx: Record<string, number> = {};
  lines.forEach((l, idx) => {
    if (!l.category) return;
    if (l.category in masterIdx) return;
    masterIdx[l.category] = idx;
  });

  const variants = lines.map((l, idx) => {
    if (!l.category) return l.variants;
    if (cascadeCategories !== null && !cascadeCategories.has(l.category)) return l.variants;
    if (masterIdx[l.category] === idx) return l.variants;
    const master = lines[masterIdx[l.category]!]!.variants;
    return followerVariants(master, l.variants, previousMasters[l.category]);
  });

  const masters: Record<string, Record<string, unknown>> = {};
  for (const [cat, idx] of Object.entries(masterIdx)) {
    masters[cat] = lines[idx]!.variants;
  }
  return { variants, masters };
}
