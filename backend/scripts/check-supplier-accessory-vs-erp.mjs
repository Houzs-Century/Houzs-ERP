#!/usr/bin/env node
/* READ-ONLY. The accessory half of the supplier comparison, which was never run.
 *
 * `check-supplier-listing-vs-erp` and `check-supplier-bedframe-vs-erp` compared
 * the SOFA and BEDFRAME rows of the supplier export against our purchase orders.
 * The ACCESSORY rows were listed as "never compared" in the 2026-09-10 handoff and
 * stayed that way. Owner, 2026-09-14: 「配件 66 行没有对过的，也可以做到完」.
 *
 * WHAT THE ROWS ARE, measured on the 2026-09-11 export: 72 accessory lines over
 * 58 supplier documents, and only THREE codes — `SQUARE PILLOW`,
 * `SQUARE PILLOW RDM` (random colour) and `LONG PILLOW`. So the comparison is
 * per document, per pillow TYPE, on QUANTITY. There are no variants to compare:
 * an accessory carries no soft attributes (the 2026-09-11 whole-flow audit).
 *
 * ── WHY THIS IS A CHECK AND NOT A REPAIR ───────────────────────────────────
 * Pillows are where a confident reading was already wrong once. On 2026-09-11
 * five square-pillow pairs were called duplicate orders to cancel; measurement
 * refuted it — SQUARE PILLOW demand 503 against 237 on hand plus 62 on order. A
 * quantity on a purchase order is what we BOUGHT, and a type on a received line
 * is a stock bucket. Neither is changed from a comparison alone.
 *
 * ── FOUR OUTCOMES PER (document, type) ─────────────────────────────────────
 *   AGREE          same type, same total quantity
 *   QTY DIFFERS    same type, different total
 *   OURS MISSING   the supplier lists the type, our PO has none of it
 *   SUPPLIER NONE  our PO has the type, the supplier lists none
 * plus, per document, TYPE SWAPPED: the totals match across types but the split
 * between square / random / long does not — the random-colour-versus-custom
 * question the 09-10 handoff recorded as "not touched".
 *
 * The four outcomes are reported with received quantity beside each, because
 * a difference on an unreceived line and one on a received line are different
 * kinds of fix.
 *
 * IT WRITES NOTHING. SELECT only, no DDL, no transaction.
 * RE-RUN: read-only and stateless.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));
const pad = (n, w = 4) => String(n).padStart(w);
const norm = (s) => String(s ?? '').trim().toUpperCase();

/** One pillow TYPE from any code or description, ours or the supplier's.
 *  Random colour is its own type: it is a different thing to buy. */
