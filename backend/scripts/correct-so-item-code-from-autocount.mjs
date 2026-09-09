#!/usr/bin/env node
// Correct the migrated sales-order lines that name a different product from the
// account book, to the product the book names. READ-ONLY by default.
//
// THE OWNER'S RULING, 2026-09-08: follow AutoCount, correct the sales order.
// Ten sales-order lines name a product that BOTH AutoCount and our own purchase
// order disagree with - a customer's REGAL (A)-(K) where the book says
// TRION (A) (HB STR)-(K), a CODY-(Q) where it says JAGER-(Q), a JAGER-(Q) where
// it says JAGER-(SS). AutoCount's own FromSODtlKey edge pairs each of these SO
// lines with a PO line carrying a BYTE-IDENTICAL item code, so the book agrees
// with itself and with our purchase order; the row that disagrees with its own
// source is the sales-order line (docs/bugs/0668, 0671).
//
// The wrong DEDICATIONS those rows caused were already reverted (run
// 34138205774, 10 of 10, verified on a fresh connection). Correcting the product
// is what lets them legitimately re-link: a bedframe line is HARD-BOUND
// (`isHardBoundLine`, src/scm/lib/so-stock-allocation.ts) and reads READY only
// through its OWN dedicated purchase order, so it must be dedicated to the
// purchase-order line for the bed the customer actually ordered.
//
// WHAT MOVES AND WHAT DOES NOT is stated once, in lib/so-item-code-correction.mjs,
// with the importer line numbers that prove it. In one sentence: item_code,
// item_group and description follow the product; qty, unit_price_sen, total_sen,
// variants and custom_specials do NOT, because the importer copied every one of
// them from the SAME AutoCount DtlKey this correction is agreeing with. This
// script asserts that after the write, on a connection it has not used.
//
// THE POPULATION IS MEASURED, NOT LISTED. Every AutoCount PODTL SO-edge is
// resolved: the book's SODTL row for FromSODtlKey, its item code through
// autocount-erp-mapping-1561.csv, and our own sales-order line by
// `linked_ac_dtlkey`. A line whose code already agrees is counted and skipped;
// an eleventh disagreement would be found without editing this file. A
// hard-coded id list would not.
//
// linked_ac_dtlkey IS NOT UNIQUE. One AutoCount sofa line is one ERP row PER
// COMPARTMENT, and a keyed repair that ignored that proposed RM 2,216,501 of
// invented revenue (docs/bugs/0673). A key claimed by more than one ERP row is
// REFUSED and listed, never corrected.
//
// NO AUTOCOUNT SQL CONNECTION IS OPENED and none may be: a heavy read on that
// server starves the ERP -> AutoCount write-back (memory: ac-heavy-reads-starve
// -the-writeback). The book comes from snapshots committed in this repo.
//
//   DATABASE_URL   required
//   MODE           plan (default, writes NOTHING) | apply
//   CONFIRM        on apply, must equal "CORRECT <n> SALES ORDER LINES" with the
//                  count THIS run measured, so a phrase copied from an earlier
//                  run cannot fire
//   COMPANY_ID     default 1
//   OUT            restorable dump path
//
// RE-RUN: convergent and safe. The population is every line whose code still
// disagrees with the book, so a second apply finds nothing left to correct,
// says so, and exits 0 without writing. Re-running plan is free and re-prints
// the table. The UPDATE re-asserts the OLD code, so a row a person corrected in
// between is not touched and shows up in the count.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { normItemCode } from "./lib/ac-po-line.mjs";
import { readMappingCsv } from "./lib/ac-mapping-csv.mjs";
import { planSoItemCodeCorrections } from "./lib/so-item-code-correction.mjs";
import { loadModelOverrideIndex } from "./lib/ac-model-override-apply.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");

const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = process.env.CONFIRM ?? "";
const CO = Number(process.env.COMPANY_ID || 1);
/* WHICH SALES-ORDER LINES ARE ASKED THE QUESTION.
 *
 *   edges  (default, the 2026-09-08 morning run) only the lines AutoCount's own
 *          PODTL FromSODtlKey edge names. That population found the ten
 *          bedframes because each had a purchase order to disagree with.
 *   all    every migrated line that carries a `linked_ac_dtlkey`. A line with no
 *          purchase order behind it is invisible to `edges` and is exactly where
 *          the rest of the reconcile's item-code column lives: on 2026-09-08 the
 *          checker's 101 sales-order differences held 52 genuinely different
 *          products and only a handful of them had an edge (docs/bugs/0689).
 *
 * The RULES do not change with the population - lib/so-item-code-correction.mjs
 * states them once, and a decomposed sofa or a code our own pick list does not
 * carry is REFUSED either way. */
