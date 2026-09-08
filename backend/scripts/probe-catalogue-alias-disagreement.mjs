#!/usr/bin/env node
// READ-ONLY. Where does the product catalogue disagree with SOFA_MODEL_ALIAS,
// and what does that disagreement COST at the one place that refuses a line?
//
// WHY. Four purchase orders (PO-010085, PO-010086, PO-010160, PO-010161) were
// withheld by topup-ac-po-lines.mjs because `HOK-5536 SOFA` / `HOK-5540 SOFA`
// read `sofa` on one importer's rule and `others` on the other's. That was
// escalated as a decision to make. It is not one: lib/parse-sofa.mjs's
// SOFA_MODEL_ALIAS already says 5536 -> 9058 and 5540 -> 8030, and every other
// sofa path folds through it (repair-orphan-sofa-codes.yml states the rule;
// import-ac-outstanding-po.mjs applies it via lib/catalog-code-guard.mjs).
//
// THE HYPOTHESIS THIS PROBE EXISTS TO REFUTE. topup-ac-po-lines.mjs:232 looks
// the catalogue up with the code the mapping CSV spells, UNFOLDED:
//
//     const fromCat = prodCat.get(norm(erp));        // erp === "5536-1S"
//     const ruleSoLinked = fromCat ?? "others";      // -> "others"
//     const sofaSplit = (ruleOutstanding === "sofa") !== (ruleSoLinked === "sofa");
//
// so the claim is that the catalogue does not say `others` about these sofas at
// all — it says NOTHING, because it carries the ALIASED code (`9058-1S`) and was
// asked about the unaliased one. `?? "others"` then turns an absent row into a
// confident wrong label.
//
// REFUTED IF: scm.mfg_products actually carries a `5536-*` / `5540-*` row whose
// category is `others`. Then the disagreement is a real mis-categorised product
// and folding the lookup fixes nothing. Q1 and Q4 below are what settle it.
//
// Q1  the four alias pairs, raw code vs aliased code, side by side
// Q2  census over EVERY mapped code in the CSV: absent from the catalogue, and
//     of those, how many the alias resolves — with the denominator
// Q3  the SOFA-axis refusal (topup's own sofaSplit rule) recomputed over every
//     mapped code, BEFORE the fold and AFTER it
// Q4  does the catalogue carry ANY row on the four alias SOURCE bases at all
// Q5  the seven documents of docs/bugs/0682, as they stand right now
//
// No writes, no DDL. Exits 0 for every legitimate answer, including "no
// disagreement" — a probe that exits non-zero on a finding cannot be dispatched
// twice without reading the exit code as a failure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { aliasedCode, aliasFoldsForCatalog, catalogPredicate } from "./lib/catalog-code-guard.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

