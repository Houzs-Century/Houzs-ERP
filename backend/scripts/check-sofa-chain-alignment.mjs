#!/usr/bin/env node
// READ-ONLY. Does the sofa build survive the whole document chain?
//
// check-po-so-completeness.mjs asks whether a document is fully specified and
// whether the SO and the PO agree. This asks the next question, which nothing
// else asks: SO -> PO -> GRN and SO -> DO are four SEPARATE snapshots of one
// build, and a correction applied to the SO or the PO does not travel on its
// own. If the customer's paperwork and the factory's paperwork describe
// different builds, both documents are internally consistent and the system is
// silent about it.
//
//   LEG 1  SO  -> PO    scm.purchase_order_items.so_item_id
//   LEG 2  PO  -> GRN   scm.grn_items.purchase_order_item_id
//   LEG 3  SO  -> DO    scm.delivery_order_items.so_item_id
//   LEG 4  (SO -> PO -> GRN)  vs  (SO -> DO)   — the transitive check: did the
//          factory build and the delivery note end up saying the same thing?
//
// COMPARISON RULES, because getting these wrong makes the audit lie:
//
//   * Compartments are compared as a CASE-INSENSITIVE MULTISET. Row order is
//     line_no, which is not the physical layout, so an order difference is not
//     a finding; a DUPLICATED piece is, so a Set would be wrong.
//   * A piece the child LACKS and a piece the child INVENTED are different
//     defects and are reported in their own directions.
//   * BEDFRAME is reported separately and WITHOUT the compartment test — a
//     bedframe is one line, not a piece set. The script measures the
//     lines-per-build distribution and prints it rather than asserting it.
//   * A category with zero rows prints "0 rows". Never a percentage of nothing.
//
// KNOWN BLIND SPOT, handled explicitly in section F: a DO line whose
// so_item_id is NULL is invisible to any so_item_id-keyed check (DO-2607-005,
// the confirmed duplicate ship against SO-2606-019, is one). Those are counted
// on their own, then matched a SECOND way — delivery_orders.so_doc_no plus
// item code, then plus quantity — so they can never be scored as "aligned" by
// having been skipped.
//
// No writes, no DDL, one statement per query. There is deliberately no APPLY.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const LIST = process.env.LIST !== "0";
const CAP = Number(process.env.CAP || 25);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const modelOf = (code) => {
  const c = norm(code);
  const d = c.indexOf("-");
  const base = d < 0 ? c : c.slice(0, d);
  return SOFA_MODEL_ALIAS[base] || base;
};
const compOf = (code) => {
  const c = norm(code);
  const d = c.indexOf("-");
  return d < 0 ? "" : c.slice(d + 1);
};
/* Sofa compares by COMPARTMENT (the part of the code after the model); bedframe
   compares by the WHOLE code, because a bedframe code's tail is its size, not a
   piece of a set. Section 0 prints the evidence for that split. */
const pieceOf = (grp, code) => (grp === "sofa" ? compOf(code) : norm(code));

const AXES = ["fabricCode", "colourId", "fabricId", "seatHeight", "depth", "divanHeight", "legHeight", "gap"];
const vget = (v, k) => {
  const x = (v || {})[k];
  return x === undefined || x === null || String(x).trim() === "" ? null : String(x).trim();
};
const hasVariants = (v) => !!v && typeof v === "object" && AXES.some((k) => vget(v, k) !== null);

/* Parent has X the child lacks / child has Y the parent never had. Multiset:
   two CONSOLEs on the SO and one on the PO is a real finding. */
function multisetDiff(parentPieces, childPieces) {
  const a = parentPieces.map(norm).sort();
  const b = childPieces.map(norm).sort();
  if (a.join("|") === b.join("|")) return null;
  const poolB = [...b], poolA = [...a];
  const childLacks = [];
  for (const x of a) { const i = poolB.indexOf(x); if (i < 0) childLacks.push(x); else poolB.splice(i, 1); }
  const childExtra = [];
  for (const x of b) { const i = poolA.indexOf(x); if (i < 0) childExtra.push(x); else poolA.splice(i, 1); }
  return { childLacks, childExtra };
}

/* One pair = one child line and the parent line its foreign key names. Four
   verdicts, kept apart on purpose: "the child carries no variants at all" is a
   property of how that document type was written, not a drifted value, and
   folding the two together would bury both. */