const POPULATION = (process.env.POPULATION || "edges").toLowerCase();
const OUT = process.env.OUT || path.join(process.cwd(), "so-item-code-dump.json");

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
if (!["edges", "all"].includes(POPULATION)) { console.error(`POPULATION must be edges or all, got ${POPULATION}`); process.exit(2); }

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m = "") => console.log(m);
const rpad = (s, n) => String(s ?? "").padEnd(n);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;
/* Malaysia is UTC+8 and has no DST. Every time this prints is LOCAL. */
const localTime = (v) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " (UTC+8)";
};

/* The BOOK, from files committed in this repo. */
function readBook() {
  const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))));
  const T = gz("ac-reconcile-truth.json.gz");
  const LF = T.line_fields;
  const obj = (row) => Object.fromEntries(LF.map((k, i) => [k, row[i]]));
  const soByDtl = new Map(T.types.SO.lines.map((r) => { const o = obj(r); return [String(o.dtlKey), o]; }));
  const poByDtl = new Map(T.types.PO.lines.map((r) => { const o = obj(r); return [String(o.dtlKey), o]; }));
  const desc2 = new Map((T.types.SO.desc2 ?? []).map((r) => [String(r[0]), r[1]]));

  /* The mapping sheet, read by lib/ac-mapping-csv.mjs - the ONE reader, since
     2026-09-08. This script always parsed it properly; check-ac-erp-reconcile.mjs
     did not, and two parsers for one file is how the two disagreed about 40
     sales-order lines (docs/bugs/0689). */
  const acMapByCode = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));

  const edgeFile = gz("ac-po-fromsodtlkey.json.gz");
  return { exportedAt: T.exported_at, edgesExportedAt: edgeFile.exportedAt, edges: edgeFile.rows, soByDtl, poByDtl, desc2, acMapByCode };
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${MODE} population=${POPULATION} company=${CO} out=${OUT}`);

  const book = readBook();
  log("SNAPSHOT VINTAGES - read these before any finding below.");
  log(`   ac-reconcile-truth.json.gz   cut ${localTime(book.exportedAt)}  (the book's SO and PO lines)`);
  log(`   ac-po-fromsodtlkey.json.gz   cut ${localTime(book.edgesExportedAt)}  (PODTL's own SO edge)`);
  log(`   ${book.edges.length} PODTL SO-edge(s); production is read live, now.`);
  log("");

  /* WHAT IS READ BACK OUT OF PRODUCTION. On `edges`, only the keys the book's
     own PODTL edges name - the whole migrated line table is not that question.
     On `all`, every migrated line that carries a key, because a line with no
     purchase order behind it can be just as wrong and no edge will ever name it. */
  const COLS = sql`s.id, s.doc_no, s.line_no, s.item_code, s.item_group, s.description, s.description2,
           s.qty::int AS qty, s.unit_price_sen::int AS unit_price_sen, s.total_sen::int AS total_sen,
           s.unit_cost_sen::int AS unit_cost_sen, s.stock_status, s.variants, s.custom_specials,
           s.linked_ac_dtlkey, s.cancelled, h.debtor_name, h.linked_ac_docno AS so_ac_docno`;
  let erpRows;
  if (POPULATION === "all") {
    erpRows = await sql`
      SELECT ${COLS}
        FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
       WHERE s.company_id = ${CO}
         AND s.linked_ac_dtlkey IS NOT NULL
       ORDER BY s.doc_no, s.line_no`;
  } else {
    const keys = [...new Set(book.edges.map((e) => (e.FromSODtlKey == null ? null : String(e.FromSODtlKey)))
      .filter((k) => k && k !== "0"))];
    erpRows = await sql`
      SELECT ${COLS}
        FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
       WHERE s.company_id = ${CO}
         AND s.linked_ac_dtlkey IS NOT NULL
         AND s.linked_ac_dtlkey::text = ANY(${keys})
       ORDER BY s.doc_no, s.line_no`;
  }
  const erpRowsByDtl = new Map();
  for (const r of erpRows) {
    const k = String(r.linked_ac_dtlkey);
    if (!erpRowsByDtl.has(k)) erpRowsByDtl.set(k, []);
    erpRowsByDtl.get(k).push(r);
  }
  /* On `all` the population IS the keys our own lines carry; the planner takes
     the same shape either way so its rules cannot fork with the population. */
  const population = POPULATION === "all"
    ? [...erpRowsByDtl.keys()].map((k) => ({ FromSODtlKey: k }))
    : book.edges;

  const products = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  const productByCode = new Map(products.map((p) => [normItemCode(p.code), p]));
  log(`company ${CO}: ${erpRows.length} sales-order line(s) carry one of those keys; pick list holds ${products.length} product(s)`);

  /* The owner's DECLARED model overrides, read from the same owner-approved
     file the compartment lane writes. Without it this planner undoes his own
     ruling on HC-SO-011657 — measured on prod run 34258437955. */
  const OV = loadModelOverrideIndex(DATA);
  log(`owner model overrides: ${OV.index.size} document(s) carry a complete declaration (${OV.why})`);
  const { plan, refused, counts } = planSoItemCodeCorrections({
    edges: population, bookSoByDtl: book.soByDtl, acMapByCode: book.acMapByCode, erpRowsByDtl, productByCode,
    overrideIndex: OV.index,
  });

  log("");
  log("THE POPULATION, measured");
  log(`  distinct AutoCount line keys examined               ${counts.edges}   (population=${POPULATION})`);
  log(`  our line already names the book's product          ${counts.agree}`);
  log(`  our line names the SAME product, written another way ${counts.translation}   (the book's own code, or a compartment of it - NOT a defect, lib/item-code-class.mjs)`);
  log(`  our line names a DIFFERENT product  <- correct     ${plan.length}`);
  log(`  REFUSED, the key is claimed by >1 ERP row          ${counts.decomposed}   (decomposed sofa; linked_ac_dtlkey is not unique)`);
  log(`  REFUSED, our pick list has no such product         ${counts.noProduct}`);
  log(`  LEFT ALONE, the owner DECIDED this product          ${counts.ownerDecided}   (a declared model override; correcting it would undo his ruling)`);
  log(`  the sales-order line is not in the ERP             ${counts.notInErp}`);
  log(`  the AutoCount line is not in this snapshot         ${counts.notInBook}`);
  log(`  the AutoCount code is not in the mapping sheet     ${counts.unmapped}   (says nothing either way)`);
  for (const r of refused) {
    log(`   REFUSED ${r.docNo ?? "(no ERP doc)"}${r.debtorName ? ` (${r.debtorName})` : ""} key ${r.dtlKey}: ${r.detail}`);
  }

  if (plan.length === 0) {
    log("");
    log("nothing to correct - every sales-order line the book's edges name already carries the book's product.");
    await sql.end();
    return;
  }

  /* ---- the table the owner asked for: per order, customer, was, now ------ */
  plain("");
  plain("WHAT EACH LINE SAYS NOW AND WHAT IT WILL SAY - the book is copied, never computed.");
  plain("```enumeration");
  plain(`${rpad("sales order", 15)}${rpad("customer", 26)}${rpad("it says", 24)}${rpad("the book says", 24)}money on the line`);
  for (const p of plan) {
    plain(`${rpad(p.docNo, 15)}${rpad(p.debtorName ?? "(none)", 26)}${rpad(p.fromCode, 24)}${rpad(p.toCode, 24)}${p.qty} x ${rm(p.unitPriceSen)} = ${rm(p.totalSen)}`);
    plain(`${rpad("", 15)}  AutoCount SODtlKey ${p.dtlKey} item "${p.acCode}"; the book states qty ${p.bookQty} at ${p.bookUnitPrice}, subtotal ${p.bookSubTotal}`);
    plain(`${rpad("", 15)}  group ${p.fromGroup} -> ${p.toGroup}${p.fromGroup === p.toGroup ? " (unchanged)" : "  <- CHANGES: isHardBoundLine reads the group"}`);
    plain(`${rpad("", 15)}  name "${p.fromDescription ?? ""}" -> "${p.toDescription}"`);
    plain(`${rpad("", 15)}  UNMOVED: qty ${p.qty}, unit price ${rm(p.unitPriceSen)}, line total ${rm(p.totalSen)}, unit cost ${rm(p.unitCostSen)}, stock_status ${p.stockStatus}`);
    plain(`${rpad("", 15)}  UNMOVED: variants ${JSON.stringify(p.variants)}`);
    plain(`${rpad("", 15)}  UNMOVED: custom_specials ${JSON.stringify(p.customSpecials)}`);
    plain(`${rpad("", 15)}  Desc2 (the customer's choices, from the same book line): ${JSON.stringify(book.desc2.get(p.dtlKey) ?? null)}`);
  }
  plain("```");
  plain("");

  /* THE MONEY QUESTION, ANSWERED RATHER THAN ASSUMED. The book's own price for
     each of these DtlKeys is printed above; this is the roll-up of whether any
     of them would move if the price followed the product. Nothing here writes -
     it exists so "the price does not move" is a MEASUREMENT in the log and not
     a sentence in a comment. */
  const bookPriceSen = (p) => Math.round(Number(p.bookUnitPrice ?? 0) * 100);
  const differ = plan.filter((p) => bookPriceSen(p) !== p.unitPriceSen);
  const bookBlank = differ.filter((p) => bookPriceSen(p) === 0);
  log("THE MONEY, and why none of it moves");
  log(`  lines whose stored unit price equals the book's    ${plan.length - differ.length} of ${plan.length}`);
  log(`  lines where they differ                            ${differ.length}`);
  log(`    of those, the BOOK states 0.00 and we hold a price   ${bookBlank.length}   <- a blank never overwrites a value (docs/bugs/0675); NOT touched here`);
  log(`    of those, the book states a DIFFERENT real price     ${differ.length - bookBlank.length}   <- repair-so-price-from-autocount owns that question, not this script`);
  log(`  total money on the ${plan.length} line(s), unchanged by this correction  ${rm(plan.reduce((a, p) => a + p.totalSen, 0))}`);
  log("");

  /* ---- the restorable dump, the precondition for the write --------------- */
  const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  const dump = {
    dumpedAt: new Date().toISOString(),
    reason: "restorable dump taken immediately before correcting mfg_sales_order_items.item_code to the AutoCount product",
    database: "production (secrets.DATABASE_URL)",
    companyId: CO,
    ruling: "owner 2026-09-08: follow AutoCount, correct the sales order",
    bookSnapshot: book.exportedAt,
    edgesSnapshot: book.edgesExportedAt,
    rows: plan,
    refused,
    counts,
    restore: plan.map((p) =>
      `UPDATE scm.mfg_sales_order_items SET item_code = ${q(p.fromCode)}, item_group = ${q(p.fromGroup)}, description = ${q(p.fromDescription)} WHERE id = ${q(p.id)};`),
  };
  const json = JSON.stringify(dump, null, 2);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json, "utf8");

  /* READ IT BACK. Writing is intent; parsing what came off the disk is
     evidence, and evidence is the precondition for the write below. */
  const readBack = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const dumpOk = Array.isArray(readBack.rows)
    && readBack.rows.length === plan.length
    && readBack.rows.every((r) => r.id && r.fromCode && r.toCode)
    && readBack.restore.length === plan.length;
  log(`dump written to ${OUT} (${json.length} bytes) and re-read: ${dumpOk ? "OK" : "FAILED"}`);
  plain("----- BEGIN RESTORABLE DUMP -----");
  plain(json);
  plain("----- END RESTORABLE DUMP -----");

  const PHRASE = `CORRECT ${plan.length} SALES ORDER LINES`;
  if (!APPLY) {
    log(`PLAN ONLY - nothing written. To correct: MODE=apply CONFIRM="${PHRASE}"`);
    await sql.end();
    return;
  }
  if (!dumpOk) { log("REFUSED: the dump did not read back. Nothing corrected."); await sql.end(); process.exit(1); }
  if (CONFIRM !== PHRASE) {
    log(`REFUSED: MODE=apply needs CONFIRM="${PHRASE}" - the count is the one THIS run measured, so a phrase copied from an earlier run cannot fire.`);
    await sql.end();
    process.exit(2);
  }

  /* The OLD code and the AutoCount key are RE-ASSERTED inside the statement.
     Between the plan and here a person could have corrected the row; if it no
     longer names what the plan read, it is not this defect and must not be
     overwritten. A row that fails the re-assertion is simply not updated and
     shows up in the count. */
  let corrected = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const res = await tx`
        UPDATE scm.mfg_sales_order_items
           SET item_code = ${p.toCode}, item_group = ${p.toGroup}, description = ${p.toDescription}
         WHERE id = ${p.id}
           AND linked_ac_dtlkey::text = ${p.dtlKey}
           AND UPPER(REGEXP_REPLACE(BTRIM(item_code), '\\s+', ' ', 'g'))
             = ${normItemCode(p.fromCode)}
        RETURNING id`;
      corrected += res.length;
    }
  });
  log(`sales-order lines corrected: ${corrected} of ${plan.length} intended`);

  /* ---- verification on a connection this run has not used ----------------
     The SHAPE, not a count: what does each row NOW say, and did anything that
     must not move actually move? */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const ids = plan.map((p) => String(p.id));
  const after = await v`
    SELECT id, doc_no, item_code, item_group, description, qty::int AS qty,
           unit_price_sen::int AS unit_price_sen, total_sen::int AS total_sen,
           variants, custom_specials, linked_ac_dtlkey
      FROM scm.mfg_sales_order_items WHERE id = ANY(${ids})`;
  const byId = new Map(after.map((a) => [String(a.id), a]));
  let wrongCode = 0, wrongGroup = 0, moneyMoved = 0, variantsMoved = 0, gone = 0;
  for (const p of plan) {
    const a = byId.get(String(p.id));
    if (!a) { gone++; log(`   VERIFY: sales-order line ${p.id} is GONE`); continue; }
    if (normItemCode(a.item_code) !== normItemCode(p.toCode)) {
      wrongCode++; log(`   VERIFY: ${a.doc_no} still says "${a.item_code}", wanted "${p.toCode}"`);
    }
    if (String(a.item_group) !== String(p.toGroup)) {
      wrongGroup++; log(`   VERIFY: ${a.doc_no} group is "${a.item_group}", wanted "${p.toGroup}"`);
    }
    if (Number(a.qty) !== p.qty || Number(a.unit_price_sen) !== p.unitPriceSen || Number(a.total_sen) !== p.totalSen) {
      moneyMoved++;
      log(`   VERIFY: ${a.doc_no} MONEY MOVED - qty ${p.qty}->${a.qty}, unit ${rm(p.unitPriceSen)}->${rm(a.unit_price_sen)}, total ${rm(p.totalSen)}->${rm(a.total_sen)}`);
    }
    if (JSON.stringify(a.variants ?? null) !== JSON.stringify(p.variants ?? null)
      || JSON.stringify(a.custom_specials ?? null) !== JSON.stringify(p.customSpecials ?? null)) {
      variantsMoved++;
      log(`   VERIFY: ${a.doc_no} VARIANTS MOVED - ${JSON.stringify(p.variants)} -> ${JSON.stringify(a.variants)}`);
    }
    log(`   VERIFY ${a.doc_no} key ${a.linked_ac_dtlkey}: item_code "${a.item_code}", group "${a.item_group}", name "${a.description}", ${a.qty} x ${rm(a.unit_price_sen)} = ${rm(a.total_sen)}`);
  }
  log(`VERIFY on a fresh connection: ${after.length} of ${ids.length} line(s) re-read; code wrong ${wrongCode}; group wrong ${wrongGroup}; money moved ${moneyMoved}; variants moved ${variantsMoved}; missing ${gone}`);
  await v.end();
  await sql.end();
  if (wrongCode > 0 || wrongGroup > 0 || moneyMoved > 0 || variantsMoved > 0 || gone > 0) process.exit(1);
  log(`DONE. ${corrected} sales-order line(s) now name the book's product; the restorable dump is at ${OUT} and printed above.`);
  log("NEXT: re-run sync-ac-delta lane `links` so these lines can re-link to the RIGHT purchase-order line.");
}
main().catch((e) => { console.error(e); process.exit(1); });
