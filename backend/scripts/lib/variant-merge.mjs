// The ONE place that says which keys of the `variants` jsonb the refresh sweeps
// are allowed to change, and the ONE way they are allowed to write them.
//
// WHY THIS EXISTS. `refresh-so-variants.mjs` and `refresh-po-variants.mjs` both
// rebuilt the whole `variants` object from a fixed list of keys and then wrote
// the WHOLE column (`SET variants = <fresh object>`). That is a delete of every
// key the fresh object does not mention. `variants` has at least six writers -
// the AutoCount importers, both refresh sweeps, the POS configurator, the SO/PO
// line editors and the specials backfill - so "rebuild the object" was never a
// correct write here. Recorded in BUG-HISTORY.md under "The variant refresh
// scripts REPLACE the whole variants jsonb"; the named casualty is
// `variants.special`, the HOOKKA-compatible singular the picker reads beside
// the plural (`specialsList(variants.specials ?? variants.special)`,
// frontend/src/vendor/scm/components/SpecialOrders.tsx:91).
//
// THE SHAPE, and why a thirteenth key is safe without anyone remembering this.
//   1. A refresh computes a PATCH, never a replacement object. The patch may
//      only carry keys from OWNED_VARIANT_KEYS; `assertOnlyOwnedKeys` throws
//      otherwise, so a key that creeps into the builder is a crash and not a
//      silent widening of what the sweep owns.
//   2. The write is `variants = COALESCE(variants,'{}'::jsonb) || <patch>` in
//      the DATABASE. `jsonb || jsonb` between two objects overwrites exactly the
//      keys on the right and leaves every other key of the left untouched. A key
//      nobody here has heard of survives BY CONSTRUCTION - there is no list to
//      keep in step with reality, because unknown keys are never enumerated.
//      It is also atomic: no read-modify-write window in which another writer's
//      key can be read, forgotten and overwritten.
//
// THE TWO TRAPS THIS CODE IS WRITTEN AROUND (docs/jsonb-double-encoding-coe.md).
//   - `jsonb || jsonb` MERGES only when BOTH sides are objects. Object || non-
//     object CONCATENATES INTO AN ARRAY, silently. So every statement carries
//     `jsonb_typeof(COALESCE(variants,'{}'::jsonb)) = 'object'` in its WHERE and
//     the caller is told how many rows that skipped, rather than corrupting a
//     row whose column is already the wrong shape (#1938's repair owns those).
//   - Never bind `JSON.stringify(value)` to a jsonb parameter. postgres.js runs
//     with `prepare: false`, learns the parameter type from the server, and then
//     applies its OWN JSON.stringify for OID 3802 - encoding an already-encoded
//     string a second time and landing a jsonb STRING scalar. The patch is
//     passed through `db.json(patch)`, which types the parameter and hands the
//     driver the VALUE.
//
// Counts come from RETURNING. A command tag answers "did a row change", never
// "does the row now hold what I meant" - the lesson the colour sweep paid for.

/* The keys a variant REFRESH owns: everything parse-bedframe derives from the
   AutoCount Desc2, and nothing else.

   `specials` is deliberately NOT here even though the old code wrote it. It
   belongs to `backfill-specials-into-variants.mjs`, which is the money-guarded
   pipeline: a picked add-on's selling surcharge is folded into the authoritative
   unit price (mfg-pricing.ts:396-415), so stamping a PRICED code onto a migrated
   line reprices a historical document on its next edit - which the owner ruled
   out on 2026-08-11. That backfill refuses priced codes and proves the money
   columns did not move by summing them inside its transaction; the refresh
   sweeps had no such guard and resolved codes against every BEDFRAME add-on
   whatever its price. They also derive a NARROWER set than the phrase map
   (backend/scripts/data/special-order-phrase-map.json) does, so re-stamping
   would have shrunk lines the backfill had already filled. One owner per key. */
export const OWNED_VARIANT_KEYS = Object.freeze([
  "fabricId",
  "colourId",
  "fabricCode",
  "colourLabel",
  "fabricLabel",
  "gap",
  "divanHeight",
  "legHeight",
  "totalHeight",
  "size",
]);

/* The keys the SOFA backfill owns. A sofa has no divan, leg or gap, so those
   must never appear in a sofa patch — its dimensional axis is the seat.

   `seatHeight` is here and in no other owned list because until now NOTHING
   swept sofa at all: `refresh-po-variants.mjs` and `refresh-so-variants.mjs`
   are both hard-filtered to `item_group = 'bedframe'`, which is why the fabric
   library being tidied repeatedly never moved a single sofa line. */
export const OWNED_SOFA_KEYS = Object.freeze([
  "fabricId",
  "colourId",
  "fabricCode",
  "colourLabel",
  "fabricLabel",
  "seatHeight",
]);

/* The subset a non-bedframe (SP) special-size line owns: its dimensions only.
   No fabric, no gap, no divan, no leg - a custom-size MATTRESS has none of
   those and must not have them nulled. */
