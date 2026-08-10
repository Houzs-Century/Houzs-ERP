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
function parseSofa(d2raw, model, recl = false) {
  const o = { pieces: [], size: null, color: null, perPieceColor: {}, specials: [], conf: "high", why: [] };
  if (!d2raw || !String(d2raw).trim()) { o.conf = "low"; o.why.push("empty Desc2"); return o; }
  let d2 = String(d2raw).replace(/[\[\]{}]/g, " ").replace(/[”“″’‘′]/g, '"').replace(/\r/g, "")
    .replace(/\b(?:icnh|inhc|inchs|inc?h?es|ich)\b/gi, "inch").trim();
  // protect composite tokens from the slash-splitter
  d2 = d2.replace(/\bCUSTOM\b/gi, " ").replace(/([123])S?\s*P\s*\+\s*P\b/gi, "$1PP")
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
    if (lg) { o.specials.push(lg[0].trim().replace(/^[*\s]+/, "")); d2 = d2.replace(/[^\/\n]*\bleg\b[^\/\n]*/gi, " "); }
  }
  // specials that ride along
  if (/nylon|nilon/i.test(d2)) o.specials.push("nylon");
  if (/(left|right)?\s*side?\s*woo[rd]+e?r?n?\s*arm/i.test(d2) || /wood\w*\s*arm/i.test(d2)) o.specials.push("wooden arm");
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
    const seg = rawSeg.replace(/^\s*[1-4]\s*[A-Za-z]{0,8}\s*\(([^)]*\+[^)]*)\)\s*$/, "$1");
    // spaces glue ("3 SEATER"->3SEATER) but paren notes become their own
    // tokens ("(HANDLE MOVABLE)"->+HANDLEMOVABLE+); quotes are residue
    let s = seg.replace(/\s+/g, "").toUpperCase().replace(/[()]/g, "+").replace(/["'*]/g, "").replace(/:/g, "+").replace(/\.(?![5])/g, "+");
    // owner layout rule: bare "n+L" == "nL"; "L+n" == "Ln"
    if (s.split("+").filter(Boolean).length === 2)
      s = s.replace(/(^|\+)([123])\+L(?=$|\+)/, "$1$2L").replace(/(^|\+)L\+([123])(?=$|\+)/, "$1L$2");
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
    // suite notation: 1+2+3 / R+2+3 — distinct digits, nothing joining them
    if (!anyConn && U.length >= 2 && U.every((u) => ["unit", "seat", "rc", "runit", "pw"].includes(u.k))) {
      const digits = U.filter((u) => u.k === "unit" || u.k === "seat").map((u) => u.n);
      if (digits.length >= 2 && new Set(digits).size === digits.length) {
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
          case "seat": // explicit nS: suite when standalone-ish, one-arm unit beside connectors
            if (single || u.solo || !hasConn) { if (u.n === "4") out.push("2A(LHF)", "2A(RHF)"); else out.push(`${u.n}S`); } // owner: 4S=2A+2A
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
    rider.forEach((n) => { o.specials.push(n); o.why.push(`note "${n}"`); o._noteDemote = true; });
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
