#!/usr/bin/env node
/* probe-gr-pi-iv-residue — WHAT ARE THE 74 GR / PI / IV DISAGREEMENTS, REALLY?
 *
 * READ-ONLY. This script issues SELECTs and nothing else. It is a measurement,
 * not a repair, and it exists because every remedy proposed for these 74 rows
 * rests on a claim about production that reading source code cannot settle.
 *
 * RE-RUN: read-only. It writes nothing, so a re-run is always safe and always
 * reproducible against the same committed cut.
 *
 * ── THE FOUR QUESTIONS ──────────────────────────────────────────────────────
 *
 * 1. GR item code (36 on run 34184553347). Every sample the reconcile printed
 *    is a TRANSPOSED PAIR inside one document — book DtlKey 917594 is
 *    `AK-IMMORTAL MATT (K)` and we answer `AKEMI ULTIMATE MATT (K)`, while
 *    917604 is `AK-ULTIMATE MATT (K)` and we answer `AKEMI IMMORTAL MATT (K)`.
 *    The two codes are each other's.
 *
 *    That shape is what a PAIRING artefact looks like, because
 *    `scm.grn_items` carries NO AutoCount line key — the reconcile hardcodes
 *    `NULL::bigint AS ac_dtlkey` for GR (check-ac-erp-reconcile.mjs:423) and
 *    falls back to zipping on (qty, unit price), then qty, then document
 *    order. Two mattresses of qty 1 land in one bucket and whichever the ERP
 *    returns first takes the first book line.
 *
 *    BUT A TRANSPOSITION IS ALSO WHAT A GENUINELY WRONG PRODUCT LOOKS LIKE
 *    FROM ONE SIDE, and on the sales/purchase side 61 of 111 such differences
 *    were the wrong product. So the question is asked as a SET question, which
 *    no ordering can affect: does this document's book-side item-code multiset
 *    EQUAL its ERP-side multiset? If it does, both sides name the same
 *    products in the same quantities and only the line-to-line correspondence
 *    is unknown. If it does not, a product is genuinely wrong and it is named.
 *
 * 2. GR money (9). The samples are tiny ERP totals against real book ones —
 *    RM 120.00 against RM 3,200.00. `grn_items.unit_price_sen` comes from the
 *    PURCHASE ORDER line by design, and Houzs does not price a factory
 *    purchase order in AutoCount (10,810 of 18,890 book PO lines carry no unit
 *    price), so a receipt totals only the lines whose order happened to carry
 *    money. This reports, per document, how many lines are priced and what the
 *    book states, so "partially priced" can be told apart from "wrong price".
 *
 * 3. PI line count (12) and IV line count (9). A migrated invoice draws its
 *    lines from OUR goods receipt / delivery order, which is a PARTIAL mirror
 *    of AutoCount's (src/scm/lib/migrated-chain.ts, rule 3's NOTE), and it is
 *    written only when its TOTAL equals AutoCount's to the sen (rule 4). If
 *    that gate held, every one of these 21 documents agrees on money and
 *    differs only in line shape. The gate is re-asserted here from the
 *    database rather than trusted from the module comment.
 *
 * 4. IV absent (6). Named, with the source sales order / delivery order the
 *    owner's population rule points at — 「没有的 SO DO 何来发票？有的 SO DO
 *    自然要发票」 — so each absence can be attributed rather than counted.
 *
 * The book side is the committed cut `data/ac-reconcile-truth.json.gz`, the
 * same one the reconcile grades against, so this probe and that run cannot
 * disagree about what AutoCount says. AutoCount's SQL book is NOT queried.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { buildScope, decodeSnapshot } from "./lib/ac-scope.mjs";
import { grPairGrain } from "./lib/ac-gr-pair-grain.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const say = (m) => console.log(m);
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/* AutoCount writes a whole sofa as "DSL-8030 SOFA"; the ERP writes one row per
   compartment, suffixed -1A(LHF) / -2A(RHF) / -L(LHF) / -CNR / -1NA / -1S /
   -STOOL / -CONSOLE. Either side saying so means the document was decomposed. */
const SOFA_CODE = /SOFA/i;
const COMPARTMENT = /-(?:\d*[AB]\s*\((?:LHF|RHF|R\)\(RHF)\)|L\((?:LHF|RHF)\)|CNR|\d*NA|STOOL|CONSOLE|\d*S)$/i;

