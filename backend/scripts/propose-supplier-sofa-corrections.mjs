#!/usr/bin/env node
/* propose-supplier-sofa-corrections - turn the SUPPLIER'S listing into entries
 * the existing corrections applier can write. READ-ONLY. SELECTs only, no
 * writes, no DDL, no transaction. It PRINTS a JSON document; a human commits it.
 *
 * ── WHY IT FEEDS THE EXISTING CHANNEL INSTEAD OF WRITING ITS OWN ───────────
 * The owner, 2026-09-10: 「你确保你是根源改动那个数据就行了」 — change the data
 * at its ROOT. For a sofa build the root is not one document: the sales order,
 * the purchase order raised from it and the delivery paperwork all carry the
 * same compartments, and correcting one of them alone is how they drift apart.
 *
 * `apply-sofa-compartment-corrections.mjs` is already that tool. It corrects the
 * SO and the PO together so the pair cannot drift, pairs rows by code and
 * UPDATEs in place so `purchase_order_items.so_item_id` survives, refuses a
 * build whose downstream actually moved stock, holds the money still, and
 * re-reads on a fresh connection. Writing a second writer beside it would mean
 * a second set of guards to keep in step - the duplicated-rule failure this
 * repo has paid for repeatedly.
 *
 * So this script's whole job is to produce its INPUT, and the answer it puts
 * there is the supplier's, not ours:
 *
 *     supplier的肯定对的 基本上你可以跟
 *
 * ── HOW A BUILD IS IDENTIFIED, AND WHY NOT BY TEXT ─────────────────────────
 * `lineKeys` - the AutoCount DtlKey the ERP rows carry - not `desc2Match`. A
 * sofa is ONE line in the book, so its DtlKey names exactly one build even on a
 * document holding two (which is what HELD HC-SO-012025 for a day,
 * docs/bugs/0779). Matching on Desc2 text is what needs an `exclude` list when
 * one sofa's description is a substring of another's.
 *
 * ── WHAT IT REFUSES TO PROPOSE ─────────────────────────────────────────────
 *   - a supplier reference with no purchase order here. Owner: 「找不到PO 可能
 *     已经送完了的 就不理」 - those are old completed orders the cutover never
 *     took (every unmatched one is below PO-009122). Counted, never proposed.
 *   - a build whose PO rows carry more than one DtlKey, or none. Then the build
 *     is not identified and guessing which rows belong to it is the mistake
 *     0779 records.
 *   - a build that ALREADY reads what the supplier says. Nothing to write.
 *
 * It marks - and does not withhold - a build with RECEIVED stock. Changing an
 * item_code under received stock moves the lot off its product, and the applier
 * refuses it by its own rule; the entry is still emitted so the applier is the
 * one place that decision lives, and this script says how many are in that
 * state so nobody is surprised by the refusals.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   OUT            optional path to write the JSON to; default stdout
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parseSofa } from './lib/parse-sofa.mjs';

const CO = Number(process.env.COMPANY_ID || 1);
const OUT = process.env.OUT || '';
const here = path.dirname(fileURLToPath(import.meta.url));

const log = (s = '') => console.log(`::notice::${s}`);
const gz = (f) => JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', f))).toString('utf8').replace(/^﻿/, ''),
);

const norm = (s) => String(s ?? '').trim().toUpperCase();
const suffix = (code) => { const s = norm(code); const i = s.indexOf('-'); return i < 0 ? s : s.slice(i + 1); };
const modelOf = (code) => { const s = norm(code); const i = s.indexOf('-'); return i < 0 ? s : s.slice(0, i); };
const bag = (xs) => xs.slice().sort().join('|');

/* One value for the whole build, or none. The supplier writes the leg on every
   piece of a run and they agree; where they do NOT agree, no single number is
   the build's leg and writing either would be inventing one. */
const oneOf = (values) => {
  const seen = [...new Set(values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map(String))];
  return seen.length === 1 ? seen[0] : null;
};

const book = gz('supplier-so-detail-2026-09-10.json.gz');
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

const entries = [];
const stats = { docs: 0, noPo: 0, noRows: 0, ambiguousKey: 0, already: 0, proposed: 0, received: 0, noSo: 0 };