function pairVerdict(parent, child, grp) {
  const codeDiff = norm(parent.code) !== norm(child.code);
  const axisDiffs = [];
  for (const k of AXES) {
    const a = vget(parent.variants, k), b = vget(child.variants, k);
    if (a === b) continue;
    if (a === null || b === null) { axisDiffs.push(`${k}: parent ${a ?? "-"} vs child ${b ?? "-"}`); continue; }
    if (norm(a) !== norm(b)) axisDiffs.push(`${k}: parent ${a} vs child ${b}`);
  }
  const childBlank = !hasVariants(child.variants);
  if (codeDiff) return { kind: "CODE", axisDiffs, codeDiff, grp };
  if (childBlank && hasVariants(parent.variants)) return { kind: "VAR_ABSENT", axisDiffs, codeDiff, grp };
  if (axisDiffs.length) return { kind: "VAR_DIFF", axisDiffs, codeDiff, grp };
  return { kind: "ALIGNED", axisDiffs, codeDiff, grp };
}

const count = (n, unit) => (n === 0 ? `0 ${unit}` : `${n} ${unit}`);

/* A build can legitimately be received across two GRNs or shipped across two
   DOs. The union of those children then holds each piece twice, which the
   multiset correctly calls a difference and a reader would wrongly call a
   defect. Tag it instead of hiding it: the count stays in the mismatch column,
   and the tag says the union spans several documents so partial receipts and
   split deliveries are read as what they are. */
const spanTag = (rows) => {
  const n = new Set(rows.map((r) => r.doc)).size;
  return n > 1 ? `  [SPANS ${n} DOCUMENTS — a duplicated piece here may be a partial receipt / split delivery, not a defect]` : "";
};

function printLeg(name, link, s, mismatchLines, buildLines) {
  log("");
  log(`=== ${name}   (link: ${link})`);
  if (s.child === 0) { log("    0 rows — no child line of this type exists in scope, so this leg is not measurable."); return; }
  log(`    child lines in scope        ${s.child}   (sofa ${s.childSofa} / bedframe ${s.childBed})`);
  log(`    UNLINKABLE (null FK)        ${s.nullFk}`);
  log(`    dangling FK (parent gone)   ${s.dangling}`);
  log(`    linked pairs                ${s.pairs}`);
  if (s.pairs === 0) {
    log("      0 rows — nothing is linked, so no pair could be compared.");
  } else {
    log(`      aligned                   ${s.aligned}`);
    log(`      MISMATCH code             ${s.code}`);
    log(`      MISMATCH variant value    ${s.varDiff}`);
    log(`      child carries no variants ${s.varAbsent}   (a snapshot that never copied them)`);
  }
  log(`    builds with >=1 child       ${s.builds}   (sofa ${s.buildsSofa} / bedframe ${s.buildsBed})`);
  if (s.builds === 0) log("      0 rows — no build reached this leg.");
  else {
    log(`      piece multiset aligned    ${s.buildsAligned}`);
    log(`      piece multiset MISMATCH   ${s.buildsMismatch}`);
  }
  if (!LIST) return;
  if (buildLines.length) {
    log(`    --- build-level differences (${buildLines.length}; showing up to ${CAP}) ---`);
    for (const t of buildLines.slice(0, CAP)) for (const ln of t.split("\n")) log(ln);
    if (buildLines.length > CAP) log(`    ... ${buildLines.length - CAP} more (raise CAP)`);
  } else log("    build-level differences: none");
  if (mismatchLines.length) {
    log(`    --- line-level differences (${mismatchLines.length}; showing up to ${CAP}) ---`);
    for (const t of mismatchLines.slice(0, CAP)) for (const ln of t.split("\n")) log(ln);
    if (mismatchLines.length > CAP) log(`    ... ${mismatchLines.length - CAP} more (raise CAP)`);
  } else log("    line-level differences: none");
}

