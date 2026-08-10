/* The ONE fabric-colour matcher. Five scripts each carried their own copy and
   they had already drifted apart: the SO importer grew a typo-fold index, a
   transposition pass and an edit-distance pass, while refresh-so-variants.mjs,
   refresh-po-variants.mjs, import-ac-outstanding-po.mjs and
   import-ac-so-linked-pos.mjs still ran exact-index-only. The refresh scripts
   are what WRITE the migrated lines, so the weakest copy is what production
   actually stores - 138 migrated sofa/bedframe lines hold no bound colour
   while carrying one in their AutoCount Desc2.

   Everything here is lexical. There is no brand-alias table and no hand-written
   "X means Y": a name resolves to a colour the library already holds, or it
   does not resolve at all.

   THE LADDER (each rung only ADDS a spelling to try; the untouched original is
   always tried first, so a more faithful spelling always wins):

     1. drop parenthesised trailing names   NX003 (HONEY)      -> NX003
     2. '#' is a separator                  GD2502#09-SANDY    -> GD2502-09-SANDY
     3. drop the trailing colour NAME       GD2502-09-SANDY    -> GD2502-09
     4. drop spaces inside the code         HR 805-40          -> HR805-40
     5. pull SERIES+NUMBER out of prose     BEETEX HARRING GD 8371 02# BEIGE
                                                               -> GD8371-02
     6. pad a one-digit tail                MODENZA 5          -> MODENZA-05
     7. fold typos: COLLAPSE DOUBLED LETTERS FIRST, THEN letter-O to zero
                                            BOO315-23 -> BO315-23
                                            B0315-21  -> BO315-21

   Rung 7's order is load-bearing and easy to get backwards. Mapping O->0 first
   turns BOO315 into B00315, whose doubled character is a ZERO, so the collapse
   then yields B0315 and every BOO* spelling misses. Collapsing letters first
   gives BO315 -> B0315, the same key the B0315* spellings produce.

   THE DIGIT GUARD, which is the other half of this fix. A colour NUMBER is an
   identity, not a spelling, so the fuzzy tail (prefix truncation, transposition,
   edit distance) may correct LETTERS and must never move a digit. Without it
   the existing passes bound B0315-27 -> BO315-2, B0315-29 -> BO315-2,
   HR805-20 -> HR805-40, Chantic141-5 -> CHANTIC-141-2, GD8371-03 -> GD8371-02
   and STAR-10 -> "STAR 01" - every one of them a real fabric silently swapped
   for a different real fabric, which is worse than leaving the line blank.
   The guard compares digits in MARK space, where letter-O is '@' and a written
   zero stays '0', so BO315 and B0315 still agree while 10 and 01 do not.

   Ambiguity is refused, never guessed: any fold key produced by two different
   library rows is dropped from the index, and the transposition and
   edit-distance passes return null the moment two different rows qualify. */

export const normColour = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
export const stripColour = (s) => normColour(s).replace(/[^A-Z0-9]/g, "");

// TBC / KIV anywhere means the colour has not been chosen yet - not a miss.
export const isPendingColour = (c) => /(TBC|KIV)/i.test(c || "");

// "BOOBOO315-1" = the code typed twice (owner, 2026-08-10).
const dedupHead = (x) => {
  for (let n = 2; n * 2 <= x.length; n++) if (x.slice(0, n) === x.slice(n, n * 2)) return x.slice(0, n) + x.slice(n * 2);
  return x;
};

// Everything up to the final character mapping, shared so fold and mark stay
// position-for-position aligned - the prefix guard indexes one by the other.
const foldBase = (x) => dedupHead(stripColour(x).replace(/(LETH?ER|LEATHER|FABRIC|VELVET)/g, "")).replace(/([A-Z])\1+/g, "$1");

export const foldColour = (x) => foldBase(x).replace(/O/g, "0");
// mark space: letter-O is neither letter nor digit, a written zero stays a digit
export const markColour = (x) => foldBase(x).replace(/O/g, "@");
const digitsOf = (mark) => (mark.match(/\d+/g) || []).join("-");
/* Same number, allowing ONE padding zero on the tail - rung 6 seen from the
   signature side, because the library stores ARMANI J9226-01 SAND while the
   document writes J9226-1. Nothing wider: 10 and 01 stay different numbers. */
