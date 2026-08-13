#!/usr/bin/env node
// READ-ONLY. Are the documents that leave the building fully specified, and do
// the SO and the PO raised from it still say the same thing?
//
// Owner 2026-08-10, verbatim scope:
//   "东西它的沙发 compartment、variants 错的都没关系,可是我们 PO 开出去,
//    我们一定要有详细的 PO compartment、沙发 compartment 跟 variants 的."
//   "如果我们的 sales order 已经 proceed 了的情况之下,它的 compartment 一定
//    是要对,还有它的沙发的颜色、尺寸、variants 等等都要对的."
//   "确保这些 PO 的 bedframe 和 sofa variant 都对 然后 sofa 的 compartment 要对"
//   "SO to PO 的 compartment 和 variant 都应该是对齐的 for sofa and bedframe"
//
// So: an un-proceeded SO may be incomplete and that is fine. Three sections:
//
//   A. PURCHASE ORDERS — every bedframe and sofa line. A PO is what the factory
//      builds from, so it must be complete regardless of the SO behind it.
//   B. PROCEEDED SALES ORDERS — same completeness bar.
//   C. SO -> PO ALIGNMENT — for a PO line dedicated to an SO line
//      (purchase_order_items.so_item_id), the item code and every required
//      variant axis must match. A PO that drifted from its SO builds the wrong
//      thing at the right price, which nothing else in the system will catch.
//
// Completeness is judged with lib/variant-axes.mjs, a tested mirror of
// src/scm/shared/so-variant-rule.ts, so this audit and the app's own confirm
// gate cannot disagree. Sofa lines get one extra check the axes table cannot
// express: the COMPARTMENT, re-derived from the stored AutoCount Desc2 with the
// current decoder. That is how the corner regression (a bare "C" filtered as
// noise) surfaces on rows imported before the fix.
//
// Anything Desc2 cannot answer is listed under NEEDS PHOTO with the line's R2
// keys, which is the input to reading the build off the AutoCount picture.
//
// No writes, no DDL. There is deliberately no APPLY.
import postgres from "postgres";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { missingVariantAxes } from "./lib/variant-axes.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const LIST = process.env.LIST !== "0";
const CAP = Number(process.env.CAP || 60); // per-section detail cap
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const isPending = (c) => /(TBC|KIV)/i.test(c || "");

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

function sofaCompartmentIssues(build, reclOK, codeSet) {
  const f = build[0];
  const model = modelOf(f.code);
  const have = build.map((r) => compartmentOf(r.code));
  const out = { issues: [], needPhoto: false };
  /* The SOFA UNPARSED remark marks the LINE the decoder could not read, not the
     build. Flagging the whole build on any one line's remark over-reported by
     11 of 30 in production: HC-PO-009018 is correctly decomposed to
     1A(LHF)+1NA+1A(RHF) and was failed only because it also carries a STOOL,
     whose own Desc2 is "BO315-21/32\" X 49\"" - a dimension, with no structure
     to parse and none needed, since STOOL IS its compartment.

     A line is only undecoded when it fell back to the bare `1S` placeholder. A
     line carrying a real named piece decoded fine whatever the remark says. */
  const undecoded = build.filter((r) => /SOFA UNPARSED/.test(r.remark || "") && /^1S$/i.test(compartmentOf(r.code)));
  if (undecoded.length) {
    out.issues.push(`COMPARTMENT: the build collapsed to a bare 1S placeholder, never decoded (${undecoded.length} line${undecoded.length > 1 ? "s" : ""})`);
    out.needPhoto = true;
    return out;
  }
  const ps = parseSofa(f.d2, model, reclOK);
  const want = ps.pieces || [];
  if (ps.conf === "low" || !want.length) {
    if (have.length === 1 && /^1S$/.test(have[0])) {
      out.issues.push(`COMPARTMENT: a single 1S that the source cannot confirm (${ps.why.join("; ") || "unreadable"})`);
      out.needPhoto = true;
    }
    return out;
  }
  /* Compare as a MULTISET, case-insensitively. Which side of the sofa a piece
     closes is carried in the code itself ("1A(LHF)"), so the row order — which
     is line_no, not a physical layout — means nothing, and "CONSOLE" vs
     "Console" is one storage convention meeting another. Only a piece that is
     actually present-or-absent is a finding. */
  const bag = (xs) => xs.map((x) => norm(x)).sort();
  const a = bag(have), b = bag(want);
  if (a.join("|") === b.join("|")) return out;
  const missPiece = b.filter((x) => { const i = a.indexOf(x); if (i < 0) return true; a.splice(i, 1); return false; });
  const extraPiece = bag(have).filter((x) => { const i = b.indexOf(x); if (i < 0) return true; b.splice(i, 1); return false; });
  out.issues.push(`COMPARTMENT: doc has ${have.join("+") || "(none)"}; Desc2 now reads ${want.join("+")}`);
  if (missPiece.length) out.issues.push(`  MISSING from the document: ${missPiece.join(", ")}`);
  if (extraPiece.length) out.issues.push(`  EXTRA on the document: ${extraPiece.join(", ")}`);
  const notMinted = want.map((c) => `${model}-${c}`).filter((c) => !codeSet.has(norm(c)));
  if (notMinted.length) out.issues.push(`  piece SKU not minted: ${notMinted.join(", ")}`);
  return out;
}

