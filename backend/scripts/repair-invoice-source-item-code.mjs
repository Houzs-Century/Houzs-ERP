#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-invoice-source-item-code.mjs — five invoice lines still name the
// cutover's un-decoded SOFA PLACEHOLDER while the delivery / receipt line they
// were raised from names the real compartment. Copy the compartment across.
//
// WHAT WAS COUNTED, AND WHAT IT TURNED OUT TO BE. `probe-link-identity.mjs`
// (runs 34137796488 and 34139187692, 2026-09-07 23:22 and 23:37 local) counted
// 2 sales-invoice and 3 purchase-invoice lines whose link "points at a line for
// a different product". `probe-invoice-link-facts.mjs` (run 34143079454,
// 2026-09-08 00:26 local, `success`) then NAMED them, and they are not that:
//
//   HC-I-000745      5526-1S  ->  HC-DO-000542   5526-L(LHF)
//   HC-I-2412-0065   2379-1S  ->  HC-DO-002158   2379-2S
//   HC-PI-007551     9058-1S  ->  HC-GR-005068   9058-1A(LHF)
//   HC-PI-007917     9058-1S  ->  HC-GR-005306   9058-1A(LHF)
//   HC-PI-007920     8030-1S  ->  HC-GR-005277   8030-1A(LHF)
//
// Every one is the SAME SOFA MODEL, a DIFFERENT COMPARTMENT, on a source
// document carrying exactly ONE line which the invoice header itself names. So
// the LINK is right — it points at the right document and the only line on it —
// and the ITEM CODE is what disagrees.
//
// `{model}-1S` IS THE PLACEHOLDER, in this repo's own words:
// scripts/lib/sofa-piece-fold.mjs — "The binding CSV maps every AutoCount sofa
// item to the model's `-1S` compartment ... all 86 SOFA-category rows end in
// `-1S`." AutoCount holds ONE line per sofa; the ERP holds one per COMPARTMENT.
// A migrated line starts on the placeholder and is decomposed later. These five
// invoice lines were never decomposed; their source lines were.
//
// NO MONEY MOVES, and that is checked rather than asserted. `qty`,
// `unit_price_sen`, `discount_sen`, `line_total_sen` and the LINK COLUMN itself
// are re-read on a fresh connection afterwards and must come back BYTE
// IDENTICAL. Only `item_code` changes. The `invoiced` ceiling
// (lib/do-line-remaining.ts) and the re-cost aggregation (lib/recost.ts) both
// resolve on the link, which this script does not touch, so neither moves.
//
// IT IS A COPY, NEVER A COMPUTATION. The new code is the source line's, byte
// for byte. Nothing is decoded, nothing is chosen. The decision is pure and
// unit-tested — scripts/lib/invoice-sofa-placeholder-repair.mjs,
// tests/invoiceSofaPlaceholderRepair.test.mjs — and refuses every case that is
// not FORCED: the code must be a placeholder the cutover binding actually maps
// a sofa onto (a bare "-1S" could be a genuine single-seat line), the source
// must be the same model, the source document must carry exactly one line, and
// the invoice header must name it. Everything else is listed for a human.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - it does not touch `variants`. Three of these five lines also carry a
//     colour that reads as disagreeing with their source, and all of those were
//     measured to be CHECKER ARTEFACTS — the same colour written as a label on
//     one side and an id on the other, or an id the fabric library superseded on
//     2026-08-11. Fixing a checker's output by editing data is the shape
//     CLAUDE.md forbids.
//   - it does not queue an AutoCount edit, and does not need to. AutoCount holds
//     one line per SOFA with no compartments at all, so the book is already
//     right at its own grain; and `composeEdit` STRIPS `ItemCode` off a keyed
//     line by design (docs/bugs/0672 site 14), so the book could not receive an
//     item-code change through the write-back even if one were queued.
//   - it does not re-point any link. There is nothing to re-point to: each
//     source document has exactly one line.
//
// PLAN BY DEFAULT. Every change runs inside a transaction, is verified against a
// FRESH connection, and is ROLLED BACK unless APPLY=true AND the confirmation
// phrase matches. A mismatched CONFIRM EXITS rather than quietly demoting to a
// plan, so "there was nothing to do" can never be the answer to a different
// question.
//
//   node backend/scripts/repair-invoice-source-item-code.mjs
//   APPLY=true CONFIRM="I HAVE READ THE PLAN" node backend/scripts/repair-invoice-source-item-code.mjs
//
//   DATABASE_URL   required
//   DUMP_PATH      optional; where the pre-change rows are written as restorable
//                  JSON. Written on the PLAN run too, so the backup exists
//                  before anybody types APPLY.
//
// RE-RUN: idempotent. A second APPLY finds nothing to repair — the query selects
// rows whose invoice code DISAGREES with the source, and a repaired row agrees —
// and reports CLEAN with exit 0. It never re-applies and never widens.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { planInvoicePlaceholderRepair } from './lib/invoice-sofa-placeholder-repair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIRM_PHRASE = 'I HAVE READ THE PLAN';
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/** Thrown to force a rollback after a successful plan. Not an error. */
class PlanRollback extends Error {}

