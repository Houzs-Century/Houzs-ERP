// ---------------------------------------------------------------------------
// Is a group of ERP item codes ONE sofa decomposed into compartments?
//
// WHY THIS QUESTION HAS A MODULE. docs/bugs/0672 measured that 296 sales-order
// and 98 purchase-order AutoCount `linked_ac_dtlkey` values are carried by more
// than one ERP row, and could not say whether that is by design. The reason it
// could not is worth keeping: its discriminator asked "do the sharing rows name
// DIFFERENT products?" and answered 295 of 296 — which is worthless, because a
// sofa's compartments DO name different products (MODEL-1S, MODEL-CNR,
// MODEL-2A(LHF)). A check that answers a different question reads exactly like
// a clean one.
//
// The question that actually separates the two cases: is every code in the
// group `{one model}-{a known compartment suffix}`, with no suffix repeated?
// If yes, this is the shape src/services/autocount-sofa-collapse.ts is built
// around — the ERP models a sofa as one line per compartment while AutoCount
// holds one line per sofa, so the compartments legitimately share the book's
// DtlKey. If no, the key is claimed by rows that are not one sofa, and every
// lane that builds a Map keyed by DtlKey keeps ONE of them.
//
// WHY THE SUFFIX LIST IS DUPLICATED HERE. `SOFA_COMPARTMENTS` is declared in
// src/services/autocount-sofa-collapse.ts, which is TypeScript inside the
// Worker bundle; backend/scripts/*.mjs is plain Node and cannot import it.
// tests/sofaCompartmentSuffixes.test.ts pins the two copies EQUAL — a second
// copy of a rule that can drift is the failure shape CLAUDE.md names, so the
// test is what makes the duplicate safe, not this comment.
//
// NO SHEBANG, deliberately: a test imports this file, and on Windows vitest
// inlines the source before running it, so a `#!` that is no longer at byte 0
// is a SyntaxError that reports as a corrupt file with no line number.
// ---------------------------------------------------------------------------

/** Upper-cased, because every caller compares an upper-cased item code.
 *  Same membership as SOFA_COMPARTMENTS in autocount-sofa-collapse.ts. */
export const SOFA_COMPARTMENTS = new Set([
  '1S', '2S', '3S',
  '1NA', '2NA',
  'CNR', 'CONSOLE', 'STOOL',
  '1A(LHF)', '1A(RHF)', '2A(LHF)', '2A(RHF)',
  '1B(LHF)', '1B(RHF)', '2B(LHF)', '2B(RHF)',
  'L(LHF)', 'L(RHF)',
  '1S(R)', '1S(P)',
  '1A(R)(LHF)', '1A(R)(RHF)', '1A(P)(LHF)', '1A(P)(RHF)',
  '1ABOX(LHF)', '1ABOX(RHF)',
]);

const norm = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * @param {Array<string|null|undefined>} codes the item codes sharing one key
 * @returns {{ok: true, model: string} | {ok: false, why: string}}
 *
 * `ok` means: ONE model, and every remainder a known compartment suffix.
 * Anything else is REFUSED with a reason rather than being called a collision —
 * the caller decides what to do with a group it cannot explain, and "I cannot
 * explain this group" is a different statement from "this is wrong".
 *
 * A REPEATED COMPARTMENT IS NOT A DEFECT, and this function said it was until
 * it was run. Probe 34143079454 flagged 10 of 296 sales-order groups and 4 of
 * 98 purchase-order groups, and every single one failed on the repeat rule
 * alone: `9058-1NA, 9058-1NA, 9058-CNR`, `8030-1A(RHF), 8030-1A(RHF)`,
 * `R819-1S(R), R819-1S(R)`. A four-seater is 1A(LHF) + 1NA + 1NA + 1A(RHF) —
 * two armless middles is an ordinary build, and two identical recliners is a
 * book line of quantity two. Refusing them was the same mistake as the one this
 * module exists to correct: a rule that answers a different question. Repeats
 * are reported so a caller can still see them, never refused.
 *
 * A group of ONE is not this function's business — a lone row does not share a
 * key with anything — and is refused rather than silently passed, so a caller
 * that forgets to filter cannot read a clean answer out of it.
 */
export function decomposeGroup(codes) {
  if (!Array.isArray(codes) || codes.length < 2) {
    return { ok: false, why: 'a group of fewer than two codes does not share a key' };
  }
  const models = new Set();
  const suffixes = [];
  for (const raw of codes) {
    const code = norm(raw);
    const cut = code.lastIndexOf('-');
    if (cut <= 0) return { ok: false, why: `"${code}" carries no compartment suffix` };
    models.add(code.slice(0, cut));
    suffixes.push(code.slice(cut + 1));
  }
  const unknown = [...new Set(suffixes.filter((s) => !SOFA_COMPARTMENTS.has(s)))];
  if (unknown.length) return { ok: false, why: `not a compartment suffix: ${unknown.join(', ')}` };
  if (models.size !== 1) return { ok: false, why: `${models.size} different models share the key` };
  const seen = new Set();
  const repeated = [...new Set(suffixes.filter((x) => (seen.has(x) ? true : (seen.add(x), false))))];
  return { ok: true, model: [...models][0], repeated };
}
