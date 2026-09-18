#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. A sofa line sitting on a bare `{model}-1S` is THREE different
// situations wearing one suffix, and until now only two of them had a name.
//
//   P  THE DECODER'S PLACEHOLDER. The importer could not read the build, so it
//      opened one line on `{model}-1S` and wrote `SOFA UNPARSED` in the remark.
//      probe-sofa-placeholder-desc2.mjs already buckets these by cause.
//
//   S  A GENUINE ONE-SEATER. The book says one seat and the ERP holds one seat.
//      Correct, and never a defect (lib/sofa-single-seat.mjs states the test).
//
//   N  NEVER DECOMPOSED AT ALL - the class this script exists to name. The line
//      carries NO `SOFA UNPARSED` marker, so it never entered the decoder's
//      fallback, and the book's own Desc2 states a real multi-piece build. The
//      ERP simply adopted the binding CSV's representative code verbatim.
//
// WHY N CAN EXIST. `data/autocount-erp-mapping-1561.csv` binds 20 AutoCount item
// codes whose CATEGORY is SOFA but whose CODE carries no "SOFA" word -
// `THL-2379 -> 2379-1S`, `THL-7219 -> 7219-1S`, `TNS-9838 DB -> 9838 DB-1S` and
// 17 more - and every one of them maps to the bare one-seat compartment. Any
// reader that decides "is this a sofa?" from the CODE rather than the binding's
// CATEGORY sees an ordinary product and passes the mapped `-1S` straight
// through. The word-on-the-code test appears in the importer
// (`import-ac-outstanding-so.mjs:81`) and in the reconcile
// (`check-ac-erp-reconcile.mjs:258`). This probe does not assert which reader
// produced the rows - it MEASURES the population and prints the evidence that
// decides it.
//
// WHAT IT PRINTS
//   1  masters, and the binding rows whose category is SOFA with no SOFA word
//   2  every company-1 sofa line on a bare `-1S`, split P / S / N, per side
//   3  for class N: the AutoCount item code behind each row, so the "category
//      says SOFA, code does not" theory is confirmed or refuted by COUNT
//   4  per model, which `{model}-*` piece codes the product master actually
//      holds - the competing explanation for a placeholder is a piece SKU that
//      was never minted, and this is what separates the two
//   5  the decode of the BOOK's own Desc2 for every N row
//
// IT READS THE BOOK FROM THE COMMITTED SNAPSHOT, NOT FROM `description2`.
// `scm.mfg_sales_order_items.description2` is meant to hold AutoCount's wording
// and is server-generated on every write
// (`docs/bugs/0639-autocount-s-desc2-is-overwritten-by-our-generated-summary-on.md`),
// so asking it what the book said can answer with our own summary. The book is
// `data/ac-reconcile-truth.json.gz`, joined on `linked_ac_dtlkey`.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Document numbers,
// item codes, models and Desc2 build text only - no customer, no address, no
// amount. Same shape probe-sofa-placeholder-desc2.mjs already prints.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction, and deliberately no
// APPLY input.
//
//   DATABASE_URL   required
//   COMPANY        default 1
//   SHOW           how many example rows to print per class (default 60)
//
// RE-RUN: idempotent and side-effect free.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";
import { isSingleSeatBuild } from "./lib/sofa-single-seat.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("DATABASE_URL required"); process.exit(2); }
/* An input a workflow does not pass arrives as "", not as undefined, so every
   default below has to be `||` and never `??` (PR #2896 paid for this one). */
const CO = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 60);
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const compartmentOf = (code) => { const c = norm(code); const i = c.indexOf("-"); return i < 0 ? "" : c.slice(i + 1); };
const modelOf = (code) => { const c = norm(code); const i = c.indexOf("-"); const b = i < 0 ? c : c.slice(0, i); return SOFA_MODEL_ALIAS[b] || b; };
const oneLine = (s) => String(s ?? "").replace(/\r/g, "").replace(/\n/g, "\\n").replace(/[ \t]+/g, " ").trim();
const bare1S = (code) => /^1S$/i.test(compartmentOf(code));

/* THE CHECKER PROVES ITS OWN PATTERNS BEFORE IT REPORTS. "A checker that cannot
   match reports a clean run" is this repo's named failure; a verdict computed
   over nothing must never read as a pass. */
