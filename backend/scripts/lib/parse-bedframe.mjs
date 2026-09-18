// Shared bedframe Desc2 parser - the owner's gap / divan / leg / colour /
// size / specials rules, imported by BOTH importers and BOTH variant-refresh
// scripts so a bedframe line decodes identically everywhere it is read.
// Extracted verbatim from import-ac-outstanding-so.mjs; every rule and its
// owner attribution stays with the code.
//
// WHY THIS MODULE EXISTS, twice over:
//  1. import-ac-outstanding-po.mjs carried a SECOND copy. At extraction the two
//     were byte-for-byte identical, so no rule was dropped from either side - but
//     they had already drifted TWICE and been resynced by hand: a808bf36 (the
//     first PO import shipped an older parser) and 60125216 (parser v5 landed the
//     HYDROLIC/HYDRAULLIC + NOLEG spelling normalisations and the
//     leg-stated-after-divan rules in the SO copy only). POs raised in those
//     windows parsed with a weaker ruleset than SOs of the same week.
//  2. refresh-so-variants.mjs / refresh-po-variants.mjs did not import the parser
//     at all: they read the SO importer's SOURCE TEXT and rebuilt it with
//     new Function(), slicing between two comment markers. That broke in
//     production on 2026-08-09 - see BUG-HISTORY.md. Import this module; never
//     reconstruct the parser from source text again.
//
// Owner rules encoded below (2026-08-09, AutoCount cutover): Desc2 is free text
// typed by many people over years, so spelling normalisation runs FIRST; a divan
// stated with no leg mentioned means NO leg (0), not unknown; TBC/KIV means the
// colour is not chosen yet; anything outside S/SS/Q/K/SK is a special size and
// MUST carry its dimensions; an unqualified DRAWER means Front Drawer.
import { isPendingColour } from "./fabric-colour-match.mjs";

