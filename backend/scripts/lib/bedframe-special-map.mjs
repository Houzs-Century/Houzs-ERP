// The ONE bedframe special-order mapper: an AutoCount special phrase -> the set
// of real scm.special_addons codes it means. Extracted verbatim from
// fix-so-specials.mjs, which is where it was written.
//
// WHY IT MOVED HERE. refresh-so-variants.mjs and refresh-po-variants.mjs both
// rebuilt this function at runtime by slicing fix-so-specials.mjs's SOURCE TEXT
// between two markers and eval'ing it. parse-bedframe.mjs was reconstructed the
// same way until a new comment line in front of the end marker swallowed its
// `return` and the refresh scripts broke in production - BUG-HISTORY.md
// 2026-08-10. An audit that has to agree with the writers is a third consumer,
// so the function becomes a module instead of gaining a third eval.
//
// Order matters: the HB+divan combos must be tested before plain "HB fully
// cover", and "straight" is independent of the cover options.
export function mapSpecial(raw) {
  const s = String(raw || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return [];
  const out = new Set();
  const hasHB = /\bhb\b|headboard/.test(s);
  const hasDivan = /\bdivan\b|\bdiv\b/.test(s);
  const cover = /cover/.test(s);
  const straight = /straight|staright|\bhb s\b|\bhb s$/.test(s); // incl. common typos/abbrev
  const topOnly = /\btop\b/.test(s);
  if (cover) {
    if (hasHB) out.add("HB Fully Cover");
    if (hasDivan) out.add(topOnly ? "Divan Top Fully Cover" : "Divan Full Cover");
    if (!hasHB && !hasDivan) out.add("HB Fully Cover"); // bare "fully cover" on a bedframe = HB
  }
  if (straight) out.add("HB Straight");
  if (/no side panel|without panel/.test(s)) out.add("No Side Panel");
  // "HB and Divan" / "HB flip on wall" with no other keyword = the HB treatment
  if (!out.size && hasHB && (hasDivan || /flip|wall|fabric|behind/.test(s))) out.add("HB Fully Cover");
  if (!out.size && hasHB && hasDivan) out.add("Divan Full Cover");
  if (/headboard only/.test(s)) out.add("Headboard Only");
  if (/nylon/.test(s)) out.add("Nylon Fabric");
  if (/left drawer/.test(s)) out.add("Left Drawer");
  if (/right drawer/.test(s)) out.add("Right Drawer");
  if (/front drawer/.test(s)) out.add("Front Drawer");
  if (/1 piece divan|one piece divan/.test(s)) out.add("1 Piece Divan");
  if (/divan curve/.test(s)) out.add("Divan Curve");
  if (/divan a11/.test(s)) out.add("Divan A11");
  return [...out];
}
