#!/usr/bin/env node
// READ-ONLY. The FINAL completeness audit of the cutover: is every sofa and
// bedframe line that the factory builds from actually fully specified?
//
// Owner 2026-08-10 says of the four things that matter: "全部有了". This script
// is what tests that sentence, one number per claim. It measures FOUR facts over
// TWO populations, split SOFA vs BEDFRAME, and then whether the SO and the PO
// raised from it still agree:
//
//   1. COMPARTMENT    sofa: the line carries a real minted compartment SKU and
//                     the build's compartments still match the AutoCount Desc2.
//                     A line that fell back to the bare 1S placeholder is
//                     reported APART from a line that is genuinely one seat —
//                     see the bare-1S census (owner 2026-09-04). Both are a
//                     "-1S" code; only the first is work.
//                     bedframe: a bedframe has no compartments — its equivalent
//                     is SIZE. Standard sizes live in the item-code suffix
//                     (S/SS/Q/K/SK); anything else is (SP) and MUST carry its
//                     dimensions in variants.size.
//   2. SEAT SIZE      sofa: the seatHeight ∥ depth axis. A bedframe has no seat,
//                     so its dimensional axes are the ones asked of it instead:
//                     Divan Height + Leg Height + Gap, with the DIVAN ONLY /
//                     divanless exemptions applied.
//   3. COLOUR         the fabric axis is present AND the value resolves to a
//                     colour that exists in scm.fabric_colours. A code nobody
//                     can look up is not a colour, it is a string.
//   4. SPECIAL ORDER  where the AutoCount Desc2 asked for something, the line
//                     carries the picker code for it — and where no picker code
//                     exists, the phrase itself, which is the owner's rule:
//                     "没有的才用 customs others 那边写进去".
//   5. SO -> PO       for a PO line dedicated to an SO line, the compartment
//                     MULTISET and every variant axis agree.
//
// Everything is re-derived with the SAME modules the writers use — parse-sofa,
// parse-bedframe, variant-axes, fabric-colour-match and the two special-order
// mappers — so the audit and the backfills cannot disagree about what "correct"
// means. Compartments are compared as a case-insensitive MULTISET, never by row
// order: line_no is a storage order, not a physical layout.
//
// No writes, no DDL. There is deliberately no APPLY.
import postgres from "postgres";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
import { missingVariantAxes } from "./lib/variant-axes.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { K, mapPhrase as mapSofaPhrase, skey } from "./lib/sofa-special-map.mjs";
import { mapSpecial as mapBedframeSpecial } from "./lib/bedframe-special-map.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";
/* "the book itself says one seat" — both halves of that question, and the two
   production lines that prove each half is needed, live in the module. */
import { isSingleSeatBuild } from "./lib/sofa-single-seat.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const LIST = process.env.LIST !== "0";
const CAP = Number(process.env.CAP || 25); // per-cell detail cap
/* The sales-order population is normally "orders that have a Processing Date" —
   what the factory is building from. ALL_SO=1 drops that filter so the question
   "is there any un-decoded build ANYWHERE" can be asked too: a placeholder on a
   CONFIRMED order is invisible to the default population and becomes the
   factory's problem the moment it proceeds. Default unchanged. */
const ALL_SO = process.env.ALL_SO === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
/* The ONE name of the Processing Date column, spliced as SQL text rather than
   bound as a parameter — see lib/so-processing-date.mjs for why. */
const PDATE = soProcessingDateFragment(sql);

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const pick = (v, keys) => { for (const k of keys) { const x = txt((v || {})[k]); if (x) return x; } return ""; };
const isPending = (c) => /(TBC|KIV)/i.test(c || "");

