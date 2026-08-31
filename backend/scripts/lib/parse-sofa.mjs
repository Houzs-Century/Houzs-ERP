// Shared sofa Desc2 decoder — the owner's compartment grammar, used by BOTH
// the SO and the PO importers so a build decodes identically on either side
// (owner 2026-08-10: "PO 需要用的是我们的 code ... 然后要看什么 supplier").
// Extracted verbatim from import-ac-outstanding-so.mjs; every rule and its
// owner attribution stays with the code.
// ─── SOFA decomposition (owner 2026-08-09: 沙发单按件拆行) ────────────────
// AutoCount writes one line per sofa; the ERP models a build as one line per
// compartment SKU ({model}-{comp}). Rules, all owner-ruled:
//  - token order = physical layout facing the sofa: 2L = L(RHF)+2A(LHF),
//    L2 = L(LHF)+2A(RHF); 1L/L1, 3L/L3 analogous (3-seat side = 2A+1NA).
//  - E = raised armrest (1EL=1A(LHF), 2ER=2A(RHF)); C = corner; C/T = Console;
//    P = 1S(P) power chair; standalone R = 1S(R).
//  - recliners are per-unit mechanisms: R819 "2S + RECLINER" = 1A(R) pair.
//  - PROCESSED orders must decompose fully or fall back (never guess pieces).
const SOFA_MODEL_ALIAS = { "5530": "9028", "5536": "9058", "5537": "8030", "5540": "8030" };
const CM_TO_INCH = { 60: 24, 66: 26, 70: 28, 75: 30, 80: 32 };
/* Vocabulary of the special-order sweep below. Built by reading every slash
   segment of all 716 sofa Desc2 in the three cutover exports and checking that
   nothing left over is an instruction — what remains uncaught is colour codes,
   seat sizes and structure. */