// The two importers' item_group vocabularies, copied from the scripts under
// test so this probe measures THEIR rule and not a tidied-up version of it.
// topup-ac-po-lines.mjs:123 and :125.
const CATG = { MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory", BEDLINES: "accessory", DIFFUSER: "others", CARPET: "others", DINING: "others", OTHER: "others", SERVICE: "service", TRANS: "service", SOFA: "sofa" };
const PCATG = { SOFA: "sofa", BEDFRAME: "bedframe", ACCESSORY: "accessory", MATTRESS: "mattress", SERVICE: "service" };

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  const csvRaw = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csvRaw.shift();
  const byAc = new Map();
  for (const ln of csvRaw) {
    const f = parseCsvLine(ln);
    if (f[0]) byAc.set(norm(f[0]), { erp: (f[1] || "").trim(), cat: (f[3] || "").trim().toUpperCase() });
  }
  log(`mapping file: ${byAc.size} AutoCount item codes`);

  // ── Q1 ────────────────────────────────────────────────────────────────────
  const pairs = Object.entries(SOFA_MODEL_ALIAS).flatMap(([from, to]) => [`${from}-1S`, `${to}-1S`]);
  const q1 = await sql`
    SELECT code, category::text AS category
      FROM scm.mfg_products
     WHERE company_id = ${CO} AND upper(code) = ANY(${pairs.map((c) => c.toUpperCase())})
     ORDER BY code`;
  const catOf = new Map(q1.map((r) => [r.code.toUpperCase(), r.category]));
  log("");
  log("Q1  the four alias pairs — what the catalogue answers for each spelling");
  for (const [from, to] of Object.entries(SOFA_MODEL_ALIAS)) {
    const a = `${from}-1S`, b = `${to}-1S`;
    const ca = catOf.has(a.toUpperCase()) ? catOf.get(a.toUpperCase()) : "(NO ROW)";
    const cb = catOf.has(b.toUpperCase()) ? catOf.get(b.toUpperCase()) : "(NO ROW)";
    log(`   ${from} -> ${to}   catalogue(${a}) = ${ca}   |   catalogue(${b}) = ${cb}`);
  }

  // ── Q2 ────────────────────────────────────────────────────────────────────
  const products = await sql`SELECT code, category::text AS category FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(products.map((p) => p.code.toUpperCase()));
  const exists = catalogPredicate(codeSet);
  const prodCat = new Map(products.map((p) => [norm(p.code), PCATG[String(p.category ?? "").toUpperCase()] ?? null]));
  const mapped = [...byAc.values()].map((v) => v.erp).filter(Boolean);
  const distinctMapped = new Set(mapped.map((c) => c.toUpperCase()));
  const absent = [...distinctMapped].filter((c) => !exists(c));
  const moves = aliasFoldsForCatalog(mapped, exists, SOFA_MODEL_ALIAS);
  log("");
  log(`Q2  catalogue coverage of the mapping file`);
  log(`   catalogue rows (company ${CO}): ${products.length}`);
  log(`   distinct mapped ERP codes: ${distinctMapped.size} of ${byAc.size} mapping rows`);
  log(`   absent from the catalogue: ${absent.length} of ${distinctMapped.size}`);
  log(`   ...of which SOFA_MODEL_ALIAS resolves onto a code the catalogue DOES carry: ${moves.size} of ${absent.length}`);
  for (const [from, to] of moves) log(`      ${from} -> ${to}`);
  const stillAbsent = absent.filter((c) => !moves.has(c) && !moves.has(c.toUpperCase()));
  log(`   still absent after the fold: ${stillAbsent.length} of ${distinctMapped.size}`);
  for (const c of stillAbsent.slice(0, 25)) log(`      ${c}`);
  if (stillAbsent.length > 25) log(`      ... and ${stillAbsent.length - 25} more`);

  // ── Q3 ────────────────────────────────────────────────────────────────────
  // topup-ac-po-lines.mjs:232-243, replicated exactly, over every mapping row.
  const split = (erp, csvCat) => {
    const fromCat = prodCat.get(norm(erp));
    const fromCsv = CATG[csvCat] ?? null;
    return { on: ((fromCsv ?? "others") === "sofa") !== ((fromCat ?? "others") === "sofa"), fromCat, fromCsv };
  };
  const before = [], after = [];
  for (const [ac, v] of byAc) {
    if (!v.erp) continue;
    const b = split(v.erp, v.cat);
    if (b.on) before.push({ ac, erp: v.erp, csv: b.fromCsv ?? "others", cat: b.fromCat ?? "others" });
    const folded = moves.get(v.erp) ?? (exists(v.erp) ? v.erp : (aliasedCode(v.erp, SOFA_MODEL_ALIAS) ?? v.erp));
    const a = split(folded, v.cat);
    if (a.on) after.push({ ac, erp: folded, csv: a.fromCsv ?? "others", cat: a.fromCat ?? "others" });
  }
  log("");
  log(`Q3  topup-ac-po-lines.mjs's SOFA-axis refusal (sofaSplit), over all ${byAc.size} mapping rows`);
  log(`   BEFORE the alias fold: ${before.length} mapping row(s) refuse`);
  for (const r of before.slice(0, 40)) log(`      ${r.ac}  -> ${r.erp}   csv=${r.csv}  catalogue=${r.cat}`);
  if (before.length > 40) log(`      ... and ${before.length - 40} more`);
  log(`   AFTER the alias fold:  ${after.length} mapping row(s) refuse`);
  for (const r of after.slice(0, 40)) log(`      ${r.ac}  -> ${r.erp}   csv=${r.csv}  catalogue=${r.cat}`);
  if (after.length > 40) log(`      ... and ${after.length - 40} more`);

  // ── Q4 ────────────────────────────────────────────────────────────────────
  const bases = Object.keys(SOFA_MODEL_ALIAS);
  const q4 = await sql`
    SELECT split_part(code, '-', 1) AS base, count(*)::int AS n
      FROM scm.mfg_products
     WHERE company_id = ${CO} AND split_part(code, '-', 1) = ANY(${bases})
     GROUP BY 1 ORDER BY 1`;
  log("");
  log(`Q4  does the catalogue carry ANY row on the four alias SOURCE bases (${bases.join(", ")})?`);
  if (!q4.length) log(`   none — 0 rows on any of the four. The catalogue only ever spells them by their ALIAS.`);
  for (const r of q4) log(`   ${r.base}: ${r.n} row(s)  <- the refutation, if this is non-empty`);

  // ── Q5 ────────────────────────────────────────────────────────────────────
  const docs = ["PO-010085", "PO-010086", "PO-010146", "PO-010150", "PO-010151", "PO-010160", "PO-010161", "PO-010170"];
  const q5 = await sql`
    SELECT h.po_number, h.linked_ac_docno, h.status::text AS status, h.total_sen,
           count(i.id)::int AS lines,
           count(*) FILTER (WHERE i.item_group = 'sofa')::int AS sofa_lines
      FROM scm.purchase_orders h
      LEFT JOIN scm.purchase_order_items i ON i.po_id = h.id
     WHERE h.company_id = ${CO} AND h.linked_ac_docno = ANY(${docs})
     GROUP BY h.po_number, h.linked_ac_docno, h.status, h.total_sen
     ORDER BY h.linked_ac_docno`;
  log("");
  log(`Q5  the documents of docs/bugs/0682, as they stand now`);
  for (const r of q5) log(`   ${r.linked_ac_docno} (${r.po_number}) ${r.status}  lines=${r.lines} sofa=${r.sofa_lines} total_sen=${r.total_sen}`);
  const missing = docs.filter((d) => !q5.some((r) => r.linked_ac_docno === d));
  if (missing.length) log(`   not in the ERP at all: ${missing.join(", ")}`);

  log("");
  log("VERDICT");
  log(`   ${moves.size} mapped code(s) the catalogue does not carry resolve through SOFA_MODEL_ALIAS.`);
  log(`   sofaSplit refusals: ${before.length} before the fold -> ${after.length} after.`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
