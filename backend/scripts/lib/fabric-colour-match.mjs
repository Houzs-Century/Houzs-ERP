/* The ONE fabric-colour matcher. Five scripts each carried their own copy and
   they had already drifted apart: the SO importer grew a typo-fold index, a
   transposition pass and an edit-distance pass, while refresh-so-variants.mjs,
   refresh-po-variants.mjs, import-ac-outstanding-po.mjs and
   import-ac-so-linked-pos.mjs still ran exact-index-only. The refresh scripts
   are what WRITE the migrated lines, so the weakest copy is what production
   actually stores - 138 migrated sofa/bedframe lines hold no bound colour
   while carrying one in their AutoCount Desc2.

   Everything here is lexical, with ONE bounded exception: COLOUR_ALIAS at the
   bottom, a last-resort table that runs only after every lexical pass has
   already failed. Read its comment before adding to it. A name resolves to a
   colour the library already holds, or it does not resolve at all - the alias
   table cannot name a colour that is not there, and it is not allowed to
   invent one.

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

/* The same string with the pending marker taken off, so what is left can be
   asked of the library. "Col:BO315-21Pearl(TBC)" leaves "BO315-21Pearl". */
export const stripPendingMarker = (c) =>
  String(c || "").replace(/\(\s*(?:TBC|KIV)\s*\)|\b(?:TBC|KIV)\b/gi, " ").replace(/\s+/g, " ").trim();

/* WHICH of the two things TBC/KIV means, because they are not the same fact and
   one gate cannot answer both.

     "COL: TBC"                the colour has not been chosen        -> "only"
     "Col:BO315-21Pearl(TBC)"  a colour IS named, and may still move -> "qualified"

   Measured on company 1, 2026-09-04: 257 migrated sofa/bedframe lines carry a
   pending marker and 16 of them are "qualified" - the book names a fabric the
   library holds and the whole string is discarded because TBC appears anywhere
   in it. Naming the two apart is all this does. It fills nothing and it changes
   no existing caller: `isPendingColour` is untouched, and whether a qualified
   line should be bound is the owner's call, not a matcher's.

   `find` is required, never optional: the answer depends entirely on whether
   the library confirms what is left, so a caller that cannot ask must not get
   a cheerful "only" by forgetting an argument (BUG CLASS optional-param-noop). */
export const pendingColourKind = (c, find) => {
  if (typeof find !== "function") throw new TypeError("pendingColourKind(c, find): find is required");
  if (!isPendingColour(c)) return "none";
  const rest = stripPendingMarker(c);
  return rest && find(rest) ? "qualified" : "only";
};

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

/* THE ZERO-PADDING CLASS. On 2026-08-11 the library renumbered every 1-digit
   tail to two digits - CH141-8 became CH141-08, GARFIELD-1 became GARFIELD-01 -
   and kept each predecessor as an `active = false` row saying so in its own
   label. The documents were never rewritten, so the book still says "CH141-8
   army" while the live row is "CH141-08 ARMY".

   Pad BEFORE the separators are stripped, never after: stripColour("CH141-8")
   is "CH1418", where the 8 sits next to the 1 of 141 and no rule can tell a
   1-digit tail from the last digit of a 4-digit series. A lone digit - one with
   no digit on either side of it - is the only thing padded, so 151 stays 151
   and STAR-10 can never become STAR-010 nor collide with STAR-01. */
const padGroups = (s) => String(s).replace(/(?<!\d)(\d)(?!\d)/g, "0$1");
export const padColour = (x) => stripColour(padGroups(normColour(x)));

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
  /* rung 8, LAST so every faithful spelling above is tried first: the same
     spellings with a lone digit padded to two, for the 2026-08-11 renumbering.
     "HUGYP MADE WOWSON 8877-3" reaches WOWSONS-8877-03 only from here - rung 5
     gets it to WOWSON8877-3, and the padded form is what the edit-distance pass
     can then close the missing S on. */
  out.faithful = out.length; // everything pushed from here on is a PADDED spelling
  /* The same 3-character floor pass 1 applies, and it is load-bearing here for a
     reason padding creates: "7#" pads to "07#", which FOLDS to "07" - and the SF
     series labels its colours "01".."19", so the fold pass (which has no floor
     of its own) bound "7# CHARCOAL" to SF-AT 07. Padding may not manufacture a
     two-character key out of a string that never had one. */
  for (const f of out.slice()) { const p = padGroups(f); if (stripColour(p).length >= 3) push(p); }
  return out;
}

