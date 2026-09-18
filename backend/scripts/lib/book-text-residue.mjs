/* THE SPLITTING TEST for "does AutoCount's spec text say anything our purchase
   order does not already say?", as a library so the production probe
   (check-sofa-bedframe-book-text.mjs) and any local re-analysis of an exported
   corpus compute the answer with the SAME code. Two implementations of one test
   is the shape that lets a report and its re-check disagree.

   AN EXACT-STRING MATCH IS NOT A SUFFICIENT TEST and must not be used as one.
   The book and the ERP say overlapping things in different words — the book
   writes `L(26/28'Inch)`, `buildVariantSummary` writes `SEAT 26` — so an exact
   comparison would put almost every line in "carries something new" and would be
   measuring spelling, not information. The probe prints the exact-match count
   beside these numbers so that claim is checkable rather than asserted.

   WHAT IS MEASURED INSTEAD — RESIDUE AFTER COVERAGE:

     1. the book text is cut into ATOMS on `/`, `,`, `;` and newline, but only
        OUTSIDE brackets, so `L(26/28'Inch)` stays one atom and does not shred;
     2. a COVERAGE bag is built from a string the document already prints;
     3. an atom is COVERED when its letters-and-digits identity is contained in
        the coverage identity (3 characters or more, so `NA` cannot match inside
        `NAVY`), or when EVERY significant token of the atom appears as a whole
        token in the coverage bag;
     4. RESIDUE = the atoms left over.

   ITS ERROR DIRECTIONS, both real and both stated because neither is fixable
   without reading each line by hand:

     * FALSE POSITIVES INTO "carries something new" (the dominant one). The test
       compares SURFACE TOKENS, so the same fact in different words lands in the
       residue — the book's `1+1NA+L` describes the same build the ERP holds as
       separate piece lines with their own item codes. So the "something new"
       population is an UPPER BOUND.
     * FALSE NEGATIVES INTO "says nothing new". An atom whose words appear in the
       summary for another reason reads as covered — a note naming the fabric
       code the fabric segment already carries, where the note was asking for a
       CHANGE to it. So "says nothing new" is a slight over-count.

   Pure: no I/O, no module state, no database. */

const ALNUM = (s) => String(s).toUpperCase().replace(/NILON/g, 'NYLON').replace(/[^A-Z0-9]/g, '');

/* A DIGIT-TO-LETTER BOUNDARY IS A TOKEN BOUNDARY. The book is typed by hand and
   spells the same measurement `12"`, `12 INCH`, `12INCH` and `12”` — while our
   summary always writes `GAP 12"`. Splitting only on punctuation makes `12INCH`
   ONE token that can never equal `12`, so the test reports a difference that is
   spacing and nothing else. Measured on the corpus before this split: `GAP:12INCH`
   alone appeared as unexplained residue on 80 lines and `M.GAP:12INCH` on 99.
   Splitting the boundary makes both sides tokenise the same way, which is the
   only thing that makes them comparable — and it applies to codes symmetrically,
   so the book's `PC-151-01` and our `PC151-01` both become PC / 151 / 01. */
const TOKENS = (s) => String(s).toUpperCase().replace(/NILON/g, 'NYLON')
  .replace(/(\d)([A-Z])/g, '$1 $2').replace(/([A-Z])(\d)/g, '$1 $2')
  .split(/[^A-Z0-9]+/).filter(Boolean);

/* Deliberately tiny. A unit word and a bare conjunction carry no specification;
   everything else — including NO, WITHOUT and CHANGE — is information and stays,
   because dropping one of those would turn an instruction into its opposite. */
const STOP = new Set(['INCH', 'INCHES', 'CM', 'MM', 'FT', 'COL', 'COLOR', 'COLOUR', 'AND', 'THE', 'TO', 'OF', 'X']);

/** Cut a book text into atoms on its own separators, ignoring bracketed ones. */
export function atomsOf(text) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of String(text ?? '')) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === '/' || ch === ',' || ch === ';' || ch === '\n')) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/* ── THE LABEL VOCABULARY — the tighter, third reading ─────────────────────
   The plain test above counts `MATTRESS GAP: 12 INCHES` as new information
   beside our own `GAP 12"`, because MATTRESS and GAP are tokens the summary
   does not both carry. That is the false-positive direction stated above doing
   exactly what it was described as doing, and on this corpus it dominates — so
   a second, LABEL-AWARE reading exists to bound the answer from the other side.

   It drops the words BOTH systems use as segment LABELS rather than as values.
   Our summary prints `DIVAN 8" + LEG 4" / GAP 12"`; the book writes the same
   three numbers under `Divan:`, `Leg`, `M'Gap:`, `Mattress Gap:`, `Col:`. The
   NUMBER is the specification and the label is punctuation, so the label-aware
   reading compares the numbers and the codes.

   It also rewrites `NO LEG` to `LEG 0`, because that is the same fact our
   bedframe branch prints as `LEG 0"`, and it lets the caller widen the bag with
   the bed SIZE the item code already carries — `DIVAN ONLY-(K)` is the reason
   the book's `KING SIZE` is not new information.

   DIRECTION: this reading can only move a line from "carries something new" to
   "says nothing new", never the other way. So it is a LOWER bound and the plain
   reading is an UPPER bound, and the honest answer is the range between them.
   Neither is a substitute for reading the worked examples. */