const SPECIAL_WORD = /depth|\b(?:bottom|bttm|umbrella|umb|nylon|nilon|cover\w*|back\s*rest|backrest|back\s*cushion|backcushion|head\s*rest|headrest|cushion|firm\w*|soft\w*|harder|notch|stitch\w*|stich\w*|holes?|push\s*back|extend\w*|separate|packing|bracket|wood\w*|arm\s*rest|armrest|arm|adj\w*table|slider|plane|plain|legs?|height|seating|in\s?front|feeling|stopper|microgel|movable)\b/i;
// "CH141-4 WOOD" is a fabric colour, not a request for a wooden anything
const COLOUR_LIKE = /^[A-Z]{1,6}\s?\d{2,5}\s*[-#]?\s*\d{0,3}\s*\(?[A-Z0-9 ]{0,20}\)?$/i;
/* Instruction phrases that GLUE into one token (spaces are stripped inside a
   segment) and carry digits or the ARM/SEAT letters, so neither the rider rule
   nor SPECIAL_WORD could claim them — each then read as unknown STRUCTURE and
   killed its whole segment ("token \"HEADRESTCHANGETO8030\""). All harvested
   from the 2026-08-30 placeholder sweep; every one is a request, never a piece. */
const INSTRUCTION_TOKEN = /(ARMREST|ARMCHANGE|BACKREST|BACKCUSHION|HEADREST|CUSHION|SEATHEIGHT|SEATERDEPTH|SEATEXTEND|EXTENDTO|FEELING|CUSTOMIZE|READYSTOCK|ADJUSTABLE|INCLINER|PUSHBACK|WOODENPLATE|TAKEOFF|REPLACETO|FOLLOWTHE|SITTINGAREA|SITAREA|SEATAREA|SEATCHANGE|RESTCHANGE)/;
/* An UNLABELLED colour code — "BO315-21 (PEARL)/28"/2L" — was read as an
   unrecognised structure token and thrown away, so the colour never reached the
   line. That is the whole missing-Fabrics bucket on sofa: 85 of 86 blank colour
   axes hold no value at all rather than an unresolvable one.

   It is recovered only through `opts.knownColour`, a predicate the CALLER
   supplies and which must consult scm.fabric_colours. Without it this function
   behaves exactly as before. The asymmetry is deliberate: a code the fabric
   library can confirm is a copy of what AutoCount wrote, and a code it cannot
   confirm is a guess — and this migration does not guess. Sizes and piece
   lists are excluded before the library is consulted so a numeric coincidence
   can never be promoted to a colour. */
/* O-vs-ZERO tolerance. The floor writes the same fabric code both ways —
   "BO315-21" and "B0315-Pearl" are the same cloth — and a code the library
   cannot confirm is FATAL to the structure segment, so one typed zero threw a
   whole build to placeholder (SO-013121, owner review 2026-08-31). Try the
   swapped spellings too; the LIBRARY still has to confirm one of them, so this
   widens the lookup, never the guard. */
function ohZeroVariants(t) {
  const out = new Set([t]);
  out.add(t.replace(/0/g, "O"));
  out.add(t.replace(/O/gi, "0"));
  return [...out];
}
const confirmColour = (knownColour, t) => {
  for (const v of ohZeroVariants(t)) { const hit = knownColour(v); if (hit) return hit; }
  return null;
};

function unlabelledColour(d2raw, knownColour) {
  for (const raw of String(d2raw || "").split(/[/\n]+/)) {
    const seg = raw.trim();
    if (!seg || seg.length > 40) continue;
    const t = seg.replace(/\s*\((?:feather|foam)\)\s*/i, "").trim();
    /* A fabric code always reads letters-then-digits — BO315, CH141, GD2502,
       M2402, SL0095, HR 805. A piece token reads the other way round (2L, 1NA,
       3S), and a size has no letters at all. That one asymmetry separates them
       without having to enumerate the piece vocabulary, which would rot the
       moment a new compartment is minted. */
    if (!/[A-Z]\s?\d/i.test(t)) continue;
    if (/^\d+\s*(?:"|”|inch|cm)?$/i.test(t)) continue;                // a bare size
    if (/^(?:size|seat)\b/i.test(t)) continue;                        // a labelled size
    if (/\+/.test(t) && /^[\d+ACLNPRSTacnprst()\s]+$/.test(t)) continue; // a piece list
    const hit = confirmColour(knownColour, t) || confirmColour(knownColour, t.replace(/\s*\([^)]*\)\s*/g, "").trim());
    if (hit) return { value: typeof hit === "string" ? hit : t, evidence: seg };
  }
  return null;
}

function parseSofa(d2raw, model, recl = false, opts = {}) {
  const o = { pieces: [], size: null, color: null, perPieceColor: {}, specials: [], conf: "high", why: [] };
  if (!d2raw || !String(d2raw).trim()) { o.conf = "low"; o.why.push("empty Desc2"); return o; }
  let d2 = String(d2raw).replace(/[\[\]{}]/g, " ").replace(/[”“″’‘′]/g, '"').replace(/\r/g, "")
    .replace(/\b(?:icnh|inhc|inchs|inc?h?es|ich)\b/gi, "inch").trim();
  /* Same phrase written twice — once by the sweep, once by a rule below, once
     more as a glued rider token — is one instruction. Key on the letters and
     digits only, and let the fuller wording win: "BACKRESTCHANGE8030" and
     "BACK REST CHANGE 8030" are the same request. */
  const skey = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/NILON/g, "NYLON");
  const addSpecial = (t) => {
    const v = String(t ?? "").replace(/\s+/g, " ").replace(/^[\s*]+|[\s*]+$/g, "");
    const k = skey(v);
    if (!k) return;
    for (let i = 0; i < o.specials.length; i++) {
      const e = skey(o.specials[i]);
      if (e.includes(k)) return;
      if (k.includes(e)) { o.specials[i] = v; return; }
    }
    o.specials.push(v);
  };
  /* ── special-order sweep (owner: special order 全部 match 回来) ─────────────
     Read off the ORIGINAL text, before the structure pipeline strips anything,
     and written ONLY to o.specials — the decode below is untouched.
     Two holes this closes. `bottom[^\/\n]*` deletes its whole segment, so all
     53 "bottom use umbrella fabric" / "wrap bottom to umbrella fabric"
     instructions reached the ERP as nothing at all. And the rider path only
     ever sees the ONE segment that carried the structure, so a phrase alone in
     its own segment ("/BACK CUSHION CHANGE 8030") was dropped too. */
  {
    const src = d2.replace(/col(?:our|or)?\s*\([^)]*\)\s*[:：][^\/\n]*/gi, " ")
                  .replace(/col(?:our|or)?\s*[-:：][^\/\n]*/gi, " ");
    for (const chunk of src.split(/[\/\n*]+/)) {
      const c = chunk.trim();
      if (c && SPECIAL_WORD.test(c) && !COLOUR_LIKE.test(c)) addSpecial(c);
    }
  }
  // protect composite tokens from the slash-splitter
  d2 = d2.replace(/\bCUSTOM\b/gi, " ").replace(/([123])S?\s*P\s*\+\s*P\b/gi, "$1PP")
    /* "1R(P)+1R(P)" (SO-011530) — a recliner unit with a POWER mechanism.
       Rewrite before the bracket→'+' conversion frees the P into its own
       mid-row token, which the grammar rightly holds as ambiguous. */
    .replace(/\b([123])R\s*\(\s*P\s*\)/gi, "$1P")
    .replace(/\bCORNER\s*\((?=[^)]*[A-Za-z])/gi, "(").replace(/NO\s*CONSOLE/gi, " NOCONS ")
    .replace(/\bC\s+TABLE\b\.?/gi, "+CT+").replace(/([12])B\/S/gi, "$1B")
    .replace(/\bC\/?T\s*TABLE\.?/gi, "CT").replace(/CONSOLE\s*TABLE\.?/gi, "CT")
    .replace(/\bC\/T\b/gi, "CT").replace(/(\d?NA)\/(L|R)T/gi, "$1$2T").replace(/CONSOLE/gi, "CT");
  // colours: per-piece "colour (2s): X" first, then general COL:/COLOUR:
  d2 = d2.replace(/col(?:our|or)?\s*\(([^)]+)\)\s*[:：]\s*([^\/\n]+)/gi, (_, pc, val) => {
    o.perPieceColor[pc.trim().toUpperCase()] = val.trim(); return " ";
  });
  d2 = d2.replace(/col(?:our|or)?\s*[-:：]\s*([^\/\n]+)/gi, (_, val) => {
    if (!o.color) o.color = val.trim(); return " ";
  });
  /* Read the raw text, not `d2`: by this point the composite-token guards above
     have already rewritten it, and the colour must be the string AutoCount
     actually holds. */
  if (!o.color && typeof opts.knownColour === "function") {
    const u = unlabelledColour(d2raw, opts.knownColour);
    if (u) { o.color = u.value; o.colorEvidence = u.evidence; o.why.push(`colour from an unlabelled code "${u.evidence}"`); }
  }
  /* Colour-first with NO label ("CH141-11 (SILVER)/28”/1A(LHF)+…") stays on
     the #1998 contract: unlabelledColour above reads it ONLY when the fabric
     library confirms the code. An unconfirmed code is left blank, never
     copied — parseSofaUnlabelledColour.test.ts pins both directions. */
  // seat size: inches or cm anywhere (also "(28'Inch)" / "28''" / "28'" / "Size:28")
  const sm = /(\d{2,3})\s*(cm)\b/i.exec(d2) || /(\d{2})\s*(?:['"]{1,2}\s*inch(?:es)?\b|"|''|'(?!\w)|\s*inch(?:es)?\b)/i.exec(d2) || /size\s*[:：]\s*(\d{2})/i.exec(d2);
  if (sm) {
    const n = Number(sm[1]);
    o.size = sm[2] ? String(CM_TO_INCH[n] ?? n) : String(n);
    // strip EVERY unit-carrying size FIRST (before the inch-word cleanup can
    // orphan a number); a differing value means per-piece sizes — owner: 分件尺寸
    d2 = d2.replace(/(\d{2,3})\s*(?:cm\b|['\"]{1,2}\s*inch(?:es)?\b|"|''|'(?!\w)|\s*inch(?:es)?\b)/gi, (mm, num) => {
      if (num !== sm[1]) o._multiSize = true;
      return " ";
    });
    d2 = d2.replace(/['"]*\s*inch(?:es)?\b/gi, " ");
  }
  d2 = d2.replace(/size\s*[:：]/gi, " "); // bare label left behind ("Size:3S(28\")")
  d2 = d2.replace(/\b(TBC|KIV|RANDOM\s*COLOU?R)\b/gi, " "); // noise words glue onto piece tokens ("L2 TBC")
  // owner 2026-08-10: 脚找不到就用 default — leg text never sets a size, it
  // rides as a special so the factory sheet still shows the request.
  {
    const lg = /[^\/\n]*\bleg\b[^\/\n]*/gi.exec(d2);
    /* The sweep has already taken this sentence off the ORIGINAL text. Only
       fall back to the mangled copy when it did not, or the size cleanup's
       leftovers land beside the clean wording ("ADD 1INCH LEG" + "ADD 1 LEG"). */
    if (lg) { if (!o.specials.some((s) => /leg/i.test(s))) addSpecial(lg[0]); d2 = d2.replace(/[^\/\n]*\bleg\b[^\/\n]*/gi, " "); }
  }
  // specials that ride along
  if (/nylon|nilon/i.test(d2)) addSpecial("nylon");
  if (/(left|right)?\s*side?\s*woo[rd]+e?r?n?\s*arm/i.test(d2) || /wood\w*\s*arm/i.test(d2)) addSpecial("wooden arm");
  const hasRecliner = /recliner/i.test(d2) && recl;
  if (/recliner/i.test(d2) && !recl) o.why.push("写了 recliner 但此款无 recliner 件 — 请核对");
  d2 = d2.replace(/bottom[^\/\n]*|(left|right)?side?woo[rd]+e?r?n?\s*arm[^\/\n]*|wood\w*\s*arm[^\/\n]*|recliner/gi, " ");
  // find the structure segment: the chunk with piece tokens
  const segs = d2.split(/[\/\n,]+/).map((s) => s.trim()).filter(Boolean);
  const P = (c) => o.pieces.push(c);
  const seatSide = (n, side) => (n === "3"
    ? (side === "L" ? ["2A(LHF)", "1NA"] : ["1NA", "2A(RHF)"])
    : n === "4" // owner 2026-08-10: "4S 就是 2A 加 2A 来的"
    ? (side === "L" ? ["2A(LHF)", "2NA"] : ["2NA", "2A(RHF)"])
    : [`${n === "1" ? "1A" : "2A"}(${side === "L" ? "LHF" : "RHF"})`]);
  let matched = false;
  const orderedSegs = [...segs].sort((a, b) => (b.includes("+") ? 1 : 0) - (a.includes("+") ? 1 : 0));
  for (const rawSeg of orderedSegs) {
    // a label followed by a parenthesised BUILD is just a title: the bracket
    // wins (owner 2026-08-10: "2R(1+1) 就是 1A+1A"; "2 seater (1EL+1ER)").
    // Guarded to brackets holding a '+', so "4S (corner)+L" keeps its label.
    // The title may be letter-led too — "L2L(L+1NA+1NA+L)" (SO-008166).
    const seg = rawSeg.replace(/^\s*[A-Za-z0-9]{1,8}\s*\(([^)]*\+[^)]*)\)\s*$/, "$1")
      .replace(/^\s*[1-4]\s*[A-Za-z]{0,8}\s*\(([^)]*\+[^)]*)\)\s*$/, "$1");
    // spaces glue ("3 SEATER"->3SEATER) but paren notes become their own
    // tokens ("(HANDLE MOVABLE)"->+HANDLEMOVABLE+); quotes are residue
    let s = seg.replace(/\s+/g, "").toUpperCase().replace(/[()]/g, "+").replace(/["'*]/g, "").replace(/:/g, "+").replace(/\.(?![5])/g, "+");
    // owner layout rule: bare "n+L" == "nL"; "L+n" == "Ln"
    if (s.split("+").filter(Boolean).length === 2)
      s = s.replace(/(^|\+)([123])\+L(?=$|\+)/, "$1$2L").replace(/(^|\+)L\+([123])(?=$|\+)/, "$1L$2");
    /* NEW-STYLE tokens (staff entries since ~2026-08, SO-0131xx onward, mirror
       the ERP's own compartment spelling): "1A(LHF)+C+2A(RHF)" and bare-end
       chains "2A+1A(30')". After ()->+ the side rides as its own token, so
       fold A+side into the E-notation the grammar already speaks — 1A+LHF is
       1EL — and give a BARE A-piece its side by POSITION, the owner's sketch
       rule (草图两端阴影=扶手: the chain's two ends are the armed ends): first
       faces LEFT, last faces RIGHT. A bare A-piece in the MIDDLE stays
       unclassified and holds the line — an arm mid-row is a real ambiguity,
       not a spelling. A side marker after 1B/NA has no sided grammar class;
       position already places those, so the marker is dropped. */
    s = s.replace(/^\++|\++$/g, ""); // stripped sizes/notes leave dangling '+', which breaks the end anchors below
    s = s
      .replace(/(^|\+)([12])A\+(?:LHF|LHS|LF)(?=$|\+)/g, "$1$2EL")
      .replace(/(^|\+)([12])A\+(?:RHF|RHS|RF)(?=$|\+)/g, "$1$2ER")
      .replace(/(^|\+)([12])(B|NA)\+(?:LHF|LHS|RHF|RHS)(?=$|\+)/g, "$1$2$3");
    if (s.includes("+")) {
      s = s.replace(/^([12])A(?=\+)/, "$1EL").replace(/\+([12])A$/, "+$1ER");
    }
    if (!s || /^[\d.]+\+*$/.test(s)) continue;
    /* The single-letter arm of NOISE must exclude EVERY letter the grammar
       classifies on its own: C (corner), L (chaise), P (power), R (recliner).
       It was written [A-KM-OQ-Z] — L and P excluded, C and R NOT — so a bare
       "C" and a bare "R" were dropped here, before reaching :125 / :129, and
       the build then decoded at HIGH confidence one compartment short:
       "1+C+2" came out as 1S + 2S with no corner, no placeholder, no flag.
       35 SO / 4 PO / 10 SO-linked-PO lines in the committed exports. */
    const NOISE = /^(RANDOM(COLOU?R)?|COLOU?RTBC|COLOU?R|TBC|KIV|WRAP|PERSEAT|X?\d*PILLOWS?|FOC\w*|FREE\w*|NORMALARM\w*|NOCONS|X?\d+SETS?|CUSTOM|\d+X\d*|SEATERS?|[A-BD-KM-OQS-Z])$/;
    const quiet = [], rider = [];
    const toks = [];
    for (const t0 of s.split("+").filter(Boolean)) {
      // "IEL+C+INA+IER" — letter I typo'd for digit 1; "23793RR" — the model
      // code glues onto its own pieces ("2379 60cm 3RR")
      let t = t0.replace(/^I(?=(?:E?[LR]|NA|S)$)/, "1").replace(/^SOFA(?=.)/, "");
      if (model && t.startsWith(model) && t.length > model.length) t = t.slice(model.length);
      if (NOISE.test(t)) { quiet.push(t0); continue; }
      toks.push(t);
    }
    if (!toks.length) continue;
    // phase 1 — classify every token (owner grammar 2026-08-09/10)
    const U = [];
    let bad = null;
    for (const t of toks) {
      let m;
      if ((m = /^([123])L$/.exec(t))) U.push({ k: "nL", n: m[1], dir: "R", raw: t });
      else if ((m = /^L([123])$/.exec(t))) U.push({ k: "nL", n: m[1], dir: "L", raw: t });
      else if ((m = /^([123])(RR|PP)$/.exec(t)) && (recl || model === "R819")) U.push({ k: "mech", n: m[1], M: m[2][0], raw: t });
      else if ((m = /^([123])(R|P)$/.exec(t)) && model === "R819") U.push({ k: "mech", n: m[1], M: m[2], raw: t });
      else if ((m = /^([1234])$/.exec(t))) U.push({ k: "unit", n: m[1], raw: t });
      else if ((m = /^([1234])S(?:EATER|ETEAR)?$/.exec(t))) U.push({ k: "seat", n: m[1], raw: t });
      else if (/^(TO|USE)?8030$/.test(t)) rider.push(t);
      else if (/^2\.5S?$/.test(t)) U.push({ k: "seat", n: "2", raw: t, note: "2.5S→2S(owner:座深照写)" });
      else if ((m = /^([12])NA$/.exec(t))) U.push({ k: "na", n: m[1], raw: t });
      else if ((m = /^([12])B$/.exec(t))) U.push({ k: "bseat", n: m[1], raw: t }); // owner: 1B 我们有
      else if (t === "1C") U.push({ k: "corner", raw: t });                        // owner: 1C 是 corner
      else if (t === "2G1F") U.push({ k: "g2f1", raw: t });                        // owner: 2G1F = 2A+C+1A
      else if (t === "CS") U.push({ k: "console", raw: t });                       // owner: CS = console
      else if (t === "3R" && recl && model !== "R819") U.push({ k: "r3", raw: t }); // owner: 3R = 1AR+2A
      else if (t === "3R") U.push({ k: "seat", n: "3", raw: t, note: "3R(此款无recliner,按3S解)" }); // 无recliner款
      else if (/^BACK(REST|CUSHION)\w*\d*$/.test(t)) rider.push(t);               // special: backrest->8030
      else if ((m = /^1?NA([LR])T$/.exec(t))) U.push({ k: "box", side: m[1], raw: t }); // owner: 1ABOX
      else if ((m = /^([12])E([LR])$/.exec(t))) U.push({ k: "armed", n: m[1], side: m[2], raw: t });
      else if (t === "1R" && recl) U.push({ k: "runit", raw: t }); // owner: 1R 是 1AR;单件=1S(R)
      else if (t === "1R") U.push({ k: "armed", n: "1", side: "R", raw: t }); // 无recliner款: R=右
      else if (t === "2R") U.push({ k: "armed", n: "2", side: "R", raw: t, flag2r: recl });
      else if (/^([12])E$/.test(t)) U.push({ k: "eside", raw: t }); // owner: E 少了 L/R
      else if (t === "1P") U.push({ k: "pw", raw: t });
      else if (t === "L") U.push({ k: "chaise", raw: t });
      else if (t === "C" || t === "CNR" || t === "CORNER") U.push({ k: "corner", raw: t });
      else if (t === "CT" || t === "C-T") U.push({ k: "console", raw: t });
      else if (/^STOOL/.test(t)) U.push({ k: "stool", raw: t });
      else if (t === "P") U.push({ k: "pw", raw: t });
      else if (t === "R" && recl) U.push({ k: "rc", raw: t });
      else if (t === "LSHAPE") { U.push({ k: "nL", n: "2", dir: "R", raw: t }); o._photo = "L-shape≈2L,左右随放—看图可换"; }
      /* ── 2026-08-30 placeholder-sweep vocabulary ─────────────────────────
         Every arm below is a real book spelling from the 103-placeholder
         audit (run 33251287997); the gold cases live in
         parseSofaGrammar.test.ts under the same date. */
      else if (/^([12])CT$/.test(t)) U.push({ k: "console", raw: t });        // "1Console"→1CT (SO-012695)
      else if ((m = /^([12])EF([LR])$/.exec(t))) U.push({ k: "armed", n: m[1], side: m[2], raw: t }); // 1EFL=1EL (SO-010324)
      else if ((m = /^([12])BSEATERS?$/.exec(t))) U.push({ k: "bseat", n: m[1], raw: t }); // "1B/S seater" glued (SO-013329)
      else if ((m = /^([123])POWER(?:RE|IN)CLINERS?$/.exec(t)) && recl) U.push({ k: "mech", n: m[1], M: "P", raw: t });
      else if (/^([23]\d)$/.test(t)) {
        // an orphan size whose unit was stripped ("(26/28'Inch)" SO-010015) — never a piece
        if (!o.size) { o.size = t; o.why.push(`size from bare "${t}"`); }
        else if (t !== o.size) o._multiSize = true;
        quiet.push(t);
      }
      else if (t === model || SOFA_MODEL_ALIAS[t]) quiet.push(t);             // model rider ("back rest (5540)" SO-013312)
      else if (/^COLOU?R.+/.test(t)) quiet.push(t);                           // a glued colour mention — colour reads off the RAW text, never here
      else if (/[A-Z]\d|\d[A-Z]/.test(t) && typeof opts.knownColour === "function" && confirmColour(opts.knownColour, t)) {
        // a library-CONFIRMED colour code inside the structure segment (SO-013121);
        // an unconfirmed code stays fatal — this migration does not guess colours
        if (!o.color) { o.color = confirmColour(opts.knownColour, t); o.why.push(`colour token "${t}"`); }
        quiet.push(t);
      }
      else if (t === "ARM" || t === "ARMREST" || (t.length >= 6 && INSTRUCTION_TOKEN.test(t))) {
        rider.push(t);                                                        // digit-bearing instruction — a request, never a piece
      }
      else if (!/\d/.test(t) && t.length >= 3 && !/(ARM|SEAT|CUSTOM|RECLIN|WOOD|SHAPE|CORNER|CHAISE)/.test(t)
               && !/^(CT|CNR|STOOL|NA)/.test(t)) rider.push(t);
      else { bad = `token "${t}"`; break; }
    }
    if (bad) { o.why.push(bad); continue; }
    // phase 2 — assemble (owner 2026-08-10: 一套沙发只有左右两个闭端;
    // console 放中间;连排里 nS/裸数/R/P 都是单臂件,端头带外侧扶手)
    const out = [];
    const single = U.length === 1;
    const hasConn = U.some((u) => ["chaise", "corner", "console", "nL", "box"].includes(u.k));
    const anyConn = U.some((u) => ["chaise", "corner", "console", "nL", "box", "na"].includes(u.k));
    if (!anyConn && U.some((u) => u.k === "seat"))
      for (const u of U) if (u.k === "unit") u.k = "seat";
    /* suite notation: 1+2+3 / R+2+3 — THREE or more distinct digits, nothing
       joining them, is a SUITE of separate sofas. TWO digits is not: owner
       2026-08-31, 「1+2 这种大部分是 1A+2A」 — a two-token run is one sofa whose
       ends carry the arms, which is what the end-walk below produces. This
       said `>= 2` until then and turned every `1+2` into two standalone
       sofas. */
    if (!anyConn && U.length >= 3 && U.every((u) => ["unit", "seat", "rc", "runit", "pw"].includes(u.k))) {
      const digits = U.filter((u) => u.k === "unit" || u.k === "seat").map((u) => u.n);
      if (digits.length >= 3 && new Set(digits).size === digits.length) {
        for (const u of U) { if (u.k === "unit") u.k = "seat"; u.solo = true; }
      }
    }
    const seatUnits = U.filter((u) => u.k === "unit" || u.k === "seat");
    let hold = null;
    if (!single && U.length === 2 && seatUnits.length === 1 && U.some((u) => u.k === "console")) {
      // owner: "2s+console 一定分开的 1A+1A, console 才能放中间"
      const n = seatUnits[0].n;
      if (n === "2") out.push("1A(LHF)", "Console", "1A(RHF)");
      else if (n === "3") { out.push("2A(LHF)", "Console", "1A(RHF)"); o._photo = "3拆2A+1A绕console(2A左按写序)"; }
      else { out.push("1A(LHF)", "Console"); o._photo = "1件+console 布局看图"; }
      if (seatUnits[0].note) o.why.push(seatUnits[0].note);
    } else if (!single && U.some((u) => u.k === "nL" && u.n !== "1")) {
      // "2L" beside other pieces would fold a whole 2A+L set mid-row — still held
      o.why.push(`"${U.find((u) => u.k === "nL" && u.n !== "1").raw}" 与其他件并列 — 歧义,看图`);
      continue;
    } else {
      // "2R+1L" = 2A+L (owner): a 1L beside other pieces is ONE chaise at its
      // position; side is provisional (owner: left/right 放先,之后让他们改)
      if (U.length === 3) {
        const ci = U.findIndex((u) => u.k === "console");
        const others = U.filter((u) => u.k !== "console");
        if ((ci === 0 || ci === U.length - 1) && others.length === 2 &&
            others.every((u) => ["unit", "seat", "armed", "na", "bseat", "runit", "rc", "pw"].includes(u.k))) {
          const [con] = U.splice(ci, 1);
          U.splice(1, 0, con);
        }
      }
      if (!single && U.some((u) => u.k === "nL")) {
        for (const u of U) if (u.k === "nL") u.k = "chaise";
        o._photo = (o._photo ? o._photo + "; " : "") + "1L并排=贵妃,边先放—看图可换";
      }
      for (let i = 0; i < U.length && !hold; i++) {
        const u = U[i];
        const end = i === 0 ? "L" : i === U.length - 1 ? "R" : null;
        if (u.note) o.why.push(u.note);
        switch (u.k) {
          case "nL":
            if (u.dir === "R") { seatSide(u.n, "L").forEach((x) => out.push(x)); out.push("L(RHF)"); }
            else { out.push("L(LHF)"); seatSide(u.n, "R").forEach((x) => out.push(x)); }
            break;
          case "mech":
            ({ "1": [`1S(${u.M})`], "2": [`1A(${u.M})(LHF)`, `1A(${u.M})(RHF)`], "3": [`1A(${u.M})(LHF)`, "1NA", `1A(${u.M})(RHF)`] })[u.n].forEach((x) => out.push(x));
            break;
          case "unit": // bare digit: owner "1A+1A=1+1" — multi row means one-arm units
            if (single || u.solo) { if (u.n === "4") out.push("2A(LHF)", "2A(RHF)"); else out.push(`${u.n}S`); }
            else if (end) { seatSide(u.n, end).forEach((x) => out.push(x)); if (u.n === "4") o._photo = "4S在连排,2A+2NA按端位—看图"; }
            else { out.push(`${u.n === "1" ? "1" : "2"}NA`); o._photo = (o._photo ? o._photo + "; " : "") + `中排 ${u.raw}=NA—看图核`; }
            break;
          case "seat": /* explicit nS. Standalone only when it IS alone or the
               suite rule marked it solo — NOT merely because no connector token
               is present: owner 2026-08-31, 「1+2 这种大部分是 1A+2A」, and the
               drawings agree (SO-006941's `2+1S` has two arms, at the two ends,
               i.e. ONE run). `!hasConn` used to force standalone here, so
               `2s+1s` came out as two sofas while the bare-digit `1+2` came out
               as a run — the same order written two ways, decoded two ways. */
            if (single || u.solo) { if (u.n === "4") out.push("2A(LHF)", "2A(RHF)"); else out.push(`${u.n}S`); } // owner: 4S=2A+2A
            else if (end) { seatSide(u.n, end).forEach((x) => out.push(x)); if (u.n === "4") o._photo = "4S在连排,2A+2NA按端位—看图"; }
            else { out.push(`${u.n === "1" ? "1" : "2"}NA`); o._photo = (o._photo ? o._photo + "; " : "") + `中排 ${u.raw}=NA—看图核`; }
            break;
          case "na": out.push(`${u.n}NA`); break;
          case "box": out.push(`1ABOX(${u.side === "L" ? "LHF" : "RHF"})`); break;
          case "armed":
            if (single) { out.push(`${u.n}S`); break; } // owner: 单件 1ER=1S、2ER=2S
            out.push(`${u.n}A(${u.side === "L" ? "LHF" : "RHF"})`);
            if (u.flag2r) o._photo = (o._photo ? o._photo + "; " : "") + "2R按右扶手解,若是recliner看图";
            if (!end && !single) o._midArm = true;
            break;
          case "runit": // owner 2026-08-10: 2379 很多 1R 就是 1S(R)
            if (single || u.solo) out.push("1S(R)");
            else if (end) out.push(`1A(R)(${end === "L" ? "LHF" : "RHF"})`);
            else { out.push("1A(R)(RHF)"); o._photo = (o._photo ? o._photo + "; " : "") + "中排1R边先放—看图"; }
            break;
          case "eside": {
            const n = u.raw[0] === "2" ? "2" : "1";
            if (single && n === "1") out.push("1S");
            else out.push(`${n}A(${end === "L" ? "LHF" : "RHF"})`);
            o._photo = (o._photo ? o._photo + "; " : "") + "E没写左右,先放—看图可换";
            break;
          }
          case "chaise": out.push(i === 0 ? "L(LHF)" : "L(RHF)"); break;
          case "corner":
            if (single) { out.push("2A(LHF)", "CNR", "1A(RHF)"); o._photo = "corner单写=2A+C+1A,左右看图"; }
            else out.push("CNR");
            break;
          case "bseat": {
            const bs = end ?? "R";
            out.push(`${u.n}B(${bs === "L" ? "LHF" : "RHF"})`);
            if (!end && !single) o._photo = (o._photo ? o._photo + "; " : "") + `中排${u.n}B边先放—看图`;
            break;
          }
          case "g2f1": out.push("2A(LHF)", "CNR", "1A(RHF)"); break;
          case "r3": // owner: 3R = 1AR+2A (写序左→右), photo-verify sides
            out.push("1A(R)(LHF)", "2A(RHF)"); o._photo = (o._photo ? o._photo + "; " : "") + "3R=1AR+2A,边按写序—看图";
            break;
          case "console": out.push("Console"); break;
          case "stool": out.push("STOOL"); break;
          case "pw":
            if (single || u.solo) out.push("1S(P)");
            else if (end) out.push(`1A(P)(${end === "L" ? "LHF" : "RHF"})`);
            else hold = `"P" 在中排 — 看图`;
            break;
          case "rc": // owner: "R+R" = 1AR+1AR
            if (single || u.solo) out.push("1S(R)");
            else if (end) out.push(`1A(R)(${end === "L" ? "LHF" : "RHF"})`);
            else hold = `"R" 在中排 — 看图`;
            break;
        }
      }
      if (hold) { o.why.push(hold); continue; }
    }
    // owner 2026-08-10: "不可能两个扶手的,2NA 放在中间嘛" — an armed piece
    // written mid-row swaps with an armless END piece (arms only ever close
    // the run); side follows the end it lands on. Photo-flagged.
    if (out.length >= 3) {
      const isArm = (c) => /^\d?A/.test(c.replace(/^1S/, "X"));
      const isNAp = (c) => /^\dNA$/.test(c);
      for (let i = 1; i < out.length - 1; i++) {
        if (!isArm(out[i])) continue;
        const side = isNAp(out[0]) ? "L" : isNAp(out[out.length - 1]) ? "R" : null;
        if (!side) continue;
        const j = side === "L" ? 0 : out.length - 1;
        const moved = out[i].replace(/\((LHF|RHF)\)\s*$/, "") + (side === "L" ? "(LHF)" : "(RHF)");
        const na = out[j];
        out.splice(i, 1, na);
        out[j] = moved;
        o._photo = (o._photo ? o._photo + "; " : "") + "扶手件归位到端(中间只能NA)—看图核";
        o._midArm = false;
        break;
      }
    }
    // owner 2026-08-10: 一张单的扶手只会一左一右,不会 right+right / left+left.
    // Same-side closures auto-correct by position (leftmost→LHF, rightmost→RHF).
    {
      const sided = [];
      for (let i = 0; i < out.length; i++) if (/\((LHF|RHF)\)$/.test(out[i])) sided.push(i);
      if (sided.length >= 2) {
        const first = sided[0], last = sided[sided.length - 1];
        const sideOf = (c) => (/\(LHF\)$/.test(c) ? "L" : "R");
        if (sideOf(out[first]) === sideOf(out[last])) {
          out[first] = out[first].replace(/\((LHF|RHF)\)$/, "(LHF)");
          out[last] = out[last].replace(/\((LHF|RHF)\)$/, "(RHF)");
          o._photo = (o._photo ? o._photo + "; " : "") + "同边扶手按位置纠正—看图核";
        }
      }
    }
    quiet.forEach((n) => o.why.push(`note "${n}"`));
    rider.forEach((n) => { addSpecial(n); o.why.push(`note "${n}"`); o._noteDemote = true; });
    if (out.length) { o._seg = rawSeg; out.forEach(P); matched = true; break; }
  }
  if (matched) {
    // GUARD (owner: proceed 单件必须对) — if any OTHER segment still contains
    // piece-looking tokens, the structure was split by punctuation and we may
    // have silently dropped pieces. Never half-parse: demote to placeholder.
    const PIECE_RE = /(^|[+\s(])(?:[123]S?|[12]NA|[12]E?[LR]|L[123]?|CT|CNR|C|STOOL|P|R)(\)|[+\s]|$)/;
    for (const seg of segs) {
      if (seg === o._seg) continue;
      const s = seg.replace(/\s+/g, "").toUpperCase();
      if (/^[\d."']+$/.test(s)) continue;
      if (s.includes("+") && PIECE_RE.test(s)) { o.pieces = []; o.conf = "low"; o.why.push(`structure split across segments ("${seg}")`); matched = false; break; }
    }
  }
  // C/T sits inside a slash-split seg; catch it on the raw text
  if (matched && /C\/T|CONSOLE/i.test(String(d2raw).replace(/NO\s*CONSOLE/gi, " ")) && !o.pieces.includes("Console")) o.pieces.push("Console");
  // owner 2026-08-10: "3s 都是[拆 2A+1A] 除非 seat size 24"
  if (matched && o.size && o.size !== "24" && o.pieces.includes("3S")) {
    const nx = [];
    for (const c of o.pieces) (c === "3S" ? nx.push("2A(LHF)", "1A(RHF)") : nx.push(c));
    o.pieces = nx;
    o.why.push("3S→2A+1A(owner 定规:座深≠24\" 必拆)");
  }
  if (hasRecliner) {
    // mechanism rule: seats become per-unit recliner pieces
    const conv = { "2S": ["1A(R)(LHF)", "1A(R)(RHF)"], "1S": ["1S(R)"], "3S": ["1A(R)(LHF)", "1NA", "1A(R)(RHF)"] };
    const next = [];
    for (const c of o.pieces) (conv[c] || [c]).forEach((x) => next.push(x));
    o.pieces = next;
  }
  if (!matched) { o.conf = "low"; if (!o.why.length) o.why.push("no structure tokens"); }
  else if (!o.size) { o.conf = "medium"; o.why.push("no seat size"); }
  else if (o._midArm || o._noteDemote || o._photo || o._multiSize) {
    o.conf = "medium";
    if (o._midArm) o.why.push("armed piece mid-row (owner: likely at outer end) — photo-verify");
    if (o._photo) o.why.push(o._photo);
    if (o._multiSize) o.why.push("多尺寸分件 — 各件尺寸看备注/图");
  }
  return o;
}


export { SOFA_MODEL_ALIAS, CM_TO_INCH, parseSofa };