function pillowType(code, desc = '') {
  const s = `${norm(code)} ${norm(desc)}`;
  if (!/PILLOW|CUSHION/.test(s)) return null;
  if (/LONG/.test(s)) return 'LONG';
  if (/SQUARE|16"?\s*X\s*16/.test(s)) return /\bRDM\b|RANDOM/.test(s) ? 'SQUARE-RANDOM' : 'SQUARE';
  return 'OTHER-PILLOW';
}

/* Self-test on the three real supplier codes and on our own shapes before
   reporting. A type reader that cannot match reports "all agree". */
{
  const cases = [
    [['SQUARE PILLOW', 'SOFA SQUARE PILLOW (16"X16")'], 'SQUARE'],
    [['SQUARE PILLOW RDM', 'SOFA SQUARE PILLOW (RANDOM)(16"X16")'], 'SQUARE-RANDOM'],
    [['LONG PILLOW', 'SOFA LONG PILLOW (12"X28")'], 'LONG'],
    [['8030-1A(LHF)', 'SOFA SOFFIO 1A'], null],
  ];
  const bad = cases.filter(([[c, d], want]) => pillowType(c, d) !== want);
  if (bad.length) {
    console.error(`SELF-TEST FAILED on ${bad.length} case(s). Refusing to report.`);
    for (const [[c, d], want] of bad) console.error(`   ${c} / ${d} -> ${pillowType(c, d)} (wanted ${want})`);
    process.exit(1);
  }
}

const book = JSON.parse(zlib.gunzipSync(
  fs.readFileSync(path.join(here, 'data', 'supplier-so-detail-2026-09-11.json.gz'))).toString('utf8').replace(/^﻿/, ''));
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

/** The supplier writes our PO number several ways, including `PO--009780`. */
function refVariants(ref) {
  const r = norm(ref).replace(/-{2,}/g, '-');
  const out = new Set([r]);
  if (/^PO-/.test(r)) out.add(`HC-${r}`);
  if (/^HC-PO-/.test(r)) out.add(r.slice(3));
  return [...out];
}

try {
  line('='.repeat(78));
  line('SUPPLIER ACCESSORIES (pillows) vs OUR PURCHASE ORDERS — read-only');
  line('='.repeat(78));
  line(`   company ${CO}   source ${book._source ?? 'supplier-so-detail-2026-09-11'}`);

  const supplier = new Map();   // ourRef -> Map(type -> qty)
  let rows = 0;
  for (const d of book.documents) {
    for (const l of d.lines) {
      if (norm(l.group) !== 'ACCESSORY') continue;
      const t = pillowType(l.code, l.desc);
      if (!t) continue;
      rows += 1;
      /* KEY BY THE NORMALISED REFERENCE. The first production run
         (34777318705) keyed by the raw string, and the supplier writes one PO
         two ways - `PO--009780` x2 and `PO-009780` x1. Both resolved to the same
         purchase order, and each half was compared against our FULL quantity,
         so a document that agrees (2 + 1 = 3 against our 3) was reported as two
         quantity differences. */
      const key = refVariants(d.ourPoRef)[0];
      const m = supplier.get(key) ?? new Map();
      m.set(t, (m.get(t) ?? 0) + Number(l.qty ?? 0));
      supplier.set(key, m);
    }
  }
  line(`   supplier accessory rows: ${rows} over ${supplier.size} document(s)`);

  const out = { agree: [], qty: [], oursMissing: [], supplierNone: [], swapped: [], poNotFound: [] };
  for (const [ref, theirs] of supplier) {
    let po = null;
    for (const v of refVariants(ref)) {
      [po] = await sql`
        SELECT id, po_number FROM scm.purchase_orders
         WHERE company_id = ${CO} AND (po_number = ${v} OR linked_ac_docno = ${v}) LIMIT 1`;
      if (po) break;
    }
    if (!po) { out.poNotFound.push(ref); continue; }

    /* material_name, not description: it is the text column proven on
       purchase_order_items by check-sofa-code-vs-description, which has run on
       production. A column that does not exist is 42703, which fails the WHOLE
       statement - an audit that reads 0 after one is reporting nothing. */
    const lines = await sql`
      SELECT i.item_code, coalesce(i.material_name,'') AS description,
             coalesce(i.qty,0)::numeric AS qty, coalesce(i.received_qty,0)::numeric AS recv,
             lower(coalesce(i.item_group,'')) AS grp,
             so.doc_no AS so_doc, so.item_code AS so_code, coalesce(so.description,'') AS so_desc,
             coalesce(so.description2,'') AS so_desc2
        FROM scm.purchase_order_items i
        LEFT JOIN scm.mfg_sales_order_items so ON so.id = i.so_item_id
       WHERE i.purchase_order_id = ${po.id}`;
    const ours = new Map();
    const recv = new Map();
    const evidence = new Map();
    for (const r of lines) {
      const t = pillowType(r.item_code, r.description);
      if (!t) continue;
      ours.set(t, (ours.get(t) ?? 0) + Number(r.qty));
      recv.set(t, (recv.get(t) ?? 0) + Number(r.recv));
      const ev = evidence.get(t) ?? [];
      ev.push(`${r.item_code} "${r.description}" x${Number(r.qty)}`
        + (r.so_doc ? `  <- customer line ${r.so_doc} ${r.so_code} "${r.so_desc}"${r.so_desc2 ? ` / ${r.so_desc2}` : ''}` : '  (no sales line)'));
      evidence.set(t, ev);
    }

    const types = new Set([...theirs.keys(), ...ours.keys()]);
    const sumT = [...theirs.values()].reduce((a, b) => a + b, 0);
    const sumO = [...ours.values()].reduce((a, b) => a + b, 0);
    let anyDiff = false;
    for (const t of types) {
      const a = theirs.get(t) ?? 0;
      const b = ours.get(t) ?? 0;
      const e = { po: po.po_number, type: t, supplier: a, ours: b, received: recv.get(t) ?? 0,
        evidence: evidence.get(t) ?? [] };
      if (a === b) out.agree.push(e);
      else if (b === 0) { out.oursMissing.push(e); anyDiff = true; }
      else if (a === 0) { out.supplierNone.push(e); anyDiff = true; }
      else { out.qty.push(e); anyDiff = true; }
    }
    if (anyDiff && sumT === sumO && sumT > 0) {
      out.swapped.push({
        po: po.po_number, total: sumT,
        supplier: [...theirs].map(([t, q]) => `${t}x${q}`).join(' '),
        ours: [...ours].map(([t, q]) => `${t}x${q}`).join(' '),
      });
    }
  }

  rule();
  line(`   AGREE                                        ${pad(out.agree.length)}`);
  line(`   QTY DIFFERS   (same type, different total)   ${pad(out.qty.length)}`);
  line(`   OURS MISSING  (supplier has it, we do not)   ${pad(out.oursMissing.length)}`);
  line(`   SUPPLIER NONE (we have it, supplier does not)${pad(out.supplierNone.length)}`);
  line(`   TYPE SWAPPED  (same total, different split)  ${pad(out.swapped.length)}   <- random vs custom colour`);
  line(`   our PO not found for the supplier's reference ${pad(out.poNotFound.length)}`);

  const show = (title, list) => {
    if (!list.length) return;
    rule();
    line(`   ${title}`);
    for (const e of list) {
      line(`      ${String(e.po).padEnd(16)} ${String(e.type).padEnd(14)} supplier ${pad(e.supplier, 3)}`
        + `   ours ${pad(e.ours, 3)}   received ${pad(e.received, 3)}`
        + (e.received > 0 ? '   <- goods are IN' : ''));
      for (const ev of e.evidence) line(`           ours: ${ev}`);
    }
  };
  show('QTY DIFFERS', out.qty);
  show('OURS MISSING', out.oursMissing);
  show('SUPPLIER NONE', out.supplierNone);
  if (out.swapped.length) {
    rule();
    line('   TYPE SWAPPED — same number of pillows, different type split:');
    for (const s of out.swapped) line(`      ${String(s.po).padEnd(16)} total ${pad(s.total, 3)}   supplier ${s.supplier}   ours ${s.ours}`);
  }
  if (out.poNotFound.length) {
    rule();
    line('   supplier references with no matching purchase order:');
    line(`      ${out.poNotFound.join(', ')}`);
  }
  rule();
  line('READ-ONLY — nothing was written.');
} finally {
  await sql.end({ timeout: 5 });
}