/* custom_specials holds THREE shapes in production and a reader that assumes
   one of them measures the wrong thing. The 2026-08-10 backfill bound
   JSON.stringify(next) to a $1::jsonb parameter and postgres.js JSON-encodes a
   value bound to jsonb anyway, so those rows hold a jsonb STRING whose text is
   a JSON array - "[\"Nylon Fabric\"]" - not a jsonb array. Array.isArray() sees
   nothing there, which is exactly how check-specials-and-ocr.mjs first read
   those lines as carrying no specials at all (#1913). Coerce so the payload can
   be MEASURED, and count the shape defect separately: the Special Orders picker
   binds to an array, so a double-encoded line is invisible in the UI even
   though the data is present. */
const asList = (v) => {
  if (Array.isArray(v)) return { list: v, wrapped: false };
  if (typeof v === "string" && v) {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return { list: p, wrapped: true }; } catch { /* a bare string payload */ }
    return { list: [v], wrapped: true };
  }
  return { list: [], wrapped: false };
};
// some rows carry { label | description } objects rather than plain strings
const elText = (el) => {
  if (el == null) return "";
  if (typeof el === "string") return el;
  if (typeof el === "object") { const v = el.label ?? el.description ?? el.name ?? el.value; return typeof v === "string" ? v : ""; }
  return String(el);
};

const modelOf = (code) => {
  const c = norm(code);
  const dash = c.indexOf("-");
  const base = dash < 0 ? c : c.slice(0, dash);
  return SOFA_MODEL_ALIAS[base] || base;
};
const compartmentOf = (code) => {
  const c = norm(code);
  const dash = c.indexOf("-");
  return dash < 0 ? "" : c.slice(dash + 1);
};
// standard bedframe sizes are written into the code as a suffix by the importer
// (import-ac-outstanding-so.mjs's SIZE table); everything else is (SP).
const STD_SIZE = /\((SK|SS|S|Q|K)\)/i;
const SPECIAL_SIZE = /\(SP\)/i;

/* ---- the grid ------------------------------------------------------------
   16 cells: 4 sections x {PO, SO} x {sofa, bedframe}. A cell counts LINES, so
   every number in the grid is comparable; a build-level finding marks each of
   its lines. `note` carries the states that are NOT defects (source says TBC,
   Desc2 undecodable) so they can be named rather than buried in a total. */
const SECTIONS = ["1 COMPARTMENT", "2 SEAT SIZE", "3 COLOUR", "4 SPECIAL ORDER"];
const POPS = ["PO", "SO"];
const GRPS = ["sofa", "bedframe"];
const CELLS = new Map();
for (const s of SECTIONS) for (const p of POPS) for (const g of GRPS)
  CELLS.set(`${s}|${p}|${g}`, { total: 0, ok: 0, bad: [], note: new Map() });
const cell = (s, p, g) => CELLS.get(`${s}|${p}|${g}`);
const note = (c, k, n = 1) => c.note.set(k, (c.note.get(k) || 0) + n);
const score = (c, r, reasons) => {
  c.total++;
  if (!reasons.length) { c.ok++; return; }
  // a defect on a document nobody will build is still counted, but it is named
  // so the number cannot be read as worse than it is
  if (r.dead) note(c, `incomplete AND ${r.dead}`);
  c.bad.push(`  ${r.doc}${r.ac ? ` (AC ${r.ac})` : ""}  ${r.grp === "sofa" ? modelOf(r.code) : r.code}  ${r.grp === "sofa" ? r.code : ""}`.trimEnd()
    + "\n" + reasons.map((x) => `     - ${x}`).join("\n")
    + (r.dead ? `\n     (${r.dead})` : ""));
};

/* One AutoCount sofa line becomes many ERP rows; they share the document, the
   model and the Desc2, which is what makes a build recoverable here. */