async function main() {
  log(`READ-ONLY sofa/bedframe DOCUMENT-CHAIN alignment — company ${CO}`);
  log("Scope: SO -> PO -> GRN and SO -> DO. Compartments compared as a case-insensitive MULTISET.");

  // ── pulls ──────────────────────────────────────────────────────────────────
  const soRows = (await sql`
    SELECT i.id::text AS id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp,
           i.variants, i.description2 AS d2, i.line_no, i.qty, i.cancelled,
           h.linked_ac_docno AS ac, h.proceeded_at,
           UPPER(COALESCE(h.status::text, '')) AS status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE i.company_id = ${CO} AND i.item_group IN ('bedframe', 'sofa')
     ORDER BY i.doc_no, i.line_no`).map((r) => ({ ...r }));

  const poRows = (await sql`
    SELECT i.id::text AS id, p.po_number AS doc, p.id::text AS po_hdr_id,
           i.item_code AS code, i.item_group AS grp,
           i.variants, i.description2 AS d2, i.so_item_id::text AS so_item_id, i.qty,
           p.linked_ac_docno AS ac, UPPER(COALESCE(p.status::text, '')) AS status
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group IN ('bedframe', 'sofa')
     ORDER BY p.po_number`).map((r) => ({ ...r }));

  const poIds = poRows.map((r) => r.id);
  /* GRN lines are taken by PARENT REACH as well as by item_group, so a GRN line
     that lost its group tag still enters the audit instead of vanishing from it. */
  const grRows = (poIds.length ? await sql`
    SELECT gi.id::text AS id, g.grn_number AS doc, gi.item_code AS code, gi.item_group AS grp,
           gi.variants, gi.purchase_order_item_id::text AS po_item_id, gi.qty_accepted AS qty,
           g.purchase_order_id::text AS po_id, g.migrated_no_stock AS migrated,
           UPPER(COALESCE(g.status::text, '')) AS status
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
     WHERE g.company_id = ${CO}
       AND (gi.item_group IN ('bedframe', 'sofa') OR gi.purchase_order_item_id::text = ANY(${poIds}))
     ORDER BY g.grn_number` : []).map((r) => ({ ...r }));

  /* EVERY DO line for the company, deliberately unfiltered by item_group: the
     migrated DO writer (create-migrated-documents.mjs) inserts only
     so_item_id / item_code / description / uom / qty, so item_group is NULL on
     the whole migrated corpus and an item_group filter would return nothing. */
  const doRowsAll = (await sql`
    SELECT di.id::text AS id, d.do_number AS doc, d.so_doc_no, di.item_code AS code,
           di.item_group AS grp, di.variants, di.so_item_id::text AS so_item_id, di.qty,
           di.description2 AS d2, d.migrated_no_stock AS migrated,
           d.linked_ac_docno AS ac, UPPER(COALESCE(d.status::text, '')) AS status
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE d.company_id = ${CO}
     ORDER BY d.do_number`).map((r) => ({ ...r }));

  const prods = await sql`SELECT code, UPPER(category::text) AS cat FROM scm.mfg_products WHERE company_id = ${CO}`;
  const catOf = new Map(prods.map((p) => [norm(p.code), p.cat]));

  const soById = new Map(soRows.map((r) => [r.id, r]));
  const poById = new Map(poRows.map((r) => [r.id, r]));

  /* A DO line's group has to be inferred, in this order: its own tag, the SO
     line it names, then the product catalogue — the last is the only one that
     works for a line whose so_item_id is NULL, which is precisely the blind
     spot section F exists for. */
  const groupOfDo = (r) => {
    const own = (r.grp || "").toLowerCase();
    if (own === "sofa" || own === "bedframe") return own;
    const s = r.so_item_id ? soById.get(r.so_item_id) : null;
    if (s) return s.grp;
    const cat = catOf.get(norm(r.code));
    if (cat === "SOFA") return "sofa";
    if (cat === "BEDFRAME") return "bedframe";
    return null;
  };
  for (const r of doRowsAll) r.inferredGrp = groupOfDo(r);
  const doRows = doRowsAll.filter((r) => r.inferredGrp === "sofa" || r.inferredGrp === "bedframe");

  // ── 0. SHAPE — what each document type actually carries ────────────────────
  log("");
  log("=== 0. SNAPSHOT FIDELITY — what each child document type actually copied");
  const grReach = grRows.filter((r) => r.po_item_id && poById.has(r.po_item_id));
  const shape = (label, rows, fields) => {
    if (!rows.length) { log(`    ${label}: 0 rows`); return; }
    const parts = fields.map(([n, f]) => `${n} null on ${rows.filter((r) => !f(r)).length}/${rows.length}`);
    log(`    ${label}: ${parts.join(" · ")}`);
  };
  shape("SO lines        ", soRows, [["item_group", (r) => r.grp], ["variants", (r) => hasVariants(r.variants)], ["description2", (r) => r.d2]]);
  shape("PO lines        ", poRows, [["item_group", (r) => r.grp], ["variants", (r) => hasVariants(r.variants)], ["description2", (r) => r.d2]]);
  shape("GRN lines (reach)", grReach, [["item_group", (r) => r.grp], ["variants", (r) => hasVariants(r.variants)]]);
  shape("DO lines (sofa/bedframe)", doRows, [["item_group", (r) => r.grp], ["variants", (r) => hasVariants(r.variants)], ["description2", (r) => r.d2]]);
  log(`    DO lines total on company ${CO}: ${doRowsAll.length}; classified sofa/bedframe: ${doRows.length}` +
      ` (own tag ${doRows.filter((r) => (r.grp || "").toLowerCase() === r.inferredGrp).length},` +
      ` via SO line ${doRows.filter((r) => !(r.grp || "").trim() && r.so_item_id && soById.has(r.so_item_id)).length},` +
      ` via catalogue only ${doRows.filter((r) => !(r.grp || "").trim() && !(r.so_item_id && soById.has(r.so_item_id))).length})`);

  // ── builds ─────────────────────────────────────────────────────────────────
  /* A BUILD is one AutoCount line: same document, same model, same Desc2. It is
     the only unit at which "the piece set" means anything. */
  const buildKey = (r) => `${r.doc}|${modelOf(r.code)}|${norm(r.d2).slice(0, 140)}`;
  const soBuilds = new Map();
  for (const r of soRows) {
    if (r.cancelled) continue;
    const k = buildKey(r);
    if (!soBuilds.has(k)) soBuilds.set(k, { key: k, doc: r.doc, grp: r.grp, model: modelOf(r.code), so: [], po: [], gr: [], do: [] });
    soBuilds.get(k).so.push(r);
    r.build = soBuilds.get(k);
  }
  const bedSizes = [...soBuilds.values()].filter((b) => b.grp === "bedframe").map((b) => b.so.length);
  const sofaSizes = [...soBuilds.values()].filter((b) => b.grp === "sofa").map((b) => b.so.length);
  const dist = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} line${k > 1 ? "s" : ""}:${v}`).join(" · "); };
  log("");
  log("=== 0b. IS THE COMPARTMENT TEST APPLICABLE? — lines per SO build, measured");
  log(`    sofa builds     ${sofaSizes.length}${sofaSizes.length ? `   ${dist(sofaSizes)}` : "   (0 rows)"}`);
  log(`    bedframe builds ${bedSizes.length}${bedSizes.length ? `   ${dist(bedSizes)}` : "   (0 rows)"}`);
  log("    Compartments are tested for SOFA only. Bedframe is compared on the WHOLE item code");
  log("    plus the variant axes; if the distribution above is dominated by 1-line builds, a");
  log("    bedframe piece set does not exist to be wrong.");

  // ── LEG 1: SO -> PO ────────────────────────────────────────────────────────
  const legStats = () => ({ child: 0, childSofa: 0, childBed: 0, nullFk: 0, dangling: 0, pairs: 0, aligned: 0, code: 0, varDiff: 0, varAbsent: 0, builds: 0, buildsSofa: 0, buildsBed: 0, buildsAligned: 0, buildsMismatch: 0 });

  const s1 = legStats(); const m1 = []; const b1 = [];
  for (const p of poRows) {
    s1.child++; (p.grp === "sofa" ? s1.childSofa++ : s1.childBed++);
    if (!p.so_item_id) { s1.nullFk++; continue; }
    const s = soById.get(p.so_item_id);
    if (!s) { s1.dangling++; continue; }
    s1.pairs++;
    if (s.build) s.build.po.push(p);
    const v = pairVerdict(s, p, s.grp);
    if (v.kind === "ALIGNED") { s1.aligned++; continue; }
    if (v.kind === "CODE") s1.code++; else if (v.kind === "VAR_ABSENT") s1.varAbsent++; else s1.varDiff++;
    m1.push(`      ${s.doc} -> ${p.doc}  ${s.grp} ${modelOf(s.code)}  [${v.kind}]\n` +
            `         SO ${s.code}  vs  PO ${p.code}` + (v.axisDiffs.length ? `\n         ${v.axisDiffs.join("\n         ")}` : ""));
  }
  for (const b of soBuilds.values()) {
    if (!b.po.length) continue;
    s1.builds++; (b.grp === "sofa" ? s1.buildsSofa++ : s1.buildsBed++);
    const d = multisetDiff(b.so.map((r) => pieceOf(b.grp, r.code)), b.po.map((r) => pieceOf(b.grp, r.code)));
    if (!d) { s1.buildsAligned++; continue; }
    s1.buildsMismatch++;
    b1.push(`      ${b.doc} -> ${[...new Set(b.po.map((r) => r.doc))].join(",")}  ${b.grp} ${b.model}${spanTag(b.po)}\n` +
            `         SO  ${b.so.map((r) => pieceOf(b.grp, r.code)).join("+")}\n` +
            `         PO  ${b.po.map((r) => pieceOf(b.grp, r.code)).join("+")}\n` +
            `         PO lacks: ${d.childLacks.join(", ") || "(none)"}   PO has that the SO never had: ${d.childExtra.join(", ") || "(none)"}`);
  }
  printLeg("LEG 1  SO -> PO", "purchase_order_items.so_item_id", s1, m1, b1);

  // ── LEG 2: PO -> GRN ───────────────────────────────────────────────────────
  const s2 = legStats(); const m2 = []; const b2 = [];
  const poBuildOf = new Map(); // po line id -> the SO build it hangs under
  for (const b of soBuilds.values()) for (const p of b.po) poBuildOf.set(p.id, b);
  /* PO-side builds are keyed on the PO document itself, so a PO with no SO
     behind it is still measured rather than dropped. */
  const poBuilds = new Map();
  for (const p of poRows) {
    const k = buildKey(p);
    if (!poBuilds.has(k)) poBuilds.set(k, { doc: p.doc, grp: p.grp, model: modelOf(p.code), po: [], gr: [] });
    poBuilds.get(k).po.push(p);
    p.pbuild = poBuilds.get(k);
  }
  for (const g of grRows) {
    const parent = g.po_item_id ? poById.get(g.po_item_id) : null;
    const grp = parent ? parent.grp : ((g.grp || "").toLowerCase() === "sofa" ? "sofa" : (g.grp || "").toLowerCase() === "bedframe" ? "bedframe" : null);
    if (!grp) continue;
    s2.child++; (grp === "sofa" ? s2.childSofa++ : s2.childBed++);
    if (!g.po_item_id) { s2.nullFk++; continue; }
    if (!parent) { s2.dangling++; continue; }
    s2.pairs++;
    if (parent.pbuild) parent.pbuild.gr.push(g);
    const b = poBuildOf.get(parent.id);
    if (b) b.gr.push(g);
    const v = pairVerdict(parent, g, grp);
    if (v.kind === "ALIGNED") { s2.aligned++; continue; }
    if (v.kind === "CODE") s2.code++; else if (v.kind === "VAR_ABSENT") s2.varAbsent++; else s2.varDiff++;
    m2.push(`      ${parent.doc} -> ${g.doc}  ${grp} ${modelOf(parent.code)}  [${v.kind}]${g.status === "CANCELLED" ? "  (GRN CANCELLED)" : ""}\n` +
            `         PO ${parent.code}  vs  GRN ${g.code}` + (v.axisDiffs.length ? `\n         ${v.axisDiffs.join("\n         ")}` : ""));
  }
  for (const b of poBuilds.values()) {
    if (!b.gr.length) continue;
    s2.builds++; (b.grp === "sofa" ? s2.buildsSofa++ : s2.buildsBed++);
    const d = multisetDiff(b.po.map((r) => pieceOf(b.grp, r.code)), b.gr.map((r) => pieceOf(b.grp, r.code)));
    if (!d) { s2.buildsAligned++; continue; }
    s2.buildsMismatch++;
    b2.push(`      ${b.doc} -> ${[...new Set(b.gr.map((r) => r.doc))].join(",")}  ${b.grp} ${b.model}${spanTag(b.gr)}\n` +
            `         PO   ${b.po.map((r) => pieceOf(b.grp, r.code)).join("+")}\n` +
            `         GRN  ${b.gr.map((r) => pieceOf(b.grp, r.code)).join("+")}\n` +
            `         GRN lacks: ${d.childLacks.join(", ") || "(none)"}   GRN has that the PO never had: ${d.childExtra.join(", ") || "(none)"}`);
  }
  printLeg("LEG 2  PO -> GRN", "grn_items.purchase_order_item_id", s2, m2, b2);

  // ── LEG 3: SO -> DO ────────────────────────────────────────────────────────
  const s3 = legStats(); const m3 = []; const b3 = [];
  const crossDoc = [];
  for (const r of doRows) {
    s3.child++; (r.inferredGrp === "sofa" ? s3.childSofa++ : s3.childBed++);
    if (!r.so_item_id) { s3.nullFk++; continue; }
    const s = soById.get(r.so_item_id);
    if (!s) { s3.dangling++; continue; }
    s3.pairs++;
    if (s.build) s.build.do.push(r);
    if (r.so_doc_no && r.so_doc_no !== s.doc) crossDoc.push(`      ${r.doc} line ${r.code}: header says SO ${r.so_doc_no}, so_item_id points at ${s.doc}`);
    const v = pairVerdict(s, r, s.grp);
    if (v.kind === "ALIGNED") { s3.aligned++; continue; }
    if (v.kind === "CODE") s3.code++; else if (v.kind === "VAR_ABSENT") s3.varAbsent++; else s3.varDiff++;
    m3.push(`      ${s.doc} -> ${r.doc}  ${s.grp} ${modelOf(s.code)}  [${v.kind}]${r.status === "CANCELLED" ? "  (DO CANCELLED)" : ""}\n` +
            `         SO ${s.code}  vs  DO ${r.code}` + (v.axisDiffs.length ? `\n         ${v.axisDiffs.join("\n         ")}` : ""));
  }
  for (const b of soBuilds.values()) {
    if (!b.do.length) continue;
    s3.builds++; (b.grp === "sofa" ? s3.buildsSofa++ : s3.buildsBed++);
    const d = multisetDiff(b.so.map((r) => pieceOf(b.grp, r.code)), b.do.map((r) => pieceOf(b.grp, r.code)));
    if (!d) { s3.buildsAligned++; continue; }
    s3.buildsMismatch++;
    b3.push(`      ${b.doc} -> ${[...new Set(b.do.map((r) => r.doc))].join(",")}  ${b.grp} ${b.model}${spanTag(b.do)}\n` +
            `         SO  ${b.so.map((r) => pieceOf(b.grp, r.code)).join("+")}\n` +
            `         DO  ${b.do.map((r) => pieceOf(b.grp, r.code)).join("+")}\n` +
            `         DO lacks: ${d.childLacks.join(", ") || "(none)"}   DO has that the SO never had: ${d.childExtra.join(", ") || "(none)"}`);
  }
  printLeg("LEG 3  SO -> DO", "delivery_order_items.so_item_id", s3, m3, b3);
  log(`    DO lines whose header SO and whose so_item_id disagree: ${crossDoc.length}`);
  if (LIST) for (const t of crossDoc.slice(0, CAP)) log(t);

  // ── LEG 4: (SO -> PO -> GRN) vs (SO -> DO) ─────────────────────────────────
  log("");
  log("=== LEG 4  TRANSITIVE — the factory's document vs the customer's document");
  log("    For each SO build reachable BOTH ways, is the GRN piece set the DO piece set?");
  let both = 0, agree = 0, disagree = 0, onlyGr = 0, onlyDo = 0, neither = 0;
  const l4 = [];
  for (const b of soBuilds.values()) {
    const hasG = b.gr.length > 0, hasD = b.do.length > 0;
    if (hasG && hasD) {
      both++;
      const d = multisetDiff(b.gr.map((r) => pieceOf(b.grp, r.code)), b.do.map((r) => pieceOf(b.grp, r.code)));
      if (!d) { agree++; continue; }
      disagree++;
      l4.push(`      ${b.doc}  ${b.grp} ${b.model}${spanTag([...b.gr, ...b.do])}\n` +
              `         GRN ${[...new Set(b.gr.map((r) => r.doc))].join(",")}: ${b.gr.map((r) => pieceOf(b.grp, r.code)).join("+")}\n` +
              `         DO  ${[...new Set(b.do.map((r) => r.doc))].join(",")}: ${b.do.map((r) => pieceOf(b.grp, r.code)).join("+")}\n` +
              `         DO lacks: ${d.childLacks.join(", ") || "(none)"}   DO has that the GRN never had: ${d.childExtra.join(", ") || "(none)"}`);
    } else if (hasG) onlyGr++;
    else if (hasD) onlyDo++;
    else neither++;
  }
  log(`    SO builds total                              ${soBuilds.size}`);
  log(`    reachable BOTH ways (GRN and DO)             ${both}`);
  if (both === 0) log("      0 rows — no build has a GRN and a DO at the same time, so this leg cannot be tested.");
  else { log(`      the two documents AGREE                    ${agree}`); log(`      the two documents DISAGREE                 ${disagree}`); }
  log(`    GRN only (bought/received, not yet shipped)  ${onlyGr}`);
  log(`    DO only (shipped, no GRN reaches it)         ${onlyDo}`);
  log(`    neither                                      ${neither}`);
  if (LIST && l4.length) { log(`    --- disagreements (${l4.length}; showing up to ${CAP}) ---`); for (const t of l4.slice(0, CAP)) for (const ln of t.split("\n")) log(ln); if (l4.length > CAP) log(`    ... ${l4.length - CAP} more (raise CAP)`); }

  // ── E. why did today's correction carry 0 DO lines? ────────────────────────
  log("");
  log('=== E. WHY THE COMPARTMENT CORRECTION REPORTED "DO lines 0"');
  let corrDocs = [];
  try {
    const DATA = JSON.parse(fs.readFileSync(path.join(here, "data", "sofa-compartment-corrections-2026-08.json"), "utf8"));
    corrDocs = [...new Set(DATA.corrections.flatMap((c) => c.docs).filter((d) => /^HC-SO-/.test(d)))];
  } catch { log("    correction data file not readable — section skipped"); }
  if (corrDocs.length) {
    const [{ n: nDo }] = await sql`SELECT COUNT(*)::int AS n FROM scm.delivery_orders d
       WHERE d.company_id = ${CO} AND d.so_doc_no = ANY(${corrDocs})`;
    const [{ n: nLines }] = await sql`SELECT COUNT(*)::int AS n
        FROM scm.delivery_order_items di
        JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
       WHERE si.company_id = ${CO} AND si.doc_no = ANY(${corrDocs})`;
    const [{ n: nNull }] = await sql`SELECT COUNT(*)::int AS n
        FROM scm.delivery_order_items di
        JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
       WHERE d.company_id = ${CO} AND d.so_doc_no = ANY(${corrDocs}) AND di.so_item_id IS NULL`;
    const soLines = soRows.filter((r) => corrDocs.includes(r.doc) && r.grp === "sofa").length;
    log(`    sales orders named by the correction file          ${corrDocs.length}`);
    log(`    their sofa SO lines now in the ERP                 ${soLines}`);
    log(`    delivery orders whose header names one of them     ${nDo}`);
    log(`    DO lines whose so_item_id points at one of them    ${nLines}`);
    log(`    DO lines on those DOs with a NULL so_item_id       ${nNull}`);
    log(`    VERDICT: the correction's DO arm updates delivery_order_items WHERE so_item_id = <touched SO line>.`);
    if (nDo === 0) log("      It carried 0 because NO delivery order exists for any corrected order — the path was never exercised, not silently broken.");
    else if (nLines === 0 && nNull > 0) log("      A delivery order DOES exist, but its lines carry a NULL so_item_id, so the UPDATE matched nothing. The path IS silently blind.");
    else if (nLines === 0) log("      A delivery order exists and its lines are linked, but to SO lines the correction did not touch.");
    else log(`      ${nLines} DO line(s) are reachable, so a 0 would mean those rows were already correct or the touched ids differ.`);
  }

  // ── F. the so_item_id blind spot, matched a second way ─────────────────────
  log("");
  log("=== F. UNLINKABLE DO LINES — counted, then matched a SECOND way");
  const orphanDo = doRows.filter((r) => !r.so_item_id);
  log(`    sofa/bedframe DO lines with so_item_id NULL   ${orphanDo.length}`);
  if (!orphanDo.length) log("      0 rows — every DO line in scope names its SO line.");
  else {
    const soByDoc = new Map();
    for (const r of soRows) { if (!soByDoc.has(r.doc)) soByDoc.set(r.doc, []); soByDoc.get(r.doc).push(r); }
    let byCodeQty = 0, byCode = 0, ambiguous = 0, noDoc = 0, noCand = 0;
    const secondPass = [], stillBlind = [];
    for (const r of orphanDo) {
      if (!r.so_doc_no) { noDoc++; stillBlind.push(`      ${r.doc}  ${r.code} x${r.qty}: DO header names no sales order at all`); continue; }
      const cands = (soByDoc.get(r.so_doc_no) ?? []).filter((s) => norm(s.code) === norm(r.code));
      if (!cands.length) { noCand++; stillBlind.push(`      ${r.doc} (SO ${r.so_doc_no})  ${r.code} x${r.qty}: no SO line on that order carries this code`); continue; }
      const exact = cands.filter((s) => Number(s.qty) === Number(r.qty));
      const pick = exact.length === 1 ? exact[0] : (cands.length === 1 ? cands[0] : null);
      if (!pick) { ambiguous++; stillBlind.push(`      ${r.doc} (SO ${r.so_doc_no})  ${r.code} x${r.qty}: ${cands.length} SO lines carry this code, quantity does not disambiguate`); continue; }
      if (exact.length === 1) byCodeQty++; else byCode++;
      const v = pairVerdict(pick, r, pick.grp);
      secondPass.push({ r, pick, v });
    }
    log(`      matched by so_doc_no + item code + qty      ${byCodeQty}`);
    log(`      matched by so_doc_no + item code alone      ${byCode}`);
    log(`      ambiguous (several candidates)              ${ambiguous}`);
    log(`      DO header names no sales order              ${noDoc}`);
    log(`      no SO line on that order carries the code   ${noCand}`);
    const al = secondPass.filter((x) => x.v.kind === "ALIGNED").length;
    const cd = secondPass.filter((x) => x.v.kind === "CODE").length;
    const va = secondPass.filter((x) => x.v.kind === "VAR_ABSENT").length;
    const vd = secondPass.filter((x) => x.v.kind === "VAR_DIFF").length;
    if (!secondPass.length) log("      second-way comparison: 0 rows");
    else {
      log(`      second-way comparison, ${secondPass.length} recovered pair(s):`);
      log(`        aligned ${al} · code mismatch ${cd} · child carries no variants ${va} · variant value differs ${vd}`);
      log("        (NOT folded into LEG 3's counts — a recovered link is weaker evidence than a stored one)");
      /* But a LEG 3 build scored as "the DO lacks a piece" purely because that
         piece's DO line has a NULL link is a reporting artefact, not a real
         gap. Re-score with the recovered links so the two numbers are both on
         the table and neither can be mistaken for the other. */
      const extra = new Map();
      for (const x of secondPass) { const b = x.pick.build; if (!b) continue; if (!extra.has(b)) extra.set(b, []); extra.get(b).push(x.r); }
      let healed = 0, stillOff = 0;
      for (const b of soBuilds.values()) {
        const add = extra.get(b) ?? [];
        if (!b.do.length && !add.length) continue;
        const before = multisetDiff(b.so.map((r) => pieceOf(b.grp, r.code)), b.do.map((r) => pieceOf(b.grp, r.code)));
        const after = multisetDiff(b.so.map((r) => pieceOf(b.grp, r.code)), [...b.do, ...add].map((r) => pieceOf(b.grp, r.code)));
        if (before && !after) healed++;
        else if (after) stillOff++;
      }
      log(`      LEG 3 build verdicts re-scored WITH the recovered links:`);
      log(`        build mismatches explained away by a NULL link   ${healed}`);
      log(`        build mismatches that survive the recovery       ${stillOff}`);
    }
    if (LIST) {
      const bad = secondPass.filter((x) => x.v.kind !== "ALIGNED").map((x) =>
        `      ${x.pick.doc} -> ${x.r.doc}  ${x.pick.grp} ${modelOf(x.pick.code)}  [${x.v.kind}]\n         SO ${x.pick.code}  vs  DO ${x.r.code}`);
      if (bad.length) { log(`      --- recovered pairs that do not agree (${bad.length}; up to ${CAP}) ---`); for (const t of bad.slice(0, CAP)) for (const ln of t.split("\n")) log(ln); }
      if (stillBlind.length) { log(`      --- still unmatchable (${stillBlind.length}; up to ${CAP}) ---`); for (const t of stillBlind.slice(0, CAP)) log(t); if (stillBlind.length > CAP) log(`      ... ${stillBlind.length - CAP} more (raise CAP)`); }
    }
    const dupes = orphanDo.filter((r) => /2607-005/.test(r.doc));
    log(`      of these, on DO-2607-005 (the confirmed duplicate ship): ${count(dupes.length, "line(s)")}`);
  }

  // ── G. the same blind spot on the other two legs ───────────────────────────
  log("");
  log("=== G. UNLINKABLE ELSEWHERE — the other two legs, and what recovers them");
  log(`    PO lines with so_item_id NULL                 ${s1.nullFk}   (a stock PO legitimately has none — provenance, not a defect: docs/modules/document-traceability.md)`);
  log(`    GRN lines with purchase_order_item_id NULL    ${s2.nullFk}`);
  const orphanGr = grRows.filter((r) => !r.po_item_id && ["sofa", "bedframe"].includes((r.grp || "").toLowerCase()));
  if (!orphanGr.length) log("      0 rows — every sofa/bedframe GRN line names its PO line.");
  else {
    /* The GRN header keeps grns.purchase_order_id even when the LINE lost its
       purchase_order_item_id, so the document link plus the material code
       recovers most of them without guessing. */
    const poByHdrId = new Map();
    for (const p of poRows) { if (!poByHdrId.has(p.po_hdr_id)) poByHdrId.set(p.po_hdr_id, []); poByHdrId.get(p.po_hdr_id).push(p); }
    let rec = 0, ambig = 0, none = 0, noHdr = 0;
    const blind = [];
    for (const g of orphanGr) {
      if (!g.po_id) { noHdr++; blind.push(`      ${g.doc}  ${g.code}: GRN header names no purchase order`); continue; }
      const cands = (poByHdrId.get(g.po_id) ?? []).filter((p) => norm(p.code) === norm(g.code));
      if (cands.length === 1) { rec++; continue; }
      if (cands.length > 1) { ambig++; blind.push(`      ${g.doc}  ${g.code}: ${cands.length} PO lines on ${cands[0].doc} carry this code`); continue; }
      none++; blind.push(`      ${g.doc}  ${g.code}: no PO line on the header's purchase order carries this code`);
    }
    log(`      recovered via grns.purchase_order_id + material code: ${rec} of ${orphanGr.length}`);
    log(`      ambiguous ${ambig} · no matching PO line ${none} · GRN header names no PO ${noHdr}`);
    if (LIST) for (const t of blind.slice(0, CAP)) log(t);
  }

  log("");
  log("=== VERDICTS (the number is the proof)");
  const verdict = (n, s, extra) => log(`    ${n}: ${s.pairs === 0 ? "0 linked pairs — nothing to align" : (s.code + s.varDiff === 0 && s.buildsMismatch === 0 ? `ALIGNED — ${s.pairs} pairs, ${s.builds} builds, 0 code or piece-set differences` : `NOT fully aligned — ${s.code} code, ${s.varDiff} variant-value, ${s.buildsMismatch} piece-set`)}${extra ? `; ${extra}` : ""}`);
  verdict("LEG 1  SO -> PO ", s1, `${s1.nullFk} unlinkable`);
  verdict("LEG 2  PO -> GRN", s2, `${s2.varAbsent} carry no variants`);
  verdict("LEG 3  SO -> DO ", s3, `${s3.nullFk} unlinkable, ${s3.varAbsent} carry no variants`);
  log(`    LEG 4  transitive: ${both === 0 ? "0 builds reachable both ways — untestable" : (disagree === 0 ? `AGREE on all ${both} builds reachable both ways` : `${disagree} of ${both} builds DISAGREE`)}`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
