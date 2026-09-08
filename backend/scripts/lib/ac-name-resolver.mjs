/* ac-name-resolver — the free-text line resolver the cutover SO import uses.
 *
 * NO SHEBANG — this module is imported by a test (CLAUDE.md: on Windows vitest
 * inlines the source, and a `#!` off byte 0 is a SyntaxError at LOAD).
 *
 * WHY THIS FILE EXISTS. AutoCount lets a salesperson type a sales line with no
 * ItemCode at all — the product is named only in the Description. The cutover
 * import resolves those against the LIVE company-1 pick list, and when the
 * resolve fails the owner's 2026-08-09 rule takes over: a priced blank line is
 * a charge, a zero-priced one is dropped. So this resolver decides whether a
 * line is GOODS or gets treated as a charge / dropped, and on 2026-09-08 it was
 * found to have dropped two real ones off `SO-000015` (docs/bugs/0711).
 *
 * It lived inside `import-ac-outstanding-so.mjs` as a local function, where
 * nothing could ask it WHY it failed without re-implementing it. A second copy
 * of a matching rule is this repo's most expensive recurring bug, so the rule
 * is stated once here and both the importer and
 * `probe-dropped-book-lines.mjs` read it.
 *
 * THE TRACE IS THE SAME CODE PATH, NOT A DESCRIPTION OF IT. `buildNameResolver`
 * is `buildTracedNameResolver` with the verdict's `.code` taken off it — there
 * is no branch a trace can report that the resolver does not actually take.
 *
 * READ-ONLY. Pure functions over a product list: no database, no network.
 */

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const stripDim = (s) => norm(s).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

/* The size suffixes AutoCount's free text can carry, and the ERP code suffix
   each one means. `(?<!1)90 X 190` keeps 190x190 from reading as a single. */
export const SIZE_SUFFIX = [
  [/\b183\s*X\s*190|6\s*FT|\(K\)/i, "(K)"],
  [/\b152\s*X\s*190|5\s*FT|\(Q\)/i, "(Q)"],
  [/\b107\s*X\s*190|3\.5\s*FT|\(SS\)/i, "(SS)"],
  [/\b(?<!1)90\s*X\s*190|3\s*FT|\(S\)/i, "(S)"],
  [/\b200\s*X\s*200|\(SK\)/i, "(SK)"],
];

/** Resolve a free-text sales line against the live pick list, REPORTING the
 *  route it took. Verdict: { code, via, size, words, best, bestScore }.
 *  `code` is null when nothing matched; `via` always names the last rule tried.
 *  @param {{code: string, name: string}[]} products company-1 pick list
 */
export function buildTracedNameResolver(products) {
  const byName = new Map();      // normalized product name -> code
  const byNameNoDim = new Map(); // name without its (dimensions) -> code
  for (const p of products) {
    byName.set(norm(p.name), p.code);
    const k = stripDim(p.name);
    if (!byNameNoDim.has(k)) byNameNoDim.set(k, p.code);
  }
  return (desc) => {
    if (!desc) return { code: null, via: "no description" };
    const n = norm(desc);
    if (byName.has(n)) return { code: byName.get(n), via: "exact product name" };
    const k = stripDim(desc);
    if (byNameNoDim.has(k)) return { code: byNameNoDim.get(k), via: "product name without its dimensions" };
    if (/DELIVERY\s*FEE|DELIVERY\s*CHARGE|TRANSPORT/i.test(desc)) return { code: "TRANSPORTATION CHARGES", via: "delivery/transport wording" };
    let size = null;
    for (const [re, sz] of SIZE_SUFFIX) if (re.test(desc)) { size = sz; break; }
    if (!size) return { code: null, via: "no size suffix could be read, so the token match never ran", stripped: k };
    const base = k.replace(/\bB\/?FRAME\b/g, "BEDFRAME").replace(/\bMATTRESS\b/g, "MATT").replace(/^NK-|^NB-|^DL-|^AK-/g, "").trim();
    const words = base.split(" ").filter((w) => w.length > 2);
    let best = null, bestScore = 0;
    for (const p of products) {
      const pn = stripDim(p.name);
      if (!p.code.toUpperCase().endsWith(size)) continue;
      const score = words.filter((w) => pn.includes(w)).length;
      if (score > bestScore) { bestScore = score; best = p.code; }
    }
    if (best && bestScore >= 2) return { code: best, via: `token match on ${size}`, size, words, best, bestScore };
    return { code: null, via: `token match on ${size} scored ${bestScore}, below the threshold of 2`, size, words, best, bestScore, stripped: k };
  };
}

/** The importer's resolver: the traced one with the reasoning taken off.
 *  @returns {(desc: string) => string|null} */
export function buildNameResolver(products) {
  const traced = buildTracedNameResolver(products);
  return (desc) => traced(desc).code;
}