function selfTest() {
  const cases = [
    [bare1S("2379-1S"), true, "bare1S on 2379-1S"],
    [bare1S("8030-1A(LHF)"), false, "bare1S on a real compartment"],
    [bare1S("9838 DB-1S"), true, "bare1S on a spaced model"],
    [modelOf("5540-1S") === "8030", true, "the alias fold reaches modelOf"],
    [modelOf("5535-1S") === "5535", true, "5535 is its OWN model and is never aliased"],
    [compartmentOf("2379") === "", true, "a code with no dash has no compartment"],
  ];
  const bad = cases.filter(([got, want]) => got !== want);
  if (bad.length) { console.error("SELF-TEST FAILED: " + bad.map((b) => b[2]).join("; ")); process.exit(3); }
}

/** The AutoCount side, from the committed read-only snapshot. */
function loadBook() {
  const p = path.join(here, "data", "ac-reconcile-truth.json.gz");
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)));
  const idx = Object.fromEntries(j.line_fields.map((k, i) => [k, i]));
  const byDtl = new Map();
  for (const T of ["SO", "PO", "GR", "DO", "IV", "PI"]) {
    const t = j.types[T];
    const d2m = new Map(t.desc2.map((r) => [String(r[0]), r[1]]));
    for (const l of t.lines) {
      const k = String(l[idx.dtlKey]);
      if (byDtl.has(k)) continue;
      byDtl.set(k, { type: T, docNo: l[idx.docNo], acCode: l[idx.itemKey], desc2: d2m.get(k) ?? null });
    }
  }
  return { exportedAt: j.exported_at, byDtl };
}

/** The binding CSV: ac_code -> { erp, category }. */
function loadBinding() {
  const lines = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  lines.shift();
  const m = new Map();
  for (const ln of lines) {
    const f = ln.split(",");
    if (f[0]) m.set(norm(f[0]), { erp: (f[1] || "").trim(), cat: (f[3] || "").trim().toUpperCase() });
  }
  return m;
}

/** Classify one collapsed row. Shared by the per-side report and the roll-up so
 *  the two cannot answer differently (they did, in an earlier draft). */
function classifyRow(r, book, binding, deps) {
  const b = r.dtl ? book.byDtl.get(String(r.dtl)) : null;
  const model = modelOf(r.code);
  const d2 = b ? b.desc2 : null;
  const ps = parseSofa(d2, model, deps.reclOf(model), { knownColour: deps.knownColour });
  let cls;
  if (/SOFA UNPARSED/.test(String(r.remark || ""))) cls = "P";
  else if (!b) cls = "?";
  else if (isSingleSeatBuild(d2, ps)) cls = "S";
  else if (ps.pieces.length && ps.conf !== "low") cls = "N";
  else cls = "?";
  return { r, b, model, ps, d2, cls };
}