try {
  const docs = book.documents
    .map((d) => ({ ...d, lines: d.lines.filter((l) => norm(l.group) === 'SOFA') }))
    .filter((d) => d.lines.length);
  log(`${docs.length} supplier document(s) carry a sofa. Company ${CO}.`);

  for (const d of docs) {
    stats.docs += 1;
    const ref = d.ourPoRef;
    let po = (await sql`SELECT id, po_number FROM scm.purchase_orders
                         WHERE company_id = ${CO} AND linked_ac_docno = ${ref}`)[0]
      ?? (await sql`SELECT id, po_number FROM scm.purchase_orders
                     WHERE company_id = ${CO} AND po_number = ${ref}`)[0];
    if (!po) { stats.noPo += 1; continue; }

    const rows = await sql`
      SELECT i.id, i.item_code, i.linked_ac_dtlkey::text AS dtlkey,
             coalesce(i.received_qty, 0) AS received, i.so_item_id, i.variants
        FROM scm.purchase_order_items i
       WHERE i.purchase_order_id = ${po.id}
         AND lower(coalesce(i.item_group, '')) = 'sofa'
       ORDER BY i.id`;
    if (!rows.length) { stats.noRows += 1; continue; }

    const keys = [...new Set(rows.map((r) => r.dtlkey).filter(Boolean))];
    if (keys.length !== 1) { stats.ambiguousKey += 1; continue; }

    const theirs = d.lines.map((l) => suffix(l.code));
    const mine = rows.map((r) => suffix(r.item_code));
    const sameBag = bag(theirs) === bag(mine);
    const sameSeq = theirs.join('+') === mine.join('+');

    const parsed = d.lines.map((l) => (l.desc2 ? parseSofa(l.desc2, modelOf(l.code)) : null));
    const seat = oneOf(parsed.map((p) => p?.size));
    const leg = oneOf(parsed.map((p) => (p?.leg === null || p?.leg === undefined ? null : p.leg)));

    /* The SALES ORDER the purchase order was raised from, so the pair is
       corrected together and cannot drift. */
    const soIds = rows.map((r) => r.so_item_id).filter(Boolean);
    let soDoc = null;
    if (soIds.length) {
      const so = await sql`
        SELECT DISTINCT i.doc_no FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
         WHERE h.company_id = ${CO} AND i.id = ANY(${soIds})`;
      if (so.length === 1) soDoc = so[0].doc_no;
    }
    if (!soDoc) stats.noSo += 1;

    const received = rows.reduce((a, r) => a + Number(r.received || 0), 0);
    if (received > 0) stats.received += 1;

    /* Nothing to write: the build already reads what the supplier says, and the
       supplier states no seat or leg we are missing. */
    const legMissing = leg !== null && rows.some((r) => !((r.variants ?? {}).legHeight));
    if (sameBag && sameSeq && !legMissing && seat === null) { stats.already += 1; continue; }

    const ourModel = oneOf(rows.map((r) => modelOf(r.item_code)));
    if (!ourModel) { stats.ambiguousKey += 1; continue; }

    entries.push({
      docs: [po.po_number, ...(soDoc ? [soDoc] : [])],
      model: ourModel,
      pieces: theirs,
      ...(seat === null ? {} : { seat }),
      ...(leg === null ? {} : { leg: String(leg) }),
      lineKeys: keys,
      confidence: 'certain',
      why: `SUPPLIER LISTING ${d.supplierDoc} (${book._source}). The supplier records the build by `
        + `compartment with every variant; the owner named it the authority on a proceeded order `
        + `(「supplier的肯定对的 基本上你可以跟」). Ours reads ${mine.join('+') || '(none)'}, `
        + `the supplier ${theirs.join('+')}`
        + `${sameBag && sameSeq ? ' (pieces already agree; this entry carries the seat/leg only)' : ''}`
        + `${received > 0 ? `. ${received} unit(s) already received against this purchase order.` : '.'}`,
      source: 'supplier-2026-09-10',
    });
    stats.proposed += 1;
  }

  const doc = {
    _note: 'Generated by propose-supplier-sofa-corrections.mjs from the supplier listing the owner '
      + 'gave on 2026-09-10. Applied through apply-sofa-compartment-corrections.mjs, which corrects '
      + 'the sales order and the purchase order together.',
    _authority: 'THE SUPPLIER IS RIGHT. Owner 2026-09-10: 「supplier的肯定对的 基本上你可以跟」.',
    _source: book._source,
    _sourceSha256: book._sha256,
    _generatedFrom: `company ${CO}`,
    entries,
  };

  log('');
  log('SUMMARY');
  log(`   supplier sofa documents            ${stats.docs}`);
  log(`   no purchase order here (IGNORED)   ${stats.noPo}   <- owner: already delivered, do not chase`);
  log(`   purchase order has no sofa row     ${stats.noRows}`);
  log(`   build not identified by one key    ${stats.ambiguousKey}`);
  log(`   already correct, nothing to write  ${stats.already}`);
  log(`   PROPOSED                           ${stats.proposed}`);
  log(`      of those, no sales order found  ${stats.noSo}   <- purchase order corrected alone`);
  log(`      of those, stock already received ${stats.received}   <- the applier decides, by its own rule`);

  const json = `${JSON.stringify(doc, null, 1)}\n`;
  if (OUT) { fs.writeFileSync(OUT, json); log(`written to ${OUT} (${json.length} bytes)`); }
  else console.log(json);
} finally {
  await sql.end({ timeout: 5 });
}