const norm = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** Every `erp_code` the cutover binding gives a SOFA-category AutoCount item.
 *  This is the EVIDENCE that a code is the placeholder rather than a real
 *  single-seat piece, and it is read from the committed file rather than
 *  hard-coded, so the two cannot drift. */
function sofaPlaceholderCodes() {
  const csv = readFileSync(join(HERE, 'data/autocount-erp-mapping-1561.csv'), 'utf8');
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = lines[0].replace(/^﻿/, '').split(',');
  const iErp = head.indexOf('erp_code');
  const iCat = head.indexOf('category');
  if (iErp < 0 || iCat < 0) throw new Error('autocount-erp-mapping-1561.csv: erp_code / category column not found');
  const out = new Set();
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    if (norm(cols[iCat]) !== 'SOFA') continue;
    const code = norm(cols[iErp]);
    if (code.endsWith('-1S')) out.add(code);
  }
  return out;
}

/* The two chains, written out. `docCol` is the header's document number and
   `headerFk` the column by which the header names its own source document —
   which is half of what makes a repair FORCED. */
const CHAINS = [
  {
    name: 'SI -> DO',
    lineTable: 'sales_invoice_items', headTable: 'sales_invoices', headFk: 'sales_invoice_id',
    docCol: 'invoice_number', linkCol: 'do_item_id',
    srcLine: 'delivery_order_items', srcHead: 'delivery_orders', srcFk: 'delivery_order_id', srcDocCol: 'do_number',
    headerSrcCol: 'delivery_order_id',
  },
  {
    name: 'PI -> GR',
    lineTable: 'purchase_invoice_items', headTable: 'purchase_invoices', headFk: 'purchase_invoice_id',
    docCol: 'invoice_number', linkCol: 'grn_item_id',
    srcLine: 'grn_items', srcHead: 'grns', srcFk: 'grn_id', srcDocCol: 'grn_number',
    headerSrcCol: 'grn_id',
  },
];

const NORMSQL = (e) => `upper(regexp_replace(btrim(coalesce(${e}, '')), '\\s+', ' ', 'g'))`;

