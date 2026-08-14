// Does the account book ALREADY hold this ERP value under a different spelling?
//
// WHY THIS EXISTS. `/ensure-masters` opens a master AutoCount cannot find, under
// exactly the string it was given. So an ERP value the book already holds under
// another spelling does not fail — it silently OPENS A DUPLICATE, and for a
// stock location that splits one physical place's stock across two rows in a
// licensed book. Measured on 2026-08-14 the write-back would have opened twelve
// stock locations, and eleven of the twelve already existed:
// `SUNWAY SHOWROOM` is the book's `SUNWAY`, `C&C DISPLAY` is its `C&C DISP`,
// `KL SERVICE` is its `SERV KL`.
//
// WHAT THIS IS, AND WHAT IT IS NOT. It is a MATCHER whose output a human
// confirms — never an automatic binder. A wrong bind writes the wrong place or
// the wrong salesperson into a licensed account book, so every proposal carries
// the REASON it was proposed and nothing reaches the composer until a person has
// moved the pair into `data/autocount-so-writeback-mappings.json`.
//
// THE FOUR BUCKETS, and the line between the two that matter:
//
//   CONFIDENT — NORMALISATION ALONE explains the difference. The two values
//               reduce to the SAME multiset of canonical tokens: case,
//               punctuation, whitespace, word order, a `SOLO` suffix,
//               `DISP`/`DISPLAY`, `SERV`/`SERVICE`, a dropped `WAREHOUSE` or
//               `SHOWROOM`. Nothing is inferred. A tie between two candidates is
//               NOT confident — it is an ambiguity, and it is reported as one.
//   LIKELY    — the two share a DISTINCTIVE token (`KELANA`, `SUNWAY`, `SABAH`:
//               one that names at most two masters in the whole book) and score
//               above a floor. A human decides.
//   NONE      — nothing distinctive is shared. Opening a new master is correct.
//
// Bucket 1, "already mapped", is deliberately NOT computed here: it is
// `bookSpelling(v, MAP)` from the composer itself, and re-implementing the
// composer's own decision in the report that audits it is the exact drift this
// module's caller exists to avoid.
//
// NO SHEBANG — a test imports this (CLAUDE.md: Windows vitest inlines the
// source and a `#!` no longer at byte 0 is a SyntaxError at LOAD).