/* THE ALIAS TABLE - the one non-lexical thing here, kept small on purpose.

   These five document spellings name a colour the library REALLY HOLDS, and no
   lexical rung can reach it, because the miss is not a typo - it is the
   document writing an identity a different way:

     - the number is simply absent      "Modenza-Houston Cream" vs MODENZA-01
                                        (whose label IS "MODENZA-01 HOUSTON CREAM")
     - the series letters are absent    "141-1" vs CH141-1, "9226-13" vs
                                        ARMANI J9226-13 WARM GREY
     - the brand is written INSTEAD of  "Harring 02# Beige" vs
       the series code                  HIRRING GD8371-02# BEIGE
     - the number trails the NAME       "Phoenix-oyster1" vs PHOENIX-1 OYSTER
       instead of leading it

   Loosening a rung to catch these would have to let a query match a library key
   it shares no number with, which is the exact door the digit guard closes - so
   the fix is five named facts instead of a weaker rule.

   THE RULES THAT KEEP THIS HONEST, all enforced below, not just described:
     1. It runs LAST, only when every lexical pass returned null. It therefore
        cannot change any binding that already resolves. That is what makes it
        safe to add to.
     2. The target must EXIST in the live library. A stale entry goes inert
        instead of binding to nothing; a deleted colour cannot be resurrected.
     3. It resolves to a WHOLE library row, never to a fabricated code. Nothing
        here invents a colour - each right-hand side was read out of a prod
        DUMP=1 dump of scm.fabric_colours on 2026-08-10.
     4. Every entry carries the document string and the live line count that
        justify it. No line, no entry.

   Keyed by foldColour(), so case, spacing, '#' and '-' variants of the same
   document string collapse onto one entry ("Harring 02# Beige" and
   "Harring 02# beige" are one row here, not two). */
export const COLOUR_ALIAS = [
  // fold key            -> [fabric_id, colour_id]            document string (live lines)
  ["M0DENZAH0UST0NCREAM", ["MODENZA", "MODENZA-01"], "Modenza-Houston Cream (10)"],
  ["1411", ["CH141", "CH141-1"], "141-1 (2)"],
  ["922613", ["ARMANI J9226", "ARMANI J9226-13 WARM GREY"], "9226-13 (2)"],
  ["HARING02BEIGE", ["HIRRING GD8371", "HIRRING GD8371-02# BEIGE"], "Harring 02# Beige / beige (3)"],
  ["PH0ENIX0YSTER1", ["PHOENIX", "PHOENIX-1"], "Phoenix-oyster1 (2)"],
];

/* ONE KEY CLAIMED BY TWO DIFFERENT ROWS IS AMBIGUOUS, AND AMBIGUOUS MEANS
   REFUSE. This is the rule the whole widening rests on: a normalisation that
   folds two different library rows onto one key may never pick one of them.

   It is not hypothetical. `CREAM` is the label of BOTH CASSNYE-04 and
   TARONI-01, both active, and the bedframe decoder reads a bare "Cream/Divan10/
   Gap13" as a colour. The exact index used to be first-wins - `if (!exact.has(
   k)) exact.set(k, r)` - so findColour("CREAM") answered CASSNYE-04 with a coin
   toss's confidence and nothing said so. It now answers null, which is the
   owner's rule: a colour that cannot be CONFIRMED is left empty.

   THE ONE EXCEPTION, and it is a fact the library states about itself rather
   than a preference we apply. The 2026-08-11 renumbering kept each 1-digit
   predecessor as `active = false` with "[superseded by CH141-08 on 2026-08-11]"
   written into its own label. Sixty-six padded keys are claimed by exactly such
   a pair. That is one identity spelled twice, not two identities competing, so
   the ACTIVE row takes the key. Two ACTIVE rows on one key stays a refusal.

   `active` is read ONLY where the caller selected it. A row with no `active`
   property is neither active nor superseded, so a key two such rows claim is
   dropped exactly as a strict reading requires - a caller that does not supply
   the fact does not get the exception. */