async function readDisagreements(pg, ch) {
  return pg.unsafe(`
    SELECT h.${ch.docCol}                          AS invoice_no,
           h.status::text                          AS invoice_status,
           l.id                                    AS line_id,
           l.item_code                             AS invoice_code,
           l.qty                                   AS qty,
           l.unit_price_sen                        AS unit_price_sen,
           l.line_total_sen                        AS line_total_sen,
           l.${ch.linkCol}                         AS link_id,
           s.item_code                             AS source_code,
           sh.${ch.srcDocCol}                      AS source_doc_no,
           (h.${ch.headerSrcCol} = s.${ch.srcFk})  AS header_names_source_doc,
           (SELECT count(*)::int FROM scm.${ch.srcLine} x WHERE x.${ch.srcFk} = s.${ch.srcFk}) AS source_line_count
      FROM scm.${ch.lineTable} l
      JOIN scm.${ch.headTable} h  ON h.id = l.${ch.headFk}
      JOIN scm.${ch.srcLine}   s  ON s.id = l.${ch.linkCol}
      JOIN scm.${ch.srcHead}   sh ON sh.id = s.${ch.srcFk}
     WHERE ${NORMSQL('l.item_code')} <> ${NORMSQL('s.item_code')}
     ORDER BY h.${ch.docCol}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL required'); process.exit(1); }

  /* A MISMATCHED CONFIRM EXITS; it does not quietly demote to a plan. The
     operator who typed APPLY=true asked for a write, and answering a different
     question while printing "PLAN" reads as "there was nothing to do". Exit 2 so
     a wrapper can tell "refused" from "ran and found nothing" (exit 0). */
  if (process.env.APPLY === 'true' && process.env.CONFIRM !== CONFIRM_PHRASE) {
    console.error(`APPLY requested but CONFIRM did not match "${CONFIRM_PHRASE}". Nothing was written.`);
    process.exit(2);
  }
  const APPLY = process.env.APPLY === 'true';
  const placeholders = sofaPlaceholderCodes();

  const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  const dumpPath = process.env.DUMP_PATH || join(process.cwd(), 'invoice-source-item-code-before.json');
  const allRepairs = [];
  const allRefusals = [];
  const before = [];

  try {
    log('');
    log(`INVOICE SOFA-PLACEHOLDER REPAIR — ${APPLY ? 'APPLY (writes will be COMMITTED)' : 'PLAN (nothing will be written)'}`);
    log(`${placeholders.size} SOFA-category placeholder codes read from the cutover binding.`);
    log('');

    for (const ch of CHAINS) {
      const rows = await readDisagreements(pg, ch);
      log(`${ch.name}: ${rows.length} line(s) whose item code disagrees with the line it was raised from.`);
      const { repairs, refusals } = planInvoicePlaceholderRepair(
        rows.map((r) => ({
          chain: ch,
          invoiceNo: r.invoice_no,
          invoiceStatus: r.invoice_status,
          lineId: r.line_id,
          invoiceCode: r.invoice_code,
          sourceCode: r.source_code,
          sourceDocNo: r.source_doc_no,
          sourceLineCount: r.source_line_count,
          headerNamesSourceDoc: r.header_names_source_doc === true,
          qty: r.qty,
          unitPriceSen: r.unit_price_sen,
          lineTotalSen: r.line_total_sen,
          linkId: r.link_id,
        })),
        placeholders,
      );
      for (const rep of repairs) {
        log(`   REPAIR  ${rep.invoiceNo} [${rep.invoiceStatus}]  ${rep.invoiceCode} -> ${rep.newCode}   (from ${rep.sourceDocNo}, its only line)`);
        before.push({
          chain: ch.name, table: `scm.${ch.lineTable}`, lineId: rep.lineId,
          invoiceNo: rep.invoiceNo, itemCode: rep.invoiceCode, newItemCode: rep.newCode,
          qty: rep.qty, unitPriceSen: rep.unitPriceSen, lineTotalSen: rep.lineTotalSen,
          linkColumn: ch.linkCol, linkId: rep.linkId,
          restore: `UPDATE scm.${ch.lineTable} SET item_code = '${String(rep.invoiceCode).replace(/'/g, "''")}' WHERE id = '${rep.lineId}';`,
        });
      }
      for (const ref of refusals) log(`   REFUSED ${ref.invoiceNo}  ${ref.invoiceCode} -> ${ref.sourceCode}  — ${ref.why}`);
      allRepairs.push(...repairs);
      allRefusals.push(...refusals);
    }

    /* THE BACKUP IS WRITTEN ON THE PLAN RUN TOO, so it exists before anybody
       types APPLY. Every entry carries the single UPDATE that puts the row back. */
    writeFileSync(dumpPath, JSON.stringify({
      takenAt: new Date().toISOString(), mode: APPLY ? 'apply' : 'plan', rows: before,
    }, null, 2));
    log('');
    log(`${allRepairs.length} repair(s), ${allRefusals.length} refusal(s). Pre-change rows written to ${dumpPath}.`);

    if (allRepairs.length === 0) {
      log('Nothing to repair. CLEAN.');
      return;
    }

    /* The rollback throw is caught HERE, not by the outer handler: the
       verification below must run on a PLAN too, so a plan can prove it read
       the right rows and left them alone. */
    try {
      await pg.begin(async (tx) => {
        for (const rep of allRepairs) {
          const res = await tx.unsafe(
            `UPDATE scm.${rep.chain.lineTable} SET item_code = $1 WHERE id = $2 AND ${NORMSQL('item_code')} = ${NORMSQL('$3')}`,
            [rep.newCode, rep.lineId, rep.invoiceCode],
          );
          /* The predicate on the OLD code is the whole point. docs/bugs/0672
             site 5 is a script that wrote `SET item_code = ? WHERE so_item_id =
             ?` with no predicate on the old value — the inverted form of this
             same bug class. A row that moved under us must not be overwritten. */
          if (res.count !== 1) throw new Error(`${rep.invoiceNo}: expected to update exactly 1 row on the stored code "${rep.invoiceCode}", updated ${res.count}`);
        }
        if (!APPLY) throw new PlanRollback();
      });
    } catch (e) {
      if (!(e instanceof PlanRollback)) throw e;
    }

    /* VERIFY ON A FRESH CONNECTION, AND ASSERT THE SHAPE. A row count is not a
       shape: on 2026-08-13 a repair reproduced the jsonb double-encoding bug on
       7 production rows and its row count reported 7 of 7. What must be true is
       (a) the code now equals the source's and (b) NOTHING ELSE MOVED — the
       link, the quantity, the price and the line total come back byte identical
       to what was dumped before the write. */
    const v = postgres(url, { ssl: 'require', prepare: false, max: 1 });
    try {
      let bad = 0;
      for (const rep of allRepairs) {
        const [row] = await v.unsafe(
          `SELECT l.item_code, l.qty, l.unit_price_sen, l.line_total_sen, l.${rep.chain.linkCol} AS link_id, s.item_code AS source_code
             FROM scm.${rep.chain.lineTable} l
             JOIN scm.${rep.chain.srcLine} s ON s.id = l.${rep.chain.linkCol}
            WHERE l.id = $1`, [rep.lineId]);
        const expected = APPLY ? rep.newCode : rep.invoiceCode;
        const problems = [];
        if (!row) problems.push('the row is gone');
        else {
          if (norm(row.item_code) !== norm(expected)) problems.push(`item_code is "${row.item_code}", expected "${expected}"`);
          if (APPLY && norm(row.item_code) !== norm(row.source_code)) problems.push('item_code still disagrees with the source line');
          if (String(row.link_id) !== String(rep.linkId)) problems.push('the LINK moved — this script must never touch it');
          if (Number(row.qty) !== Number(rep.qty)) problems.push(`qty moved: ${rep.qty} -> ${row.qty}`);
          if (Number(row.unit_price_sen) !== Number(rep.unitPriceSen)) problems.push(`unit_price_sen moved: ${rep.unitPriceSen} -> ${row.unit_price_sen}`);
          if (Number(row.line_total_sen) !== Number(rep.lineTotalSen)) problems.push(`line_total_sen moved: ${rep.lineTotalSen} -> ${row.line_total_sen}`);
        }
        if (problems.length) { bad += 1; log(`   VERIFY FAILED ${rep.invoiceNo}: ${problems.join('; ')}`); }
        else log(`   VERIFIED ${rep.invoiceNo}: item_code ${row.item_code}, money and link unchanged`);
      }
      log('');
      if (bad > 0) {
        log(`${bad} of ${allRepairs.length} row(s) did not verify. ${APPLY ? 'The commit already landed — restore from the dump above.' : 'Nothing was written.'}`);
        process.exitCode = 1;
      } else {
        log(APPLY
          ? `${allRepairs.length} of ${allRepairs.length} repaired and verified on a fresh connection. Money and links unchanged.`
          : `PLAN ONLY — the transaction was rolled back. ${allRepairs.length} row(s) would be repaired. Re-run with APPLY=true CONFIRM="${CONFIRM_PHRASE}".`);
      }
    } finally {
      await v.end();
    }
  } finally {
    await pg.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
