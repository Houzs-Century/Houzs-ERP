// ----------------------------------------------------------------------------
// so-variant-cascade — the ONE master-follower rule for line variants.
//
// A Sales Order's FIRST line of a category is the MASTER. Every later line of
// that category is a FOLLOWER: it wears the master's fabric / seat size / leg
// height unless the operator has deliberately moved it since.
//
// Owner ruling 2026-08-21 — **the master's LATEST change always wins.** He was
// told what it costs (a follower the operator had already typed by hand gets
// overwritten) and chose it anyway: one sofa set is one set, and re-typing the
// fabric on line 1 must reach lines 2..n. That REPLACES the old
// `overriddenKeys` veto, under which a follower touched once was sticky
// forever and line 1 could never correct it again.
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
 *  it before this module existed. */
export const NEVER_INHERITED_KEYS: readonly string[] = ['remark', 'buildKey'];

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
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const l of lines) {
    if (!l.category) continue;
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
