/* ---------------------------------------------------------------------------
   vocabulary.mjs — ONE registry of the words this system has agreed on.

   THE PROBLEM, in the owner's words (2026-08-18): 「我跟你讲 Processing Date,
   你却去找成 Process Date」. The same thing carries several spellings, so every
   conversation starts by re-agreeing which word we mean, and every audit script
   that guesses wrong queries a column that no longer exists.

   THE PATTERN ALREADY EXISTED — THREE TIMES, HAND-BUILT EACH TIME. Processing
   Date got `so-processing-date.mjs` plus its own 80-line directory-walking test;
   transfer got `transfer-vocabulary.ts` plus another; the catalogue series got a
   third. Each new concept therefore cost somebody remembering to write a fourth
   test, and the concept that nobody remembers is exactly the one that drifts.
   That is the root, and it is what this file removes: a concept is now an ENTRY,
   and the guard, the glossary and the doc rule all read the entry.

   WHAT AN ENTRY OWES:
     concept     what a human calls it, and what the glossary prints
     canonical   the ONE spelling code may use
     retired     spellings that must not appear in CODE. Comments are allowed —
                 a rename is a story worth telling, and `so-processing-date.mjs`
                 quotes the owner naming the column verbatim
     declaredIn  where the canonical value actually lives, so the glossary can
                 point a reader at the source rather than restating it
     allow       files entitled to spell a retired name in code: the declaration
                 itself, and the migrations that performed the rename

   WHY `retired` IS NOT "every wrong spelling anyone might type": a guard that
   fires on a word nobody uses teaches people to ignore it. Every entry below was
   verified against this tree on 2026-08-18 — `proceeded_at` appears 52 times and
   NOT ONCE in code, which is the state this registry is meant to hold, not a
   violation of it.
   --------------------------------------------------------------------------- */

/** Paths whose matches are always historical, whatever the concept: a migration
 *  records the rename it performed, and a test names the thing it forbids. */
export const ALWAYS_HISTORICAL = [
  "src/db/migrations-pg/",
  "src/db/migrations/",
];

/* A TEST that pins a rename has to name the retired side — that is the whole
   assertion. Excluding tests is not a loophole in the guard, it is the guard
   declining to fail the only files whose job is to hold the line. A test never
   reaches production, so a dropped column named here costs a red test, not a
   42703 in front of the owner. */
export const isTestPath = (relPath) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(String(relPath));

export const VOCABULARY = [
  {
    concept: "Processing Date",
    canonical: "processing_date",
    alsoCanonical: ["processingDate"],
    /* `proceeded_at` is NOT on this list, and the first draft of this file had it
       there. Checked against production 2026-08-18 before shipping: the COLUMN
       STILL EXISTS on scm.mfg_sales_orders, and the diagnostic probes read it on
       purpose to see whether the split finished. Listing it produced 175
       findings, essentially all of them false — the exact failure this file's
       header warns about, committed by its own author. `internal_expected_dd`
       is different in kind: information_schema has no such column any more, so
       any code naming it is querying nothing. */
    retired: ["internal_expected_dd"],
    declaredIn: "backend/scripts/lib/so-processing-date.mjs",
    allow: [
      "scripts/lib/so-processing-date.mjs",
      "scripts/lib/vocabulary.mjs",
      "scripts/lib/drift-catalogue.mjs",
      "src/scm/shared/so-processing-date.ts",
    ],
    note:
      "The date the order is prepared on. It had SEVEN names; migration 0286 retired the " +
      "column `internal_expected_dd`, which no longer exists — code naming it queries nothing " +
      "and postgres fails the WHOLE statement with 42703. The camelCase PAYLOAD key " +
      "`internalExpectedDd` is a DIFFERENT thing and is NOT retired: the status route still " +
      "accepts it from old clients on purpose. `proceeded_at` is a SECOND STORAGE " +
      "the application no longer reads, but the column is still there and diagnostics may read " +
      "it. It is NOT a production date.",
  },
  {
    concept: "Transfer (document conversion)",
    canonical: "Transfer to / Transfer from",
    alsoCanonical: [],
    retired: [],
    declaredIn: "backend/src/scm/shared/transfer-vocabulary.ts",
    allow: [],
    note:
      "One rule generates every transfer label. \"Transfer to\" names the DOCUMENT a " +
      "document converts into — it never means a warehouse.",
  },
  {
    concept: "Branding",
    canonical: "branding",
    alsoCanonical: [],
    retired: [],
    declaredIn: "backend/src/scm/shared/so-branding-label.ts",
    allow: [],
    note:
      "The label rule: SOFA is the company's house brand (ZANOTTI / 2990s Sofa) and does not " +
      "read the line; MATTRESS is the SKU's branding, falling back to the category noun. " +
      "The VALUES are maintained by the owner in PMS -> Project Maintenance -> BRANDS " +
      "(`project_brands`, per company) and checked by `audit:branding-vocabulary`.",
  },
  {
    concept: "Money (minor unit)",
    canonical: "_sen",
    alsoCanonical: [],
    retired: ["_centi"],
    declaredIn: "backend/src/scm/lib/money.ts",
    allow: ["scripts/lib/vocabulary.mjs", "scripts/lib/drift-catalogue.mjs"],
    note:
      "Money is stored as an INTEGER count of sen (the Malaysian subunit AutoCount " +
      "speaks; 100 sen = RM 1) and displayed as RM at the edge. The column/field " +
      "suffix is `_sen` / `Sen`; `_centi` was the drift (291 columns across 70 tables, " +
      "renamed by migration 0305 on 2026-08-18). Storing decimals is what money.ts " +
      "exists to prevent — the retirement is of the NAME, not the integer type. Bare " +
      "`centi` local helpers in one-off scripts are not `_centi` and are not retired.",
  },
];

/** A retired spelling may appear here without being a defect. */
export function isHistoricalPath(relPath) {
  const p = String(relPath).replace(/\\/g, "/");
  return ALWAYS_HISTORICAL.some((h) => p.includes(h));
}

/**
 * Strip comments so a match in prose is not reported as a match in code.
 *
 * Character-for-character length-preserving, so a caller can still report a line
 * number. Deliberately simple: it does not parse strings, so a retired name
 * inside a string literal still counts — which is correct, because that is
 * exactly how one reaches a query.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const s = String(source);
  while (i < s.length) {
    if (s[i] === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end === -1 ? s.length : end + 2;
      for (let k = i; k < stop; k += 1) out += s[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (s[i] === "-" && s[i + 1] === "-" && (i === 0 || s[i - 1] === "\n" || s[i - 1] === " ")) {
      while (i < s.length && s[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/** Every retired spelling found in `source`, as {term, concept, line}. */
export function findRetired(source, relPath) {
  if (isHistoricalPath(relPath) || isTestPath(relPath)) return [];
  const code = stripComments(source);
  const lines = code.split("\n");
  const hits = [];
  for (const entry of VOCABULARY) {
    if (entry.allow.some((a) => String(relPath).replace(/\\/g, "/").endsWith(a))) continue;
    for (const term of entry.retired) {
      const rx = new RegExp(`\\b${term}\\b`);
      lines.forEach((text, idx) => {
        if (rx.test(text)) hits.push({ term, concept: entry.concept, line: idx + 1, canonical: entry.canonical });
      });
    }
  }
  return hits;
}
