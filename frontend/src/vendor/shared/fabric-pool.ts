// ----------------------------------------------------------------------------
// fabric-pool — may this fabric colour be picked on a line of this Model?
//
// ONE rule with three readers: the save gate (scm/lib/allowed-options-check.ts),
// the desktop line editor's colour combobox (SoLineCard) and the phone's fabric
// sheet (mobile/MobileFabricPicker). The phone never asked, so it offered
// colours the save then refused; the desktop asked without the gate's trim and
// quote folding, so it could hide a colour the gate accepts (docs/bugs/0889).
// The browser copy is frontend/src/vendor/shared/fabric-pool.ts, held
// byte-identical by fabric-pool.canonical.test.ts.
//
// THE POOL HOLDS SERIES AND COLOURS (docs/bugs/0814). A fabric_library id means
// "this Model offers this cloth, every shade"; a colour id means that one shade.
// An empty or absent pool is no restriction. Both sides are folded — quote
// glyphs and surrounding space — because the pool is typed by people into the
// Modular drawer (a stray trailing space on "TARONI " sat in every sofa Model).
// ----------------------------------------------------------------------------

import { normaliseTypographicQuotes } from './mfg-pricing';

const foldForPool = (s: string): string => normaliseTypographicQuotes(s).trim();

/** True when `value` is in `pool`: exactly, or after folding both sides. */
export function inFabricPool(pool: readonly string[], value: string): boolean {
  if (pool.includes(value)) return true;
  const wanted = foldForPool(value);
  return pool.some((p) => foldForPool(p) === wanted);
}

/** May a colour be picked under a Model's fabric pool? `colourId` is the
 *  colour the line would carry, `fabricId` its series; pass `null` for one the
 *  caller does not know — an unknown series simply cannot widen the answer. */
export function fabricAllowedByPool(
  pool: readonly string[] | null | undefined,
  colourId: string | null,
  fabricId: string | null,
): boolean {
  if (!Array.isArray(pool) || pool.length === 0) return true;
  if (colourId && inFabricPool(pool, colourId)) return true;
  return fabricId !== null && fabricId !== '' && inFabricPool(pool, fabricId);
}