function variantIssues(row) {
  const miss = missingVariantAxes(row.grp, row.variants, row.code);
  if (!miss.length) return { issues: [], needPhoto: false };
  const labels = miss.map((a) => a.label).join(", ");
  // A source that says TBC/KIV is "not chosen yet" — a real state, not a defect
  // to chase, so it is named differently.
  if (isPending(row.d2)) return { issues: [`VARIANTS: missing ${labels} — source says TBC/KIV`], needPhoto: false };
  return { issues: [`VARIANTS: missing ${labels}`], needPhoto: true };
}

const AXES = ["fabricCode", "colourId", "fabricId", "seatHeight", "depth", "divanHeight", "legHeight", "gap"];
const vget = (v, k) => { const x = (v || {})[k]; return x === undefined || x === null || String(x).trim() === "" ? null : String(x).trim(); };

async function main() {
  log(`READ-ONLY completeness + SO->PO alignment audit — company ${CO}`);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => norm(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (m) => RECL.some((s) => codeSet.has(norm(m + s)));

  const poRows = (await sql`
    SELECT i.id, p.po_number AS doc, p.linked_ac_docno AS ac, i.material_code AS code,
           i.item_group AS grp, i.description2 AS d2, i.variants, i.notes AS remark,
           i.qty, i.photo_urls, i.so_item_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')
     ORDER BY p.po_number`).map((r) => ({ ...r }));

  const soRows = (await sql`
    SELECT i.id, h.doc_no AS doc, h.linked_ac_docno AS ac, i.item_code AS code,
           i.item_group AS grp, i.description2 AS d2, i.variants, i.remark,
           i.qty, i.photo_urls, h.proceeded_at
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')
       AND h.proceeded_at IS NOT NULL
     ORDER BY h.doc_no, i.line_no`).map((r) => ({ ...r }));

  for (const [rows, label] of [[poRows, "A. PURCHASE ORDERS — every bedframe + sofa line"],
                               [soRows, "B. PROCEEDED SALES ORDERS — bedframe + sofa"]]) {
    const bad = new Map(); // doc -> lines of text
    let nPhoto = 0, nBF = 0, nSofa = 0;
    for (const r of rows) (r.grp === "sofa" ? nSofa++ : nBF++);

    // sofa: compartment per BUILD, variants per line
    for (const [, b] of groupSofaBuilds(rows)) {
      const c = sofaCompartmentIssues(b, reclOf(modelOf(b[0].code)), codeSet);
      if (!c.issues.length) continue;
      const f = b[0];
      const keys = [...new Set(b.flatMap((x) => x.photo_urls || []))];
      const t = [`  ${f.doc}${f.ac ? ` (AC ${f.ac})` : ""} sofa ${modelOf(f.code)} x${f.qty}`,
                 `     Desc2: ${JSON.stringify((f.d2 || "").slice(0, 100))}`,
                 ...c.issues.map((i) => `     - ${i}`)];
      if (c.needPhoto) { nPhoto++; t.push(`     PHOTO: ${keys.length ? keys.join(" ") : "(none attached)"}`); }
      if (!bad.has(f.doc)) bad.set(f.doc, []);
      bad.get(f.doc).push(t.join("\n"));
    }
    for (const r of rows) {
      const v = variantIssues(r);
      if (!v.issues.length) continue;
      const keys = r.photo_urls || [];
      const t = [`  ${r.doc}${r.ac ? ` (AC ${r.ac})` : ""} ${r.grp} ${r.code} x${r.qty}`,
                 `     Desc2: ${JSON.stringify((r.d2 || "").slice(0, 100))}`,
                 ...v.issues.map((i) => `     - ${i}`)];
      if (v.needPhoto) { nPhoto++; t.push(`     PHOTO: ${keys.length ? keys.join(" ") : "(none attached)"}`); }
      if (!bad.has(r.doc)) bad.set(r.doc, []);
      bad.get(r.doc).push(t.join("\n"));
    }
    const findings = [...bad.values()].flat();
    log("");
    log(`=== ${label}: ${rows.length} lines (${nBF} bedframe / ${nSofa} sofa) across ${new Set(rows.map((r) => r.doc)).size} docs`);
    log(`    ${findings.length} findings on ${bad.size} documents; ${nPhoto} need the photo`);
    if (LIST) {
      for (const t of findings.slice(0, CAP)) for (const ln of t.split("\n")) log(ln);
      if (findings.length > CAP) log(`  ... ${findings.length - CAP} more (raise CAP to see them)`);
    }
  }

  // ---- C. SO -> PO alignment ----
  const soById = new Map();
  const soAll = await sql`
    SELECT i.id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp, i.variants
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group IN ('bedframe','sofa')`;
  for (const r of soAll) soById.set(r.id, r);

  const linked = poRows.filter((r) => r.so_item_id);
  let mism = 0, orphan = 0;
  const rows = [];
  for (const p of linked) {
    const s = soById.get(p.so_item_id);
    if (!s) { orphan++; continue; }
    const diffs = [];
    if (norm(p.code) !== norm(s.code)) diffs.push(`code: SO ${s.code} vs PO ${p.code}`);
    for (const k of AXES) {
      const a = vget(s.variants, k), b = vget(p.variants, k);
      if (a === b) continue;
      if (a === null || b === null) { diffs.push(`${k}: SO ${a ?? "-"} vs PO ${b ?? "-"}`); continue; }
      if (norm(a) !== norm(b)) diffs.push(`${k}: SO ${a} vs PO ${b}`);
    }
    if (!diffs.length) continue;
    mism++;
    rows.push(`  ${s.doc} -> ${p.doc}  ${p.grp}\n     ${diffs.join("\n     ")}`);
  }
  log("");
  log(`=== C. SO -> PO ALIGNMENT: ${linked.length} dedicated PO lines checked`);
  log(`    ${mism} disagree with their SO line; ${orphan} point at an SO line that is gone`);
  if (LIST) {
    for (const t of rows.slice(0, CAP)) for (const ln of t.split("\n")) log(ln);
    if (rows.length > CAP) log(`  ... ${rows.length - CAP} more (raise CAP to see them)`);
  }
  log("");
  log(`unlinked PO lines (no so_item_id, so nothing to align against): ${poRows.length - linked.length}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
