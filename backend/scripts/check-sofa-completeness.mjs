#!/usr/bin/env node
// READ-ONLY. Which sofa documents are not fully specified?
//
// Owner 2026-08-10, verbatim scope:
//   "东西它的沙发 compartment、variants 错的都没关系,可是我们 PO 开出去,
//    我们一定要有详细的 PO compartment、沙发 compartment 跟 variants 的.
//    再来,如果我们的 sales order 已经 proceed 了的情况之下,它的 compartment
//    一定是要对,还有它的沙发的颜色、尺寸、variants 等等都要对的."
//
// So exactly two populations are in scope, and an un-proceeded SO is NOT:
//   PO   — every sofa line on a purchase order. A PO leaves the building.
//   SO   — sofa lines on orders with proceeded_at set.
//
// Three independent things are checked per line, because they fail separately:
//   COMPARTMENT — is this an honest placeholder (remark SOFA UNPARSED), or a
//                 bare {model}-1S that no decode ever confirmed? And does the
//                 CURRENT decoder read MORE pieces out of the stored Desc2 than
//                 the document actually holds? That last one is how the corner
//                 regression (a bare "C" filtered as noise, fixed alongside
//                 this script) shows up on already-imported rows.
//   COLOUR      — variants.colourId / fabricId resolved against the library.
//                 TBC/KIV in the source is "not chosen yet", reported apart
//                 from "we could not read it".
//   SEAT SIZE   — variants.seatHeight.
//
// Lines whose Desc2 cannot answer the question are listed under NEEDS PHOTO
// with their photo keys, which is the input to reading the build off the
// AutoCount picture instead.
//
// No writes, no DDL, one connection. APPLY does not exist here on purpose.
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const LIST = process.env.LIST !== "0"; // print the per-line detail
const here = path.dirname(fileURLToPath(import.meta.url));
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

/* A build is one AutoCount line: every ERP row that came from it shares the
   document and the model, and (for a decomposed build) the same Desc2. */
function groupBuilds(rows, docKey) {
  const g = new Map();
  for (const r of rows) {
    const k = `${r[docKey]}|${modelOf(r.code)}|${norm(r.d2).slice(0, 120)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
}

function judge(build, reclOK, codeSet) {
  const first = build[0];
  const model = modelOf(first.code);
  const have = build.map((r) => norm(r.code).replace(model + "-", ""));
  const placeholder = build.some((r) => /SOFA UNPARSED/.test(r.remark || ""));
  const ps = parseSofa(first.d2, model, reclOK);
  const want = ps.pieces || [];
  const wantCodes = want.map((c) => `${model}-${c}`);
  const wantExists = wantCodes.length > 0 && wantCodes.every((c) => codeSet.has(norm(c)));

  const issues = [];
  let needPhoto = false;
  if (placeholder) {
    issues.push("COMPARTMENT: placeholder (SOFA UNPARSED)");
    needPhoto = true;
  } else if (ps.conf === "low") {
    /* The document holds pieces but the source text cannot confirm them —
       either they were decoded by an older parser or an operator typed them. */
    if (have.length === 1 && /^1S$/i.test(have[0])) {
      issues.push("COMPARTMENT: single 1S, source unreadable");
      needPhoto = true;
    }
  } else if (want.length && want.length !== build.length) {
    issues.push(`COMPARTMENT: doc has ${build.length} (${have.join("+")}), Desc2 reads ${want.length} (${want.join("+")})`);
    if (!wantExists) issues.push(`  piece SKU missing: ${wantCodes.filter((c) => !codeSet.has(norm(c))).join(",")}`);
  } else if (want.length && want.join("+") !== have.join("+")) {
    issues.push(`COMPARTMENT: doc ${have.join("+")} vs Desc2 ${want.join("+")}`);
  }

  const v = first.variants || {};
  const colour = v.colourId || v.fabricCode || v.colourLabel || null;
  if (!colour) {
    if (isPending(ps.color) || isPending(first.d2)) issues.push("COLOUR: source says TBC/KIV (not chosen yet)");
    else if (ps.color) { issues.push(`COLOUR: "${ps.color}" not matched to the fabric library`); }
    else { issues.push("COLOUR: none in Desc2"); needPhoto = true; }
  }
  if (!v.seatHeight) {
    if (ps.size) issues.push(`SEAT SIZE: Desc2 reads ${ps.size}" but the line has none`);
    else { issues.push("SEAT SIZE: none in Desc2"); needPhoto = true; }
  }
  return { issues, needPhoto, want, have, conf: ps.conf, why: ps.why || [] };
}

async function main() {
  log(`READ-ONLY sofa completeness audit — company ${CO}`);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => norm(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (model) => RECL.some((s) => codeSet.has(norm(model + s)));

  // ---- population 1: EVERY sofa line on a purchase order ----
  const poRows = await sql`
    SELECT p.po_number AS doc, p.linked_ac_docno AS ac, i.material_code AS code,
           i.description2 AS d2, i.variants, i.notes AS remark, i.qty, i.photo_urls
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group = 'sofa'
     ORDER BY p.po_number`;

  // ---- population 2: sofa lines on PROCEEDED sales orders ----
  const soRows = await sql`
    SELECT h.doc_no AS doc, h.linked_ac_docno AS ac, h.proceeded_at, i.item_code AS code,
           i.description2 AS d2, i.variants, i.remark, i.qty, i.photo_urls
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.proceeded_at IS NOT NULL
     ORDER BY h.doc_no, i.line_no`;

  for (const [rows, label] of [[poRows, "PURCHASE ORDER (all sofa lines)"], [soRows, "SALES ORDER (proceeded only)"]]) {
    const builds = groupBuilds(rows, "doc");
    let bad = 0, photo = 0;
    const detail = [];
    for (const [, b] of builds) {
      const r = judge(b, reclOf(modelOf(b[0].code)), codeSet);
      if (!r.issues.length) continue;
      bad++;
      if (r.needPhoto) photo++;
      detail.push({ b, r });
    }
    log("");
    log(`=== ${label}: ${rows.length} lines / ${builds.size} builds — ${bad} incomplete (${photo} need the photo) ===`);
    if (!LIST) continue;
    for (const { b, r } of detail) {
      const f = b[0];
      const keys = [...new Set(b.flatMap((x) => x.photo_urls || []))];
      log(`  ${f.doc}${f.ac ? ` (AC ${f.ac})` : ""}  ${modelOf(f.code)}  x${f.qty}`);
      log(`     Desc2: ${JSON.stringify((f.d2 || "").slice(0, 90))}`);
      for (const i of r.issues) log(`     - ${i}`);
      if (r.needPhoto) log(`     PHOTO: ${keys.length ? keys.join(" ") : "(none attached)"}`);
    }
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
