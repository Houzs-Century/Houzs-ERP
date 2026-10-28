/**
 * THE AXES A SOFA'S PIECES SHARE — and filling a piece that is missing them.
 *
 * A sofa is ONE line in the account book and several rows here, one per piece.
 * The colour and the leg are the build's, not the piece's: the book states them
 * once for the whole line. The owner said so on HC-SO-010120 (2026-09-09,
 * fill-sofa-sibling-fabric-2026-09-09.mjs): 「第一个 item 不是应该跟第三、第四个
 * item 全部一样的吗？」
 *
 * WHY THIS EXISTS (docs/bugs/0896). The corrections applier built the variants
 * of an ADDED piece from `p.row?.variants` — and an added piece has no row, so
 * it got `{seatHeight}` and nothing else. Measured on HC-SO-013346 / HC-PO-010086
 * 2026-09-14 (trace run 34844739166): the 8030-1A(RHF) it added carried no
 * fabric on either document while its 8030-1A(LHF) sibling carried CH141-11. The
 * factory sheet for that piece has no colour, and stock buckets by
 * (warehouse, item_code, variant_key), so the two halves of one sofa sit in
 * different buckets.
 *
 * THE RULE, the same one the sibling-fabric repair was approved on:
 *   - fill BLANKS only; a value a row already carries is never replaced;
 *   - the FABRIC fields move together, from one donor, and only when the build's
 *     rows carry exactly ONE distinct non-blank fabric code. Two fabrics is a
 *     real two-tone build, and it is left alone;
 *   - `legHeight` is filled only when the rows carry exactly one distinct value;
 *   - SPECIALS ARE NEVER COPIED — they carry money (a specials surcharge per
 *     line), and this applier moves no money.
 *
 * Zero dependencies, so `node --test` runs it on a bare checkout.
 */

/** The fabric identity. All five move together or a row is half-labelled:
 *  `fabricCode` is what the stock KEY reads, `colourLabel` is what the document
 *  PRINTS, and the ids are what the fabric library is looked up by. */
export const FABRIC_FIELDS = ['fabricId', 'colourId', 'fabricCode', 'colourLabel', 'fabricLabel'];

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * What a build's rows agree on, or null per axis where they do not.
 *
 * @param {Array<{variants?: Record<string, unknown> | null}>} rows one sofa's rows
 * @returns {{ fabric: Record<string,string> | null, legHeight: string | null, twoTone: boolean }}
 */
export function sharedBuildAxes(rows) {
  const withFabric = rows.filter((r) => str(r?.variants?.fabricCode) !== '');
  const codes = [...new Set(withFabric.map((r) => str(r.variants.fabricCode)))];
  let fabric = null;
  if (codes.length === 1) {
    const donor = withFabric[0].variants;
    fabric = {};
    for (const f of FABRIC_FIELDS) if (str(donor[f])) fabric[f] = str(donor[f]);
  }
  const legs = [...new Set(rows.map((r) => str(r?.variants?.legHeight)).filter(Boolean))];
  return { fabric, legHeight: legs.length === 1 ? legs[0] : null, twoTone: codes.length > 1 };
}

/**
 * Fill the blanks of one piece's variants from what its build shares.
 * Returns a NEW object and the list of keys it filled.
 *
 * @param {Record<string, unknown>} variants
 * @param {ReturnType<typeof sharedBuildAxes>} shared
 * @returns {{ variants: Record<string, unknown>, filled: string[] }}
 */
export function fillFromBuild(variants, shared) {
  const v = { ...(variants ?? {}) };
  const filled = [];
  if (shared.fabric && str(v.fabricCode) === '') {
    for (const [k, val] of Object.entries(shared.fabric)) {
      if (str(v[k]) === '') { v[k] = val; filled.push(k); }
    }
  }
  if (shared.legHeight && str(v.legHeight) === '') { v.legHeight = shared.legHeight; filled.push('legHeight'); }
  return { variants: v, filled };
}