/** Uppercase, punctuation to spaces, whitespace collapsed. */
export function normalise(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Per-dimension vocabulary rules.
 *
 * `alias` folds two spellings of ONE word together. `drop` removes a word that
 * carries no identity in that dimension.
 *
 * WHAT IS DELIBERATELY NOT DROPPED. `DISPLAY` is not noise on a location — the
 * book holds `KL` and `KL DISP` as two SEPARATE stock locations, and dropping
 * the word would bind a showroom's display stock onto the main warehouse. Only
 * the words that never distinguish two masters are dropped, and the alias table
 * is what makes `KL DISPLAY` reach `KL DISP` without touching `KL`.
 */
export const DIMENSION_RULES = {
  location: {
    /* The book's location NAMES are abbreviated (`SERV KL`, `C&C DISP`); the
       ERP's are spelled out (`KL SERVICE`, `C&C DISPLAY`). */
    alias: { DISP: "DISPLAY", SERV: "SERVICE", WH: "WAREHOUSE", WHSE: "WAREHOUSE" },
    /* A code is the place; `SUNWAY WAREHOUSE` and `SUNWAY SHOWROOM` are the ERP
       naming the same physical site the book calls `SUNWAY`. */
    drop: ["WAREHOUSE", "SHOWROOM"],
  },
  venue: {
    /* Only spellings of ONE word. `&` is not here because `normalise` has
       already turned it into a space by the time an alias could see it. */
    alias: { CENTER: "CENTRE", CENTRES: "CENTRE", CTR: "CENTRE" },
    /* `SOLO` is the book's own suffix for a single-brand roadshow stand — the
       ERP does not carry it (`SUTERA MALL` -> `SUTERA MALL SOLO`). */
    drop: ["SOLO"],
  },
  /* A person's name has no noise words and no abbreviations we can trust:
     `SHELDON` and `SHELDON TAN` are the same rep only because a human said so.
     Word ORDER folds (`TAN KAR JIUN` / `KAR JIUN TAN`) and nothing else does. */
  agent: { alias: {}, drop: [] },
  /* A brand is a brand. `DUNLOP` and `DUNLOPILLO` are two DIFFERENT options in
     the live book (both appear in its own SO history), which is the whole
     argument against inferring anything here. */
  branding: { alias: {}, drop: [] },
};

function ruleFor(dimension) {
  const r = DIMENSION_RULES[dimension];
  if (!r) throw new Error(`unknown dimension "${dimension}" — expected one of ${Object.keys(DIMENSION_RULES).join(", ")}`);
  return r;
}

/** Canonical tokens: normalised, aliased, with the dimension's noise removed. */
export function canonicalTokens(value, dimension) {
  const { alias, drop } = ruleFor(dimension);
  const raw = normalise(value).split(" ").filter(Boolean);
  const aliased = raw.map((t) => alias[t] ?? t);
  const kept = aliased.filter((t) => !drop.includes(t));
  /* A value made ENTIRELY of noise (`WAREHOUSE`) still has to mean something,
     so the drop is skipped rather than producing an empty key that would match
     every other all-noise value. */
  return kept.length ? kept : aliased;
}

/** The order-insensitive identity of a value within one dimension. */
export function canonicalKey(value, dimension) {
  return canonicalTokens(value, dimension).slice().sort().join(" ");
}

/** Levenshtein distance, iterative two-row. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** 1 = identical, 0 = nothing in common. */
export function editSimilarity(a, b) {
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - editDistance(a, b) / longest : 1;
}

/**
 * A candidate master in the account book.
 *
 * `value` is what would be WRITTEN (the book's short code / option text);
 * `aliases` are other spellings of the SAME master — for a stock location, the
 * long description the maintenance screen shows (`SUNWAY` is
 * `DUNLOPILLO SUITE SUNWAY`), which is often the only place the ERP's own
 * wording appears.
 */
export function buildIndex(candidates, dimension) {
  const entries = candidates.map((c) => {
    const value = typeof c === "string" ? c : c.value;
    const aliases = typeof c === "string" ? [] : (c.aliases ?? []);
    const spellings = [value, ...aliases].filter((s) => String(s ?? "").trim() !== "");
    return {
      value,
      aliases,
      spellings,
      keys: new Set(spellings.map((s) => canonicalKey(s, dimension))),
      tokens: new Set(spellings.flatMap((s) => canonicalTokens(s, dimension))),
      tokenLists: spellings.map((s) => canonicalTokens(s, dimension)),
      normals: spellings.map((s) => normalise(s)),
    };
  });
  /* Document frequency over the CANDIDATES, not over the ERP side: how many
     masters a word names is what makes it distinctive. `AEON` names 25 venues
     and settles nothing; `SOUTHKEY` names one. */
  const df = new Map();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  return { dimension, entries, df, size: entries.length };
}

/* A token naming at most two masters is DISTINCTIVE. Two, not one, because the
   book routinely holds a place and its display bay under the same word
   (`SABAH` / `SABAH BEDDING DISPLAY`), and a rule that called that generic
   would refuse the very matches this exists to find. */
const DISTINCTIVE_DF = 2;

/** Inverse document frequency, floored so an unseen token still weighs. */
function idf(df, size, token) {
  return Math.log((size + 1) / ((df.get(token) ?? 0) + 1)) + 1;
}

/**
 * One side writes as two words what the other writes as one.
 *
 * `MID VALLEY` is the book's `MIDVALLEY`; `Pei Fen` is its `PEIFEN`; `Weng Gi`
 * is its `WENGGI`. Only a concatenation the OTHER side actually holds is added,
 * so this can never invent a token — and it is added for SCORING only, never to
 * the canonical key, because one-word-versus-two is a spelling variant a person
 * should confirm (`MID VALLEY` could be either MIDVALLEY master) and not a
 * normalisation that makes a pair confident on its own.
 */
function withGlue(tokenList, otherTokens) {
  if (tokenList.length < 2) return new Set(tokenList);
  /* The glued form REPLACES its parts — `MID` and `VALLEY` carry no information
     the book's `MIDVALLEY` does not. Leaving them in would make the ERP value
     look two-thirds unexplained and put it below the coverage floor, which is
     exactly what happened to `MID VALLEY` (254 orders) on the first run. */
  const whole = tokenList.join("");
  if (otherTokens.has(whole)) return new Set([whole]);
  const out = [];
  for (let i = 0; i < tokenList.length; i += 1) {
    const glued = i + 1 < tokenList.length ? tokenList[i] + tokenList[i + 1] : null;
    if (glued && otherTokens.has(glued)) {
      out.push(glued);
      i += 1;
    } else {
      out.push(tokenList[i]);
    }
  }
  return new Set(out);
}

function overlapScore(index, erpTokenList, entry) {
  const erpTokens = withGlue(erpTokenList, entry.tokens);
  const entryTokens = new Set(entry.tokens);
  const erpSet = new Set(erpTokenList);
  for (const list of entry.tokenLists) for (const t of withGlue(list, erpSet)) entryTokens.add(t);
  const shared = [];
  const union = new Set([...erpTokens, ...entryTokens]);
  let sharedWeight = 0;
  let unionWeight = 0;
  for (const t of union) {
    const w = idf(index.df, index.size, t);
    unionWeight += w;
    if (erpTokens.has(t) && entryTokens.has(t)) {
      sharedWeight += w;
      shared.push(t);
    }
  }
  /* COVERAGE is measured against the ERP value alone, and it is the number that
     decides. Jaccard punishes a candidate for words the ERP value does not have
     (`JOHOR`, `SOLO`), which is exactly the book's naming habit — so it would
     bury `KSL CITY MALL` -> `KSL CITY MALL JOHOR SOLO` under its own suffix. */
  let erpWeight = 0;
  for (const t of erpTokens) erpWeight += idf(index.df, index.size, t);
  return {
    shared,
    score: unionWeight ? sharedWeight / unionWeight : 0,
    coverage: erpWeight ? sharedWeight / erpWeight : 0,
  };
}

/** The transformations that had to fire for these two to be the same value. */
function explainSameness(erpValue, spelling, dimension) {
  const { alias, drop } = ruleFor(dimension);
  const a = normalise(erpValue);
  const b = normalise(spelling);
  const notes = [];
  if (a === b) {
    if (String(erpValue) !== String(spelling)) notes.push("case / punctuation / spacing only");
    return notes.length ? notes : ["identical"];
  }
  if (a.replace(/ /g, "") === b.replace(/ /g, "")) notes.push("spacing only");
  const aTok = a.split(" ").filter(Boolean);
  const bTok = b.split(" ").filter(Boolean);
  for (const [from, to] of Object.entries(alias)) {
    if ((aTok.includes(from) && bTok.includes(to)) || (bTok.includes(from) && aTok.includes(to))) {
      notes.push(`${from} = ${to}`);
    }
  }
  for (const word of drop) {
    if (aTok.includes(word) !== bTok.includes(word)) notes.push(`dropped "${word}"`);
  }
  const aCanon = canonicalTokens(erpValue, dimension).slice().sort().join(" ");
  const bCanon = canonicalTokens(spelling, dimension).slice().sort().join(" ");
  if (aCanon === bCanon
    && canonicalTokens(erpValue, dimension).join(" ") !== canonicalTokens(spelling, dimension).join(" ")) {
    notes.push("word order");
  }
  return notes.length ? notes : ["normalisation"];
}

/**
 * Bucket one ERP value against the book's own vocabulary.
 *
 * Returns `{ bucket, target, reason, alternatives }`. `bucket` is one of
 * `confident` | `ambiguous` | `likely` | `none`; `ambiguous` is a confident-shaped
 * match that hit TWO masters and therefore needs the human that `confident`
 * was allowed to skip.
 */
export function matchValue(erpValue, index, { likelyFloor = 0.2 } = {}) {
  const { dimension } = index;
  const key = canonicalKey(erpValue, dimension);
  const erpTokenList = canonicalTokens(erpValue, dimension);
  const erpTokens = new Set(erpTokenList);
  const erpNormal = normalise(erpValue);

  const exact = index.entries.filter((e) => e.keys.has(key));
  if (exact.length === 1) {
    const e = exact[0];
    const via = e.spellings.find((s) => canonicalKey(s, dimension) === key);
    const notes = explainSameness(erpValue, via, dimension);
    const through = via === e.value ? "" : ` (matched through the book's own name for it, "${via}")`;
    return {
      bucket: "confident",
      target: e.value,
      score: 1,
      reason: `normalisation alone: ${notes.join(", ")}${through}`,
      alternatives: [],
    };
  }
  if (exact.length > 1) {
    return {
      bucket: "ambiguous",
      target: null,
      score: 1,
      reason: `normalises identically to ${exact.length} different masters — a person has to pick: ${exact.map((e) => e.value).join(", ")}`,
      alternatives: exact.map((e) => ({ value: e.value, score: 1, reason: "same canonical form" })),
    };
  }

  const scored = index.entries
    .map((e) => {
      const { shared, score, coverage } = overlapScore(index, erpTokenList, e);
      const sim = Math.max(...e.normals.map((n) => editSimilarity(erpNormal, n)));
      const distinctive = shared.filter((t) => (index.df.get(t) ?? 0) <= DISTINCTIVE_DF);
      return { entry: e, shared, distinctive, coverage, score: 0.65 * score + 0.35 * sim, sim };
    })
    /* THREE WAYS TO EARN A PROPOSAL, and sharing a lot of common words is not
       one of them. `AEON BIG PUCHONG` shares `AEON` (22 masters) and `BIG` (4)
       with a dozen book venues and is none of them; what it does NOT share is
       the word that says which one. So a candidate needs either a shared
       DISTINCTIVE word, or EVERY word of the ERP value (the book's habit of
       appending `JOHOR SOLO`), or to be a near-typo of the whole string. */
    .filter((c) => (
      /* A near-typo is judged on the WHOLE string and answers coverage to
         nobody: `Pei Fen` and the book's `PEIFEN` share no token at all. */
      c.sim >= 0.85
      || ((c.distinctive.length > 0 || c.coverage > 0.999) && c.coverage >= 0.4)
    ))
    .filter((c) => c.score >= likelyFloor)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      bucket: "none",
      target: null,
      score: 0,
      reason: "shares no distinctive word with any master in the book",
      alternatives: [],
    };
  }
  const best = scored[0];
  const why = best.distinctive.length
    ? `shares the distinctive word${best.distinctive.length > 1 ? "s" : ""} ${best.distinctive.map((t) => `"${t}" (names ${index.df.get(t)} master${index.df.get(t) === 1 ? "" : "s"})`).join(", ")}`
    : best.coverage > 0.999
      ? `the book's name contains every word of the ERP's, and adds ${best.entry.tokens.size - erpTokens.size} of its own`
      : `spelling is ${(best.sim * 100).toFixed(0)}% identical`;
  return {
    bucket: "likely",
    target: best.entry.value,
    score: best.score,
    reason: `${why}; score ${best.score.toFixed(2)}`,
    alternatives: scored.slice(1, 3).map((c) => ({
      value: c.entry.value,
      score: c.score,
      reason: c.distinctive.length ? `shares ${c.distinctive.join(", ")}` : `${(c.sim * 100).toFixed(0)}% spelling`,
    })),
  };
}

