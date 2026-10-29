// ---------------------------------------------------------------------------
// hydraulic-normalize.mjs — the pure spelling rules behind
// normalize-houzs-hydraulic.mjs. Owner 2026-10-29: "目前有了，但是帮我修改成
// proper text" — the HOUZS "hydraulic" special order reads as all-caps HYDRAULIC
// (and three ways across old lines); make every surface read "Hydraulic".
//
// NO SHEBANG line, ON PURPOSE: this is imported by a node:test file (see
// hydraulic-normalize.test.mjs) and by the runner script, and a `#!` in an
// imported .mjs is a load-time SyntaxError on Windows (CLAUDE.md: "Modules
// imported by tests live in backend/scripts/lib/ with no shebang").
//
// Everything here is PURE: value in, value out. No DB, no process, no I/O. The
// runner does the reads and writes and owns the verdict.
//
// A "BARE HYDRAULIC" token means exactly "hydraulic", any case, trimmed —
// nothing else. "Power Hydraulic" (2990's second variant) is deliberately NOT a
// bare token and is never rewritten; this only ever tidies the one bare word.
// ---------------------------------------------------------------------------

/** The proper spelling the owner asked for. */
export const HYD_TARGET = 'Hydraulic';

/** True when `s` is the bare hydraulic token in any case, e.g. "HYDRAULIC",
 *  "hydraulic", " Hydraulic ". "Power Hydraulic" and "hydraulics" are NOT. */
export function isBareHydraulic(s) {
  return typeof s === 'string' && s.trim().toLowerCase() === 'hydraulic';
}

/**
 * Normalize an array of special-order codes: every bare-hydraulic entry becomes
 * "Hydraulic", a second hydraulic entry is dropped (a line may carry both
 * "hydraulic" and "Hydraulic"), and EVERY OTHER ENTRY IS LEFT EXACTLY AS IS,
 * in its original position. Only the hydraulic token is ever touched.
 *
 * @returns {{ next: unknown, changed: boolean }}
 */
export function normalizeSpecialsArray(arr) {
  if (!Array.isArray(arr)) return { next: arr, changed: false };
  let changed = false;
  let hydrSeen = false;
  const out = [];
  for (const el of arr) {
    if (isBareHydraulic(el)) {
      if (hydrSeen) { changed = true; continue; } // collapse a duplicate hydraulic
      hydrSeen = true;
      if (el !== HYD_TARGET) changed = true;
      out.push(HYD_TARGET);
    } else {
      out.push(el);
    }
  }
  return { next: out, changed };
}

/**
 * Normalize the hydraulic token wherever a Sales Order line's variant bag
 * carries it: the canonical `specials` array, the legacy singular `special`,
 * the read-only `specialsRecorded`, the display snapshot `specialLabels`, and a
 * `specialChoices` key (renamed to the proper form, merging if both exist).
 * Every non-hydraulic value, and every other key, is preserved untouched.
 *
 * @returns {{ next: unknown, changed: boolean }}
 */
export function normalizeVariantsHydraulic(variants) {
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) {
    return { next: variants, changed: false };
  }
  const next = { ...variants };
  let changed = false;

  for (const key of ['specials', 'special', 'specialsRecorded', 'specialLabels']) {
    const val = next[key];
    if (Array.isArray(val)) {
      const r = normalizeSpecialsArray(val);
      if (r.changed) { next[key] = r.next; changed = true; }
    } else if (isBareHydraulic(val) && val !== HYD_TARGET) {
      // Legacy singular `special` stored as a plain string.
      next[key] = HYD_TARGET;
      changed = true;
    }
  }

  // specialChoices is an object keyed by add-on CODE — rename a hydraulic key to
  // the proper form so the choices stay attached. Hydraulic carries no option
  // groups, so this is usually a no-op, but handled for completeness.
  const sc = next.specialChoices;
  if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
    const hydKeys = Object.keys(sc).filter((k) => isBareHydraulic(k));
    const needsRename = hydKeys.some((k) => k !== HYD_TARGET);
    if (needsRename) {
      const merged = { ...sc };
      let acc = Array.isArray(merged[HYD_TARGET])
        ? [...merged[HYD_TARGET]]
        : (merged[HYD_TARGET] != null ? [merged[HYD_TARGET]] : []);
      for (const k of hydKeys) {
        if (k === HYD_TARGET) continue;
        const v = merged[k];
        delete merged[k];
        if (Array.isArray(v)) acc = acc.concat(v);
        else if (v != null) acc.push(v);
      }
      if (acc.length) merged[HYD_TARGET] = acc;
      next.specialChoices = merged;
      changed = true;
    }
  }

  return { next, changed };
}

/**
 * Fix the hydraulic token inside a stored description2 string with a WHOLE-WORD,
 * case-insensitive replace — "HYDRAULIC" / "hydraulic" -> "Hydraulic" — and
 * change nothing else. description2 is a derived buildVariantSummary output
 * whose only hydraulic-bearing input is the specials; the word boundary leaves a
 * glued token (none exist in prod) and any other text exactly as it was, so a
 * stale migrated summary keeps its shape apart from this one word.
 *
 * @returns {{ next: unknown, changed: boolean }}
 */
export function properHydraulicText(text) {
  if (typeof text !== 'string' || text === '') return { next: text, changed: false };
  const next = text.replace(/\bhydraulic\b/gi, HYD_TARGET);
  return { next, changed: next !== text };
}
