// ---------------------------------------------------------------------------
// maintenance-quote-normalise — fold typographic inch/foot marks in a
// maintenance config's option pools onto their ASCII equivalents.
//
// WHY THIS IS A SEPARATE, REFUSABLE STEP. The PRICING consequence of the mixed
// spellings is already closed in code: mfg-pricing.ts matches exactly first and
// only then quote-insensitively, so a `12“` line finds the `12"` tier without
// anything being rewritten. What is left is the pool ITSELF reading
// inconsistently — `17“` and `18"` side by side in Products · Maintenance — and
// the duplicate rows that mixed spellings let in.
//
// A DUPLICATE IS A REFUSAL, NOT A MERGE. Supplier 07204b99's live pool carries
// 19 inches twice, curly at RM120 and straight at RM40. Normalising both to
// `19"` would leave two identical keys whose lookup answer depends on array
// order — the ambiguity made permanent and invisible instead of removed. Which
// price is right is a business fact nobody has written down, so the pool is
// reported and left exactly as it is.
//
// PURE, so the decision is testable without a database.
// NO SHEBANG: a test imports this (see #2062 — an inlined `#!` past byte 0 is a
// hard SyntaxError on Windows that reports as a failed file with zero tests).
// ---------------------------------------------------------------------------

const QUOTE_MAP = {
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', 'ʺ': '"',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", 'ʹ': "'",
};
const QUOTE_RE = /[‘’‚‛“”„‟′″ʹʺ]/g;

/** Fold typographic quote/prime characters onto ASCII. Mirrors
 *  normaliseTypographicQuotes in scm/shared/mfg-pricing.ts — same characters,
 *  same narrow scope (no trim, no case folding). */
export const normaliseQuotes = (s) => String(s).replace(QUOTE_RE, (c) => QUOTE_MAP[c] ?? c);

/** Pools whose entries are `{ value, priceSen, … }` objects. */
export const PRICED_POOLS = ['divanHeights', 'legHeights', 'totalHeights', 'specials', 'sofaLegHeights', 'sofaSpecials'];
/** Pools whose entries are bare strings or `{ value, active }` (maintenance-pools.ts). */
export const STRING_POOLS = ['gaps', 'sofaSizes', 'bedframeSizes', 'mattressSizes', 'sofaCompartments', 'brandings'];

const entryValue = (e) => (e && typeof e === 'object' ? e.value : e);
const withValue = (e, v) => (e && typeof e === 'object' ? { ...e, value: v } : v);

/**
 * PURE. Plan the rewrite of one config object.
 *
 * @returns {{ config: object, changes: Array<{pool,from,to}>, collisions: Array<{pool,value,detail}> }}
 *          `config` is the rewritten copy — identical to the input when nothing
 *          changed. A pool with a collision is left UNTOUCHED in it.
 */
export function planQuoteNormalise(config) {
  const out = { ...config };
  const changes = [];
  const collisions = [];

  for (const pool of [...PRICED_POOLS, ...STRING_POOLS]) {
    const entries = config?.[pool];
    if (!Array.isArray(entries)) continue;

    /* Group by the NORMALISED value first, so a collision is detected before
       anything is rewritten. Two entries that normalise together are a conflict
       only when they would price differently — the same tier written twice at
       the same price is a harmless duplicate this step is happy to collapse
       onto one spelling (it still writes both rows; only their labels align). */
    const byNorm = new Map();
    for (const e of entries) {
      const raw = entryValue(e);
      if (typeof raw !== 'string') continue;
      const key = normaliseQuotes(raw);
      const arr = byNorm.get(key) ?? [];
      arr.push(e);
      byNorm.set(key, arr);
    }

    let poolBlocked = false;
    for (const [key, group] of byNorm) {
      if (group.length < 2) continue;
      const prices = new Set(group.map((e) => (e && typeof e === 'object' ? e.priceSen ?? e.costSen ?? null : null)));
      if (prices.size > 1) {
        poolBlocked = true;
        collisions.push({
          pool,
          value: key,
          detail: group
            .map((e) => `${JSON.stringify(entryValue(e))} = ${(e && typeof e === 'object' ? e.priceSen : null)}`)
            .join(' vs '),
        });
      }
    }
    if (poolBlocked) continue; // leave the whole pool exactly as it is

    const rewritten = entries.map((e) => {
      const raw = entryValue(e);
      if (typeof raw !== 'string') return e;
      const next = normaliseQuotes(raw);
      if (next === raw) return e;
      changes.push({ pool, from: raw, to: next });
      return withValue(e, next);
    });
    if (rewritten.some((e, i) => e !== entries[i])) out[pool] = rewritten;
  }

  return { config: out, changes, collisions };
}
