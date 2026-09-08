#!/usr/bin/env node
/* probe-gr-iv-pi-remainder — WHAT ARE THE 18 GOODS-RECEIPT / SALES-INVOICE /
 * PURCHASE-INVOICE DIFFERENCES, ONE ROW PER DOCUMENT, WITH ITS CAUSE?
 *
 * READ-ONLY. Every statement is a SELECT. No DDL, no writes, no transaction.
 *
 * RE-RUN: read-only, so a re-run answers again from current state. That is the
 * point: it is the before/after instrument for a repair, and it must be run
 * again after one.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * The reconcile prints a COUNT per axis ("item code: 2; document total: 9").
 * A count cannot be repaired and it cannot be classified. The sales-order half
 * of the same remainder got `docs/cutover-so-do-remainder-2026-09-08.md` — one
 * row per document with its cause — and closed. The goods-receipt and invoice
 * half never did, which is why it has been sitting.
 *
 * ── THE ONE FACT THAT CHANGED, AND WHY EVERY PRE-14:22 VERDICT IS VOID ──────
 * `backfill-ac-downstream-line-keys.mjs` stamped AutoCount's own DtlKey onto
 * the migrated goods receipts at 2026-09-08 14:22 (+08) — 563 of 636 lines.
 * Before that `check-ac-erp-reconcile.mjs` had to GUESS which of our rows
 * answers which of the book's, and a transposed pair is exactly what that guess
 * looks like AND exactly what a genuinely wrong product looks like. So section
 * 1 asks the question the guess cannot survive: for each item-code difference,
 * DOES THE ERP ROW CARRY A KEY? A difference at a shared key is a DEFECT. A
 * difference with no key on our side is the checker's own pairing and the
 * multiset settles the document.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * Decide anything about a sofa's compartments, and touch nothing. The book side
 * is the committed cut `data/ac-reconcile-truth.json.gz`, the same one the
 * reconcile grades against, so this probe and that run cannot disagree about
 * what AutoCount says. AutoCount's SQL book is not queried — a hosted runner
 * has no route to it.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { buildScope, decodeSnapshot } from "./lib/ac-scope.mjs";
import { grPairGrain } from "./lib/ac-gr-pair-grain.mjs";
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { bagOf, compareBags, comparisonKey, printableBag } from "./lib/keyless-multiset.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const say = (m) => console.log(m);
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;

const snapPath = path.join(DATA, "ac-reconcile-truth.json.gz");
if (!fs.existsSync(snapPath)) { console.error(`REFUSED: ${snapPath} is missing.`); process.exit(2); }
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
const book = decodeSnapshot(snap);
const SCOPE = buildScope(book);
const { view } = grPairGrain(book, SCOPE);

const MAPPING = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));
const translate = (c) => MAPPING.get(normCode(c))?.erp ? normCode(MAPPING.get(normCode(c)).erp) : normCode(c);

/* The self-test the checker runs, restated for this probe's own inputs: a
   mapping that loaded nothing would make every code "differ" and the whole
   section 1 verdict would be manufactured. */
if (MAPPING.size < 100) {
  console.error(`REFUSED: the AutoCount->ERP sheet loaded ${MAPPING.size} rows. Every item-code verdict below would be its own artefact.`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });

/* THE SOFA FOLD IS NOT OPTIONAL, and leaving it out INVENTS findings — this
   probe's own first run proved it. A sofa is ONE book line (`DSL-8030 SOFA`,
   translated to `8030-1S`) and ONE ERP ROW PER COMPARTMENT, so an unfolded
   comparison can never be equal on a sofa document: run 34202080707 printed
   four goods receipts as differing bags and two invoice rows as goods the book
   does not have, and every one of the six was a decomposition. Same shape as
   docs/bugs/0694, where a sofa exclusion testing only `line_suffix` printed 40
   decompositions as wrong products. docs/bugs/0707 is this one.

   So nothing here writes its own opinion about a sofa code. Both sides go
   through `lib/keyless-multiset.mjs` — `bagOf` + `compareBags` where a WHOLE
   document is compared, because counting sofas needs the book's build text
   divided rather than compartment quantities summed, and `comparisonKey` alone
   where only a code has to be canonicalised.

   `rawCode` is the BOOK's own UNTRANSLATED code and it is load-bearing: the book
   names a sofa `AMN-SF2379 SOFA` and the sheet turns that into `2379-1S`, which
   contains no "SOFA" at all. Handing the translated string in as `rawCode`
   silently turns the fold off on exactly the rows it exists for. */
