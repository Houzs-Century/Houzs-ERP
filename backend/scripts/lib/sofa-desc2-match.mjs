/**
 * Which lines of ONE document belong to ONE sofa build.
 *
 * A document can hold several sofa builds, and the ERP explodes each build into
 * one row per compartment. `desc2Match` — a prefix of the AutoCount Desc2 the
 * build was ordered with — is the only thing that tells those builds apart, so
 * this matcher is what keeps a correction for build A off build B's rows.
 *
 * ── WHY IT IS NOT A PLAIN `includes` ────────────────────────────────────────
 * It was, and on 2026-09-02 that silently dropped 7 owner-approved builds
 * (prod run 33657082664), five of them on orders already in production or ready
 * to ship. The cause, read off prod on 2026-09-04 and not guessed:
 *
 *   sofa-compartment-corrections-2026-08.json carries  "…8030 \\nbottom wrap…"
 *   scm.mfg_sales_order_items.description2 carries     "…8030 <LF>bottom wrap…"
 *
 * The data file's line breaks are the two CHARACTERS backslash-n, because the
 * Desc2 was lifted from an already-escaped dump and JSON-escaped a second time.
 * A real newline never equals a written `\n`, so the needle could not be found
 * in a haystack that was otherwise identical.
 *
 * ── WHAT IT MAY AND MAY NOT DO ──────────────────────────────────────────────
 * Every normalisation below was bought by a difference OBSERVED between the
 * file and prod. None of them removes a space, drops punctuation, or matches
 * approximately — a build differs from its neighbour by exactly those
 * characters. Measured on the live corrections file: `2+C+2NA+C TABLE(28'INCH)`
 * and `C TABLE(W)+2(28'INCH)` share a document (HC-SO-013164), and this matcher
 * must keep on refusing to see either in the other.
 *
 * And the widening carries its own brake. Loosening a needle is only safe while
 * it stays UNAMBIGUOUS, so a match that spans more than one distinct Desc2 on
 * the document is not narrowed down and not chosen between — it is reported as
 * `ambiguous` and the caller must refuse the build. Measured against prod
 * 2026-09-04: all 16 documents that match exactly today match exactly ONE
 * distinct Desc2, so the guard cannot regress a build that already applies.
 *
 * Zero dependencies — `node --test scripts/lib/sofa-desc2-match.test.mjs` runs
 * it on a bare checkout, and the working-agreement workflow does exactly that.
 */

/* Line breaks and tabs as they are literally WRITTEN in the corrections file:
   a backslash followed by n / r / t. String.raw so the backslash survives into
   the pattern. */
const WRITTEN_ESCAPE = new RegExp(String.raw`\\r\\n|\\[nrt]`, "g");

/* Typographic swaps, as \u escapes rather than the characters themselves: this
   file is read far more often than it is run, and a curly quote inside a
   character class is invisible to the next reader.
     SMART_QUOTE  left/right single quote, modifier apostrophe, acute accent
     SMART_DQUOTE left/right double quote, double prime  (30" written two ways)
     DASH         U+2010..U+2015 and the minus sign      (MODENZA 05- DARK) */
const SMART_QUOTE = /[‘’ʼ´]/g;
const SMART_DQUOTE = /[“”″]/g;
const DASH = /[‐-―−]/g;

/**
 * The comparison form of a Desc2. Case, line breaks, run-together spacing and
 * the typographic characters a re-keyed slip swaps in are all noise; every
 * other character is signal and survives untouched.
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseDesc2(value) {
  return String(value ?? "")
    .replace(WRITTEN_ESCAPE, " ")
    .replace(SMART_QUOTE, "'")
    .replace(SMART_DQUOTE, '"')
    .replace(DASH, "-")
    /* Any run of whitespace — a real newline, a no-break space, a doubled
       space — becomes one space. JS \s already covers U+00A0, so it needs no
       rule of its own. */
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Does one Desc2 carry this needle — exactly, or once both are normalised?
 * @param {unknown} haystack
 * @param {string} needle
 * @returns {boolean}
 */
export function desc2Contains(haystack, needle) {
  if (String(haystack ?? "").includes(needle)) return true;
  const wanted = normaliseDesc2(needle);
  return wanted !== "" && normaliseDesc2(haystack).includes(wanted);
}

/**
 * @typedef {object} BuildSelection
 * @property {"all"|"exact"|"normalised"|"none"|"ambiguous"} verdict
 *   `all` — the correction carries no desc2Match, so every row is the build.
 *   `exact` — plain substring, the behaviour this matcher has always had.
 *   `normalised` — found only after normalising; say so in the operator's log.
 *   `none` — no row carries the text. The build is not on this document.
 *   `ambiguous` — the needle spans more than one build. REFUSE; never pick.
 * @property {any[]} rows the rows of the build; empty unless the verdict allows
 * @property {string} how one line, for the operator's log
 * @property {string[]} texts the distinct normalised Desc2 the needle reached
 */

/**
 * Narrow a document's sofa rows to the one build a correction is about.
 *
 * @param {any[]} rows every sofa row on the document, in document order
 * @param {string|null|undefined} needle the correction's `desc2Match`
 * @param {(row:any)=>unknown} [readDesc2] how to read a row's Desc2
 * @returns {BuildSelection}
 */
export function selectBuildRows(rows, needle, readDesc2 = (r) => r.description2) {
  const all = Array.isArray(rows) ? rows : [];
  if (!needle) return { verdict: "all", rows: all.slice(), how: "no desc2Match on this correction", texts: [] };

  /* One build is one Desc2. Two distinct texts under one needle means the
     needle reached a second build, and choosing between them is precisely the
     thing this function must never do. */
  const decide = (hits, verdict, how) => {
    const texts = [...new Set(hits.map((r) => normaliseDesc2(readDesc2(r))))];
    return texts.length > 1
      ? { verdict: "ambiguous", rows: [], how, texts }
      : { verdict, rows: hits, how, texts };
  };

  const exact = all.filter((r) => String(readDesc2(r) ?? "").includes(needle));
  if (exact.length) return decide(exact, "exact", "matched the Desc2 exactly");

  const wanted = normaliseDesc2(needle);
  if (wanted === "") return { verdict: "none", rows: [], how: "the desc2Match is blank once normalised", texts: [] };

  const loose = all.filter((r) => normaliseDesc2(readDesc2(r)).includes(wanted));
  if (!loose.length) return { verdict: "none", rows: [], how: "no line carries this text, exactly or normalised", texts: [] };
  return decide(loose, "normalised", "matched once line breaks, quotes and spacing were normalised");
}