const digitsCompatible = (a, b) => a === b || a.replace(/(.)$/, "0$1") === b || b.replace(/(.)$/, "0$1") === a;

const padTail = (x) => x.replace(/(?<!\d)(\d)$/, "0$1");

/* "PC151-2" / "PC151101" -> the series plus a 2-digit number, both ways round,
   because the owner's data carries a 1-digit tail and an over-long one. */
const seriesNum = (x) => {
  const m = /^([A-Z]{2,4})(\d{2,4})(\d{1,3})$/.exec(stripColour(x));
  return m ? [m[1] + m[2] + m[3].padStart(2, "0"), m[1] + m[2] + m[3].slice(-2)] : [];
};

/* Rung 3. Peel trailing alphabetic words off a string that still holds a digit:
   "GD2502-04-OAK" -> "GD2502-04", "B0315-5 FOSIL request to normal leg" ->
   "B0315-5". The remainder must keep a digit AND a letter, so a name-only
   colour ("MODENZA-HOUSTON CREAM") is left whole rather than shaved to a bare
   series, and "03#STRAW" is never reduced to the bare number "03" - which the
   SF series happens to carry as a LABEL, so it would have bound there. */
const dropTrailingName = (s) => {
  let v = s, m;
  while ((m = /^(.+?)[\s-]+[A-Z]+$/.exec(v)) && /\d/.test(m[1]) && /[A-Z]/.test(m[1])) v = m[1].trim();
  return v;
};

// rung 6 on the written tail: "J9047-1" -> "J9047-01", "MODENZA 5" -> "MODENZA 05"
const padWrittenTail = (s) => s.replace(/([\s-])(\d)$/, "$10$2");