const canon = ({ code, rawCode, side, suffixed = false }) =>
  comparisonKey({ code: normCode(code), rawCode: rawCode ?? code, side, suffixed }).key;

async function main() {
  say(`AutoCount cut exported_at=${snap.exported_at}  company=${CO}  READ-ONLY`);
  say("");

  /* ── 1 + 2. GOODS RECEIPTS, at (receipt x purchase order) pair grain ────── */
  const grDocs = await sql`SELECT g.grn_number AS erp_no,
      g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
      COALESCE(g.total_sen, 0)::bigint AS total_sen,
      COALESCE(g.migrated_no_stock, false) AS migrated_no_stock, g.status
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
      AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`;
  const grLines = await sql`SELECT g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
      i.id::text AS id, i.item_code, i.qty_accepted::float8 AS qty,
      COALESCE(i.unit_price_sen, 0)::bigint AS unit_price_sen,
      COALESCE(i.line_total_sen, 0)::bigint AS line_total_sen,
      i.line_suffix, i.linked_ac_dtlkey::text AS ac_dtlkey, i.description2,
      i.purchase_order_item_id::text AS poi_id
    FROM scm.grn_items i
    JOIN scm.grns g ON g.id = i.grn_id
    JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
      AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`;

  const byPair = new Map();
  for (const d of grDocs) byPair.set(d.ac_no, { ...d, lines: [] });
  for (const l of grLines) byPair.get(l.ac_no)?.lines.push(l);
  const keyed = grLines.filter((l) => l.ac_dtlkey != null).length;
  log(`GR — ${byPair.size} pairs, ${grLines.length} ERP lines; ${keyed} carry linked_ac_dtlkey ` +
    `(${(100 * keyed / Math.max(1, grLines.length)).toFixed(1)}%)`);

  /* ── 1. ITEM CODE: a defect at a SHARED key, or the checker's own pairing? */
  say("");
  say("── 1. GR ITEM CODE — is it a wrong product, or a correspondence the checker guessed?");
  const codeDefects = [];   // ERP row and book line agree on the KEY and disagree on the code
  const codeGuessed = [];   // no key on our row: the pairing is a guess
  for (const [pair, erp] of byPair) {
    const bookLines = view.lines.get(pair) || [];
    if (!bookLines.length) continue;
    const bookByKey = new Map(bookLines.map((l) => [String(l.dtlKey).trim(), l]));
    for (const el of erp.lines) {
      const k = el.ac_dtlkey == null ? null : String(el.ac_dtlkey).trim();
      if (!k) continue;
      const bl = bookByKey.get(k);
      if (!bl) continue;
      /* A sofa compartment is NOT comparable to the book's whole-sofa code and
         is skipped by name, exactly as the reconcile declares it. */
      if (/SOFA/i.test(String(bl.itemKey ?? "")) || el.line_suffix) continue;
      const b = translate(bl.itemKey), e = normCode(el.item_code);
      if (b !== e) codeDefects.push({ pair, erpNo: erp.erp_no, key: k, book: b, erp: e, id: el.id, poi: el.poi_id });
    }
    /* The other half: our rows with NO key at all. Their pairing is the
       checker's guess, so the only honest question is the multiset — and it is
       asked by `lib/keyless-multiset.mjs`, never by arithmetic written here. A
       raw bag CANNOT answer it: a sofa is one book line and one ERP row per
       compartment, so summing our quantities reports `SOFA 9058 x1` against
       `SOFA 9058 x5` on a document holding exactly one sofa. That module folds
       our compartments by the BOOK's own build text and DIVIDES, which is the
       only reduction that gets it right (its header carries the two ways `MIN`
       gets it wrong). docs/bugs/0707 is this probe printing four such
       decompositions as differences before it called the module. */
    const unkeyed = erp.lines.filter((l) => l.ac_dtlkey == null);
    if (unkeyed.length) {
      const kv = compareBags({
        book: bagOf(bookLines.map((l) => ({
          code: translate(l.itemKey), rawCode: l.itemKey, qty: l.qty ?? 0, sen: l.subTotalSen ?? 0,
        })), "book"),
        erp: bagOf(erp.lines.map((l) => ({
          code: l.item_code, qty: l.qty ?? 0, sen: 0,
          suffixed: l.line_suffix != null, desc2: l.description2,
        })), "erp"),
        /* A migrated receipt's price comes from the purchase ORDER by design, so
           a book-vs-ERP money comparison here would measure our own derivation.
           The money axis is section 2, against the header, where it is real. */
        compareMoney: false,
      });
      codeGuessed.push({
        pair, erpNo: erp.erp_no, unkeyed: unkeyed.length, of: erp.lines.length,
        verdict: kv.verdict, notes: [...kv.differences, ...kv.ambiguities],
        bBag: printableBag(bagOf(bookLines.map((l) => ({
          code: translate(l.itemKey), rawCode: l.itemKey, qty: l.qty ?? 0, sen: l.subTotalSen ?? 0,
        })), "book")),
        eBag: printableBag(bagOf(erp.lines.map((l) => ({
          code: l.item_code, qty: l.qty ?? 0, sen: 0,
          suffixed: l.line_suffix != null, desc2: l.description2,
        })), "erp")),
      });
    }
  }
  log(`GR item code — ${codeDefects.length} line(s) where the ERP row and the book line carry the SAME AutoCount key and DIFFERENT products. Those are defects; the book decides them.`);
  for (const d of codeDefects) say(`     DEFECT ${d.pair} (ERP ${d.erpNo}) DtlKey ${d.key}: book "${d.book}" vs ours "${d.erp}"  [grn_items.id ${d.id}, po_item ${d.poi ?? "none"}]`);
  const c = (v) => codeGuessed.filter((g) => g.verdict === v).length;
  log(`GR unkeyed rows — ${codeGuessed.length} pair(s) still carry at least one ERP row with NO AutoCount key. Compared as MULTISETS (sofa builds folded by the book's own build text): ${c("IDENTICAL")} PROVEN identical, ${c("DIFFERS")} carry a real difference, ${c("AMBIGUOUS")} genuinely undecidable.`);
  for (const g of codeGuessed.filter((x) => x.verdict !== "IDENTICAL")) {
    say(`     ${g.verdict} ${g.pair} (ERP ${g.erpNo}) — ${g.unkeyed} of ${g.of} rows unkeyed: ${g.notes.join(" ; ")}`);
    say(`        book: ${g.bBag}`);
    say(`        ours: ${g.eBag}`);
  }

  /* ── 2. MONEY: name the cause per document ──────────────────────────────── */
  say("");
  say("── 2. GR MONEY — every pair whose header total is not the book's, with its cause");
  /* The purchase order's own book lines, so a receipt's missing money can be
     told apart from a PO line the book never priced and from AutoCount's LINE
     DISCOUNT (unit price x qty is not the line amount when a discount is set). */
  const poDisc = new Map(); // poDocNo -> {gross, net}
  for (const [docNo, ls] of book.PO.lines) {
    let gross = 0, net = 0;
    for (const l of ls) { gross += Math.round((l.qty ?? 0) * (l.unitPriceSen ?? 0)); net += l.subTotalSen ?? 0; }
    poDisc.set(docNo, { gross, net });
  }
  const money = [];
  for (const [pair, erp] of byPair) {
    const bookLines = view.lines.get(pair) || [];
    if (!bookLines.length) continue;
    const bookTotal = Number(view.headers.get(pair)?.totalSen ?? 0);
    const erpTotal = Number(erp.total_sen || 0);
    if (bookTotal === erpTotal) continue;
    const sofa = erp.lines.some((l) => l.line_suffix) || bookLines.some((l) => /SOFA/i.test(String(l.itemKey ?? "")));
    const priced = erp.lines.filter((l) => Number(l.unit_price_sen || 0) > 0).length;
    const lineSum = erp.lines.reduce((a, l) => a + Number(l.line_total_sen || 0), 0);
    const po = pair.split("|")[1];
    const d = poDisc.get(po);
    money.push({ pair, erpNo: erp.erp_no, bookTotal, erpTotal, priced, lines: erp.lines.length, sofa, lineSum,
      poGross: d?.gross ?? null, poNet: d?.net ?? null, migrated: erp.migrated_no_stock });
  }
  const zero = money.filter((m) => m.erpTotal === 0);
  const nonZero = money.filter((m) => m.erpTotal !== 0);
  log(`GR money — ${money.length} pair(s) differ from the book: ${zero.length} carry RM 0.00 (the owner's ruling 「GR 0 没关系」) and ${nonZero.length} carry a NON-ZERO figure that is not the book's.`);
  say("   the NON-ZERO ones, with the cause the numbers force:");
  for (const m of nonZero.sort((a, b) => (a.pair > b.pair ? 1 : -1))) {
    const ratio = m.bookTotal ? (m.erpTotal / m.bookTotal) : 0;
    const disc = m.poGross && m.poNet && m.poGross !== m.poNet ? `PO book gross ${rm(m.poGross)} vs net ${rm(m.poNet)} (a LINE DISCOUNT of ${rm(m.poGross - m.poNet)})` : "PO book states no line discount";
    say(`     ${m.pair} (ERP ${m.erpNo}): book ${rm(m.bookTotal)} vs ours ${rm(m.erpTotal)}  ratio ours/book ${ratio.toFixed(4)}`);
    say(`        ${m.priced} of ${m.lines} ERP lines priced; sum of our line totals ${rm(m.lineSum)}; sofa on this pair: ${m.sofa ? "YES" : "no"}; migrated_no_stock=${m.migrated}`);
    say(`        ${disc}`);
  }
  say(`   the RM 0.00 ones: ${zero.length} (named by the reconcile; every one is migrated paperwork and is the owner's accepted class)`);

  /* ── 3. PURCHASE INVOICE PI-007875 and every PI/IV row we hold that the book
        does not. A line DELETION is never done by a script here: the repo rule
        is never delete, only cancel. This NAMES them. */
  say("");
  say("── 3. INVOICE ROWS WE HOLD THAT THE BOOK DOES NOT (a deletion decision, never a script's)");
  for (const [t, tbl, hdr, num] of [
    ["PI", "scm.purchase_invoice_items", "scm.purchase_invoices", "invoice_number"],
    ["IV", "scm.sales_invoice_items", "scm.sales_invoices", "invoice_number"],
  ]) {
    const rows = await sql.unsafe(
      `SELECT h.linked_ac_docno AS ac_no, h.${num} AS erp_no, i.id::text AS id, i.item_code,
              i.qty::float8 AS qty, COALESCE(i.unit_price_sen,0)::bigint AS unit_price_sen, i.line_suffix
         FROM ${tbl} i JOIN ${hdr} h ON h.id = i.${t === "PI" ? "purchase_invoice_id" : "sales_invoice_id"}
        WHERE h.company_id = $1 AND h.linked_ac_docno IS NOT NULL`, [CO]);
    const byDoc = new Map();
    for (const r of rows) { if (!byDoc.has(r.ac_no)) byDoc.set(r.ac_no, []); byDoc.get(r.ac_no).push(r); }
    let extras = 0;
    for (const [ac, ours] of byDoc) {
      const bl = book[t].lines.get(ac) || [];
      if (!bl.length) continue;
      /* Both sides folded the same way as the bag above: a sofa's compartments
         are ONE book line, so an unfolded subtraction reports every compartment
         beyond the first as a row the book does not have. */
      const have = new Map();
      for (const l of bl) {
        const c = canon({ code: translate(l.itemKey), rawCode: l.itemKey, side: "book" });
        have.set(c, (have.get(c) ?? 0) + (l.qty ?? 0));
      }
      for (const r of ours) {
        const c = canon({ code: r.item_code, side: "erp", suffixed: r.line_suffix != null });
        const left = have.get(c) ?? 0;
        if (left >= (r.qty ?? 0)) { have.set(c, left - (r.qty ?? 0)); continue; }
        /* A sofa's ERP rows outnumber the book's line by construction, so a
           shortfall on a folded sofa key says nothing. Only a PLAIN code the
           book does not carry at all is a finding here. */
        if (c.startsWith("SOFA ")) continue;
        extras++;
        say(`     ${t} ${ac} (ERP ${r.erp_no}): we hold "${normCode(r.item_code)}" qty ${r.qty} at ${rm(r.unit_price_sen)} — the book has ${left} of it  [id ${r.id}]`);
      }
    }
    log(`${t} — ${extras} ERP row(s) the book does not account for.`);
  }

  /* ── 4. CONTROL. Goods receipts are the stock side; a repair here must move
        NOTHING. The shape, not a row count: a count cannot see a trigger. */
  say("");
  say("── 4. CONTROL — stock behind migrated paperwork (must read the same after any repair)");
  const [ctl] = await sql`SELECT
      (SELECT count(*)::int FROM scm.grns g WHERE g.company_id = ${CO} AND g.linked_ac_gr_docno IS NOT NULL) AS migrated_grns,
      (SELECT count(*)::int FROM scm.grns g WHERE g.company_id = ${CO} AND g.linked_ac_gr_docno IS NOT NULL AND COALESCE(g.migrated_no_stock,false) = false) AS migrated_grns_not_flagged,
      (SELECT count(*)::int FROM scm.inventory_movements m
         WHERE m.company_id = ${CO} AND m.source_doc_no IN (
           SELECT g.grn_number FROM scm.grns g WHERE g.company_id = ${CO} AND g.linked_ac_gr_docno IS NOT NULL)) AS movements_behind_migrated_grns,
      (SELECT count(*)::int FROM scm.inventory_movements m
         WHERE m.company_id = ${CO} AND m.source_doc_no IN (
           SELECT i.invoice_number FROM scm.purchase_invoices i WHERE i.company_id = ${CO} AND i.linked_ac_docno IS NOT NULL
           UNION ALL
           SELECT s.invoice_number FROM scm.sales_invoices s WHERE s.company_id = ${CO} AND s.linked_ac_docno IS NOT NULL)) AS movements_behind_migrated_invoices,
      (SELECT COALESCE(sum(gi.qty_accepted),0)::float8 FROM scm.grn_items gi
         JOIN scm.grns g ON g.id = gi.grn_id
        WHERE g.company_id = ${CO} AND g.linked_ac_gr_docno IS NOT NULL) AS migrated_gr_units,
      (SELECT COALESCE(sum(COALESCE(gi.line_total_sen,0)),0)::bigint FROM scm.grn_items gi
         JOIN scm.grns g ON g.id = gi.grn_id
        WHERE g.company_id = ${CO} AND g.linked_ac_gr_docno IS NOT NULL) AS migrated_gr_line_money,
      (SELECT count(*)::int FROM scm.sales_invoices s WHERE s.company_id = ${CO} AND s.linked_ac_docno IS NOT NULL) AS migrated_sales_invoices,
      (SELECT count(*)::int FROM scm.purchase_invoices p WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL) AS migrated_purchase_invoices`;
  for (const [k, v] of Object.entries(ctl)) say(`   ${k} = ${v}`);
  log(`CONTROL — ${ctl.movements_behind_migrated_grns} inventory movement(s) behind migrated goods receipts and ` +
    `${ctl.movements_behind_migrated_invoices} behind migrated invoices. Both MUST still read 0 after any repair.`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(`REFUSED: ${e?.message || e}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
});