export const OWNED_SIZE_ONLY_KEYS = Object.freeze(["size"]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Throw unless every key of `patch` is one this writer declared it owns. */
export function assertOnlyOwnedKeys(patch, owned = OWNED_VARIANT_KEYS, who = "variant patch") {
  if (!isPlainObject(patch)) throw new Error(`${who} must be a plain object, got ${Array.isArray(patch) ? "array" : typeof patch}`);
  const stray = Object.keys(patch).filter((k) => !owned.includes(k));
  if (stray.length)
    throw new Error(
      `${who} carries keys this writer does not own: ${stray.join(", ")}. ` +
      `Add them to OWNED_VARIANT_KEYS in backend/scripts/lib/variant-merge.mjs ` +
      `only if this sweep is genuinely their owner - every key listed there is a ` +
      `key the sweep OVERWRITES on every run.`);
  return patch;
}

/** The bedframe patch: exactly the keys a Desc2 re-parse is entitled to move. */
export function buildBedframeVariantPatch(bf, fc) {
  const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
  return assertOnlyOwnedKeys({
    fabricId: fc ? fc.fabric_id : null,
    colourId: fc ? fc.colour_id : null,
    fabricCode: fc ? fc.colour_id : null,
    colourLabel: fc ? fc.label : null,
    fabricLabel: fc ? fc.fabric_id : null,
    gap: bf.gap != null ? bf.gap + '"' : null,
    divanHeight: bf.divan != null ? bf.divan + '"' : null,
    legHeight: bf.leg != null ? bf.leg + '"' : null,
    totalHeight: tot ? tot + '"' : null,
    size: bf.size || null,
  }, OWNED_VARIANT_KEYS, "bedframe variant patch");
}

/**
 * The SOFA patch, and it FILLS ONLY — a key already carrying a value is left
 * exactly as it is.
 *
 * The bedframe sweep overwrites the keys it owns, which is right for a sweep
 * that re-derives the whole line every run. This is a BACKFILL of documents
 * staff have been editing for months, so an operator's own correction outranks
 * a re-parse of the same old text: the owner's instruction was 补齐, fill in
 * the blanks, not restate them. `existing` is the row's current `variants`.
 *
 * @returns a patch carrying only the blank axes, or null when nothing is blank
 */
export function buildSofaVariantPatch(sofa, fc, existing) {
  const had = existing && isPlainObject(existing) ? existing : {};
  const filled = (...keys) => keys.some((k) => {
    const v = had[k];
    return v !== undefined && v !== null && String(v).trim() !== "";
  });
  const patch = {};
  if (fc && !filled("fabricCode", "colourId", "colorCode", "colourCode", "fabricColor")) {
    patch.fabricId = fc.fabric_id;
    patch.colourId = fc.colour_id;
    patch.fabricCode = fc.colour_id;
    patch.colourLabel = fc.label;
    patch.fabricLabel = fc.fabric_id;
  }
  if (sofa.size && !filled("seatHeight", "depth")) patch.seatHeight = `${sofa.size}"`;
  if (!Object.keys(patch).length) return null;
  return assertOnlyOwnedKeys(patch, OWNED_SOFA_KEYS, "sofa variant patch");
}

/** The (SP) special-size patch: the dimensions and nothing else. */
export function buildSizeOnlyVariantPatch(bf) {
  return assertOnlyOwnedKeys({ size: bf.size || null }, OWNED_SIZE_ONLY_KEYS, "size-only variant patch");
}

/* The two line tables a refresh sweep writes. Enumerated rather than
   interpolated: a table name is never taken from data here. */
export const MERGE_TABLES = Object.freeze(["mfg_sales_order_items", "purchase_order_items"]);

/**
 * Merge `patch` into one row's `variants`, and optionally restamp the three
 * geometry columns that mirror it.
 *
 * @param db  a postgres.js sql / transaction handle (needs `.json`)
 * @param opts.table     one of MERGE_TABLES
 * @param opts.id        the line id
 * @param opts.patch     keys from OWNED_VARIANT_KEYS only
 * @param opts.geometry  {gap, divan, leg} in inches, or null to leave the
 *                       columns alone
 * @returns 1 when the row was merged, 0 when it was skipped because its
 *          `variants` is not a jsonb object (the caller must report that).
 */
export async function mergeVariantPatch(db, { table, id, patch, geometry = null, owned = OWNED_VARIANT_KEYS }) {
  if (!MERGE_TABLES.includes(table)) throw new Error(`mergeVariantPatch: unknown table ${table}`);
  assertOnlyOwnedKeys(patch, owned, `${table} variant patch`);
  const json = db.json(patch);
  const round = (v) => (v != null ? Math.round(v) : null);

  let rows;
  if (table === "mfg_sales_order_items") {
    rows = geometry
      ? await db`UPDATE scm.mfg_sales_order_items SET
                   variants = COALESCE(variants, '{}'::jsonb) || ${json},
                   gap_inches = ${round(geometry.gap)},
                   divan_height_inches = ${round(geometry.divan)},
                   leg_height_inches = ${round(geometry.leg)}
                 WHERE id = ${id}
                   AND jsonb_typeof(COALESCE(variants, '{}'::jsonb)) = 'object'
                 RETURNING id`
      : await db`UPDATE scm.mfg_sales_order_items SET
                   variants = COALESCE(variants, '{}'::jsonb) || ${json}
                 WHERE id = ${id}
                   AND jsonb_typeof(COALESCE(variants, '{}'::jsonb)) = 'object'
                 RETURNING id`;
  } else {
    rows = geometry
      ? await db`UPDATE scm.purchase_order_items SET
                   variants = COALESCE(variants, '{}'::jsonb) || ${json},
                   gap_inches = ${round(geometry.gap)},
                   divan_height_inches = ${round(geometry.divan)},
                   leg_height_inches = ${round(geometry.leg)}
                 WHERE id = ${id}
                   AND jsonb_typeof(COALESCE(variants, '{}'::jsonb)) = 'object'
                 RETURNING id`
      : await db`UPDATE scm.purchase_order_items SET
                   variants = COALESCE(variants, '{}'::jsonb) || ${json}
                 WHERE id = ${id}
                   AND jsonb_typeof(COALESCE(variants, '{}'::jsonb)) = 'object'
                 RETURNING id`;
  }
  return rows.length;
}

/**
 * The same write for a REVIEWED HAND PATCH (apply-variant-patch.mjs), which is
 * the one caller that legitimately carries keys no sweep owns.
 *
 * WHY THE OWNED-KEY ASSERTION IS NOT APPLIED HERE, and why that is not a hole.
 * `assertOnlyOwnedKeys` exists to stop a SWEEP quietly widening the set of keys
 * it overwrites on every future run against every future row. A hand patch is
 * the opposite kind of write: a human or AI read one line's Desc2 that the regex
 * parser could not, and the patch's key list IS the reviewed artifact, submitted
 * per batch through a workflow input. Constraining it to OWNED_VARIANT_KEYS
 * would make the escape hatch unable to set `seatHeight` or the picker's
 * `special` - the very fields it exists for.
 *
 * WHAT IS NOT RELAXED. Everything the COE mandates still applies, because none
 * of it depends on knowing the key names:
 *   - the merge happens in the DATABASE (`variants || patch`), not in JavaScript.
 *     The old code did `{...row.variants, ...p.variants}` between a SELECT and an
 *     UPDATE: correct on key preservation, but a read-modify-write window in
 *     which a concurrent writer's key is read, forgotten and overwritten.
 *   - `jsonb_typeof(...) = 'object'` guards it. Object || non-object CONCATENATES
 *     INTO AN ARRAY. Worse for the old JS merge: spreading an ARRAY variants
 *     column yields `{"0":..,"1":..}` and writes that back as a perfectly valid
 *     object, converting a detectably damaged row into an undetectably damaged
 *     one. A row this guard refuses belongs to #1938's shape repair.
 *   - the patch is bound with `db.json(patch)`, never a pre-stringified value.
 *   - the caller counts RETURNING, not the command tag.
 *
 * Geometry uses COALESCE, unlike the sweep: a hand patch that says nothing about
 * `gap` must LEAVE gap alone, where a Desc2 re-parse is entitled to restamp all
 * three from the text it just read.
 *
 * @returns 1 when merged, 0 when the row was skipped (missing, or `variants` is
 *          not a jsonb object). The caller must report a 0.
 */
export async function mergeReviewedVariantPatch(db, { table, id, patch, geometry = null }) {
  if (!MERGE_TABLES.includes(table)) throw new Error(`mergeReviewedVariantPatch: unknown table ${table}`);
  if (!isPlainObject(patch)) throw new Error(`reviewed variant patch must be a plain object, got ${Array.isArray(patch) ? "array" : typeof patch}`);
  const json = db.json(patch);
  const g = geometry || {};
  const gap = g.gap ?? null, divan = g.divan ?? null, leg = g.leg ?? null;

  const rows = table === "mfg_sales_order_items"
    ? await db`UPDATE scm.mfg_sales_order_items SET
                 variants = COALESCE(variants, '{}'::jsonb) || ${json},
                 gap_inches = COALESCE(${gap}, gap_inches),
                 divan_height_inches = COALESCE(${divan}, divan_height_inches),
                 leg_height_inches = COALESCE(${leg}, leg_height_inches)
               WHERE id = ${id}
                 AND jsonb_typeof(COALESCE(variants, '{}'::jsonb)) = 'object'
               RETURNING id`
    : await db`UPDATE scm.purchase_order_items SET
                 variants = COALESCE(variants, '{}'::jsonb) || ${json},
                 gap_inches = COALESCE(${gap}, gap_inches),
                 divan_height_inches = COALESCE(${divan}, divan_height_inches),
                 leg_height_inches = COALESCE(${leg}, leg_height_inches)
               WHERE id = ${id}
                 AND jsonb_typeof(COALESCE(variants, '{}'::jsonb)) = 'object'
               RETURNING id`;
  return rows.length;
}