/* Every spelling worth trying, most faithful first. */
export function colourForms(text) {
  const out = [];
  const push = (s) => { const v = (s || "").trim(); if (v && !out.includes(v)) out.push(v); };
  const n = normColour(text);
  if (!n) return out;
  push(n);
  const noParen = n.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(); // rung 1
  push(noParen);
  const hashed = noParen.replace(/\s*#\s*/g, "-"); // rung 2
  const tidy = hashed.replace(/\s*-\s*/g, "-").replace(/-+$/, "").trim();
  push(hashed); push(tidy);
  const named = dropTrailingName(tidy); // rung 3
  push(named);
  push(named.replace(/\s+/g, "")); // rung 4
  push(tidy.replace(/\s+/g, ""));
  push(padWrittenTail(named)); // rung 6
  push(padWrittenTail(named).replace(/\s+/g, ""));
  push(n.split(" ")[0]);
  const code = /[A-Z]{1,4}\s?\d{2,4}\s?-?\s?\d*/.exec(n);
  if (code) push(code[0]);
  const inProse = /([A-Z]{1,8}\s?\d{3,4})[\s-]+(\d{1,3})(?!\d)/.exec(hashed); // rung 5
  if (inProse) push((inProse[1] + "-" + inProse[2]).replace(/\s+/g, ""));
  return out;
}

/* rows: [{ fabric_id, colour_id, label }] straight out of scm.fabric_colours. */
export function buildFabricColourIndex(rows) {
  const exact = new Map();
  for (const r of rows) {
    for (const k of [normColour(r.colour_id), normColour(r.label), stripColour(r.colour_id), stripColour(r.label)]) {
      if (k && !exact.has(k)) exact.set(k, r);
    }
  }
  // fold key -> { row, digits } where digits come from the key's OWN mark form
  const folded = new Map(); const ambiguous = new Set(); const markKey = new Map();
  for (const r of rows) {
    for (const src of [r.colour_id, r.label]) {
      const k = foldColour(src);
      if (!k) continue;
      const prev = folded.get(k);
      if (prev && prev.row !== r) ambiguous.add(k);
      else if (!prev) { folded.set(k, { row: r, digits: digitsOf(markColour(src)) }); markKey.set(k, markColour(src)); }
    }
  }
  for (const k of ambiguous) { folded.delete(k); markKey.delete(k); }
  const foldKeys = [...folded.keys()];

  const swap1 = (q, qDigits) => { // one unique library key one TRANSPOSITION away
    let hit = null;
    for (let i = 0; i + 1 < q.length; i++) {
      const h = folded.get(q.slice(0, i) + q[i + 1] + q[i] + q.slice(i + 2));
      if (!h || !digitsCompatible(h.digits, qDigits)) continue;
      if (hit && hit !== h.row) return null;
      hit = h.row;
    }
    return hit;
  };
  const dist1 = (q, qDigits) => { // one unique library key at edit distance 1
    let hit = null;
    for (const k of foldKeys) {
      if (Math.abs(k.length - q.length) > 1) continue;
      const h = folded.get(k);
      if (!digitsCompatible(h.digits, qDigits)) continue; // letters may be corrected, digits may not
      let i = 0, j = 0, edits = 0;
      while (i < q.length && j < k.length) {
        if (q[i] === k[j]) { i++; j++; continue; }
        if (++edits > 1) break;
        if (q.length > k.length) i++; else if (q.length < k.length) j++; else { i++; j++; }
      }
      if (edits + (q.length - i) + (k.length - j) > 1) continue;
      if (hit && hit !== h.row) return null; // ambiguous - refuse
      hit = h.row;
    }
    return hit;
  };

  const findColour = (text) => {
    if (!text) return null;
    const forms = colourForms(text);
    if (!forms.length) return null;
    // pass 1: the exact index, over every spelling. Faithful spellings first.
    for (const f of forms) {
      for (const cand of [normColour(f), stripColour(f), padTail(stripColour(f)), ...seriesNum(f)]) {
        // under 3 characters is not a code. The SF series labels its colours
        // "01".."19", so a bare "03" would otherwise claim SF-AT 03.
        if (!cand || stripColour(cand).length < 3) continue;
        const h = exact.get(cand);
        if (h) return h;
      }
      if (/^\d/.test(f)) { // a bare number is a PC151 colour in the owner's data
        for (const cand of [stripColour("PC" + f), padTail(stripColour("PC" + f))]) {
          const h = exact.get(cand);
          if (h) return h;
        }
      }
    }
    // pass 2: the typo fold, over every spelling. Fold equality means the two
    // strings agree digit for digit already, so no guard is needed here.
    for (const f of forms) { const h = folded.get(foldColour(f)); if (h) return h.row; }
    // pass 2b: the NAME lives in the library's colour_id, not in the document -
    // the STAR series is stored as "STAR-10 NAVY", so a document that writes
    // plain STAR-10 has no exact key. Accept the code as a prefix of exactly
    // ONE library key, min 6 chars, and only where the key's own number ends
    // there (so STAR-1 can never claim STAR-10 NAVY).
    for (const f of forms) {
      const q = foldColour(f);
      if (q.length < 6) continue;
      let hit = null, many = false;
      for (const k of foldKeys) {
        if (k.length <= q.length || !k.startsWith(q)) continue;
        const h = folded.get(k);
        if (/\d/.test(markKey.get(k)[q.length] || "")) continue;
        if (hit && hit !== h.row) { many = true; break; }
        hit = h.row;
      }
      if (hit && !many) return hit;
    }
    // pass 3: free-text rider ("Modenza 01*Bottom wrap ...") - the longest
    // folded PREFIX that indexes uniquely, then one transposition away. Min 6
    // chars so a bare series prefix cannot win alone; the prefix may not stop
    // in the middle of a number (that is what bound B0315-27 to BO315-2).
    for (const src of forms) {
      const f = foldColour(src), mk = markColour(src);
      for (let len = Math.min(f.length, 14); len >= 6; len--) {
        if (/\d/.test(mk[len] || "")) continue; // cuts a number in half
        const pre = f.slice(0, len), preDigits = digitsOf(mk.slice(0, len));
        const exactPre = folded.get(pre);
        const h = (exactPre && digitsCompatible(exactPre.digits, preDigits) ? exactPre.row : null) || swap1(pre, preDigits);
        if (h) return h;
      }
    }
    for (const src of forms) {
      const f = foldColour(src);
      const h = f.length >= 6 ? dist1(f, digitsOf(markColour(src))) : null;
      if (h) return h;
    }
    return null;
  };

  return { findColour, exact, folded, ambiguous };
}