function groupSofaBuilds(rows) {
  const g = new Map();
  for (const r of rows) {
    if (r.grp !== "sofa") continue;
    const k = `${r.doc}|${modelOf(r.code)}|${norm(r.d2).slice(0, 140)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
}

const bag = (xs) => xs.map((x) => norm(x)).sort();
function multisetDiff(have, want) {
  const a = bag(have), b = bag(want);
  if (a.join("|") === b.join("|")) return null;
  const left = [...a], right = [...b];
  const miss = bag(want).filter((x) => { const i = left.indexOf(x); if (i < 0) return true; left.splice(i, 1); return false; });
  const extra = bag(have).filter((x) => { const i = right.indexOf(x); if (i < 0) return true; right.splice(i, 1); return false; });
  return { miss, extra };
}

async function main() {
  log(`READ-ONLY sofa + bedframe completeness audit — company ${CO}`);
  if (ALL_SO) log("ALL_SO=1 — sales-order population is EVERY order, not only the proceeded ones");

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => norm(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (m) => RECL.some((s) => codeSet.has(norm(m + s)));

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const pairSet = new Set(fcRows.map((r) => `${norm(r.fabric_id)}|${norm(r.colour_id)}`));
  const idSet = new Set(fcRows.flatMap((r) => [norm(r.colour_id), norm(r.label)]));

  const addons = await sql`SELECT code, label, categories FROM scm.special_addons WHERE company_id = ${CO}`;
  const sofaLive = new Map();
  for (const r of addons.filter((x) => (x.categories || []).some((c) => /sofa/i.test(String(c)))))
    { sofaLive.set(K(r.code), r.code); if (r.label) sofaLive.set(K(r.label), r.code); }
  const bedLive = new Set(addons.filter((x) => (x.categories || []).includes("BEDFRAME")).map((r) => r.code));
  log(`masters: ${codeSet.size} product codes, ${fcRows.length} fabric colours, ${sofaLive.size ? [...new Set(sofaLive.values())].length : 0} sofa addons, ${bedLive.size} bedframe addons`);

  const poRows = (await sql`
    SELECT i.id, p.po_number AS doc, p.linked_ac_docno AS ac, p.status AS po_status,
           i.item_code AS code, i.item_group AS grp, i.description2 AS d2, i.variants,
           i.custom_specials, i.notes AS remark, i.qty, i.so_item_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')
     ORDER BY p.po_number`).map((r) => ({ ...r, dead: r.po_status === "CANCELLED" ? "on a CANCELLED PO" : null }));

  /* The proceeded population is "carries a Processing Date", and that date is
     internal_expected_dd — what the UI writes and what soProcessingLocked and
     MRP read. proceeded_at is only the IN_PRODUCTION stamp, so it named a
     narrower set than the orders the factory is actually building from. */
  const soRows = (await sql`
    SELECT i.id, h.doc_no AS doc, h.linked_ac_docno AS ac, i.item_code AS code,
           i.item_group AS grp, i.description2 AS d2, i.variants, i.custom_specials,
           i.remark, i.qty, i.cancelled
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')
       AND (${ALL_SO} OR h.${PDATE} IS NOT NULL)
     ORDER BY h.doc_no, i.line_no`).map((r) => ({ ...r, dead: r.cancelled ? "CANCELLED line" : null }));

  for (const [pop, rows] of [["PO", poRows], ["SO", soRows]]) {
    const docs = new Set(rows.map((r) => r.doc)).size;
    const nSofa = rows.filter((r) => r.grp === "sofa").length;
    log(`${pop}: ${rows.length} lines (${nSofa} sofa / ${rows.length - nSofa} bedframe) across ${docs} documents; ${rows.filter((r) => r.dead).length} of them ${pop === "PO" ? "on cancelled POs" : "cancelled lines"}`);
  }

  // ---- 1. COMPARTMENT -------------------------------------------------------
  for (const [pop, rows] of [["PO", poRows], ["SO", soRows]]) {
    const buildIssue = new Map(); // line id -> the build-level finding
    const c = cell("1 COMPARTMENT", pop, "sofa");
    for (const [, b] of groupSofaBuilds(rows)) {
      const f = b[0];
      const model = modelOf(f.code);
      /* The remark marks the LINE the decoder could not read, not the build.
         Failing the whole build on any one line's remark over-reported by 11 of
         30 in production: HC-PO-009018 is correctly decomposed to
         1A(LHF)+1NA+1A(RHF) and was failed only because it also carries a
         STOOL, whose own Desc2 is a dimension with no structure to parse and
         none needed - STOOL IS its compartment. Only a line that fell back to
         the bare 1S placeholder is genuinely undecoded. */
      const undecoded = b.filter((r) => /SOFA UNPARSED/.test(r.remark || "") && /^1S$/i.test(compartmentOf(r.code)));
      const ps = parseSofa(f.d2, model, reclOf(model));
      if (undecoded.length) {
        /* THE SPLIT (owner 2026-09-04). Two different things arrive here as one
           number, and reading them together inflates the backlog he plans from:
           "we could not read the build, so the line fell back to one seat" and
           "the book says a single seater and the ERP holds a single seater".
           The second is CORRECT and is not a failure to decode.

           They are separated by asking the DECODER what the Desc2 says, never by
           the remark. The remark is free text — it is what put the line in this
           branch in the first place, and other work rewrites it — so a line whose
           Desc2 reads as exactly 1S and whose document holds exactly that is
           counted as agreeing, whatever the remark still says. The census below
           prints the TOTAL beside the split so nothing disappears. */
        if (isSingleSeatBuild(f.d2, ps) && !multisetDiff(b.map((r) => compartmentOf(r.code)), ps.pieces)) {
          note(c, 'bare "1S" — the book says a single seater and the document agrees, though the remark still says UNPARSED', b.length);
          continue;
        }
        for (const r of undecoded) buildIssue.set(r.id, "COMPARTMENT: the build collapsed to a bare 1S placeholder, never decoded");
        continue;
      }
      if (ps.conf === "low" || !ps.pieces.length) {
        // Desc2 cannot answer it. That is a photo job, not a data defect, and
        // it is counted on its own rather than folded into "incomplete".
        note(c, "build cannot be re-derived from Desc2 (photo needed)", b.length);
        continue;
      }
      const d = multisetDiff(b.map((r) => compartmentOf(r.code)), ps.pieces);
      if (!d) continue;
      const detail = `COMPARTMENT: doc has ${b.map((r) => compartmentOf(r.code)).join("+") || "(none)"}; Desc2 now reads ${ps.pieces.join("+")}`
        + (d.miss.length ? ` | MISSING ${d.miss.join(", ")}` : "")
        + (d.extra.length ? ` | EXTRA ${d.extra.join(", ")}` : "");
      for (const r of b) buildIssue.set(r.id, detail);
    }
    for (const r of rows) {
      if (r.grp === "sofa") {
        const reasons = [];
        const comp = compartmentOf(r.code);
        if (!comp) reasons.push(`no compartment on the code ("${r.code}" has no {model}-{piece} suffix)`);
        else if (!codeSet.has(norm(r.code))) reasons.push(`compartment SKU "${r.code}" is not minted in mfg_products`);
        if (buildIssue.has(r.id)) reasons.push(buildIssue.get(r.id));
        score(c, r, reasons);
        continue;
      }
      const cb = cell("1 COMPARTMENT", pop, "bedframe");
      const reasons = [];
      const size = txt((r.variants || {}).size);
      if (SPECIAL_SIZE.test(r.code || "")) {
        if (!size) reasons.push("(SP) special size but variants.size is empty — the dimensions are nowhere");
        else note(cb, "(SP) special size carrying its dimensions", 1);
      } else if (!STD_SIZE.test(r.code || "")) {
        reasons.push(`no size on the code ("${r.code}" carries neither (S|SS|Q|K|SK) nor (SP))`);
      }
      score(cb, r, reasons);
    }

    /* THE BARE-1S CENSUS (owner 2026-09-04). Every line whose code ends in -1S,
       split by WHY it is a one-seater, with the total printed first so nothing
       disappears from the number he plans against. Counted by hand off the item
       code, the backlog and the correct lines came to one figure — 26 on the
       proceeded sales orders — and only the last row of this census is work. */
    const bare1S = rows.filter((r) => r.grp === "sofa" && /^1S$/i.test(compartmentOf(r.code)));
    if (bare1S.length) {
      let agree = 0, cannotRead = 0, otherFinding = 0, inLongerBuild = 0;
      for (const r of bare1S) {
        const m = modelOf(r.code);
        const says1S = isSingleSeatBuild(r.d2, parseSofa(r.d2, m, reclOf(m)));
        const finding = buildIssue.get(r.id) || "";
        if (/collapsed to a bare 1S placeholder/.test(finding)) cannotRead++;
        else if (finding) otherFinding++;
        else if (says1S) agree++;
        else inLongerBuild++;
      }
      note(c, 'bare "1S" lines, all told', bare1S.length);
      note(c, 'bare "1S" — the book says a single seater and we agree', agree);
      note(c, 'bare "1S" — WE COULD NOT READ THE BUILD (the real backlog)', cannotRead);
      if (inLongerBuild) note(c, 'bare "1S" — one piece of a longer build the decoder reads', inLongerBuild);
      if (otherFinding) note(c, 'bare "1S" — carries a different compartment finding', otherFinding);
    }
  }

  // ---- 2. SEAT SIZE ---------------------------------------------------------
  for (const [pop, rows] of [["PO", poRows], ["SO", soRows]]) {
    for (const r of rows) {
      const c = cell("2 SEAT SIZE", pop, r.grp);
      const reasons = [];
      if (r.grp === "sofa") {
        if (!pick(r.variants, ["seatHeight", "depth"])) {
          reasons.push("SEAT SIZE: seatHeight / depth both empty");
          if (isPending(r.d2)) { reasons[0] += " — source says TBC/KIV"; note(c, "seat size not chosen yet (TBC/KIV in Desc2)"); }
        }
      } else {
        // a bedframe has no seat; the dimensional axes asked of it are the
        // divan stack, and variant-axes.mjs already knows which frames are exempt
        const miss = missingVariantAxes("bedframe", r.variants, r.code)
          .filter((a) => a.key !== "fabricCode");
        if (miss.length) reasons.push(`DIMENSIONS: missing ${miss.map((a) => a.label).join(", ")}`);
      }
      score(c, r, reasons);
    }
  }

  // ---- 3. COLOUR ------------------------------------------------------------
  for (const [pop, rows] of [["PO", poRows], ["SO", soRows]]) {
    for (const r of rows) {
      const c = cell("3 COLOUR", pop, r.grp);
      const v = r.variants || {};
      const code = pick(v, ["fabricCode", "colorCode", "colourCode", "fabricColor"]);
      const reasons = [];
      if (!code) {
        if (txt(v.fabricId) || txt(v.fabricLabel)) { reasons.push("COLOUR: only the fabric series is committed, no colour (colour-KIV)"); note(c, "series committed, colour still KIV"); }
        else if (isPending(r.d2)) { reasons.push("COLOUR: no fabric axis — source says TBC/KIV"); note(c, "colour not chosen yet (TBC/KIV in Desc2)"); }
        else reasons.push("COLOUR: no fabricCode / colorCode / colourCode / fabricColor");
      } else if (isPendingColour(code)) {
        reasons.push(`COLOUR: axis says "${code}" — not chosen yet`);
        note(c, "colour not chosen yet (TBC/KIV in the axis)");
      } else {
        const fid = txt(v.fabricId), cid = txt(v.colourId);
        if (fid && cid && pairSet.has(`${norm(fid)}|${norm(cid)}`)) { /* bound to a real library row */ }
        else if (idSet.has(norm(code))) { /* the code itself is a library colour_id or label */ }
        else {
          const hit = findColour(code);
          if (hit) note(c, "resolves only through the fuzzy matcher, not by exact id");
          else reasons.push(`COLOUR: "${code}" does not exist in scm.fabric_colours`);
        }
      }
      score(c, r, reasons);
    }
  }

  // ---- 4. SPECIAL ORDER -----------------------------------------------------
  /* Scope is the lines whose AutoCount Desc2 actually asked for something: a
     line with no special-order phrase has nothing to be incomplete about, so it
     is out of the denominator rather than counted as a free pass. */
  for (const [pop, rows] of [["PO", poRows], ["SO", soRows]]) {
    for (const r of rows) {
      const c = cell("4 SPECIAL ORDER", pop, r.grp);
      const model = modelOf(r.code);
      const phrases = !r.d2 ? []
        : r.grp === "sofa" ? parseSofa(r.d2, model, false).specials
        : parseBedframe(r.d2).specials;
      if (!phrases.length) { note(c, "no special-order phrase in Desc2 (out of scope)"); continue; }
      const cs = asList(r.custom_specials), vs = asList((r.variants || {}).specials);
      if (cs.wrapped) note(c, "custom_specials is a jsonb STRING, not an array — the picker cannot see it");
      if (!vs.list.length && cs.list.length) note(c, "specials live in custom_specials only; variants.specials (what the picker reads) is empty");
      const carried = [...cs.list, ...vs.list].map(elText).filter(Boolean);
      const carriedK = new Set(carried.map((x) => K(x)));
      const carriedS = carried.map((x) => skey(x)).filter(Boolean);
      const reasons = [];
      let codeGap = 0;
      for (const p of phrases) {
        const codes = r.grp === "sofa"
          ? (sofaLive.has(K(p)) ? [sofaLive.get(K(p))] : mapSofaPhrase(p, sofaLive))
          : (bedLive.has(p) ? [p] : mapBedframeSpecial(p).filter((x) => bedLive.has(x)));
        if (codes.length) {
          const miss = codes.filter((x) => !carriedK.has(K(x)));
          if (miss.length) { reasons.push(`SPECIAL: Desc2 says "${p}" -> picker code ${miss.map((x) => `[${x}]`).join(" ")} is not on the line`); codeGap++; }
          continue;
        }
        const k = skey(p);
        if (!k) continue;
        if (!carriedS.some((e) => e.includes(k) || k.includes(e)))
          reasons.push(`SPECIAL: Desc2 says "${p}" — no picker code exists for it and it is not carried as free text either`);
      }
      // the lenient reading of the same lines: no picker code is missing, so any
      // gap left is a phrase the picker has no code for at all
      if (!codeGap) note(c, "no picker code missing (any gap is free text only)");
      score(c, r, reasons);
    }
  }

  // ---- report the four sections --------------------------------------------
  for (const s of SECTIONS) {
    log("");
    log(`=== ${s}`);
    for (const pop of POPS) for (const g of GRPS) {
      const c = cell(s, pop, g);
      const head = `${pop} ${g}`.padEnd(14);
      // a cell with no rows says so; "100%" over nothing is a lie
      if (!c.total) log(`  ${head} 0 rows`);
      else log(`  ${head} total ${c.total} / complete ${c.ok} / incomplete ${c.total - c.ok}  (${((c.ok / c.total) * 100).toFixed(1)}% complete)`);
      for (const [k, n] of [...c.note.entries()].sort((a, b) => b[1] - a[1])) log(`       of which — ${k}: ${n}`);
      if (!c.total) continue;
      const dead = c.bad.length;
      if (LIST && dead) {
        for (const t of c.bad.slice(0, CAP)) for (const ln of t.split("\n")) log(ln);
        if (dead > CAP) log(`  ... ${dead - CAP} more (raise CAP to see them)`);
      }
    }
  }

  // ---- 5. SO -> PO ALIGNMENT ------------------------------------------------
  const soAll = new Map();
  for (const r of await sql`
    SELECT i.id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp, i.variants, i.custom_specials
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')`) soAll.set(r.id, r);

  const AXES = [
    ["seat size", ["seatHeight", "depth"]],
    ["fabric colour", ["fabricCode", "colorCode", "colourCode", "fabricColor"]],
    ["colourId", ["colourId"]],
    ["fabricId", ["fabricId"]],
    ["divan height", ["divanHeight"]],
    ["leg height", ["legHeight"]],
    ["gap", ["gap"]],
  ];
  const linked = poRows.filter((r) => r.so_item_id);
  const findings = [];
  const builds = new Map(); // so doc|po doc|model -> { so:Map(id->code), po:[code] }
  let orphan = 0, axisBad = 0, codeBad = 0;
  const lineKind = { poBlank: 0, soBlank: 0, conflict: 0 };
  const poBlankKind = { inOwnD2: 0, notInOwnD2: 0 };
  const provSofa = { imported: 0, createdHere: 0 };
  const provBed = { imported: 0, createdHere: 0 };
  const linkedProv = { imported: 0, createdHere: 0 };
  for (const p of linked) linkedProv[p.ac ? "imported" : "createdHere"]++;
  for (const p of linked) {
    const s = soAll.get(p.so_item_id);
    if (!s) { orphan++; continue; }
    if (p.grp === "sofa" || s.grp === "sofa") {
      const k = `${s.doc}|${p.doc}|${modelOf(s.code)}`;
      if (!builds.has(k)) builds.set(k, { so: new Map(), po: [] });
      builds.get(k).so.set(s.id, s.code);
      builds.get(k).po.push(p.code);
    }
    const diffs = [];
    if (norm(p.code) !== norm(s.code)) { diffs.push(`item code: SO ${s.code} vs PO ${p.code}`); codeBad++; }
    /* WHICH SIDE IS EMPTY decides who can fix it, and the headline count cannot
       say. "the SO knows the colour and the PO carries nothing" is a value to
       carry forward; "they name different colours" is a question for a human.
       Counting them together reads as 325 contradictions when most are
       omissions. */
    let poBlankHere = 0, soBlankHere = 0, conflictHere = 0;
    for (const [label, keys] of AXES) {
      const a = pick(s.variants, keys), b = pick(p.variants, keys);
      if (norm(a) === norm(b)) continue;
      if (a && !b) poBlankHere++; else if (!a && b) soBlankHere++; else conflictHere++;
      diffs.push(`${label}: SO ${a || "-"} vs PO ${b || "-"}`);
    }
    if (!diffs.length) continue;
    axisBad++;
    /* One bucket per LINE, worst-first: a line holding any real conflict is a
       conflict line whatever else it also omits. */
    if (conflictHere) lineKind.conflict++;
    else if (poBlankHere && soBlankHere) lineKind.conflict++;
    else if (poBlankHere) {
      lineKind.poBlank++;
      /* AND THE QUESTION THAT DECIDES WHO MAY FIX IT. The owner's migration rule
         is that we copy AutoCount's own value for a row and never infer one
         (`migration-copy-never-compute`). So a PO line missing what the SO holds
         is only OURS to repair if the PO's OWN AutoCount remark already carries
         it and the decoder missed it — then it is a copy. If the book's purchase
         line genuinely never said it, putting the SO's value there is a business
         decision about what the supplier is told to build, and that is his, not
         a data repair. This counts the two apart by asking whether the value the
         SO holds appears verbatim in the PO's own Desc2. */
      const own = String(p.d2 || "").toUpperCase();
      let anyInOwnD2 = false;
      for (const [, keys] of AXES) {
        const a = pick(s.variants, keys), b = pick(p.variants, keys);
        if (!a || b || norm(a) === norm(b)) continue;
        if (own.includes(String(a).toUpperCase())) { anyInOwnD2 = true; break; }
      }
      if (anyInOwnD2) poBlankKind.inOwnD2++; else poBlankKind.notInOwnD2++;
    }
    else lineKind.soBlank++;
    const prov = p.ac ? "imported" : "createdHere";
    (p.grp === "sofa" ? provSofa : provBed)[prov]++;
    findings.push(`  ${s.doc} -> ${p.doc}  ${p.grp} ${p.code}\n     ${diffs.join("\n     ")}`);
  }
  const compFindings = [];
  for (const [k, v] of builds) {
    const [soDoc, poDoc, model] = k.split("|");
    const d = multisetDiff(v.po.map(compartmentOf), [...v.so.values()].map(compartmentOf));
    if (!d) continue;
    compFindings.push(`  ${soDoc} -> ${poDoc}  sofa ${model}\n     compartment multiset: SO ${[...v.so.values()].map(compartmentOf).join("+")} vs PO ${v.po.map(compartmentOf).join("+")}`
      + (d.miss.length ? `\n     MISSING from the PO: ${d.miss.join(", ")}` : "")
      + (d.extra.length ? `\n     EXTRA on the PO: ${d.extra.join(", ")}` : ""));
  }

  log("");
  log("=== 5 SO -> PO ALIGNMENT");
  log(`  ${linked.length} dedicated PO lines (so_item_id set); ${poRows.length - linked.length} unlinked PO lines have no SO line to align against`);
  log(`  line-level: total ${linked.length - orphan} / aligned ${linked.length - orphan - axisBad} / disagree ${axisBad}  (of which ${codeBad} disagree on the item code itself)`);
  log(`     by SHAPE — the PO is simply MISSING what the SO holds: ${lineKind.poBlank}`
    + ` / the SO is missing what the PO holds: ${lineKind.soBlank}`
    + ` / both hold a value and they CONFLICT: ${lineKind.conflict}`);
  log(`     of the PO-missing lines, the value IS in the PO's own AutoCount remark`
    + ` (a decoder miss, ours to repair): ${poBlankKind.inOwnD2};`
    + ` the book's purchase line never said it (his call, not a repair): ${poBlankKind.notInOwnD2}`);
  log(`     by PROVENANCE — disagreeing sofa lines: ${provSofa.imported} on POs imported from AutoCount,`
    + ` ${provSofa.createdHere} on POs raised in the ERP;`
    + ` bedframe: ${provBed.imported} imported, ${provBed.createdHere} raised here`);
  log(`     (for scale, of ALL ${linked.length} dedicated lines: ${linkedProv.imported} imported,`
    + ` ${linkedProv.createdHere} raised here — a bucket can only be as big as its population)`);
  log(`  sofa builds: total ${builds.size} / compartment multiset agrees ${builds.size - compFindings.length} / disagrees ${compFindings.length}`);
  log(`  ${orphan} links point at an SO line that no longer exists`);
  if (LIST) {
    for (const t of compFindings.slice(0, CAP)) for (const ln of t.split("\n")) log(ln);
    if (compFindings.length > CAP) log(`  ... ${compFindings.length - CAP} more build mismatches`);
    for (const t of findings.slice(0, CAP)) for (const ln of t.split("\n")) log(ln);
    if (findings.length > CAP) log(`  ... ${findings.length - CAP} more line mismatches (raise CAP to see them)`);
  }

  // ---- the grid -------------------------------------------------------------
  const fmt = (c) => (c.total ? `${c.total}/${c.ok}/${c.total - c.ok}` : "0 rows");
  const W = 18;
  log("");
  log("=== GRID  total / complete / incomplete");
  log(`  ${"".padEnd(W)}${"PO sofa".padEnd(W)}${"PO bedframe".padEnd(W)}${"SO sofa".padEnd(W)}${"SO bedframe".padEnd(W)}`);
  for (const s of SECTIONS)
    log(`  ${s.padEnd(W)}${fmt(cell(s, "PO", "sofa")).padEnd(W)}${fmt(cell(s, "PO", "bedframe")).padEnd(W)}${fmt(cell(s, "SO", "sofa")).padEnd(W)}${fmt(cell(s, "SO", "bedframe")).padEnd(W)}`);
  log(`  ${"5 SO->PO lines".padEnd(W)}${`${linked.length - orphan}/${linked.length - orphan - axisBad}/${axisBad}`.padEnd(W)}`);
  log(`  ${"5 SO->PO builds".padEnd(W)}${(builds.size ? `${builds.size}/${builds.size - compFindings.length}/${compFindings.length}` : "0 rows").padEnd(W)}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