function parseBedframe(d2) {
  /* AutoCount Desc2 is free text typed by many people over years. Normalise the
     wrappers and misspellings FIRST so one set of patterns can read them all:
     strip [..]/(..) wrappers, "diavan"->divan, "mattressgap"/"mgap"->m.gap. */
  let s = (d2 || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^[[(]\s*/, "").replace(/\s*[\])]\s*$/, "");
  s = s.replace(/DIAVAN/gi, "DIVAN").replace(/MATTRESS\s*GAP/gi, "M.GAP").replace(/\bM\s?GAP/gi, "M.GAP")
       .replace(/HYDROLIC|HYDRAULLIC|HYDRAILIC/gi, "HYDRAULIC")
       .replace(/NOLEG/gi, "NO LEG");
  const o = { raw: (d2 || "").replace(/\s+/g, " ").trim(), specials: [] };
  let m;
  /* gap / divan / leg. AutoCount uses ", ”, '', ’’, "inch", "in" interchangeably
     and sometimes runs them together ("Divan10/Gap14", "8''+2\"leg",
     "10inch+NoLeg"). QUOTE = every quote-ish inch marker. */
  const QUOTE = `["”“"″'’‘′]{1,2}`;
  // an inch marker may be a quote, the word, or BOTH run together ("8'INCH")
  const INCHM = `(?:${QUOTE}\\s*INCH(?:ES)?|${QUOTE}|INCH(?:ES)?|IN\\b)`;
  /* A measurement written BEFORE its keyword must be a number in its own right,
     not the tail of a FABRIC CODE. Unguarded, \d+ starts mid-token: "PC151
     divan" gave divan 151" and "PC151-01 divan" gave divan 1" (the -01 suffix);
     "PC151 LEG 4" gave a 151" leg instead of 4".

     Two ways to qualify, because staff DO glue real figures to the word before
     them - "Hydraulic2pcs12”inner" is a genuine 12" inner depth:
       1. the number starts cleanly, after a delimiter or at the start, or
       2. it carries an EXPLICIT inch marker, which a fabric code never does.
     A code like PC151 satisfies neither. Both alternatives are zero-width, so
     the rules below keep their single capture group. Rules where the number
     comes AFTER the keyword ("Divan10", "M.GAP:14") never had the problem. */
  const NUM = `(?:(?<![A-Za-z0-9.-])|(?=\\d+(?:\\.\\d+)?\\s*(?:${QUOTE}|INCH)))`;
  /* HYDRAULIC beds first: the height lives inside a note — "Col:X(hydraulic 16”/
     Inner 14”/4Pump)" — and the INNER figure is the divan. Run before the general
     divan pattern so it cannot grab the 16" outer or a pump count. */
  if (/HYDRAULIC/i.test(s)) {
    let hm2;
    /* Two DIFFERENT numbers live in this text and telling them apart is the
       whole job: the OUTER height of the box (the divan the factory builds) and
       the INNER storage depth. Find each on its own terms, then decide.

       Owner 2026-08-10, ruling on both: "我们就以12“ 14” 16“ divan 就可以了" and
       "inner的话就是inner+2 就是total了". So the outer wins when it is written,
       and an inner-only line converts at +2. The data agrees with him without
       exception - every line stating both reads "hydraulic 16”/Inner 14”". */
    const innerM = new RegExp(`${NUM}(\\d+(?:\\.\\d+)?)\\s*["”“"″'’‘′]{0,2}\\s*(?:INCH(?:ES)?)?\\s*INNER`, "i").exec(s)
      || /INNER[^0-9+]{0,14}?(\d+(?:\.\d+)?)/i.exec(s);
    const inner = innerM ? parseFloat(innerM[1]) : null;
    /* An outer height: stated on DIVAN, or on the word HYDRAULIC when INNER is
       not what that word is qualifying ("INNER HYDRAULIC: 12" is an inner). The
       figure must carry an inch marker, so "Hydraulic2pcs12”" cannot read the
       PIECE COUNT as a height. */
    if ((hm2 = /DIV(?:AN)?\.?\s*[:：]?\s*(?:HYDRAUL[A-Z]*\s*)?(\d+(?:\.\d+)?)/i.exec(s))) o.divan = parseFloat(hm2[1]);
    else if ((hm2 = new RegExp(`${NUM}(\\d+(?:\\.\\d+)?)\\s*["”“"″'’‘′]{0,2}\\s*(?:INCH(?:ES)?)?\\s*DIV(?:AN)?\\b`, "i").exec(s))) o.divan = parseFloat(hm2[1]);
    else if ((hm2 = /(?<!INNER[^0-9]{0,14})HYDRAUL[A-Z]*(?:\s*TOTAL)?[^0-9A-Za-z]{0,4}(\d+(?:\.\d+)?)\s*(?:["”“"″'’‘′]|INCH)/i.exec(s))) o.divan = parseFloat(hm2[1]);
    // no outer height written anywhere: the inner is what we have, +2
    if (o.divan == null && inner != null) o.divan = inner + 2;
    // the outer figure WAS the inner (e.g. "Div:HydraulicInner(10\")") - convert
    else if (o.divan != null && inner != null && o.divan === inner
             && /INNER[^0-9]{0,4}$|INNER\s*\(?\s*$/i.test(s.slice(0, s.indexOf(String(inner))))) o.divan = inner + 2;
    /* A hydraulic divan normally sits on no legs, but "DIVAN:10'INCH 1'INCH
       LEG/HYDRAULIC" states one — defaulting to 0 there overwrote a height the
       salesperson actually wrote. Only default when the text is silent. */
    if (o.divan != null && !/LEG/i.test(s)) o.leg = 0;
    o.specials.push("hydraulic");
  }
  // "10”gap" / "12 INCH GAP" — the figure sits BEFORE the word as often as after
  // gap: also "M'GP:", "M'Gap:", "M.Gap :", and runs-together "M.GAP:14INCHES"
  if ((m = new RegExp(`(?:MATT(?:RESS)?|M)?\\s*['’.]?\\s*(?:GAP|GP)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(s))) o.gap = parseFloat(m[1]);
  if (o.gap == null && (m = new RegExp(`${NUM}(\\d+(?:\\.\\d+)?)\\s*${INCHM}?\\s*(?:MATT(?:RESS)?|M)?\\s*['’.]?\\s*(?:GAP|GP)\\b`, "i").exec(s))) o.gap = parseFloat(m[1]);
  if (o.divan == null && (m = new RegExp(`\\bDIV(?:AN)?\\.?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*${INCHM}?\\s*(?:\\+\\s*(\\d+(?:\\.\\d+)?))?`, "i").exec(s))) { o.divan = parseFloat(m[1]); if (m[2] != null) o.leg = parseFloat(m[2]); }
  if (/NO\s*LEGS?/i.test(s)) o.leg = 0;
  else if (o.leg === undefined && (m = new RegExp(`${NUM}(\\d+(?:\\.\\d+)?)\\s*${INCHM}?\\s*(?:WOODEN\\s*)?LEGS?`, "i").exec(s))) o.leg = parseFloat(m[1]);
  // "Leg:4”" — the figure after the word, the mirror of the form above
  else if (o.leg === undefined && (m = new RegExp(`LEGS?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(s))) o.leg = parseFloat(m[1]);
  // a divan stated with no leg mentioned at all = no leg (0), per owner's model
  if (o.leg === undefined && o.divan != null && !/LEG/i.test(s)) o.leg = 0;
  /* divan written WITHOUT the word "divan": "PC151-07/8inch+4inchLeg/Gap14inch"
     or 'DIVAN"8"'. Take the height that sits right before the leg figure. */
  if (o.divan == null && (m = new RegExp(`${NUM}(\\d+(?:\\.\\d+)?)\\s*${INCHM}\\s*\\+\\s*(?:NO\\s*LEGS?|(\\d+(?:\\.\\d+)?))`, "i").exec(s))) {
    o.divan = parseFloat(m[1]); if (o.leg === undefined) o.leg = m[2] != null ? parseFloat(m[2]) : 0;
  }
  if (o.divan == null && (m = new RegExp(`DIVAN\\s*${QUOTE}?\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(s))) o.divan = parseFloat(m[1]);
  /* Staff run words together, so DIVAN is not always preceded by a boundary
     ("frontdrawerdivan12”"), and the height is often written FIRST ("12”Divan").
     Both are the same fact stated in a different order. */
  if (o.divan == null && (m = new RegExp(`DIV(?:AN)?\\.?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(s))) o.divan = parseFloat(m[1]);
  if (o.divan == null && (m = new RegExp(`${NUM}(\\d+(?:\\.\\d+)?)\\s*${INCHM}?\\s*DIV(?:AN)?\\b`, "i").exec(s))) o.divan = parseFloat(m[1]);
  /* hydraulic beds state the height inside the note: "hydraulic 16”/Inner 14”",
     "12”innerhydraulic", "Hydraulic (Inner 10\")" — the INNER figure is the divan. */
  /* SPECIAL SIZE (owner): anything outside S/SS/Q/K/SK is "SP" and MUST carry its
     dimensions. Staff write them every way: "240CM x 210CM", "180cmx200cm",
     "200cm(L)x183cm(W)", "200cm width + 190cm length". Normalise to "AxB". */
  if ((m = /(\d{2,3}(?:\.\d+)?)\s*CM?\s*(?:\([LW]\))?\s*[xX*]\s*(\d{2,3}(?:\.\d+)?)\s*CM?\s*(?:\([LW]\))?/i.exec(s))) o.size = `${m[1]}x${m[2]}`;
  else if ((m = /(\d{2,3})\s*CM\s*(?:WIDTH|LENGTH|\(?[LW]\)?)?\s*[+&,]\s*(\d{2,3})\s*CM\s*(?:WIDTH|LENGTH|\(?[LW]\)?)?/i.exec(s))) o.size = `${m[1]}x${m[2]}`;
  /* colour: AutoCount writes it many ways — "COL:", "COLOUR:", "Color:",
     "COL CUSHION:", or the bare code first ("PC151-01/8inch+NoLeg/Gap12inch").
     Missing the Color:/bare forms left 1,500+ lines with no colour. */
  if ((m = /(?:COL(?:OUR|OR)?|CLR)(?:\s*CUSHION)?\s*[-:：;]\s*([A-Z0-9][A-Z0-9\- ]*?)(?:\s*[\/,;(]|\s*DIVAN?\b|\s*GAP|\s*M['’.]|$)/i.exec(s))) o.color = m[1].trim();
  else if ((m = /(?:COL(?:OUR|OR)?|CLR)\s+([A-Z]{2,4}\s?-?\s?\d{2,4}[\d-]*)/i.exec(s))) o.color = m[1].trim(); // "colour PC151-01" (no colon)
  else if ((m = /^\s*([A-Z]{2,4}\s?[-:]?\s?\d{2,4}\s?-\s?\d{1,3})(?![\d-])/i.exec(s))) o.color = m[1].trim(); // bare code at the start, also "PC:151-01" and glued to the next word
  // a colour code anywhere in the text (e.g. "Mgap 14 inch / colour PC151-01 / ...")
  if (!o.color && (m = /\b((?:PC|KS|BF|NB|SF|BO|AM|CH|CX|SC|DC|PU|HR|GD|FG|ZL|NV|RU)\s?-?\s?\d{2,4}\s?-\s?\d{1,3}|SF-AT\s?\d{1,3})\b/i.exec(s))) o.color = m[1].trim();
  /* The same two-group code GLUED to the word before it — staff write
     "DivanabovefullcoverPC151-01" with no space — has no word boundary, so the
     rule above walked straight past a colour that was sitting right there. */
  if (!o.color && (m = /((?:PC|KS|BF|NB|SF|BO|AM|CH|CX|SC|DC|PU|HR|GD|FG|ZL|NV|RU)\s?[-:]?\s?\d{2,4}\s?-\s?\d{1,3})(?![\d-])/i.exec(s))) o.color = m[1].trim();
  /* SINGLE-group codes — KS-01, NB-04 (owner 2026-08-10: "KS 01 有的啊"). Only at
     the very start or right after a delimiter, so a measurement inside a
     sentence can never be mistaken for a colour. */
  if (!o.color && (m = /(?:^|[/,;(]\s*)((?:PC|KS|BF|NB|SF|BO|AM|CH|CX|SC|DC|PU|HR|GD|FG|ZL|NV|RU)\s?-\s?\d{2,3})(?!\s?-\s?\d)/i.exec(s))) o.color = m[1].trim();
  if (o.color && /^(TBC|KIV)$/i.test(o.color)) o.color = null;   // "COL: KIV" = not chosen
  // colour written as a plain word ("Cream/Divan10/Gap13", ")Cream/...", "sliver/...")
  if (!o.color && (m = /(?:^|[\/)\s])\s*(CREAM|SILVER|SLIVER|WHITE|BLACK|GREY|GRAY|BEIGE|BROWN|BLUE|GREEN|PINK|IVORY|CHARCOAL)\b/i.exec(s))) o.color = m[1].trim();
  // "8" NO LEG" with no divan keyword: the bare height before NO LEG is the divan
  if (o.divan == null && (m = new RegExp(`${NUM}(\\d+(?:\\.\\d+)?)\\s*${INCHM}?\\s*NO\\s*LEGS?`, "i").exec(s))) { o.divan = parseFloat(m[1]); o.leg = 0; }
  // "8 inch : 2 inch leg" / "8 inch 1 inch leg" / "8'INCH 4'INCH LEG" — divan then leg without +
  if ((m = new RegExp(`${NUM}(\\d+(?:\\.\\d+)?)\\s*${INCHM}\\s*[:,]?\\s*(\\d+(?:\\.\\d+)?)\\s*${INCHM}?\\s*LEGS?`, "i").exec(s))) {
    if (o.divan == null) o.divan = parseFloat(m[1]);
    if (o.leg === undefined) o.leg = parseFloat(m[2]);
  }
  // "Divan8+4" / "divan:10inch+no leg" — the +N right after the divan figure is the leg
  if (o.leg === undefined && o.divan != null && (m = new RegExp(`DIV(?:AN)?\\D{0,3}${o.divan}\\s*${INCHM}?\\s*\\+\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(s))) o.leg = parseFloat(m[1]);
  // specials -> variants.specials (the "Special Orders" picker). Capture all HB
  // phrasings ("HB straight", "HB without panel", "HB & divan fully cover", "HB
  // straight to wall"), fully-cover(ed), and push-back.
  const hm = /\bHB\b[^\/,()]*/i.exec(s); if (hm) { const t = hm[0].replace(/\s+/g, " ").trim(); if (t.length > 2) o.specials.push(t); }
  if (/FULL(?:Y)?\s*COVER(?:ED)?/i.test(s) && !o.specials.some((x) => /cover/i.test(x))) o.specials.push("fully cover");
  if (/PUSH\s*BACK/i.test(s)) o.specials.push("push back");
  /* Every other option the staff describe in words. Without these, 245 lines
     mentioning a real option (drawer / curve / headboard only / side panel /
     infront / one-piece divan) imported with NOTHING ticked. */
  /* A HAND may be written with no space and on either side of the word:
     "Leftside Drawer", "Sidedrawer", "drawer at left", "add on right side
     drawer", "2SIDE DRAWER". The tests below used to demand a space, so
     `Sidedrawer` matched none of them and fell through to the unqualified rule
     beneath - which called it a FRONT drawer. 41 sales lines over 29 sales
     orders were recorded as Front while the customer's own text asked for a
     side one, and the customer of HC-SO-003434 received a delivery order
     printing "Front Drawer" (docs/bugs/0824). */
  if (/LEFT\s*-?\s*(?:HAND\s*)?(?:SIDE\s*)?DRAWER|DRAWER\s*(?:AT\s*)?(?:THE\s*)?LEFT|LEFTSIDE/i.test(s)) o.specials.push("Left Drawer");
  if (/RIGHT\s*-?\s*(?:HAND\s*)?(?:SIDE\s*)?DRAWER|DRAWER\s*(?:AT\s*)?(?:THE\s*)?RIGHT|RIGHTSIDE/i.test(s)) o.specials.push("Right Drawer");
  if (/FRONT\s*-?\s*DRAWER|DRAWER\s*(?:AT\s*)?FRONT|FRONTDRAWER/i.test(s)) o.specials.push("Front Drawer");
  /* A SIDE drawer with no hand named is NOT a front drawer, and which side it
     is cannot be guessed here: the catalogue holds Front / Left / Right and no
     neutral "Side", and the answer lives in the supplier's own record, the
     slip's drawing, or the salesperson. Marked so the repair tool can find it
     and a human can answer it - never silently filed as Front. */
  if (/SIDE\s*-?\s*DRAWER|DRAWER\s*(?:AT\s*)?(?:THE\s*)?SIDE|SIDEDRAWER/i.test(s)
      && !o.specials.some((x) => /drawer/i.test(x))) o.specials.push("Side Drawer (side unknown)");
  if (/DRAWER/i.test(s) && !o.specials.some((x) => /drawer/i.test(x))) o.specials.push("Front Drawer"); // unqualified drawer = front
  if (/DIVAN\s*CURVE|CURVE\s*DIVAN|DO\s*CURVE|EDGE.*CURVE/i.test(s)) o.specials.push("Divan Curve");
  if (/HEADBOARD\s*ONLY|HB\s*ONLY/i.test(s)) o.specials.push("Headboard Only");
  if (/NO\s*SIDE\s*PANEL|WITHOUT\s*(?:SIDE\s*)?PANEL/i.test(s)) o.specials.push("No Side Panel");
  if (/1\s*PIECE\s*DIVAN|ONE\s*PIECE\s*DIVAN/i.test(s)) o.specials.push("1 Piece Divan");
  if (/NYLON/i.test(s)) o.specials.push("Nylon Fabric");
  if (/IN\s*FRONT\s*L|INFRONT\s*L|ADD\s*1.*INFRONT/i.test(s)) o.specials.push('Add 1" Infront L');
  if (/DIVAN\s*TOP\s*\(?W\)?/i.test(s)) o.specials.push("Divan Top(W)");
  if (/DIVAN\s*A11/i.test(s)) o.specials.push("Divan A11");
  if (/SEPARATE\s*BACKREST/i.test(s)) o.specials.push("Separate Backrest Packing");
  // "straight to wall" / "H/B Straight" / "Headboard straight" — all HB Straight
  if (/STRAIGHT\s*TO\s*(?:THE\s*)?WALL|H\/?B\s*STRAIGHT|HEADBOARD\s*STRAIGHT|FLIP\s*ON\s*WALL/i.test(s)) o.specials.push("HB Straight");
  // "pull out" = a pull-out drawer
  if (/PULL\s*OUT|PULLOUT|PUT\s*OUT/i.test(s) && !o.specials.some((x) => /drawer/i.test(x))) o.specials.push("Front Drawer");
  o.specials = [...new Set(o.specials)];
  /* The no-leg default runs early, when several divan rules have not fired yet:
     "frontdrawerdivan12”/PC151-01/gap9" mentions no leg at all, but its divan
     was only found by a later rule, so the default had nothing to key off and
     the line came out with no leg rather than none. Re-apply it once every
     divan rule has had its turn. */
  if (o.leg === undefined && o.divan != null && !/LEG/i.test(s)) o.leg = 0;
  /* ── A HEIGHT STATED AS "NOT CHOSEN YET" ─────────────────────────────────
     TBC/KIV against a height is the SAME owner rule the colour already obeys
     ("TBC/KIV means the colour is not chosen yet", the header above): the
     component exists and its size has not been picked. Recorded as its own
     fact because `o.divan == null` cannot carry it — an absent divan and an
     undecided one are different, and the owner's model treats them
     differently (a divan with no leg mentioned means NO leg; a leg written
     "Leg TBC" means nobody knows).

     Only an EXPLICIT statement counts. Nothing here infers a pending height
     from silence, so a line that never mentions a divan is untouched.

     Measured on the committed book cut (83,610 Desc2 lines): divan 55,
     mattress gap 38, leg 20. All three are written this way by staff, which is
     why all three are read rather than the divan alone.

     The separator between the word and the marker is whatever staff typed —
     a colon, a space, nothing at all ("LegTBC"), or a bracket the wrapper
     strip left behind ("DIVAN: 8 (LEG) KIV"). One character class covers them
     all. There is deliberately NO word boundary after the keyword: "LegTBC" is
     one token to a regex engine, and requiring a boundary there missed the
     book's own `Divan:8"+TBC"legs`.

     The marker also comes BEFORE the word as often as after it — 'TBC"legs',
     '(legs KIV)' — so both orders are read. Neither pattern can run away: the
     separator class holds no letters or digits, so `DIVAN: 8" (LEG) KIV` marks
     the LEG pending and leaves the divan at 8", which is what it says. */
  const SEP = `[\\s:："'’”().+-]*`;
  const MARK = `(?:TBC|KIV)`;
  const pendingFor = (word) =>
    new RegExp(`\\b${word}${SEP}${MARK}\\b|\\b${MARK}${SEP}${word}`, "i").test(s);
  o.divanPending = pendingFor(`DIV(?:AN)?\\.?`);
  o.gapPending = new RegExp(
    `(?:MATT(?:RESS)?|M)?\\s*['’.]?\\s*(?:GAP|GP)${SEP}${MARK}\\b|\\b${MARK}${SEP}(?:M['’.]?\\s*)?(?:GAP|GP)\\b`,
    "i",
  ).test(s);
  o.legPending = pendingFor(`LEGS?`);
  return o;
}

/* THE VARIANTS BLOCK a bedframe line stores, built from one parse.
 *
 * WHY IT LIVES HERE. `parseBedframe` returns the owner's rules DECODED; every
 * writer then has to turn that into the exact jsonb the Fabrics picker and the
 * "Total height (auto)" field read back. That mapping was written out FOUR
 * times - import-ac-outstanding-so.mjs, import-ac-outstanding-po.mjs,
 * topup-ac-po-lines.mjs and now a fifth caller - and all four were byte-for-byte
 * identical at extraction, which is the same state parseBedframe itself was in
 * before it drifted twice (see the header above). A fifth copy is how the next
 * drift happens, so there is now one.
 *
 * The key names MUST match a real UI-created line exactly: the Fabrics picker
 * reads `fabricCode`, and `totalHeight` is what the form shows as
 * "Total height (auto)". `size` is deliberately NOT here - it is not part of
 * what those four writers stored, and lib/po-arm-own-text.mjs's `blockFor`
 * (which does carry `size` and does NOT carry `specials`) answers a different
 * question: it is a COMPARISON projection for a diagnostic, not the block a
 * writer persists.
 *
 * @param {ReturnType<typeof parseBedframe>} bf
 * @param {(colour: string | null | undefined) => ({fabric_id: string, colour_id: string, label: string} | null)} findColour
 *        the fabric-colour resolver from lib/fabric-colour-match.mjs.
 *        A PENDING colour (TBC / KIV) is not looked up: the owner's rule is
 *        that the colour is simply not chosen yet, which is blank, not a miss.
 */
function bedframeVariants(bf, findColour) {
  const fc = isPendingColour(bf.color) ? null : findColour(bf.color);
  const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
  /* ── AN UNDECIDED COMPONENT MAKES THE TOTAL UNKNOWN, NOT SMALLER ─────────
     This block used to read `Divan: TBC / Gap: 12"` as `divanHeight: null`
     — right — and then `totalHeight: '12"'`, which states the bed is twelve
     inches tall. Nobody knows how tall it is: the divan under it has not been
     picked, and `Number(null) || 0` counted "not chosen yet" as ZERO.

     The colour arm one line above already honours the owner's rule that
     TBC/KIV is not-chosen-yet. This is the same rule on the same line of text,
     and the two arms disagreeing is the whole defect.

     THE RECONCILE CANNOT SEE THIS, which is why it survived: the AutoCount
     comparison derives the book's side with THIS SAME EXPRESSION, so both
     sides produce '12"' and the axis reports agreement. tests/
     bedframePendingHeight.test.ts asserts the INTENDED value instead, and was
     run RED against this function before the guard existed: 5 failed, 3
     passed — the 3 being the controls that pin what must NOT change.

     A merely ABSENT component is untouched. `Gap: 12"` on a line that never
     mentions a divan still totals 12", and a divan with no leg mentioned still
     means no leg (0) per the owner's model. Only an explicit TBC/KIV counts. */
  const heightPending = bf.divanPending === true || bf.gapPending === true || bf.legPending === true;
  return {
    fabricId: fc ? fc.fabric_id : null,
    colourId: fc ? fc.colour_id : null,
    fabricCode: fc ? fc.colour_id : null,
    colourLabel: fc ? fc.label : null,
    fabricLabel: fc ? fc.fabric_id : null,
    gap: bf.gap != null ? bf.gap + '"' : null,
    divanHeight: bf.divan != null ? bf.divan + '"' : null,
    legHeight: bf.leg != null ? bf.leg + '"' : null,
    totalHeight: heightPending || !tot ? null : tot + '"',
    specials: bf.specials || [],
  };
}

export { parseBedframe, bedframeVariants };
