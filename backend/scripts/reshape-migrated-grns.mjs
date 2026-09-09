#!/usr/bin/env node
/* reshape-migrated-grns — make the ERP's carried-over goods receipts the shape
 * the ACCOUNT BOOK has, instead of the shape the migration found convenient.
 *
 * THE OWNER'S RULING, 2026-09-07, on being offered three shapes:
 *   「不是说过了吗？是 A 的，不过只是把那些需要的搬进来，不需要的不需要搬」
 * Option A: if AutoCount received a purchase order in three deliveries, the ERP
 * shows three receipts, with the book's own dates and the book's own
 * quantities — for the IN-SCOPE set only.
 *
 * WHAT THE ERP HAS TODAY, and why it is not that. `create-migrated-documents.mjs`
 * writes ONE goods receipt per PURCHASE ORDER, built from
 * `purchase_order_items.received_qty`, and stamps `received_at = CURRENT_DATE`.
 * So a purchase order received in 2024, again in 2025 and again in 2026 reads as
 * a single receipt that arrived on the day the migration ran. Measured on
 * production 2026-09-07 (check-gr-shape, run 34135520445): 320 documents, every
 * one dated the migration day, against a book that received 318 in-scope
 * purchase orders in 400 (receipt x purchase order) pairs across 214 receipts —
 * 70 of those purchase orders in more than one go, 61 of them on genuinely
 * different dates.
 *
 * ── THE ONE PLACE THIS DIFFERS FROM THE WORDS, AND WHY ──────────────────────
 * The owner said "one document per receipt". `scm.grns.purchase_order_id` is a
 * SINGLE purchase order, and 51 of the 214 receipts cover more than one in-scope
 * purchase order (GR-000201 covers 17). So one ERP document per AutoCount
 * receipt is structurally impossible without a schema change. This builds at the
 * PAIR grain — one ERP receipt per (AutoCount receipt x purchase order), 400
 * documents — which delivers exactly what he asked for WITHIN each purchase
 * order: the book's split, the book's dates, the book's quantities. The
 * AutoCount receipt number is on every document (`linked_ac_gr_docno`), so the
 * several documents standing for one receipt are one filter apart.
 *
 * ── THE PO-LINE ATTRIBUTION, AND THE RULING THAT GOVERNS IT ─────────────────
 * AutoCount records the receipt, the item and the quantity. It does NOT record
 * which purchase-order LINE was received: `GRDTL.FromDocDtlKey` is 0 of 21,746
 * rows, agreed by two independently-cut extracts. Where a purchase order carries
 * an item code ONCE, the receipt line resolves to exactly one line and copying
 * that link is a copy. Where it carries the same code TWICE, no rule in the book
 * decides which line was received.
 *
 * Owner, 2026-09-07, on those lines: 「跟 autocount 一样」. So this writer copies
 * the receipt, the item and the quantity, and leaves `purchase_order_item_id`
 * NULL on exactly those lines, flagged in the line's own `notes` and named on
 * the document's `notes` so a person reading the receipt sees it. It does NOT
 * take the first matching line: an invented attribution is the shape that binds
 * one customer's furniture to another customer's purchase order. The total
 * quantity per (purchase order, item) is identical either way, so stock and MRP
 * are unaffected by leaving it unset — which is why the ruling is safe.
 *
 * ── THE MONEY IS CARRIED, NEVER RECOMPUTED ──────────────────────────────────
 * `stamp-migrated-source-prices.mjs` owns what a migrated receipt line is worth,
 * and it applied 32 lines to production on 2026-09-07 at 16:02Z (run
 * 34141318054). The money it wrote is on the RECEIPT line in AutoCount, not on
 * the purchase order behind it - on all 180 zero-priced migrated receipt lines
 * the book's own purchase-order line reads `UnitPrice 0, SubTotal 0`, because
 * Houzs does not price factory purchase orders (docs/bugs/0674).
 *
 * So this writer decides no price. It CARRIES what the line already holds, per
 * unit: `unit_price_sen` as-is, and `discount_sen` shared out by quantity, so a
 * line split across two receipts keeps the same money per unit. The lookup is
 * `(purchase-order line, item code)` first and `(purchase order, item code)`
 * second - the second is what an unattributed line uses, and it is not an
 * invention, because every candidate line shares the code and therefore the
 * price. Where the ERP holds no money at all, an attributed line falls back to
 * the purchase-order line's price (the old behaviour, usually zero) and an
 * unattributed line to the book's own receipt line. The run PRINTS the money
 * before and after so any drift is visible instead of discovered.
 *
 * AFTER THIS RUNS, RE-DISPATCH "Stamp migrated source prices". Its selection is
 * `unit_price_sen = 0`, so it is the authority for everything still unpriced -
 * and the new grain makes MORE of it stampable, because its partial-mirror
 * refusal exists precisely for the one-document-per-purchase-order shape this
 * replaces.
 *
 * ── THE ITEM CODE IS TRANSLATED, ON BOTH ARMS ───────────────────────────────
 * A receipt line that resolves to a purchase-order line COPIES that line's
 * `item_code`, which the PO importer already translated. A line that does NOT
 * resolve — the deliberate non-attribution above — used to fall back to
 * `i.book.itemKey`, AutoCount's own code, untranslated. The ERP then carried
 * `HOK-1007 (HF)(W) (SP)` where its catalogue spells that product
 * `CODY 2.0 (F)-(SP)`, and `check-ac-erp-reconcile.mjs` reported 103 company-1
 * item-code differences whose samples printed two identical-looking strings,
 * because the checker COMPARES the mapped value and PRINTED the raw one. (That
 * print was fixed on `main` by PR #3167 on 2026-09-08 — its message now carries
 * `the sheet says "<erp code>"`. `check-ac-erp-reconcile.mjs` is untouched here.)
 *
 * So the fallback now resolves through `data/autocount-erp-mapping-1561.csv`,
 * the same file every other AutoCount writer reads, with the same two rules
 * those writers apply (docs/bugs/0577, docs/bugs/0686):
 *   - the SOFA ALIAS FOLD at read time — only a mapped code the catalogue LACKS
 *     is folded, and only onto one it HAS, so it can never move a code that
 *     already resolves. `5535` is its own model and never folds.
 *   - the CATALOGUE GUARD at write time — `item_code` has no foreign key to
 *     `scm.mfg_products`, so a code nobody minted lands as an orphan line that
 *     every joining screen renders blank. The run REFUSES and names the rows
 *     rather than writing one.
 * `material_name` follows the same resolution: the ERP product's own name where
 * the code resolves, never the book's code standing in for a name.
 *
 * ── NO STOCK, IN EITHER DIRECTION ───────────────────────────────────────────
 * Every document written here keeps `migrated_no_stock` (migration 0276) and no
 * inventory movement is written. On-hand came in once through the AutoCount
 * balance snapshot, which already counts every past receipt as IN. Measured on
 * production the same day: `inventory_movements` behind the 320 existing
 * migrated receipts is 0 rows / 0 units, and the FIFO trigger is
 * `AFTER INSERT ON inventory_movements`, not on `grn_items` — so writing or
 * retiring receipt ROWS by SQL moves nothing. This script re-asserts that with a
 * COUNT before it writes and REFUSES if it is not zero.
 *
 * ── NEVER DELETE, ONLY RETIRE ───────────────────────────────────────────────
 * The owner's standing rule. An existing migrated receipt whose (receipt x
 * purchase order) pair is in the plan is UPDATED IN PLACE — it keeps its id, its
 * number and its place in every document-relationship map, and only its date,
 * its receipt link and its lines change. One that is NOT in the plan, on a
 * purchase order the plan covers, is CANCELLED by a direct status flip: its row
 * and its lines stay, readable, with a note saying what replaced it.
 *
 * NOT through `PATCH /grns/:id/cancel`. That route never reads
 * `migrated_no_stock` (zero occurrences in routes/grns.ts) and would write a
 * reversing inventory OUT for every line — 879 units of phantom stock out across
 * the 320. Its one guard, `grnReverseWouldGoNegative`, PASSES here, because the
 * units really are on the shelf; they just came from the balance snapshot rather
 * than from this document. The route is the unsafe path, not the outcome.
 *
 * An existing migrated receipt whose purchase order the BOOK CUT CANNOT SPEAK
 * ABOUT is left untouched and reported. The export scope is narrower than the
 * ERP's frozen migrated set, and treating "the snapshot has no rows about this"
 * as "the book has no receipt" manufactures a gap.
 *
 * ── THE BOOK, AND WHY TWO EXTRACTS ──────────────────────────────────────────
 * Line truth comes from `data/ac-convert-edges.json.gz` — "one row per AutoCount
 * DocNo (headers) and per DtlKey (lines); NO filtering" — which carries the
 * receipt date, the cancelled flag, the item code, the quantity and the source
 * purchase order. Its rows are ARRAYS, positional per `line_fields` /
 * `header_fields`; reading them as objects returns `undefined`, and an agent
 * already mistook that empty result for evidence (docs/bugs/0674).
 *
 * The in-scope population and the cross-check come from
 * `data/ac-reconcile-truth.json.gz` through `lib/ac-scope.mjs`, the same module
 * `check-ac-erp-reconcile.mjs` reads, so the writer and the checker cannot
 * disagree about who is in scope. The two extracts are cut independently; this
 * script REFUSES if their (receipt x purchase order) pair sets differ, rather
 * than building on either alone.
 *
 * ── PLAN BY DEFAULT ─────────────────────────────────────────────────────────
 *   MODE=plan  node backend/scripts/reshape-migrated-grns.mjs        (default)
 *   MODE=apply CONFIRM="I HAVE REVIEWED THE GR RESHAPE PLAN" node ...
 *   DUMP_DIR=<dir>   where the restorable JSON of the CURRENT documents is
 *                    written. Written in BOTH modes, before anything moves.
 *
 * RE-RUN: convergent, not inert. The plan is "make the ERP equal the book", so a
 * second run against an unchanged book and an already-reshaped ERP finds every
 * document present, dated and quantified as planned, plans zero creates and zero
 * cancels, rewrites the same lines with the same values, and reads the same
 * numbers back. It is the safe way to confirm the first run landed. A run after
 * a FRESH AutoCount cut carries the new receipts in and re-dates any that
 * moved — which is the point.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { buildScope, decodeSnapshot } from "./lib/ac-scope.mjs";
/* The receiving warehouse is the BOOK'S, not the purchase order's. One rule,
   one location map — see the header of lib/ac-gr-location.mjs. */