const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, "ac-reconcile-truth.json.gz"))).toString("utf8"));
const book = decodeSnapshot(snap);
const SCOPE = buildScope(book);
const mapping = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));

/* THE SAME TRANSLATION THE WRITER USED — and DELIBERATELY NO SOFA MODEL FOLD.
   `SOFA_MODEL_ALIAS` maps 5537 -> 8030, which the owner has NOT confirmed
   (2026-09-07 he confirmed 8030 = 5540 and ruled 5535 is its own model). Folding
   here would make two codes he may consider different products compare EQUAL,
   which is the one direction this probe must never fail in: it would hide a
   wrong product rather than surface one. Sofa-decomposed documents are excluded
   from the multiset test outright a few lines below, so nothing needs the fold. */
const translate = (acCode) => {
  const hit = mapping.get(normCode(acCode));
  return normCode(hit ? hit.erp : acCode);
};
/** multiset of codes -> a canonical, order-independent string */
const bag = (codes) => {
  const m = new Map();
  for (const c of codes) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).map(([c, n]) => `${c} x${n}`).join(" | ");
};

async function main() {
  say(`AutoCount cut exported_at=${snap.exported_at}  company=${CO}  READ-ONLY`);
  say("");

  /* ── 1 + 2. GOODS RECEIPTS, at (receipt x purchase order) pair grain ────── */
  const { view } = grPairGrain(book, SCOPE);
  const erpGrnDocs = await sql`SELECT g.grn_number AS erp_no,
      g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
      COALESCE(g.total_sen, 0)::bigint AS total_sen,
      COALESCE(g.migrated_no_stock, false) AS migrated_no_stock
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
      AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`;
  const erpGrnLines = await sql`SELECT g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
      i.item_code, i.qty_accepted::float8 AS qty, i.unit_price_sen::bigint AS unit_price_sen,
      i.line_total_sen::bigint AS line_total_sen, i.line_suffix, i.linked_ac_dtlkey::text AS ac_dtlkey,
      i.purchase_order_item_id::text AS poi_id
    FROM scm.grn_items i
    JOIN scm.grns g ON g.id = i.grn_id
    JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
      AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`;

  const erpByPair = new Map();
  for (const d of erpGrnDocs) erpByPair.set(d.ac_no, { ...d, lines: [] });
  for (const l of erpGrnLines) erpByPair.get(l.ac_no)?.lines.push(l);

  /* HOW MANY ERP RECEIPT LINES CARRY AN AUTOCOUNT LINE KEY AT ALL. Migration
     0280 added the column and says plainly that nothing backfills it; this
     states what production actually holds rather than repeating the comment. */
  const keyed = erpGrnLines.filter((l) => l.ac_dtlkey != null).length;
  log(`GR — ${erpByPair.size} (receipt x purchase order) pairs in the ERP, ${erpGrnLines.length} lines; ` +
    `${keyed} of those lines carry linked_ac_dtlkey (the key the reconcile pairs on)`);

  let sameBag = 0, diffBag = 0, sofaPairs = 0;
  const bagDiffers = [];
  const moneyRows = [];
  for (const [pair, erp] of erpByPair) {
    const bookLines = view.lines.get(pair) || [];
    if (!bookLines.length) continue;
    /* A sofa is ONE book line and one ERP row per compartment, so the two
       multisets are not commensurable and the comparison is not attempted —
       counted apart, never folded into either verdict.
       DETECTED THREE WAYS, as check-ac-erp-reconcile.mjs:1109 does, because no
       single one holds across the import rounds. The first run of this probe
       tested `line_suffix` ALONE and reported 0 sofa pairs and 61 genuine
       product differences; `scm.grn_items.line_suffix` is NULL on every
       migrated receipt, so the test could not fire and 40-odd decompositions
       (book `9028-1S` against our `9028-1A(RHF)` + `9028-2A(LHF)`) were
       printed as wrong products. A weak exclusion INVENTS findings exactly the
       way a weak matcher misses them. */
    const isSofa = erp.lines.some((l) => l.line_suffix)
      || bookLines.some((l) => SOFA_CODE.test(String(l.itemKey ?? "")))
      || erp.lines.some((l) => COMPARTMENT.test(String(l.item_code ?? "")));
    if (isSofa) { sofaPairs++; continue; }

    const bBag = bag(bookLines.map((l) => translate(l.itemKey)));
    const eBag = bag(erp.lines.map((l) => normCode(l.item_code)));
    if (bBag === eBag) sameBag++;
    else { diffBag++; bagDiffers.push({ pair, erpNo: erp.erp_no, bBag, eBag }); }

    const bookTotal = Number(view.headers.get(pair)?.totalSen ?? 0);
    const erpTotal = Number(erp.total_sen || 0);
    if (bookTotal !== erpTotal) {
      const priced = erp.lines.filter((l) => Number(l.unit_price_sen || 0) > 0).length;
      moneyRows.push({
        pair, erpNo: erp.erp_no, bookTotal, erpTotal, priced, lines: erp.lines.length,
        migrated: erp.migrated_no_stock,
      });
    }
  }
  log(`GR ITEM CODE AS A SET — ${sameBag} pairs where the book's item codes and ours are the SAME MULTISET ` +
    `(same products, same counts, correspondence unknown); ${diffBag} where they genuinely DIFFER; ` +
    `${sofaPairs} sofa-decomposed pairs not comparable as sets`);
  if (bagDiffers.length) {
    say("   THE MULTISET GENUINELY DIFFERS — a product is wrong on these, and each is real work:");
    for (const d of bagDiffers.slice(0, 40)) {
      say(`     ${d.pair} (ERP ${d.erpNo})`);
      say(`        book: ${d.bBag}`);
      say(`        ours: ${d.eBag}`);
    }
    if (bagDiffers.length > 40) say(`     ... and ${bagDiffers.length - 40} more`);
  } else {
    say("   NONE differ as a set. Every GR item-code difference the reconcile counts is a LINE-TO-LINE");
    say("   correspondence the checker had to guess, not a product we got wrong.");
  }
  say("");

  const zeroMoney = moneyRows.filter((r) => r.erpTotal === 0);
  const partMoney = moneyRows.filter((r) => r.erpTotal !== 0);
  log(`GR MONEY — ${moneyRows.length} pairs whose total differs from the book: ` +
    `${zeroMoney.length} carry RM 0.00 (the owner's 「GR 0 没关系」) and ` +
    `${partMoney.length} carry a NON-ZERO figure that is not the book's`);
  say("   the non-zero ones, with how many of their lines carry a price at all:");
  for (const r of partMoney.sort((a, b) => b.bookTotal - a.bookTotal)) {
    say(`     ${r.pair} (ERP ${r.erpNo}): book ${rm(r.bookTotal)} vs ours ${rm(r.erpTotal)} — ` +
      `${r.priced} of ${r.lines} lines priced; migrated_no_stock=${r.migrated}`);
  }
  say("");

  /* ── 3. INVOICE LINE COUNTS ─────────────────────────────────────────────── */
  for (const [t, docsQ, linesQ] of [
    ["IV", () => sql`SELECT invoice_number AS erp_no, linked_ac_docno AS ac_no,
         COALESCE(total_sen, local_total_sen)::bigint AS total_sen
       FROM scm.sales_invoices WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`,
      () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
         i.unit_price_sen::bigint AS unit_price_sen, i.line_suffix, i.linked_ac_dtlkey::text AS ac_dtlkey
       FROM scm.sales_invoice_items i JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
       WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`],
    ["PI", () => sql`SELECT invoice_number AS erp_no, linked_ac_docno AS ac_no, total_sen::bigint AS total_sen
       FROM scm.purchase_invoices WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`,
      () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
         i.unit_price_sen::bigint AS unit_price_sen, i.line_suffix, i.linked_ac_dtlkey::text AS ac_dtlkey
       FROM scm.purchase_invoice_items i JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
       WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`],
  ]) {
    const docs = await docsQ();
    const lines = await linesQ();
    const byAc = new Map();
    for (const d of docs) byAc.set(d.ac_no, { ...d, lines: [] });
    for (const l of lines) byAc.get(l.ac_no)?.lines.push(l);
    const keyedN = lines.filter((l) => l.ac_dtlkey != null).length;
    log(`${t} — ${byAc.size} ERP documents mirroring an AutoCount one, ${lines.length} lines; ` +
      `${keyedN} carry linked_ac_dtlkey`);

    const shape = [];
    for (const [ac, erp] of byAc) {
      const bl = book[t]?.lines.get(ac) || [];
      const bh = book[t]?.headers.get(ac);
      if (!bl.length || !bh) continue;
      if (bl.length === erp.lines.length) continue;
      const bookTotal = Number(bh.docTotalSen ?? bh.totalSen ?? 0);
      shape.push({
        ac, erpNo: erp.erp_no, bookN: bl.length, erpN: erp.lines.length,
        bookTotal, erpTotal: Number(erp.total_sen || 0),
        bBag: bag(bl.map((l) => translate(l.itemKey))),
        eBag: bag(erp.lines.map((l) => normCode(l.item_code))),
        sofa: erp.lines.some((l) => l.line_suffix),
      });
    }
    const moneyAgrees = shape.filter((s) => s.bookTotal === s.erpTotal).length;
    log(`${t} LINE SHAPE — ${shape.length} documents whose line COUNT differs from the book; ` +
      `on ${moneyAgrees} of them the document TOTAL is identical to the sen, and on ` +
      `${shape.length - moneyAgrees} it is not`);
    for (const s of shape) {
      const verdict = s.bookTotal === s.erpTotal ? "money IDENTICAL" : `money DIFFERS (book ${rm(s.bookTotal)} vs ours ${rm(s.erpTotal)})`;
      say(`     ${s.ac} (ERP ${s.erpNo}): book ${s.bookN} lines vs ours ${s.erpN} — ${verdict}${s.sofa ? "; sofa-decomposed" : ""}`);
      if (s.bBag !== s.eBag) {
        say(`        book items: ${s.bBag}`);
        say(`        our  items: ${s.eBag}`);
      } else say("        the item multiset is IDENTICAL — the same products, expressed on a different number of lines");
    }
    say("");
  }

  /* ── 4. THE ABSENT SALES INVOICES ───────────────────────────────────────── */
  const ivErp = new Set((await sql`SELECT linked_ac_docno FROM scm.sales_invoices
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`).map((r) => r.linked_ac_docno));
  const absent = [...(SCOPE.IV || [])].filter((ac) => !ivErp.has(ac)).sort();
  log(`IV ABSENT — ${absent.length} in-scope AutoCount sales invoices with no ERP document`);
  for (const ac of absent) {
    const bh = book.IV.headers.get(ac);
    const bl = book.IV.lines.get(ac) || [];
    /* WHERE DID IT COME FROM. The owner's population rule keys an invoice to
       its source: 「没有的 SO DO 何来发票？有的 SO DO 自然要发票」. IVDTL names
       the delivery order (or the sales order for a direct invoice), so the
       source is read off the lines rather than guessed. */
    const srcs = [...new Set(bl.map((l) => `${l.fromDocType || "-"}:${l.fromDocNo || "-"}`))];
    const dos = [...new Set(bl.filter((l) => l.fromDocType === "DO").map((l) => l.fromDocNo))];
    const sos = [...new Set(bl.filter((l) => l.fromDocType === "SO").map((l) => l.fromDocNo))];
    const doHeld = dos.length
      ? (await sql`SELECT do_number FROM scm.delivery_orders
          WHERE company_id = ${CO} AND linked_ac_docno = ANY(${dos})`).map((r) => r.do_number)
      : [];
    const soHeld = sos.length
      ? (await sql`SELECT doc_no FROM scm.mfg_sales_orders
          WHERE company_id = ${CO} AND linked_ac_docno = ANY(${sos})`).map((r) => r.doc_no)
      : [];
    say(`     ${ac}  ${rm(Number(bh?.docTotalSen ?? bh?.totalSen ?? 0))}  ${bl.length} lines`);
    say(`        book sources: ${srcs.join(", ") || "(none named)"}`);
    say(`        of those we hold: ${dos.length} DO -> ${doHeld.length} in the ERP (${doHeld.join(", ") || "none"}); ` +
      `${sos.length} SO -> ${soHeld.length} in the ERP (${soHeld.join(", ") || "none"})`);
  }

  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch { /* already closed */ } process.exit(1); });
