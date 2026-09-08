#!/usr/bin/env node
/* repair-migrated-grn-item-codes — put the ERP's own product code on the
 * migrated goods-receipt lines that were written with AutoCount's.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * `reshape-migrated-grns.mjs`, in `lineRows`, resolved a receipt line's code as
 *
 *     const code = poi ? poi.item_code : i.book.itemKey;
 *
 * The first arm is a copy of a translated code and is right. The second arm —
 * taken whenever the receipt line is deliberately left UNATTRIBUTED, because
 * `GRDTL.FromDocDtlKey` is 0 on every AutoCount row and the purchase order
 * carries that item code on more than one line — wrote AutoCount's own
 * `ItemCode`, untranslated. `material_name: poi?.material_name ?? code`
 * inherited it, so the name is the book's code too.
 *
 * The result on production: a line reading `HOK-1007 (HF)(W) (SP)` where the
 * ERP catalogue spells that product `CODY 2.0 (F)-(SP)`, `HOK-2006(A) (Q)` for
 * `REGAL (A)-(Q)`, `NK-1046 (Q)` for `MINI-(Q)`. `check-ac-erp-reconcile.mjs`
 * counted 103 company-1 GR item-code differences on 2026-09-08 (run
 * 34178538830) and its samples printed two identical-looking strings, because
 * that checker COMPARES the mapped value and PRINTED the raw one. Both halves are
 * fixed in this branch: the printing half in `check-ac-erp-reconcile.mjs`, the
 * data half here. This script repairs the rows already written;
 * `reshape-migrated-grns.mjs` stops new ones being made.
 *
 * COORDINATION: PR #3167 is reported to touch `check-ac-erp-reconcile.mjs` too.
 * If both land, the printing change is the same one-line intent and the conflict
 * is a text merge, not a disagreement.
 *
 * ── WHAT IT TOUCHES, AND WHAT IT REFUSES TO ─────────────────────────────────
 * `scm.grn_items.item_code` and `.material_name`, on company-1 goods receipts
 * that are migrated (`migrated_no_stock`) and carry an AutoCount link, and ONLY
 * on lines whose `purchase_order_item_id IS NULL`. An attributed line already
 * copied the purchase-order line's translated code; rewriting it would be this
 * script inventing a second opinion about a value that has a source.
 *
 * A row is rewritten only when the mapping file gives a translation AND the
 * translated code is one `scm.mfg_products` actually carries. Anything else is
 * LEFT ALONE and COUNTED — `item_code` has no foreign key to the catalogue, so
 * writing a code nobody minted would replace a wrong-but-traceable value with
 * an orphan that every joining screen renders blank (docs/bugs/0577).
 *
 * ── WHY AN item_code REWRITE CANNOT MOVE STOCK ──────────────────────────────
 * Read this before assuming it needs a stock plan. The FIFO machinery is driven
 * by `scm.inventory_movements`; the trigger is `AFTER INSERT ON
 * inventory_movements`, not on `grn_items`. Migrated receipts carry
 * `migrated_no_stock` (migration 0276) and have NO movements at all — their
 * on-hand came in once through the AutoCount balance snapshot — and
 * `check-stock-vs-autocount.mjs` asserts exactly that, so this run must leave it
 * reading zero. It does, for three independent reasons: no movement row is
 * inserted, updated or deleted; no quantity, price, discount, line total, date
 * or status column is in any UPDATE here; and the balance snapshot that supplied
 * the on-hand was keyed on the AutoCount item, never on this text column. The
 * run ASSERTS the zero before it writes and re-asserts it afterwards on a fresh
 * connection rather than resting on this paragraph.
 *
 * ── CONVERGENT ──────────────────────────────────────────────────────────────
 * A second run finds nothing. The mapping is idempotent on its own output —
 * measured on autocount-erp-mapping-1561.csv: 171 ERP codes are also AutoCount
 * codes and all 171 map to THEMSELVES, zero chains — so a repaired row looks up
 * to the value it already holds. The run re-checks that property against the
 * live file and REFUSES if a future edit introduces a chain, because a chain
 * would make this script flip a row on every run.
 *
 *   MODE / PLAN (default):
 *     DATABASE_URL=... node backend/scripts/repair-migrated-grn-item-codes.mjs
 *   APPLY:
 *     APPLY=1 CONFIRM="REPAIR GRN ITEM CODES" node backend/scripts/...
 *
 * EXIT CODES: 0 for every legitimate verdict — nothing to repair is an answer,
 * not a failure. 2 only when the run cannot see its subject (no DSN, no
 * catalogue, a non-idempotent map, stock behind the documents); 1 only when a
 * write was made and the read-back disagrees.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { aliasFoldsForCatalog, catalogPredicate, nonCatalogRefs, formatNonCatalogRefusal } from "./lib/catalog-code-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }

const APPLY = process.env.APPLY === "1";
const CONFIRM_PHRASE = "REPAIR GRN ITEM CODES";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(CO) || CO <= 0) { console.error("COMPANY_ID must be a positive integer"); process.exit(2); }

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const rule = (t) => say(`\n═══════════ ${t} ═══════════`);
const pad = (s, n) => String(s ?? "").padEnd(n);
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
/* catalogPredicate trims and upper-cases and does NOT collapse inner
   whitespace, so the catalogue lookup has to be keyed the same way. */