/**
 * The worked examples this matcher was built against, asserted BEFORE it is
 * allowed to report anything.
 *
 * CLAUDE.md: "a checker that cannot match reports a clean run". A matcher whose
 * rules have rotted would bucket everything as `none`, which reads exactly like
 * a book that holds nothing — the most expensive wrong answer available here,
 * because acting on it opens duplicates. So the caller runs this first and
 * refuses to print a verdict if it fails.
 */
export function selfTest() {
  const locations = buildIndex(
    [
      { value: "SUNWAY", aliases: ["DUNLOPILLO SUITE SUNWAY"] },
      { value: "KL", aliases: ["BALAKONG WAREHOUSE"] },
      { value: "KL DISP", aliases: ["BALAKONG BEDDING DISPLAY"] },
      { value: "SERV KL", aliases: ["BALAKONG RETURNED TO SUPPLIER"] },
      { value: "SBH", aliases: ["SABAH"] },
    ],
    "location",
  );
  const venues = buildIndex(
    ["AEON BIG KEPONG SOLO", "AEON BIG SUBANG", "AEON BIG WANGSA MAJU SOLO", "SUTERA MALL SOLO"],
    "venue",
  );
  const cases = [
    ["SUNWAY SHOWROOM", locations, "confident", "SUNWAY"],
    ["KL DISPLAY", locations, "confident", "KL DISP"],
    ["KL SERVICE", locations, "confident", "SERV KL"],
    ["SBH WAREHOUSE", locations, "confident", "SBH"],
    ["CHINA WAREHOUSE", locations, "none", null],
    ["SUTERA MALL", venues, "confident", "SUTERA MALL SOLO"],
    ["AEON BIG PUCHONG", venues, "none", null],
  ];
  const failures = [];
  for (const [value, index, bucket, target] of cases) {
    const got = matchValue(value, index);
    if (got.bucket !== bucket || got.target !== target) {
      failures.push(`${value}: expected ${bucket}/${target}, got ${got.bucket}/${got.target}`);
    }
  }
  return failures;
}