function claimIndex(rows, keysOf) {
  const claims = new Map();
  for (const r of rows) {
    for (const k of keysOf(r)) {
      if (!k) continue;
      const set = claims.get(k);
      if (set) set.add(r); else claims.set(k, new Set([r]));
    }
  }
  const index = new Map(), refused = new Set();
  for (const [k, set] of claims) {
    if (set.size === 1) { index.set(k, [...set][0]); continue; }
    const live = [...set].filter((r) => r.active === true);
    const superseded = [...set].filter((r) => r.active === false);
    if (live.length === 1 && live.length + superseded.length === set.size) index.set(k, live[0]);
    else refused.add(k);
  }
  return { index, refused };
}

/* rows: [{ fabric_id, colour_id, label, active? }] straight out of
   scm.fabric_colours. `active` is optional and its absence is STRICTER, never
   looser - see claimIndex. */
export function buildFabricColourIndex(rows) {
  const ex = claimIndex(rows, (r) => [normColour(r.colour_id), normColour(r.label), stripColour(r.colour_id), stripColour(r.label)]);
  const exact = ex.index, exactRefused = ex.refused;
  // the same index over the zero-padded key, for the 2026-08-11 renumbering
  const pd = claimIndex(rows, (r) => [padColour(r.colour_id), padColour(r.label)]);
  const padded = pd.index, paddedRefused = pd.refused;
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

  /* Resolve COLOUR_ALIAS against THIS library. An entry whose row is not here
     is dropped, not guessed at - rule 2 of the alias contract. */
  const byPk = new Map(rows.map((r) => [JSON.stringify([r.fabric_id, r.colour_id]), r]));
  const aliasRow = new Map(); const aliasUnresolved = [];
  for (const [key, [fabricId, colourId], why] of COLOUR_ALIAS) {
    /* The renumbering can move the target out from under an entry: PHOENIX-1
       became PHOENIX-01 on 2026-08-11 and this alias went inert without a word,
       which is 2 live lines the table was written to catch. Fall back to the
       padded key - the SAME identity under its new number, still a whole row
       read out of the live library, so rules 2 and 3 of the contract hold. */
    const row = byPk.get(JSON.stringify([fabricId, colourId])) || padded.get(padColour(colourId));
    if (row) aliasRow.set(key, row); else aliasUnresolved.push(`${fabricId} / ${colourId} (${why})`);
  }

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

  /* A SUPERSEDED ROW RESOLVES TO THE ROW THAT REPLACED IT. The 2026-08-11
     renumbering left "CH141-8" in the table as `active = false` while the live
     row is "CH141-08 ARMY", and the book still says "CH141-8 army" - so the
     exact index answers, faithfully, with a colour the Fabrics picker no longer
     offers. Follow the supersession through the PADDED key, which is the one
     thing the two spellings share, and only where that key names exactly one
     ACTIVE row - a key two live rows claim was already refused above, so this
     can never choose between them. A row with no `active` property is left
     alone: nothing was stated, so nothing is followed. */
  const live = (row) => {
    if (!row || row.active !== false) return row;
    const successor = padded.get(padColour(row.colour_id));
    return successor && successor !== row && successor.active === true ? successor : row;
  };

  /* WHICH mechanism answered, so a probe can split "this resolves today" from
     "this resolves only because of the widening" without keeping a second copy
     of the matcher to compare against. \`via\` names the pass; \`padded\` is true
     when the spelling that won was one of rung 8's; \`redirected\` when the row
     the pass returned was superseded and live() followed it to its replacement.
     Every one of those three is a mechanism this file did not have before, so
     an answer carrying none of them is an answer the old matcher also gave. */
  const explainColour = (text) => {
    const hit = findColourRaw(text);
    if (!hit) return null;
    const row = live(hit.row);
    return { row, via: hit.via, form: hit.form, padded: hit.padded === true, redirected: row !== hit.row };
  };

  const findColour = (text) => {
    const e = explainColour(text);
    return e ? e.row : null;
  };

  const findColourRaw = (text) => {
    if (!text) return null;
    const forms = colourForms(text);
    if (!forms.length) return null;
    const found = (row, via, form, i) => ({ row, via, form, padded: i >= (forms.faithful ?? forms.length) });
    // pass 1: the exact index, over every spelling. Faithful spellings first.
    for (let i = 0; i < forms.length; i++) {
      const f = forms[i];
      for (const cand of [normColour(f), stripColour(f), padTail(stripColour(f)), ...seriesNum(f)]) {
        // under 3 characters is not a code. The SF series labels its colours
        // "01".."19", so a bare "03" would otherwise claim SF-AT 03.
        if (!cand || stripColour(cand).length < 3) continue;
        const h = exact.get(cand);
        if (h) return found(h, "exact", f, i);
      }
      if (/^\d/.test(f)) { // a bare number is a PC151 colour in the owner's data
        for (const cand of [stripColour("PC" + f), padTail(stripColour("PC" + f))]) {
          const h = exact.get(cand);
          if (h) return found(h, "exact", f, i);
        }
      }
    }
    /* pass 1b: the ZERO-PADDING index. After every faithful spelling has been
       tried against the exact index, so a document that writes the library's own
       spelling always wins, and a padded key two ACTIVE rows claim is already
       gone from this map rather than picked between. */
    for (let i = 0; i < forms.length; i++) {
      const k = padColour(forms[i]);
      if (k.length < 3) continue; // under 3 characters is not a code (see pass 1)
      const h = padded.get(k);
      if (h) return found(h, "padded", forms[i], i);
    }
    // pass 2: the typo fold, over every spelling. Fold equality means the two
    // strings agree digit for digit already, so no guard is needed here.
    for (let i = 0; i < forms.length; i++) { const h = folded.get(foldColour(forms[i])); if (h) return found(h.row, "fold", forms[i], i); }
    // pass 2b: the NAME lives in the library's colour_id, not in the document -
    // the STAR series is stored as "STAR-10 NAVY", so a document that writes
    // plain STAR-10 has no exact key. Accept the code as a prefix of exactly
    // ONE library key, min 6 chars, and only where the key's own number ends
    // there (so STAR-1 can never claim STAR-10 NAVY).
    for (let i = 0; i < forms.length; i++) {
      const f = forms[i];
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
      if (hit && !many) return found(hit, "name-prefix", f, i);
    }
    // pass 3: free-text rider ("Modenza 01*Bottom wrap ...") - the longest
    // folded PREFIX that indexes uniquely, then one transposition away. Min 6
    // chars so a bare series prefix cannot win alone; the prefix may not stop
    // in the middle of a number (that is what bound B0315-27 to BO315-2).
    for (let i = 0; i < forms.length; i++) {
      const src = forms[i];
      const f = foldColour(src), mk = markColour(src);
      for (let len = Math.min(f.length, 14); len >= 6; len--) {
        if (/\d/.test(mk[len] || "")) continue; // cuts a number in half
        const pre = f.slice(0, len), preDigits = digitsOf(mk.slice(0, len));
        const exactPre = folded.get(pre);
        const h = (exactPre && digitsCompatible(exactPre.digits, preDigits) ? exactPre.row : null) || swap1(pre, preDigits);
        if (h) return found(h, "prefix", src, i);
      }
    }
    for (let i = 0; i < forms.length; i++) {
      const src = forms[i];
      const f = foldColour(src);
      const h = f.length >= 6 ? dist1(f, digitsOf(markColour(src))) : null;
      if (h) return found(h, "dist1", src, i);
    }
    // LAST: the alias table. Nothing above resolved, so this cannot displace a
    // lexical answer - see COLOUR_ALIAS. Unknown targets are already dropped.
    for (let i = 0; i < forms.length; i++) { const h = aliasRow.get(foldColour(forms[i])); if (h) return found(h, "alias", forms[i], i); }
    return null;
  };

  return { findColour, explainColour, exact, exactRefused, padded, paddedRefused, folded, ambiguous, aliasRow, aliasUnresolved };
}