async function main() {
  selfTest();
  log(`READ-ONLY sofa collapsed "-1S" cause probe - company ${CO}`);

  const book = loadBook();
  const binding = loadBinding();
  const catSofaNoWord = [...binding.entries()].filter(([ac, v]) => v.cat === "SOFA" && !/SOFA/i.test(ac));
  log(`book snapshot exported ${book.exportedAt}; ${book.byDtl.size} AutoCount lines keyed by DtlKey`);
  log(`binding: ${binding.size} rows, ${[...binding.values()].filter((v) => v.cat === "SOFA").length} category=SOFA, ` +
      `of which ${catSofaNoWord.length} carry NO "SOFA" word in the AutoCount code`);
  for (const [ac, v] of catSofaNoWord) log(`   ${ac} -> ${v.erp}`);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => norm(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (m) => RECL.some((s) => codeSet.has(norm(m + s)));
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  const deps = { reclOf, knownColour };
  log(`masters: ${codeSet.size} product codes, ${fcRows.length} fabric colours`);

  const soRows = await sql`
    SELECT i.id::text AS id, h.doc_no AS doc, i.item_code AS code, i.remark,
           i.cancelled, i.linked_ac_dtlkey::text AS dtl
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group = 'sofa'
     ORDER BY h.doc_no, i.line_no`;
  const poRows = await sql`
    SELECT i.id::text AS id, p.po_number AS doc, i.item_code AS code, i.notes AS remark,
           (p.status = 'CANCELLED') AS cancelled, i.linked_ac_dtlkey::text AS dtl
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group = 'sofa'
     ORDER BY p.po_number`;

  const perModelN = new Map();
  const nByAc = new Map();

  for (const [side, key, rows] of [["SALES ORDER", "so", soRows], ["PURCHASE ORDER", "po", poRows]]) {
    const collapsed = rows.filter((r) => bare1S(r.code));
    const recs = collapsed.map((r) => classifyRow(r, book, binding, deps));
    const of = (c) => recs.filter((x) => x.cls === c);
    log("");
    log(`${side}: ${rows.length} sofa line(s); ${collapsed.length} on a bare "-1S", ` +
        `on ${new Set(collapsed.map((r) => r.doc)).size} document(s)`);
    log(`   P  the decoder's placeholder (remark says SOFA UNPARSED) : ${of("P").length}`);
    log(`   S  a GENUINE one-seater, the book says one seat          : ${of("S").length}`);
    log(`   N  NEVER DECOMPOSED - the book states a real build, and  : ${of("N").length}`);
    log(`      the row carries no placeholder marker`);
    log(`   ?  no book line reachable, or the book states no build   : ${of("?").length}`);
    log(`   (of the ${collapsed.length}, ${collapsed.filter((r) => r.cancelled).length} are cancelled)`);

    const N = of("N");
    for (const rec of N) {
      const ac = norm(rec.b.acCode);
      if (!nByAc.has(ac)) nByAc.set(ac, { so: 0, po: 0 });
      nByAc.get(ac)[key]++;
      perModelN.set(rec.model, (perModelN.get(rec.model) || 0) + 1);
    }
    if (!N.length) continue;
    log("");
    log(`   ${side} class N, up to ${SHOW} of ${N.length} rows - book text, and what the decoder makes of it TODAY:`);
    for (const rec of N.slice(0, SHOW)) {
      const codes = rec.ps.pieces.map((c) => `${rec.model}-${c}`);
      const miss = codes.filter((c) => !codeSet.has(norm(c)));
      log(`   ${rec.r.doc} ac=${rec.b.acCode} erp=${rec.r.code}${rec.r.cancelled ? " CANCELLED" : ""}`);
      log(`      book Desc2: ${oneLine(rec.d2)}`);
      log(`      decodes to: ${rec.ps.pieces.join("+")}  (conf ${rec.ps.conf})` +
          (miss.length ? `  PIECE SKU MISSING: ${miss.join(", ")}` : "  every piece SKU exists"));
    }
  }

  log("");
  log('CLASS N BY AUTOCOUNT ITEM CODE - does the binding call it SOFA while the code does not say so?');
  let wordless = 0, worded = 0;
  for (const [ac, c] of [...nByAc.entries()].sort((a, b) => (b[1].so + b[1].po) - (a[1].so + a[1].po))) {
    const bd = binding.get(ac);
    const hasWord = /SOFA/i.test(ac);
    if (hasWord) worded += c.so + c.po; else wordless += c.so + c.po;
    log(`   ${ac.padEnd(24)} binding cat=${bd ? bd.cat : "(unbound)"} erp=${bd ? bd.erp : "-"}  ` +
        `SO ${c.so}  PO ${c.po}  ${hasWord ? "code SAYS sofa" : "code does NOT say sofa"}`);
  }
  log(`   class N lines on a code that does NOT carry the word SOFA: ${wordless}`);
  log(`   class N lines on a code that DOES carry the word SOFA    : ${worded}`);

  log("");
  log("PIECE SKUs THE PRODUCT MASTER HOLDS, per model seen in class N");
  for (const m of [...perModelN.keys()].sort()) {
    const have = [...codeSet].filter((c) => c.startsWith(norm(m) + "-")).sort();
    log(`   ${m}: ${have.length} code(s)${have.length ? " - " + have.slice(0, 24).join(", ") : " - NONE MINTED"}`);
  }

  await sql.end({ timeout: 5 });
  log("");
  log("READ-ONLY probe complete. Nothing was written.");
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
