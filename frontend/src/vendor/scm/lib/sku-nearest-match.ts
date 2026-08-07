// sku-nearest-match — resolve an OCR'd product code to the CLOSEST entry in the
// live SKU picker, instead of leaving the line unpicked.
//
// Owner's standing rule (2026-08-05 handoff §2.3): "OCR should resolve to the
// nearest item from the picker." Until now `scan-prefill` looked the model's
// suggested code up in the catalog with a single case-insensitive exact match —
// so `BOOQIT 1A (LHF)` against a catalog holding `BOOQIT-1A(LHF)` resolved to
// NOTHING and the operator re-picked a SKU the reader had, in substance,
// already found. Every near miss cost a manual pick.
//
// THE RULE THIS FILE ENCODES: guess when the answer is unambiguous, and refuse
// when it is not. A wrong SKU on a sales order is worse than an empty one — it
// orders the wrong furniture — so every tier below either produces exactly one
// candidate or produces none. There is no "best effort, pick the first".
//
// Four tiers, cheapest first:
//   1. exact       — case-insensitive equality. Today's behaviour, unchanged.
//   2. normalised  — compare with every non-alphanumeric stripped, so spacing,
//                    dashes and brackets stop mattering: "BOOQIT 1A (LHF)" ==
//                    "BOOQIT-1A(LHF)". Ambiguous only if two catalog codes
//                    normalise identically, which would be a catalog problem.
//   3. prefix      — the candidate is a prefix of exactly ONE catalog code (the
//                    reader dropped a suffix). Two or more: refuse.
//   4. distance    — Levenshtein over the normalised forms, within a length-
//                    scaled budget, AND strictly better than the runner-up.
//                    A tie is a refusal: two SKUs equally close means the slip
//                    does not say which.
//
// Returns the match tier alongside the code so the caller can tell the operator
// HOW a line was filled. A fuzzy fill that looks identical to an exact one is
// the failure mode this whole file is trying to avoid.

export type NearestSkuCandidate = { code: string; name: string; category: string };

export type SkuMatchSource = 'exact' | 'normalised' | 'prefix' | 'distance';

export type NearestSkuResult<T extends NearestSkuCandidate> =
  | { sku: T; source: SkuMatchSource }
  | { sku: null; source: null };

const NO_MATCH = { sku: null, source: null } as const;

/** Uppercase, and drop everything that is not a letter or a digit. */
export function normaliseSkuCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* Levenshtein with a ceiling — it returns early once every cell in a row is
   past `max`, so a long code compared against a whole catalog stays cheap. The
   caller only ever cares whether the distance is within budget. */
function boundedDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/* How wrong a code may be before we stop guessing. One edit for a short code,
   two for anything catalog-sized — enough for a dropped character, a doubled
   one, or a single misread digit, and not enough to turn one product into a
   different one. Tuned against the real catalog shape (BOOQIT-1A(LHF),
   2990 AKKA-FIRM MATTRESS (183X190X31CM), CODY-(K)) where distinct SKUs differ
   by at least a whole token. */
function distanceBudget(len: number): number {
  if (len <= 4) return 0;
  if (len <= 8) return 1;
  return 2;
}

/**
 * Resolve `candidate` to exactly one catalog SKU, or to nothing.
 *
 * Never returns an ambiguous match: if two catalog entries are equally good at
 * the tier that would have matched, the result is `{ sku: null }` and the line
 * stays for the operator to pick.
 */
export function findNearestSku<T extends NearestSkuCandidate>(
  candidate: string,
  skus: readonly T[],
): NearestSkuResult<T> {
  const raw = (candidate ?? '').trim();
  if (!raw || skus.length === 0) return NO_MATCH;

  // 1. Exact, case-insensitive.
  const upper = raw.toUpperCase();
  const exact = skus.filter((s) => s.code.toUpperCase() === upper);
  if (exact.length === 1) return { sku: exact[0], source: 'exact' };
  // Two catalog rows with the same code is a catalog fault, not something to
  // resolve by picking one of them.
  if (exact.length > 1) return NO_MATCH;

  const target = normaliseSkuCode(raw);
  if (!target) return NO_MATCH;
  const normalised = skus.map((s) => ({ s, n: normaliseSkuCode(s.code) }));

  // 2. Same code once punctuation and spacing stop mattering.
  const normHits = normalised.filter((x) => x.n === target);
  if (normHits.length === 1) return { sku: normHits[0].s, source: 'normalised' };
  if (normHits.length > 1) return NO_MATCH;

  /* 3. The reader dropped a suffix. Only when exactly one catalog code starts
        with what it read — "BOOQIT1A" against both BOOQIT-1A(LHF) and
        BOOQIT-1A(RHF) names two different physical products and must refuse.
        Guarded on length so a two-character read cannot claim a SKU. */
  if (target.length >= 4) {
    const prefixHits = normalised.filter((x) => x.n.startsWith(target));
    if (prefixHits.length === 1) return { sku: prefixHits[0].s, source: 'prefix' };
    if (prefixHits.length > 1) return NO_MATCH;
  }

  // 4. Nearest by edit distance, and only when it is strictly the nearest.
  const budget = distanceBudget(target.length);
  if (budget === 0) return NO_MATCH;
  let best: { s: T; d: number } | null = null;
  let runnerUp = Infinity;
  for (const { s, n } of normalised) {
    const d = boundedDistance(target, n, budget);
    if (d > budget) continue;
    if (!best || d < best.d) {
      if (best) runnerUp = best.d;
      best = { s, d };
    } else if (d < runnerUp) {
      runnerUp = d;
    }
  }
  // A tie means the slip does not say which product it is. Refuse.
  if (!best || runnerUp === best.d) return NO_MATCH;
  return { sku: best.s, source: 'distance' };
}