const up = (s) => String(s ?? "").trim().toUpperCase();

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const refuse = async (msg) => {
  console.error(`REFUSED: ${msg}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
};

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** The same read every other AutoCount writer does, with the alias fold applied
 *  where the mapping is READ — before the catalogue is asked anything
 *  (docs/bugs/0686). Only a code the catalogue LACKS folds, and only onto one it
 *  HAS, so the fold can never move a code that already resolves; `5535` is its
 *  own model and never folds (owner ruling). */
function loadAcToErp(inCatalog) {
  const rows = fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  rows.shift();
  const byAc = new Map();
  for (const ln of rows) {
    const f = parseCsvLine(ln);
    const erp = (f[1] || "").trim();
    if (f[0] && erp) byAc.set(norm(f[0]), erp);
  }
  const moves = aliasFoldsForCatalog([...byAc.values()], inCatalog, SOFA_MODEL_ALIAS);
  for (const [ac, erp] of byAc) if (moves.has(erp)) byAc.set(ac, moves.get(erp));
  return { byAc, moves };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} company_id=${CO}`);

  /* ── the catalogue and the map ──────────────────────────────────────────── */
  const products = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  if (!products.length) {
    await refuse(`scm.mfg_products has no company-${CO} rows. Every translation would look like "not in the catalogue" ` +
      "and the run would report a clean refusal computed over nothing.");
  }
  const prodByCode = new Map(products.map((p) => [up(p.code), p]));
  const inCatalog = catalogPredicate(products.map((p) => p.code));
  const { byAc: acToErp, moves } = loadAcToErp(inCatalog);
  log(`CATALOGUE — ${products.length} company-${CO} product code(s); book->ERP map carries ${acToErp.size} AutoCount code(s)`);
  if (moves.size) {
    say(`  alias fold: ${moves.size} mapped code(s) the catalogue does not carry resolve through SOFA_MODEL_ALIAS`);
    for (const [from, to] of moves) say(`     ${from} -> ${to}`);
  }

  /* ── the property that makes a second run find nothing ──────────────────── */
  const chains = [];
  for (const [ac, erp] of acToErp) {
    const again = acToErp.get(norm(erp));
    if (again != null && norm(again) !== norm(erp)) chains.push(`${ac} -> ${erp} -> ${again}`);
  }
  if (chains.length) {
    await refuse(
      `the mapping is NOT idempotent on its own output: ${chains.length} code(s) translate again after being ` +
      `translated (${chains.slice(0, 5).join("; ")}). This repair writes the translated code back into the same ` +
      "column it reads, so a chain would flip those rows on every run. Fix the mapping file first.",
    );
  }
  say(`  idempotent: ${[...acToErp.values()].filter((e) => acToErp.has(norm(e))).length} ERP code(s) are also AutoCount codes and every one maps to itself.`);

  /* ── the population ─────────────────────────────────────────────────────── */
  /* Migrated, AutoCount-linked, company-scoped, and UNATTRIBUTED. The last
     predicate is the whole safety argument: an attributed line's code was
     copied from its purchase-order line and has a source to be checked
     against, so it is not this script's to re-decide. */
  const rows = await sql`SELECT i.id::text AS id, i.item_code, i.material_name,
      i.qty_accepted::float8 AS qty, i.unit_price_sen, i.line_total_sen,
      g.id::text AS grn_id, g.grn_number, g.status::text AS status
    FROM scm.grn_items i
    JOIN scm.grns g ON g.id = i.grn_id
    JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE i.company_id = ${CO} AND g.company_id = ${CO}
      AND g.migrated_no_stock = true
      AND (g.linked_ac_docno IS NOT NULL OR p.linked_ac_docno IS NOT NULL)
      AND i.purchase_order_item_id IS NULL
    ORDER BY g.grn_number, i.id`;
  rule("THE POPULATION");
  log(`CANDIDATES — ${rows.length} unattributed line(s) on ${new Set(rows.map((r) => r.grn_id)).size} migrated, AutoCount-linked company-${CO} goods receipt(s)`);
  say("  An attributed line is deliberately NOT in this set: its item_code was copied from its");
  say("  purchase-order line, which the PO importer had already translated.");

  /* ── classify ───────────────────────────────────────────────────────────── */
  const change = [];
  const alreadyOk = [];
  const noMapping = [];
  const notInCatalog = [];
  for (const r of rows) {
    const cur = String(r.item_code ?? "").trim();
    const erp = acToErp.get(norm(cur)) ?? null;
    if (!erp) { (inCatalog(cur) ? alreadyOk : noMapping).push(r); continue; }
    if (!inCatalog(erp)) { notInCatalog.push({ ...r, erp }); continue; }
    const prod = prodByCode.get(up(erp));
    const name = String(prod?.name ?? "").trim() || erp;
    if (norm(cur) === norm(erp) && String(r.material_name ?? "").trim() === name) { alreadyOk.push(r); continue; }
    change.push({ ...r, erp, name });
  }

  rule("THE PLAN");
  log(`REPAIR — ${change.length} line(s) would be rewritten; ${alreadyOk.length} already carry the ERP code; ` +
    `${noMapping.length} have no mapping row; ${notInCatalog.length} map to a code the catalogue does not carry`);
  for (const c of change) {
    say(`  ${pad(c.grn_number, 26)} ${pad(c.item_code, 30)} -> ${pad(c.erp, 26)} | name ${JSON.stringify(c.material_name)} -> ${JSON.stringify(c.name)}`);
  }
  if (noMapping.length) {
    say("");
    say(`  LEFT ALONE — no row in autocount-erp-mapping-1561.csv names these ${noMapping.length} code(s).`);
    say("  A wrong-but-traceable value beats an invented one: nothing here guesses a product.");
    for (const r of noMapping) say(`     ${pad(r.grn_number, 26)} ${r.item_code}`);
  }
  if (notInCatalog.length) {
    say("");
    for (const line of formatNonCatalogRefusal(
      nonCatalogRefs(notInCatalog.map((r) => ({ code: r.erp, doc: r.grn_number, acCode: r.item_code })), inCatalog),
      { script: "repair-migrated-grn-item-codes.mjs" },
    )) say(line);
    say("  These rows are LEFT AS THEY ARE — the run continues. item_code has no foreign key to");
    say("  scm.mfg_products, so replacing a wrong code with an orphan is a worse row, not a repaired one.");
  }

  /* ── the stock assertion, before anything is written ────────────────────── */
  rule("STOCK — asserted, not assumed");
  const grnIds = [...new Set(change.map((c) => c.grn_id))];
  const [mv] = grnIds.length
    ? await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(qty)), 0)::float8 AS q FROM scm.inventory_movements
        WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id::text = ANY(${grnIds})`
    : [{ n: 0, q: 0 }];
  log(`STOCK — inventory movements behind the ${grnIds.length} document(s) this repair would touch: ${mv.n} rows / ${mv.q} units`);
  if (mv.n !== 0) {
    await refuse(
      `${mv.n} inventory movement(s) sit behind documents flagged migrated_no_stock. That contradicts migration 0276 ` +
      "and check-stock-vs-autocount.mjs's own assertion, and it has to be understood before any of these rows is " +
      "edited — not because renaming a code moves stock, but because the documents are not what they claim to be.",
    );
  }
  say("  Zero, as migration 0276 states. The FIFO trigger is AFTER INSERT ON inventory_movements, not on");
  say("  grn_items, and no quantity, price, date or status column appears in this script's UPDATE — so the");
  say("  detector in check-stock-vs-autocount.mjs keeps reading zero after this run.");

  if (!change.length) {
    log("NOTHING TO REPAIR — every unattributed migrated receipt line already carries a catalogue code, or has no translation to give it one.");
    await sql.end();
    return;
  }

  if (!APPLY) {
    log(`PLAN ONLY — nothing was written. Re-run with APPLY=1 CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  /* ── apply ──────────────────────────────────────────────────────────────── */
  rule("APPLY");
  /* The money and quantity totals over the exact rows about to change, taken
     BEFORE the write so the read-back can prove no other column moved. */
  const ids = change.map((c) => c.id);
  const [before] = await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(qty_accepted), 0)::float8 AS qty,
      COALESCE(SUM(unit_price_sen), 0)::bigint AS price, COALESCE(SUM(line_total_sen), 0)::bigint AS total
    FROM scm.grn_items WHERE id::text = ANY(${ids})`;
  let written = 0;
  for (let i = 0; i < change.length; i += 200) {
    const batch = change.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const c of batch) {
        const res = await tx`UPDATE scm.grn_items SET item_code = ${c.erp}, material_name = ${c.name}
          WHERE id = ${c.id}::uuid AND company_id = ${CO} AND purchase_order_item_id IS NULL`;
        written += res.count ?? 0;
      }
    });
  }
  log(`APPLIED — ${written} of ${change.length} intended line(s) rewritten.`);

  /* ── verify on a fresh connection ───────────────────────────────────────── */
  rule("VERIFY (fresh connection)");
  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let bad = 0;
  const back = await v`SELECT id::text AS id, item_code, material_name, purchase_order_item_id
    FROM scm.grn_items WHERE id::text = ANY(${ids})`;
  const byId = new Map(back.map((r) => [r.id, r]));
  for (const c of change) {
    const r = byId.get(c.id);
    if (!r) { bad += 1; say(`  VERIFY FAILED — ${c.grn_number} line ${c.id} does not read back`); continue; }
    if (norm(r.item_code) !== norm(c.erp)) { bad += 1; say(`  VERIFY FAILED — ${c.grn_number}: item_code reads "${r.item_code}", expected "${c.erp}"`); }
    if (String(r.material_name ?? "").trim() !== c.name) { bad += 1; say(`  VERIFY FAILED — ${c.grn_number}: material_name reads ${JSON.stringify(r.material_name)}, expected ${JSON.stringify(c.name)}`); }
    if (r.purchase_order_item_id != null) { bad += 1; say(`  VERIFY FAILED — ${c.grn_number}: the line gained a purchase-order link, which this repair must never do`); }
  }
  const [after] = await v`SELECT COUNT(*)::int AS n, COALESCE(SUM(qty_accepted), 0)::float8 AS qty,
      COALESCE(SUM(unit_price_sen), 0)::bigint AS price, COALESCE(SUM(line_total_sen), 0)::bigint AS total
    FROM scm.grn_items WHERE id::text = ANY(${ids})`;
  for (const k of ["n", "qty", "price", "total"]) {
    if (String(before[k]) !== String(after[k])) { bad += 1; say(`  VERIFY FAILED — ${k} moved: ${before[k]} -> ${after[k]}. This repair must touch item_code and material_name only.`); }
  }
  say(`  quantity, unit price and line total over the ${change.length} rewritten line(s): unchanged (${after.qty} units, ${after.total} sen).`);
  const [mv2] = await v`SELECT COUNT(*)::int AS n FROM scm.inventory_movements
    WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id::text = ANY(${grnIds})`;
  if (mv2.n !== 0) { bad += 1; say(`  VERIFY FAILED — ${mv2.n} inventory movement(s) appeared behind the repaired receipts. They must have none.`); }
  say(`  inventory movements behind the ${grnIds.length} repaired document(s): ${mv2.n}`);
  await v.end();
  await sql.end();
  if (bad) { console.error(`${bad} verification failure(s).`); process.exit(1); }
  log(`VERIFIED on a fresh connection — ${change.length} line(s) carry the ERP catalogue's own code and name; quantity, price and stock untouched. A second run finds nothing.`);
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(1); });