import { loadBookGrLocations, resolveAcReceiptLocation } from "./lib/ac-gr-location.mjs";
/* The ERP's statement of sofa identity, and the write-time refusal that stops a
   book code being written untranslated. See "THE ITEM CODE" in the header. */
import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { aliasFoldsForCatalog, catalogPredicate, nonCatalogRefs, formatNonCatalogRefusal } from "./lib/catalog-code-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE GR RESHAPE PLAN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(CO) || CO <= 0) { console.error("COMPANY_ID must be a positive integer"); process.exit(2); }
const DUMP_DIR = process.env.DUMP_DIR || path.join(here, "..", "grn-dump");
const SHOW = Math.max(1, Number(process.env.SHOW || 20));
const SYS_USER = "00000000-0000-4000-8000-000000000001";

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const say = (m = "") => console.log(m);
const rule = (t) => say(`\n═══════════ ${t} ═══════════`);
const pad = (s, n) => String(s ?? "").padEnd(n);
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
/* The catalogue's own key shape — catalogPredicate trims and upper-cases and
   does NOT collapse inner whitespace, so a lookup that did would miss. */
const up = (s) => String(s ?? "").trim().toUpperCase();
const n0 = (x) => Number(x || 0);
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8").replace(/^﻿/, ""));

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const refuse = async (msg) => {
  console.error(`REFUSED: ${msg}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
};

/* ── the book code -> ERP code map, read exactly as the importers read it ─── */
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

/**
 * `Map<norm(AutoCount ItemCode), ERP code>` from autocount-erp-mapping-1561.csv,
 * with the sofa alias fold applied AT READ TIME — before anything asks the
 * catalogue about a code, which is the ordering docs/bugs/0686 was bought with.
 * The four HOK sofa rows deliberately still name the BOOK model in the file;
 * src/services/autocount-item-map.ts is compiled from the same file and read in
 * the other direction, so folding there moves the write-back instead.
 */
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

/* ── the book, at pair grain ─────────────────────────────────────────────── */
/** `Map<"GR|PO", {gr, po, date, lines}>` from ac-convert-edges. */
function bookPairsFromEdges(scope) {
  const ce = gz("ac-convert-edges.json.gz");
  const LF = ce.line_fields;
  const HF = ce.header_fields;
  const iDoc = LF.indexOf("docNo");
  const iKey = LF.indexOf("dtlKey");
  const iSeq = LF.indexOf("seq");
  const iItem = LF.indexOf("itemKey");
  const iQty = LF.indexOf("qty");
  const iFT = LF.indexOf("fromDocType");
  const iFN = LF.indexOf("fromDocNo");
  const hDoc = HF.indexOf("docNo");
  const hDate = HF.indexOf("docDate");
  const hCanc = HF.indexOf("cancelled");
  if ([iDoc, iKey, iItem, iQty, iFT, iFN, hDoc, hDate, hCanc].some((i) => i < 0)) {
    throw new Error("ac-convert-edges.json.gz does not carry the fields this writer reads");
  }
  const heads = new Map(ce.types.GR.headers.map((h) => [String(h[hDoc]).trim(), {
    date: String(h[hDate] ?? "").slice(0, 10), cancelled: String(h[hCanc] ?? "").trim() !== "F",
  }]));
  const pairs = new Map();
  let skippedCancelled = 0;
  for (const r of ce.types.GR.lines) {
    const gr = String(r[iDoc] ?? "").trim();
    if (!scope.GR.has(gr)) continue;
    if (String(r[iFT] ?? "").trim() !== "PO") continue;
    const po = String(r[iFN] ?? "").trim();
    if (!scope.PO.has(po)) continue;
    const h = heads.get(gr);
    if (!h || h.cancelled) { skippedCancelled += 1; continue; }
    const k = `${gr}|${po}`;
    if (!pairs.has(k)) pairs.set(k, { gr, po, date: h.date, lines: [] });
    pairs.get(k).lines.push({
      dtlKey: String(r[iKey] ?? "").trim(),
      seq: Number(r[iSeq] ?? 0),
      itemKey: String(r[iItem] ?? "").trim(),
      qty: Number(r[iQty] || 0),
    });
  }
  for (const p of pairs.values()) p.lines.sort((a, b) => a.seq - b.seq || (a.dtlKey > b.dtlKey ? 1 : -1));
  return { pairs, exportedAt: ce.exported_at, skippedCancelled };
}

/** The same pair set, cut independently, for the cross-check. */
function bookPairsFromTruth(book, scope) {
  const out = new Set();
  for (const gr of scope.GR) {
    for (const l of book.GR.lines.get(gr) || []) {
      if (l.fromDocType !== "PO" || !l.fromDocNo || !scope.PO.has(l.fromDocNo)) continue;
      out.add(`${gr}|${l.fromDocNo}`);
    }
  }
  return out;
}

/** The book's own unit price IN SEN per GR DtlKey — used ONLY for a line no ERP purchase-order line owns. */
function bookGrPriceByKey(book, scope) {
  const out = new Map();
  for (const gr of scope.GR) {
    for (const l of book.GR.lines.get(gr) || []) {
      if (l.dtlKey == null) continue;
      out.set(String(l.dtlKey).trim(), Number(l.unitPriceSen || 0));
    }
  }
  return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} company_id=${CO}`);

  /* ── the population, stated once, in lib/ac-scope.mjs ────────────────────── */
  const SNAP = path.join(DATA, "ac-reconcile-truth.json.gz");
  if (!fs.existsSync(SNAP)) await refuse(`${SNAP} is missing — run export-ac-reconcile-truth.mjs against the book first.`);
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
  const book = decodeSnapshot(snap);
  const scope = buildScope(book);
  const edges = bookPairsFromEdges(scope);
  const truthPairs = bookPairsFromTruth(book, scope);
  const priceByKey = bookGrPriceByKey(book, scope);

  rule("THE BOOK — the receipts AutoCount actually made, at pair grain");
  say(`ac-reconcile-truth.json.gz exported ${snap.exported_at}  (population + cross-check)`);
  say(`ac-convert-edges.json.gz   exported ${edges.exportedAt}  (line truth)`);
  say(`in-scope: ${scope.GR.size} goods receipts, ${scope.PO.size} purchase orders`);
  const onlyEdges = [...edges.pairs.keys()].filter((k) => !truthPairs.has(k));
  const onlyTruth = [...truthPairs].filter((k) => !edges.pairs.has(k));
  if (onlyEdges.length || onlyTruth.length) {
    await refuse(
      "the two AutoCount extracts disagree on the (receipt x purchase order) pair set — " +
        `${onlyEdges.length} only in ac-convert-edges (${onlyEdges.slice(0, 5).join(", ")}), ` +
        `${onlyTruth.length} only in ac-reconcile-truth (${onlyTruth.slice(0, 5).join(", ")}). ` +
        "Resolve which cut is right before writing documents from either.",
    );
  }
  const bookPos = new Set([...edges.pairs.values()].map((p) => p.po));
  const splitHist = {};
  const perPo = new Map();
  for (const p of edges.pairs.values()) perPo.set(p.po, (perPo.get(p.po) ?? 0) + 1);
  for (const v of perPo.values()) splitHist[v] = (splitHist[v] ?? 0) + 1;
  const bookUnits = [...edges.pairs.values()].reduce((s, p) => s + p.lines.reduce((t, l) => t + l.qty, 0), 0);
  log(`BOOK — ${edges.pairs.size} (receipt x purchase order) pairs over ${bookPos.size} purchase orders; ` +
    `${[...edges.pairs.values()].reduce((s, p) => s + p.lines.length, 0)} receipt lines, ${bookUnits} units`);
  say(`  purchase orders by how many receipts received them: ${Object.keys(splitHist).map(Number).sort((a, b) => a - b).map((k) => `${k}x ${splitHist[k]}`).join("   ")}`);
  say(`  -> RECEIVED IN MORE THAN ONE GO: ${[...perPo.values()].filter((v) => v > 1).length} of ${bookPos.size}`);
  say(`  both extracts agree on all ${edges.pairs.size} pairs. cancelled receipt lines skipped: ${edges.skippedCancelled}`);
  const years = {};
  const grYears = {};
  const seenGr = new Map();
  for (const p of edges.pairs.values()) {
    const y = p.date.slice(0, 4);
    years[y] = (years[y] ?? 0) + 1;
    if (!seenGr.has(p.gr)) { seenGr.set(p.gr, y); grYears[y] = (grYears[y] ?? 0) + 1; }
  }
  /* Two denominators, printed together because they are easy to confuse: the
     RECEIPTS the book made, and the PAIR DOCUMENTS the ERP writes for them. */
  say(`  AutoCount receipts by year:    ${Object.entries(grYears).sort().map(([y, c]) => `${y} ${c}`).join("   ")}   (${seenGr.size} receipts)`);
  say(`  pair documents by receipt year: ${Object.entries(years).sort().map(([y, c]) => `${y} ${c}`).join("   ")}   (${edges.pairs.size} documents)`);

  /* ── the ERP side ───────────────────────────────────────────────────────── */
  /* The receiving warehouse is COPIED from the book where the book can answer.
   lib/ac-gr-location.mjs owns that read and the SHARED location map; its header
   says why a surviving stock LAYER is not a receipt location. */
  const warehouses = await sql`SELECT id::text AS id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const bookLoc = loadBookGrLocations(path.join(here, "data"));
  /* THE CATALOGUE, read before the mapping so the alias fold can consult it.
     An empty catalogue would make the fold a no-op and the guard refuse
     everything, which is the honest failure — but a verdict computed over
     nothing must not read as a pass either, so say the size out loud. */
  const products = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  if (!products.length) {
    await refuse(`scm.mfg_products has no company-${CO} rows. The alias fold would move nothing and the catalogue ` +
      "guard would refuse every line — a verdict computed over nothing, not an answer about the plan.");
  }
  const prodByCode = new Map(products.map((p) => [up(p.code), p]));
  const inCatalog = catalogPredicate(products.map((p) => p.code));
  const { byAc: acToErp, moves: aliasMoves } = loadAcToErp(inCatalog);
  log(`CATALOGUE — ${products.length} company-${CO} product code(s); book->ERP map carries ${acToErp.size} AutoCount code(s)`);
  if (aliasMoves.size) {
    say(`  alias fold: ${aliasMoves.size} mapped code(s) the catalogue does not carry resolve through SOFA_MODEL_ALIAS`);
    for (const [from, to] of aliasMoves) say(`     ${from} -> ${to}`);
  }
  const pos = await sql`SELECT id::text AS id, po_number, linked_ac_docno AS ac, supplier_id::text AS supplier_id,
      purchase_location_id::text AS purchase_location_id, currency::text AS currency
    FROM scm.purchase_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const poByAc = new Map(pos.map((p) => [String(p.ac).trim(), p]));
  const poItems = await sql`SELECT i.id::text AS id, i.purchase_order_id::text AS po_id, i.item_code, i.material_name,
      i.item_group, i.variants, i.warehouse_id::text AS warehouse_id, i.qty::float8 AS qty,
      i.received_qty::float8 AS received_qty, i.unit_price_sen, i.linked_ac_dtlkey::text AS ac_dtlkey,
      i.line_suffix, i.description2, i.uom, i.supplier_sku, i.material_kind::text AS material_kind
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL ORDER BY i.id`;
  const itemsByPo = new Map();
  for (const it of poItems) {
    if (!itemsByPo.has(it.po_id)) itemsByPo.set(it.po_id, []);
    itemsByPo.get(it.po_id).push(it);
  }

  const grns = await sql`SELECT g.id::text AS id, g.grn_number, g.status::text AS status, g.received_at::text AS received_at,
      g.purchase_order_id::text AS po_id, g.notes, g.linked_ac_docno, g.migrated_no_stock,
      p.linked_ac_docno AS po_ac, p.linked_ac_grn_docnos AS ac_grs
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true ORDER BY g.grn_number`;
  const grnLines = await sql`SELECT i.id::text AS id, i.grn_id::text AS grn_id, i.purchase_order_item_id::text AS poi_id,
      i.item_code, i.material_name, i.item_group, i.qty_received::float8 AS qty_received,
      i.qty_accepted::float8 AS qty_accepted, i.invoiced_qty::float8 AS invoiced_qty,
      i.returned_qty::float8 AS returned_qty, i.unit_price_sen, i.discount_sen, i.line_total_sen, i.variants,
      i.line_suffix, i.description2, i.uom, i.notes
    FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true ORDER BY i.grn_id, i.id`;
  const linesByGrn = new Map();
  for (const l of grnLines) {
    if (!linesByGrn.has(l.grn_id)) linesByGrn.set(l.grn_id, []);
    linesByGrn.get(l.grn_id).push(l);
  }

  rule("THE ERP TODAY");
  const dates = new Set(grns.map((g) => String(g.received_at ?? "").slice(0, 10)));
  log(`ERP — ${grns.length} migrated goods receipts, ${grnLines.length} lines, ` +
    `${grnLines.reduce((s, l) => s + n0(l.qty_accepted), 0)} units, on ${new Set(grns.map((g) => g.po_id)).size} purchase orders`);
  say(`  distinct received_at values across all of them: ${dates.size} — ${[...dates].sort().join(", ")}`);

  /* ── STOCK SAFETY, RE-ASSERTED BEFORE ANYTHING MOVES ────────────────────── */
  const ids = grns.map((g) => g.id);
  const [mv] = ids.length
    ? await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(qty)), 0)::float8 AS q FROM scm.inventory_movements
        WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id::text = ANY(${ids})`
    : [{ n: 0, q: 0 }];
  log(`STOCK — inventory movements behind those ${grns.length} documents: ${mv.n} rows / ${mv.q} units`);
  if (mv.n !== 0) {
    await refuse(
      `${mv.n} inventory movement(s) sit behind the migrated goods receipts. This writer retires and ` +
        "rewrites those documents, which is only stock-neutral while they carry NO movements. " +
        "Investigate before reshaping — removing a document that DID move stock changes on-hand.",
    );
  }
  say("  -> zero, as migration 0276 states. The FIFO trigger is AFTER INSERT ON inventory_movements,");
  say("     not on grn_items, so writing or retiring receipt rows here moves no inventory.");

  /* ── THE RESTORABLE DUMP, WRITTEN IN BOTH MODES, BEFORE ANYTHING MOVES ──── */
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const dumpFile = path.join(DUMP_DIR, `migrated-grns-company${CO}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(dumpFile, JSON.stringify({
    taken_at: new Date().toISOString(),
    company_id: CO,
    mode: APPLY ? "apply" : "plan",
    note: "Every migrated goods receipt and its lines, as they stood BEFORE reshape-migrated-grns ran. " +
      "Restorable: each header and each line carries its own id, so an UPDATE by id puts every column back.",
    grns,
    grn_items: grnLines,
  }, null, 2));
  log(`DUMP — ${grns.length} headers and ${grnLines.length} lines written to ${dumpFile} before anything moves.`);

  /* ── build the plan ─────────────────────────────────────────────────────── */
  rule("THE PLAN");
  /* An existing document's (receipt x purchase order) pair. The receipt half is
     DERIVED from the number — HC-<GR> or HC-<GR>-<PO> — because
     `grns.linked_ac_docno` holds the PURCHASE ORDER's AutoCount number, not the
     receipt's, despite what migration 0276's column comment says. */
  const existingByPair = new Map();
  const existingUnpaired = [];
  for (const g of grns) {
    const acGr = (g.ac_grs ?? []).map((x) => String(x).trim())
      .find((gr) => g.grn_number === `HC-${gr}` || g.grn_number.startsWith(`HC-${gr}-`)) ?? null;
    g._acGr = acGr;
    g._poAc = String(g.po_ac ?? "").trim();
    const k = acGr ? `${acGr}|${g._poAc}` : null;
    if (k && edges.pairs.has(k) && !existingByPair.has(k)) existingByPair.set(k, g);
    else existingUnpaired.push(g);
  }

  /* THE MONEY EVERY MIGRATED LINE ALREADY HOLDS, per unit, so a line split
     across two receipts keeps the same money per unit rather than being
     re-derived from a purchase order that states none. */
  const poIdByGrn = new Map(grns.map((g) => [g.id, g.po_id]));
  const carry = new Map();
  const carryByPo = new Map();
  const addCarry = (map, key, l) => {
    const e = map.get(key) ?? { unit: 0, disc: 0, qty: 0 };
    e.unit = Math.max(e.unit, n0(l.unit_price_sen));
    e.disc += n0(l.discount_sen);
    e.qty += n0(l.qty_accepted);
    map.set(key, e);
  };
  for (const g of grns) {
    for (const l of linesByGrn.get(g.id) ?? []) {
      if (l.poi_id) addCarry(carry, `${l.poi_id}|${norm(l.item_code)}`, l);
      addCarry(carryByPo, `${poIdByGrn.get(g.id)}|${norm(l.item_code)}`, l);
    }
  }
  const moneyBefore = grnLines.reduce((t, l) => t + n0(l.line_total_sen), 0);

  const allGrnNumbers = new Set((await sql`SELECT grn_number FROM scm.grns`).map((r) => r.grn_number));
  /* A receipt covering ONE in-scope purchase order keeps the bare AutoCount
     number; one covering several carries the purchase order too, because the
     ERP document is a slice of it. Same rule check-migrated-numbering.mjs
     enforces, so the reshape cannot break the owner's numbering rule. */
  const grSpan = new Map();
  for (const p of edges.pairs.values()) grSpan.set(p.gr, (grSpan.get(p.gr) ?? 0) + 1);

  const plan = [];
  const skippedNoPo = [];
  const unattributed = [];
  const noErpLineForKey = [];
  for (const [key, p] of [...edges.pairs].sort((a, b) => (a[0] > b[0] ? 1 : -1))) {
    const po = poByAc.get(p.po);
    if (!po) { skippedNoPo.push(key); continue; }
    const erpLines = itemsByPo.get(po.id) ?? [];
    const byKey = new Map();
    for (const it of erpLines) {
      const k = it.ac_dtlkey == null ? null : String(it.ac_dtlkey).trim();
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(it);
    }
    /* How many lines of this purchase order carry each item code, IN THE BOOK.
       Exactly one -> the receipt line resolves. Two or more -> nothing in the
       book decides which, and the owner ruled 「跟 autocount 一样」. */
    const bookPoLines = book.PO.lines.get(p.po) ?? [];
    const byCode = new Map();
    for (const l of bookPoLines) {
      const c = norm(l.itemKey);
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(l);
    }

    const items = [];
    for (const bl of p.lines) {
      const cands = byCode.get(norm(bl.itemKey)) ?? [];
      let why = null;
      if (cands.length === 0) why = "the purchase order carries no line with this item code in the book";
      else if (cands.length > 1) why = `the purchase order carries this item code on ${cands.length} lines and AutoCount does not record which one was received`;
      if (!why) {
        const src = cands[0];
        const erp = byKey.get(String(src.dtlKey).trim()) ?? [];
        const bookQty = Number(src.qty || 0);
        if (!erp.length) {
          why = `no ERP purchase-order line carries AutoCount line key ${src.dtlKey}`;
          noErpLineForKey.push(`${key} ${bl.itemKey} (book PO line ${src.dtlKey})`);
        } else if (bookQty <= 0) {
          why = `the book's purchase-order line ${src.dtlKey} has quantity ${bookQty}, so the received quantity cannot be apportioned`;
        } else {
          /* A sofa is ONE book line and SEVERAL ERP lines, one per
             compartment. Receiving one sofa receives each compartment once, so
             the share is the ERP line's own quantity over the book line's,
             which is 1:1 for every ordinary line. */
          let wrote = 0;
          for (const e of erp) {
            const q = Math.round((bl.qty / bookQty) * Number(e.qty || 0));
            if (q <= 0) continue;
            items.push({ book: bl, poi: e, qty: q, attributed: true });
            wrote += 1;
          }
          if (wrote) continue;
          why = `every ERP line under AutoCount line key ${src.dtlKey} works out to zero received quantity`;
        }
      }
      unattributed.push({ pair: key, gr: p.gr, po: p.po, itemKey: bl.itemKey, qty: bl.qty, dtlKey: bl.dtlKey, why });
      items.push({ book: bl, poi: null, qty: bl.qty, attributed: false, why, cands });
    }

    const existing = existingByPair.get(key) ?? null;
    let number = existing?.grn_number ?? null;
    if (!number) {
      const bare = `HC-${p.gr}`;
      const full = `HC-${p.gr}-${p.po}`;
      number = (grSpan.get(p.gr) === 1 && !allGrnNumbers.has(bare)) ? bare : full;
      if (allGrnNumbers.has(number)) {
        await refuse(`the number this plan wants for ${key} (${number}) is already taken by another goods receipt. Resolve before writing.`);
      }
      allGrnNumbers.add(number);
    }
    plan.push({ key, gr: p.gr, po: p.po, date: p.date, erpPo: po, existing, number, items });
  }

  const creates = plan.filter((d) => !d.existing);
  const updates = plan.filter((d) => d.existing);
  /* An existing document whose pair the plan does not hold is superseded — but
     ONLY where the plan actually covers its purchase order. Where it does not,
     the book cut simply has no rows about that purchase order and calling it a
     gap manufactures one. */
  const retire = existingUnpaired.filter((g) => bookPos.has(g._poAc));
  const untouched = existingUnpaired.filter((g) => !bookPos.has(g._poAc));

  const planUnits = plan.reduce((s, d) => s + d.items.reduce((t, i) => t + i.qty, 0), 0);
  const planLines = plan.reduce((s, d) => s + d.items.length, 0);
  log(`PLAN — ${plan.length} pair documents: ${creates.length} to CREATE, ${updates.length} to UPDATE IN PLACE; ` +
    `${retire.length} existing document(s) to CANCEL as superseded; ${untouched.length} left untouched (their purchase order is outside the book cut)`);
  say(`  lines to write: ${planLines}; units: ${planUnits}`);
  if (skippedNoPo.length) {
    say(`  pairs the ERP has no purchase order for: ${skippedNoPo.length} — ${skippedNoPo.slice(0, SHOW).join(", ")}`);
    say("    (the receipt is in the book against a purchase order this migration never carried; not this writer's to invent)");
  }
  if (noErpLineForKey.length) {
    say(`  receipt lines whose book purchase-order line has NO ERP line carrying its key: ${noErpLineForKey.length}`);
    for (const x of noErpLineForKey.slice(0, SHOW)) say(`     ${x}`);
  }

  /* ── the flagged lines, named ───────────────────────────────────────────── */
  rule("PO-LINE ATTRIBUTION — what the book decides, and what it does not");
  const attributedLines = plan.reduce((s, d) => s + d.items.filter((i) => i.attributed).length, 0);
  const unattributedUnits = unattributed.reduce((s, u) => s + u.qty, 0);
  log(`ATTRIBUTION — ${attributedLines} of ${planLines} written lines carry a purchase-order line; ` +
    `${unattributed.length} receipt line(s) / ${unattributedUnits} unit(s) are left UNATTRIBUTED and flagged, per the owner's 「跟 autocount 一样」`);
  say("  The line is still written — item, quantity and receipt date, exactly as AutoCount has them.");
  say("  Only the purchase-order LINE is left unset, because AutoCount does not record it");
  say("  (GRDTL.FromDocDtlKey is 0 of 21,746 rows) and inventing one is not a copy.");
  say("  Each flagged line carries its own grn_items.notes saying so, and its document's notes names them,");
  say("  so a person opening the receipt reads it without running anything.");
  const byWhy = new Map();
  for (const u of unattributed) {
    const w = u.why.replace(/ on \d+ lines/, " on more than one line");
    byWhy.set(w, (byWhy.get(w) ?? 0) + 1);
  }
  for (const [w, c] of [...byWhy].sort((a, b) => b[1] - a[1])) say(`     ${c}x  ${w}`);
  say(`  the flagged lines (first ${SHOW} of ${unattributed.length}):`);
  for (const u of unattributed.slice(0, SHOW)) say(`     ${pad(u.pair, 26)} ${pad(u.itemKey, 28)} qty ${u.qty}`);

  /* ── would the reshape move a receipt total? ────────────────────────────── */
  rule("QUANTITY — does the reshape change how much each purchase-order line has received?");
  const afterByPoi = new Map();
  for (const d of plan) {
    for (const i of d.items) {
      if (!i.attributed) continue;
      afterByPoi.set(i.poi.id, (afterByPoi.get(i.poi.id) ?? 0) + i.qty);
    }
  }
  const seenPoi = new Set();
  let same = 0;
  const moved = [];
  for (const d of plan) {
    for (const it of (itemsByPo.get(d.erpPo.id) ?? [])) {
      if (seenPoi.has(it.id)) continue;
      seenPoi.add(it.id);
      const before = n0(it.received_qty);
      const after = afterByPoi.get(it.id) ?? 0;
      if (before === after) { same += 1; continue; }
      moved.push({ po: d.erpPo.po_number, code: it.item_code, before, after });
    }
  }
  log(`QUANTITY — purchase-order lines whose received total is UNCHANGED by the reshape: ${same}; different: ${moved.length}`);
  say("  `purchase_order_items.received_qty` is NOT written by this script. This compares what the");
  say("  book's receipts add up to against the number the column holds today, so any difference is");
  say("  visible now rather than discovered later by a recount.");
  for (const m of moved.slice(0, SHOW)) say(`     ${pad(m.po, 16)} ${pad(m.code, 28)} received_qty ${m.before} -> the book's receipts add to ${m.after}`);
  if (moved.length > SHOW) say(`     ... ${moved.length - SHOW} more`);

  rule("DOCUMENTS");
  for (const d of plan.slice(0, SHOW)) {
    say(`  ${d.existing ? "UPDATE" : "CREATE"} ${pad(d.number, 30)} ${pad(d.erpPo.po_number, 16)} received ${d.date}  ` +
      `${d.items.length} line(s), ${d.items.reduce((s, i) => s + i.qty, 0)} unit(s)` +
      (d.existing ? `  (was received_at ${String(d.existing.received_at).slice(0, 10)})` : ""));
  }
  if (plan.length > SHOW) say(`  ... ${plan.length - SHOW} more`);
  say("");
  for (const g of retire.slice(0, SHOW)) say(`  CANCEL ${pad(g.grn_number, 30)} — superseded by the book's own receipts for ${g._poAc}`);
  if (retire.length > SHOW) say(`  ... ${retire.length - SHOW} more`);

  /* The billing state a reused document already carries, so an invoice raised
     from it is not forgotten when its lines are rewritten. Keyed on the
     purchase-order line plus the item code, allocated across the new documents
     in plan order and capped at each line's own quantity. */
  const billed = new Map();
  for (const g of grns) {
    for (const l of linesByGrn.get(g.id) ?? []) {
      const k = `${l.poi_id ?? "-"}|${norm(l.item_code)}`;
      billed.set(k, (billed.get(k) ?? 0) + n0(l.invoiced_qty));
    }
  }

  const noteFor = (d) => {
    const flagged = d.items.filter((i) => !i.attributed);
    const parts = [
      `Mirrors AutoCount goods receipt ${d.gr}, received ${d.date}, for the part of it raised against ${d.po}.`,
    ];
    if ((grSpan.get(d.gr) ?? 1) > 1) {
      parts.push(`SCOPE: ${d.gr} receives ${grSpan.get(d.gr)} purchase orders in AutoCount; this document covers ONLY ${d.po}, so its quantity is smaller than the AutoCount document of the same number. That is correct, not a shortfall.`);
    }
    if (flagged.length) {
      parts.push(
        `PURCHASE-ORDER LINE NOT RECORDED on ${flagged.length} line(s): ` +
        flagged.map((i) => `${i.book.itemKey} x${i.qty}`).join(", ") +
        ". AutoCount records the item and the quantity but not which purchase-order line was received, and this purchase order carries that item code on more than one line. The quantity is correct; only the link to the line is left unset, deliberately, rather than guessed.",
      );
    }
    parts.push("No stock movement: the units are already on hand from the AutoCount balance snapshot.");
    return parts.join(" ");
  };

  const lineRows = (d) => d.items.map((i) => {
    const poi = i.poi;
    /* THE TRANSLATION. An attributed line COPIES the purchase-order line's code
       — already translated by the importer, and a copy is what a migration
       writes. An unattributed line has no purchase-order line to copy, so it
       resolves AutoCount's own code through the same mapping file; only where
       the map is silent does the book code stand, and the catalogue guard below
       refuses the run rather than letting that reach a document line. */
    const translated = poi ? null : (acToErp.get(norm(i.book.itemKey)) ?? null);
    const code = poi ? poi.item_code : (translated ?? i.book.itemKey);
    const prod = poi ? null : prodByCode.get(up(code));
    const k = `${poi?.id ?? "-"}|${norm(code)}`;
    /* Exact line first, then any line of the same purchase order carrying the
       same code - which is what an unattributed line has, and the price does
       not depend on WHICH of the identically-coded lines it was.

       THE THIRD LOOKUP IS THE UNTRANSLATED CODE, and it is not redundancy: the
       rows sitting in scm.grn_items today were written under the RAW book code,
       so once the fallback is translated the first two keys miss the money this
       document already holds and the line would silently be re-derived from the
       book. Carrying is the rule; the key has to follow what is on disk. */
    const kRaw = `${poi?.id ?? "-"}|${norm(i.book.itemKey)}`;
    const held = (poi ? carry.get(k) : null)
      ?? carryByPo.get(`${d.erpPo.id}|${norm(code)}`)
      ?? (translated ? carryByPo.get(`${d.erpPo.id}|${norm(i.book.itemKey)}`) : null)
      ?? null;
    let price;
    let discount = 0;
    if (held && held.unit > 0) {
      price = held.unit;
      discount = held.qty > 0 ? Math.round((held.disc / held.qty) * i.qty) : 0;
    } else if (poi) {
      price = n0(poi.unit_price_sen);
    } else {
      /* No ERP money anywhere for this code on this purchase order, and no
         purchase-order line to inherit from. The book's own receipt line is the
         only statement of what it is worth. */
      price = Math.round(n0(priceByKey.get(i.book.dtlKey)));
    }
    /* Same reason as the money key above: the invoiced quantity already booked
       against this line is held under the code the row was WRITTEN with. */
    const bk = billed.has(k) ? k : kRaw;
    const avail = billed.get(bk) ?? 0;
    const take = Math.min(avail, i.qty);
    if (take > 0) billed.set(bk, avail - take);
    return {
      discount,
      bookCode: i.book.itemKey,
      translated: translated != null,
      poi_id: poi?.id ?? null,
      material_kind: poi?.material_kind ?? "mfg_product",
      item_code: code,
      material_name: poi?.material_name ?? prod?.name ?? code,
      item_group: poi?.item_group ?? null,
      variants: poi?.variants ?? null,
      line_suffix: poi?.line_suffix ?? null,
      description2: poi?.description2 ?? null,
      uom: poi?.uom ?? "UNIT",
      supplier_sku: poi?.supplier_sku ?? null,
      qty: i.qty,
      price,
      invoiced: take,
      lineTotal: Math.max(0, Math.round(i.qty * price) - discount),
      notes: i.attributed ? null :
        `PURCHASE-ORDER LINE NOT RECORDED — ${i.why}. The item and the quantity are AutoCount's own; only the link to a purchase-order line is left unset, deliberately (owner 2026-09-07: 跟 autocount 一样).`,
    };
  });

  /* Built ONCE, here, so the PLAN reports the money the APPLY would write. A
     plan that recomputes its own preview is a second answer, not a preview. */
  let moneyAfter = 0;
  for (const d of plan) {
    d.rows = lineRows(d);
    d.total = d.rows.reduce((s, r) => s + r.lineTotal, 0);
    /* THE BOOK'S LOCATION FIRST. The old rule — the first purchase-order line's
       warehouse, else the ORDER's location — is a DERIVATION, and a migration
       copies rather than computes; a warehouse can receive into a location the
       order did not name. Where the committed cuts carry AutoCount's own GRDTL
       location we copy it; where they do not (the GR export only started
       selecting the column on 2026-09-08) we fall back and COUNT it, because a
       miss means the book was never asked, not that it agrees. */
    const bl = resolveAcReceiptLocation([d.gr], d.items.map((i) => (i.poi ? i.poi.item_code : i.book.itemKey)), bookLoc, warehouses);
    d.warehouseFrom = bl.warehouseId ? "book" : "purchase order";
    d.warehouseWhy = bl.why;
    d.bookLocation = bl.bookLocation;
    d.warehouse = bl.warehouseId ?? d.items.find((i) => i.poi?.warehouse_id)?.poi.warehouse_id ?? d.erpPo.purchase_location_id;
    moneyAfter += d.total;
  }
  rule("RECEIVING LOCATION — copied where the book can answer");
  const locCopied = plan.filter((d) => d.warehouseFrom === "book").length;
  log(`LOCATION — ${locCopied} of ${plan.length} documents take the warehouse from AutoCount's own receipt; ${plan.length - locCopied} fall back to the purchase order.`);
  say(`  Book sources on this cut: ${bookLoc.sources.join("; ") || "NONE"}.`);
  say("  A fallback means the book was NEVER ASKED, not that it agrees — export-ac-reimport.py's");
  say("  grrefs section only started selecting GRDTL.Location on 2026-09-08, so an older cut answers");
  say("  for part of the corpus. Re-cut it and re-run this to raise the copied count.");
  for (const d of plan.filter((x) => x.warehouseFrom !== "book").slice(0, 5)) say(`    ${d.gr} / ${d.po}: ${d.warehouseWhy}`);

  rule("MONEY — carried, never recomputed, and reconciled to the book");
  /* THE BOOK IS THE CEILING. A money jump between two ERP states cannot tell a
     correction from a double-count; only the book can. This sums AutoCount's
     own GRDTL SubTotal for exactly the pairs this plan writes, so the run
     STATES the ceiling instead of leaving the next reader to guess. The bare
     before/after this replaced blocked the cutover three times (docs/bugs/0682). */
  let bookSen = 0;
  for (const d of plan) {
    for (const bl of edges.pairs.get(d.key)?.lines ?? []) {
      const s = book.GR.byDtlKey.get(bl.dtlKey) ?? book.GR.byDtlKey.get(Number(bl.dtlKey));
      bookSen += s?.subTotalSen ?? Math.round(n0(bl.qty) * n0(priceByKey.get(bl.dtlKey)));
    }
  }
  /* LIKE FOR LIKE. `moneyBefore` sums `line_total_sen` over ALL migrated
     receipts; `moneyAfter` computes qty x price over the PLAN's documents only.
     Two different populations measured two different ways — which is why it
     read as a doubling. Split both apart so the comparison is honest. */
  const qpOf = (g) => (linesByGrn.get(g.id) ?? []).reduce(
    (t, l) => t + Math.round(n0(l.qty_accepted) * n0(l.unit_price_sen)), 0);
  const ltOf = (g) => (linesByGrn.get(g.id) ?? []).reduce((t, l) => t + n0(l.line_total_sen), 0);
  const sum = (a, f) => a.reduce((t, g) => t + f(g), 0);
  const replaced = updates.map((d) => d.existing);
  const rm = (sen) => `RM ${(sen / 100).toFixed(2)}`;
  log(`MONEY — the ${plan.length} documents this plan writes are worth ${rm(moneyAfter)}; ` +
    `the ${replaced.length} they REPLACE are worth ${rm(sum(replaced, qpOf))} today on the same formula; ` +
    `the BOOK states those same pairs are worth ${rm(bookSen)}.`);
  say(`  VERDICT: the plan lands ${rm(Math.abs(bookSen - moneyAfter))} ${moneyAfter > bookSen ? "ABOVE" : "BELOW"} the book.` +
    (moneyAfter > bookSen
      ? "  *** ABOVE THE BOOK IS A DOUBLE-COUNT SIGNATURE — DO NOT APPLY, partition the lines first. ***"
      : "  Below the book is the expected shape: lines the ERP never priced stay unpriced until"));
  if (moneyAfter <= bookSen) say("  `stamp-migrated-source-prices.mjs` runs. It CANNOT be a double-count: the book is the ceiling.");
  say("");
  say(`  the headline before/after, taken apart:`);
  say(`    all ${grns.length} migrated receipts, sum(line_total_sen)      ${rm(moneyBefore)}   <- the old "before"`);
  say(`    ... of which ${untouched.length} documents are UNTOUCHED and SURVIVE  ${rm(sum(untouched, ltOf))}  (NOT in the "after")`);
  say(`    ... of which ${replaced.length} documents are actually replaced      ${rm(sum(replaced, ltOf))}`);
  say(`    those same ${replaced.length}, valued as qty x unit_price            ${rm(sum(replaced, qpOf))}  <- like for like`);
  say(`    lines holding a PRICE but a ZERO line_total_sen: ${grnLines.filter((l) => n0(l.line_total_sen) === 0 && n0(l.unit_price_sen) > 0).length} of ${grnLines.length}`);
  say(`      -> that column, not the reshape, is why the old "before" read low. The reshape WRITES it.`);
  say(`    TRUE after-state: ${rm(moneyAfter)} + ${rm(sum(untouched, ltOf))} untouched = ${rm(moneyAfter + sum(untouched, ltOf))} over ${plan.length + untouched.length} documents.`);
  say("");
  say("  Nothing here decides a price. `stamp-migrated-source-prices.mjs` owns that — it applied 32 lines to");
  say("  production on 2026-09-07 16:02Z (run 34141318054) — and this carries what each line already holds,");
  say("  per unit, so a line split across two receipts keeps the same money per unit. Its selection is");
  say("  `unit_price_sen = 0`, so RE-DISPATCH IT AFTER THIS RUN to price anything still at zero.");

  /* ── THE ITEM CODE, AND THE GUARD THAT WILL NOT WRITE AN ORPHAN ─────────── */
  /* Placed BEFORE the dry-run return on purpose (docs/bugs/0686): an operator
     has to learn the plan is unwritable while reading it, not after typing
     CONFIRM. The whole plan above still prints first, because the refusal is
     text the caller emits rather than a throw. */
  rule("ITEM CODE — copied where there is a line to copy, translated where there is not");
  const allRows = plan.flatMap((d) => d.rows.map((r) => ({ ...r, doc: d.number, gr: d.gr })));
  const copied = allRows.filter((r) => r.poi_id);
  const fallback = allRows.filter((r) => !r.poi_id);
  const untranslated = fallback.filter((r) => !r.translated);
  log(`ITEM CODE — ${allRows.length} line(s) to write: ${copied.length} copy the purchase-order line's code; ` +
    `${fallback.length - untranslated.length} of the ${fallback.length} unattributed line(s) resolve AutoCount's own code ` +
    `through autocount-erp-mapping-1561.csv; ${untranslated.length} have no mapping row`);
  say("  An unattributed line used to be written with the RAW AutoCount code — that is why the reconcile");
  say("  reported company-1 GR item-code differences whose two sides looked identical: it COMPARES the");
  say("  mapped value and PRINTED the book's. Translating here removes the difference at its source.");
  for (const r of fallback.filter((x) => x.translated).slice(0, SHOW)) {
    say(`     ${pad(r.doc, 24)} ${pad(r.bookCode, 28)} -> ${pad(r.item_code, 24)} ${r.material_name}`);
  }
  if (untranslated.length) {
    say(`  NO MAPPING ROW — the book code stands, and the guard below decides whether it may be written:`);
    for (const r of untranslated.slice(0, SHOW)) say(`     ${pad(r.doc, 24)} ${r.bookCode}`);
  }

  const badCodes = nonCatalogRefs(
    allRows.map((r) => ({ code: r.item_code, doc: r.doc, acDoc: r.gr, acCode: r.bookCode })),
    inCatalog,
  );
  if (badCodes.length) {
    say("");
    for (const line of formatNonCatalogRefusal(badCodes, { script: "reshape-migrated-grns.mjs" })) log(line);
    say(`  Of those, ${badCodes.filter((b) => allRows.find((r) => r.item_code === b.code && r.poi_id)).length} were COPIED from a`);
    say("  purchase-order line that already carries the orphan; repair-orphan-sofa-codes.mjs owns those.");
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(2);
  }
  log(`ITEM CODE — every one of the ${allRows.length} line(s) carries a code scm.mfg_products holds. Nothing orphaned.`);

  if (!APPLY) {
    log(`PLAN ONLY — nothing was written to the database. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  /* ── apply ──────────────────────────────────────────────────────────────── */
  rule("APPLY");
  const [{ has }] = await sql`SELECT COUNT(*)::int AS has FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'grns' AND column_name = 'linked_ac_gr_docno'`;
  if (!has) {
    await refuse("scm.grns.linked_ac_gr_docno does not exist. Apply the migration that adds it before running APPLY.");
  }

  let created = 0;
  let updated = 0;
  let cancelled = 0;
  for (const d of plan) {
    const rows = d.rows;
    const total = d.total;
    const warehouse = d.warehouse;
    await sql.begin(async (tx) => {
      let grnId = d.existing?.id ?? null;
      if (grnId) {
        await tx`UPDATE scm.grns SET received_at = ${d.date}::date, notes = ${noteFor(d)},
            linked_ac_gr_docno = ${d.gr}, warehouse_id = ${warehouse}::uuid,
            currency = ${d.erpPo.currency ?? "MYR"}::scm.currency_code,
            subtotal_sen = ${total}, total_sen = ${total}, status = 'POSTED', updated_at = NOW()
          WHERE id = ${grnId}::uuid AND company_id = ${CO}`;
        await tx`DELETE FROM scm.grn_items WHERE grn_id = ${grnId}::uuid`;
        updated += 1;
      } else {
        const [hdr] = await tx`INSERT INTO scm.grns
            (grn_number, purchase_order_id, supplier_id, warehouse_id, status, posted_at, received_at,
             currency, subtotal_sen, total_sen, company_id, created_by, notes, migrated_no_stock,
             linked_ac_docno, linked_ac_gr_docno)
          VALUES (${d.number}, ${d.erpPo.id}::uuid, ${d.erpPo.supplier_id}::uuid, ${warehouse}::uuid, 'POSTED', NOW(),
                  ${d.date}::date, ${d.erpPo.currency ?? "MYR"}::scm.currency_code, ${total}, ${total}, ${CO},
                  ${SYS_USER}::uuid, ${noteFor(d)}, true, ${d.po}, ${d.gr})
          RETURNING id`;
        grnId = hdr.id;
        created += 1;
      }
      for (const r of rows) {
        await tx`INSERT INTO scm.grn_items
            (grn_id, purchase_order_item_id, material_kind, item_code, material_name, item_group,
             qty_received, qty_accepted, qty_rejected, unit_price_sen, discount_sen, line_total_sen, variants,
             line_suffix, description2, uom, supplier_sku, invoiced_qty, notes, company_id)
          VALUES (${grnId}::uuid, ${r.poi_id}, ${r.material_kind}::scm.material_kind, ${r.item_code}, ${r.material_name},
                  ${r.item_group}, ${r.qty}, ${r.qty}, 0, ${r.price}, ${r.discount}, ${r.lineTotal},
                  ${r.variants ? sql.json(r.variants) : null}, ${r.line_suffix}, ${r.description2}, ${r.uom ?? "UNIT"},
                  ${r.supplier_sku}, ${r.invoiced}, ${r.notes}, ${CO})`;
      }
    });
    if ((created + updated) % 50 === 0) log(`  ..${created + updated}/${plan.length}`);
  }
  for (const g of retire) {
    /* A DIRECT status flip, deliberately not PATCH /grns/:id/cancel — that route
       would write a reversing inventory OUT for every line. */
    const note = `SUPERSEDED by the account book's own receipts for ${g._poAc}: AutoCount received this ` +
      "purchase order in more than one go and the ERP now carries one document per receipt. " +
      `Cancelled, never deleted (owner's standing rule); its lines are still here to read. Previous note: ${g.notes ?? "(none)"}`;
    const res = await sql`UPDATE scm.grns SET status = 'CANCELLED', notes = ${note}, updated_at = NOW()
      WHERE id = ${g.id}::uuid AND company_id = ${CO} AND status <> 'CANCELLED'`;
    cancelled += res.count ?? 0;
  }
  log(`APPLIED — created ${created}, updated ${updated}, cancelled ${cancelled}.`);

  /* ── VERIFY ON A FRESH CONNECTION, AND ASK WHAT THE SHAPE NOW IS ────────── */
  /* A row count is not a shape. This re-reads every document by its (receipt x
     purchase order) pair and asserts the DATE, the LINE COUNT and the UNITS the
     plan said it would carry, plus that no inventory movement appeared. */
  rule("VERIFY (fresh connection)");
  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let bad = 0;
  const back = await v`SELECT g.id::text AS id, g.grn_number, g.status::text AS status, g.received_at::text AS received_at,
      g.linked_ac_gr_docno AS ac_gr, g.migrated_no_stock, p.linked_ac_docno AS po_ac,
      COUNT(i.id)::int AS lines, COALESCE(SUM(i.qty_accepted), 0)::float8 AS units,
      COUNT(i.id) FILTER (WHERE i.purchase_order_item_id IS NULL)::int AS unlinked
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    LEFT JOIN scm.grn_items i ON i.grn_id = g.id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true AND g.status <> 'CANCELLED'
    GROUP BY g.id, g.grn_number, g.status, g.received_at, g.linked_ac_gr_docno, g.migrated_no_stock, p.linked_ac_docno`;
  const byPair = new Map(back.map((r) => [`${String(r.ac_gr ?? "").trim()}|${String(r.po_ac ?? "").trim()}`, r]));
  for (const d of plan) {
    const r = byPair.get(d.key);
    if (!r) { bad += 1; say(`  VERIFY FAILED — ${d.key} (${d.number}): no live migrated receipt reads back for this pair`); continue; }
    const wantUnits = d.items.reduce((s, i) => s + i.qty, 0);
    const probs = [];
    if (String(r.received_at).slice(0, 10) !== d.date) probs.push(`received_at reads ${r.received_at}, the book says ${d.date}`);
    if (r.lines !== d.items.length) probs.push(`${r.lines} lines, the plan said ${d.items.length}`);
    if (r.units !== wantUnits) probs.push(`${r.units} units, the plan said ${wantUnits}`);
    if (r.migrated_no_stock !== true) probs.push("migrated_no_stock is NOT set");
    if (probs.length) { bad += 1; say(`  VERIFY FAILED — ${d.number}: ${probs.join("; ")}`); }
  }
  const liveIds = back.map((r) => r.id);
  const [mv2] = liveIds.length
    ? await v`SELECT COUNT(*)::int AS n FROM scm.inventory_movements
        WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id::text = ANY(${liveIds})`
    : [{ n: 0 }];
  if (mv2.n !== 0) { bad += 1; say(`  VERIFY FAILED — ${mv2.n} inventory movement(s) appeared behind the reshaped receipts. They must have none.`); }
  const flaggedBack = back.reduce((s, r) => s + r.unlinked, 0);
  const [{ n: liveDocs }] = await v`SELECT COUNT(*)::int AS n FROM scm.grns
    WHERE company_id = ${CO} AND migrated_no_stock = true AND status <> 'CANCELLED'`;
  const [{ n: cancelledDocs }] = await v`SELECT COUNT(*)::int AS n FROM scm.grns
    WHERE company_id = ${CO} AND migrated_no_stock = true AND status = 'CANCELLED'`;
  const [{ n: dateCount }] = await v`SELECT COUNT(DISTINCT received_at)::int AS n FROM scm.grns
    WHERE company_id = ${CO} AND migrated_no_stock = true AND status <> 'CANCELLED'`;
  say(`  live migrated receipts: ${liveDocs}; cancelled as superseded: ${cancelledDocs}`);
  say(`  distinct received_at across the live set: ${dateCount} (it was ${dates.size} before the reshape)`);
  say(`  lines carrying NO purchase-order line, read back from the database: ${flaggedBack} (the plan flagged ${unattributed.length})`);
  say(`  inventory movements behind the live set: ${mv2.n}`);
  await v.end();
  await sql.end();
  if (bad) { console.error(`${bad} verification failure(s).`); process.exit(1); }
  log(`VERIFIED on a fresh connection — ${plan.length} pair documents read back with the book's own date, line count and quantity, and zero inventory movements.`);
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(1); });