const LABEL_WORDS = new Set([
  'DIVAN', 'DIV', 'DIVANS', 'GAP', 'GP', 'MGAP', 'MGP', 'M', 'MATTRESS', 'MATT',
  'LEG', 'LEGS', 'SEAT', 'SEATS', 'DEPTH', 'HEIGHT', 'HEIGHTS', 'THEIGHTS',
  'TOTAL', 'SIZE', 'CLR',
]);

/** `NO LEG` and our `LEG 0"` are the same fact written two ways. */
const preNormalise = (atom) => String(atom).replace(/\bNO\s*LEGS?\b/gi, 'LEG 0');

/** The bed size an item code already states, as coverage tokens. */
export function sizeTokensFromItemCode(code) {
  const m = /\(\s*(SS|S|Q|K)\s*\)\s*$/i.exec(String(code ?? '').trim());
  if (!m) return '';
  return { SS: 'SS SUPER SINGLE', S: 'S SINGLE', Q: 'Q QUEEN', K: 'K KING' }[m[1].toUpperCase()] ?? '';
}

/** Everything the document already says, as an identity string + a token set. */
export const coverageBag = (text) => ({ id: ALNUM(text), toks: new Set(TOKENS(text)) });

/**
 * Does the document already say this atom?
 *
 * `dropLabels` selects the label-aware reading described above. It is a REQUIRED
 * argument, not an optional one: its absence would silently choose the looser
 * reading for any caller that forgot it, and which reading produced a number is
 * the whole meaning of that number.
 */
export function isCovered(atom, bag, dropLabels) {
  const text = dropLabels ? preNormalise(atom) : String(atom);
  const id = ALNUM(text);
  if (!id) return true;
  if (id.length >= 3 && bag.id.includes(id)) return true;
  const toks = TOKENS(text).filter((t) => !STOP.has(t) && !(dropLabels && LABEL_WORDS.has(t)));
  if (toks.length === 0) return true;
  return toks.every((t) => bag.toks.has(t));
}

/** The atoms of `book` that `bag` does not already cover. */
export const residueOf = (book, bag, dropLabels) =>
  atomsOf(book).filter((a) => !isCovered(a, bag, dropLabels));

/* Named shapes for a residue atom, so a report says WHAT is new and not only how
   much. Ordered: the first test that matches wins.

   THE BUILD TEST IS CHECKED BEFORE THE MEASUREMENT TEST on purpose. A sofa build
   like `1+1NA+L(26/28'Inch)` contains a measurement, so a measurement-first order
   would file the whole build under "a measurement in words" and hide the single
   most common residue there is. A build is recognised structurally instead: it
   joins its parts with `+`, and every letter-run in it is a short piece code
   (NA, L, CNR, ER, ELT, INCH) rather than a word. */
export const isBuildList = (atom) =>
  String(atom).includes('+') && (String(atom).match(/[A-Za-z]+/g) ?? []).every((w) => w.length <= 5);

export const RESIDUE_KINDS = [
  ['colour or size not yet decided (KIV / TBC)', /\b(KIV|TBC|TBA|PENDING)\b/i],
  ['a fabric or material note', /\b(FABRIC|NYLON|NILON|LEATHER|PU|COTTON|LINEN|UMBRELLA|VELVET|CANVAS|MATERIAL|CUSHION|FOAM)\b/i],
  ['an instruction to change / add / remove', /\b(UPGRADE|CHANGE|ADD|ADDITIONAL|EXTRA|REMOVE|WITHOUT|NO|NONE|NON|INSTEAD|SWAP|REPLACE|CUSTOM|SPECIAL)\b/i],
  ['a build / piece list', isBuildList],
  ['a measurement in words', /\d\s*(?:"|''|INCH|INCHES|CM|MM|FT|'|”)/i],
];

export const kindOf = (atom) => (RESIDUE_KINDS.find(([, t]) => (typeof t === 'function' ? t(atom) : t.test(atom)))
  ?? ['something else', null])[0];
