/* THE fabric-code rule. One copy, because two copies have now cost two live
   defects in one day.

   The shape the owner approved on 2026-08-11:

     series = J9226          the brand word comes off
     code   = J9226-01       series + number. No brand, no colour name, no '#'
     label  = J9226-01 SAND  the code, then the colour name

   Both defects were the SAME rule written twice and drifting:

     * normalize-fabric-codes read the colour number as \d{1,3}, so
       "NOVENA-1003" became NOVENA-100 with a colour NAME of "3", and run
       31470428224 wrote that to production.
     * align-fabric-trackings then derived the series with its own \d{1,3}
       copy, so even after the first was fixed it still called NOVENA-1003's
       series "NOVENA-1".

   Nothing here may be re-implemented in a script. Import it. */
import { normColour } from "./fabric-colour-match.mjs";

export const strip = (s) => normColour(s).replace(/[^A-Z0-9]/g, "");

/* The SERIES keeps its own internal separator, collapsed to a single dash.
   "SF-AT 01" is series SF-AT, and SF-AT is what the slips and the showroom
   actually say; flattening it to SFAT makes a code nobody recognises. Same for
   ALPINE-5311 and CHANTIC-141. Only the separator is normalised - no character
   is added or removed. */
export const seriesToken = (s) => normColour(s).replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* scm.fabric_colours grew an UNMATCHED bucket when an import could not place a
   row - "UNMATCHED-PICCO-FG66151-11", "UNMATCHED-STAR-FABRIC-CLOUD". It is not
   a fabric series and no rule can decide what its rows mean: the first is
   probably FG66151-11, the second is a STAR colour called CLOUD with no number
   at all. Reported, never rewritten. */
export const isJunkBucket = (id) => /^UNMATCHED/.test(normColour(id));

/* A leading word is a BRAND only when what follows is already a complete code -
   letters AND digits. Otherwise it belongs to the series and the space closes
   up. See the header: this is the whole PC 1461 / ARMANI J9226 distinction. */
const BRAND = /^([A-Z][A-Z]{2,})\s+(?=[A-Z]{1,4}\d{3,})/;
const JOIN_SERIES = /^([A-Z]{1,4})\s+(?=\d)/;

/* Split "<series><sep><number><sep><name>". The series part is GREEDY on
   purpose: "CHANTIC-141-2" is series CHANTIC141 colour 2, not series CHANTIC
   colour 141. A lazy match gets that backwards and would collapse a whole
   series onto one colour.

   THE NUMBER RUNS TO FOUR DIGITS, and that is not cosmetic. At {1,3} the lazy
   pattern read "NOVENA-1003" as series NOVENA, colour 100, colour NAME "3" -
   and the 2026-08-11 apply wrote exactly that to production: NOVENA-100
   labelled "NOVENA-100 3", and the same for LAMB VELVET-2005, GORGE-3003,
   POLAR-5002, MERINO-4005 and MERINO-4010. A four-digit colour number is a
   whole number, never three digits and a name that happens to be a digit.
   repair-split-colour-numbers.mjs puts the six already-written rows back. */
const SPLIT = /^(.+?)[\s\-]+(\d{1,4})\s*#?[\s\-]*(.*)$/;
const SPLIT_GREEDY = /^(.+)[\s\-]+(\d{1,4})\s*#?[\s\-]*([A-Z].*)?$/;
/* No separator at all - "NB01". Only a ONE OR TWO digit tail qualifies, which
   is what keeps "PU1910", "FG6876" and "BN125" out: nobody can tell from the
   string whether those are PU + 1910 or PU19 + 10, so they stay unparsed and
   get reported rather than guessed at. */
const SPLIT_GLUED = /^([A-Z]{2,})(\d{1,2})$/;

export function parse(colourId) {
  let v = normColour(colourId);
  let brand = null;
  const b = BRAND.exec(v);
  if (b) { brand = b[1]; v = v.slice(b[0].length).trim(); }
  const j = JOIN_SERIES.exec(v);
  if (j) v = v.replace(JOIN_SERIES, "$1");
  const m = SPLIT_GREEDY.exec(v) || SPLIT.exec(v) || SPLIT_GLUED.exec(v);
  if (!m) return null;
  const series = seriesToken(m[1]);
  const num = m[2];
  let name = (m[3] || "").replace(/^[#\s\-]+/, "").trim();
  /* A "name" made only of digits is not a name, it is the tail of the number
     that the split cut off. Refuse the parse rather than mint a colour called
     "3" - this is the NOVENA-1003 failure, seen from the other side. */
  if (name && /^\d+$/.test(name)) return null;
  /* A series may be all digits - "311" is a real one - so the guard is length,
     not the presence of a letter. */
  if (series.length < 2) return null;
  return { brand, series, num, name };
}

export const canonId = (p) => `${p.series}-${p.num.length >= 2 ? p.num : p.num.padStart(2, "0")}`;
export const canonLabel = (p) => {
  const id = canonId(p);
  return p.name ? `${id} ${p.name}` : id;
};

/* A supersede / merge stamp is bookkeeping, never part of a colour name.
   "BO315-2-FEATHER [MERGED into BO315-02 on 2026-08-11 - superseded, not
   deleted]" must read as "BO315-2-FEATHER" wherever a name is being looked
   for, or the stamp itself becomes the name on the next pass. */
export const stripNote = (s) => String(s ?? "").replace(/\[.*$/s, "").trim();

/* THE COLOUR NAME DOES NOT ONLY LIVE IN THE CODE, and after this family has
   run once it lives ONLY in the label.

   Before 2026-08-11 the name was carried by the code itself - "J9226-1 SAND".
   The first pass moved it where the owner wanted it: code "J9226-01", label
   "J9226-01 SAND". Parsing that now-clean code yields NO name, so a second
   pass that re-derives the label from the code alone rewrites "J9226-01 SAND"
   to a bare "J9226-01" and DELETES the colour name. The production PLAN of
   2026-08-13 proposed exactly that for 200 colours, every one of them with the
   code unchanged - the whole diff was a name being erased. Caught before
   apply.

   So the label is a name SOURCE, not only an output. Only a label that AGREES
   with the code may donate one: it is parsed with this same rule and its
   series+number must canonicalise to the same id, so a stale, mismatched or
   hand-typed label can never move a name onto a different colour. */
export function nameFromLabel(colourId, label) {
  const lab = stripNote(label);
  if (!lab) return null;
  const lp = parse(lab);
  if (!lp || !lp.name) return null;
  const cp = parse(colourId);
  if (!cp || canonId(cp) !== canonId(lp)) return null;
  return lp.name;
}

