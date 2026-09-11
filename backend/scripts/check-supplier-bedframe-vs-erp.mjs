#!/usr/bin/env node
/* check-supplier-bedframe-vs-erp - where our BEDFRAME lines disagree with the
 * supplier's own listing. READ-ONLY. SELECTs only, no writes, no DDL, no
 * transaction.
 *
 * ── WHY A SECOND SCRIPT AND NOT `GROUPS=BEDFRAME` ─────────────────────────
 * check-supplier-listing-vs-erp was written for sofas, and running it over
 * bedframes produced numbers that cannot be used (production run 34501427768):
 * 53 documents in "different ORDER" and 239 in "different VARIANTS". Both are
 * artefacts of the sofa rules, not findings:
 *
 *   ORDER. A sofa is one run of compartments and their sequence is the product.
 *   A bedframe line is a WHOLE BED. Three beds on one purchase order are three
 *   independent items, so (K)+(Q) and (Q)+(K) are the same order written in a
 *   different sequence - and the sofa comparison called all 53 of those a
 *   direction problem. Here the pieces are compared as a MULTISET only, and
 *   sequence is not compared at all.
 *
 *   VARIANTS. The sofa reader (lib/parse-sofa.mjs) decodes seat depth, leg and
 *   colour. A bedframe's Detail Description 2 is a different grammar entirely -
 *   measured over all 1,230 bedframe rows in the file: `div:` on 1,218,
 *   `gap:` on 1,134, `leg:` on 626. Handing that to the sofa reader is how 239
 *   documents came back "different".
 *
 * The lesson is the repo's own: a checker that cannot match must not report. It
 * did report, and it reported a number somebody could have acted on.
 *
 * ── WHAT A BEDFRAME VARIANT IS ────────────────────────────────────────────
 * Three keyed numbers - div (divan height), gap, leg - each in inches. Anything
 * without a key ("hb fully cover", "front drawer", "divan curve") is a SPECIAL
 * instruction, not a variant: memory special-order-text-is-the-home-for-spec
 * says the free text is where a spec lives and it is NOT part of the variant
 * key. Those are counted and shown, never compared as if they were fields.
 *
 * ── THE SIZE IS THE PIECE ─────────────────────────────────────────────────
 * A bedframe code is `<model>-(<size>)` - 1007-(K), 2038(A)-(SS). The size is
 * what a comparison can carry across the two systems, because the MODEL is the
 * supplier's own name for it and differing there is expected, not a defect
 * (memory: po-item-code-is-the-suppliers-model).
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   LIST_LIMIT     optional, default 60
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const LIMIT = Number(process.env.LIST_LIMIT || 60);
const here = path.dirname(fileURLToPath(import.meta.url));

const line = (s = '') => console.log(`::notice::${s}`);
const rule = () => line('-'.repeat(78));
const head = (s) => { line('='.repeat(78)); line(s); line('='.repeat(78)); };

const gz = (f) => JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', f))).toString('utf8').replace(/^﻿/, ''),
);
const norm = (s) => String(s ?? '').trim().toUpperCase();
/* Compare div/gap/leg as NUMBERS, not strings. The supplier writes 10, our
   stored variant writes 10" (or "10 inch") - the same measurement. Comparing the
   raw strings reported 296 documents "different" on 2026-09-11 (run 34555472901)
   almost all of which were the inch mark alone. Strip everything but the number,
   then compare; a real difference (8 vs 10, or a value vs blank) survives. */
const inches = (v) => {
  if (v === null || v === undefined) return null;
  const m = String(v).match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? String(parseFloat(m[1])) : null;
};

/* `1007-(K)` -> `(K)`, `2038(A)-(SS)` -> `(SS)`. The LAST dash, because a model
   may itself contain one. */
const sizeOf = (code) => {
  const s = norm(code);
  const i = s.lastIndexOf('-');
  return i < 0 ? s : s.slice(i + 1);
};
const bag = (xs) => xs.slice().sort().join('|');

/* div / gap / leg, in inches. Returns only what the string STATES - a missing
   key is "not said", never zero, because writing a zero where the supplier said
   nothing is inventing a measurement. */
const bedVariants = (d2) => {
  const out = {};
  const s = String(d2 ?? '').toLowerCase();
  for (const key of ['div', 'gap', 'leg']) {
    const m = s.match(new RegExp(`\\b${key}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`));
    if (m) out[key] = m[1];
  }
  return out;
};
/* Everything with no key is a SPECIAL instruction, not a variant. */
const bedSpecials = (d2) => String(d2 ?? '')
  .split(/[/,;]/)
  .map((x) => x.trim())
  .filter((x) => x && !/^\s*(div|gap|leg)\s*:/i.test(x));

/* Self-test both readers before reporting anything. */
{
  const v = bedVariants('div:8inch / leg:1inch / gap:16inch');
  const inchOk = inches('10"') === '10' && inches('10 inch') === '10' && inches('10') === '10' && inches(null) === null && inches('8') !== inches('10');
  const ok = inchOk && v.div === '8' && v.leg === '1' && v.gap === '16'
    && Object.keys(bedVariants('div:10inch')).join() === 'div'
    && bedSpecials('div:8inch / hb fully cover').join('|') === 'hb fully cover'
    && sizeOf('2038(A)-(SS)') === '(SS)' && sizeOf('1007-(K)') === '(K)';
  if (!ok) {
    console.error('SELF-TEST FAILED on the bedframe readers. Refusing to report.');
    process.exit(1);
  }
}

const book = gz('supplier-so-detail-2026-09-10.json.gz');
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  head('SUPPLIER LISTING vs OUR PURCHASE ORDERS - BEDFRAME');
  line(`   source: ${book._source}`);
  line(`   sha256: ${book._sha256}`);
  line('   Sequence is NOT compared: a bedframe line is a whole bed, so three beds on one');
  line('   order are three independent items and their order carries no meaning.');
  line('   Variants are div / gap / leg in inches. Unkeyed text is a SPECIAL, not a variant.');

  const docs = book.documents
    .map((d) => ({ ...d, lines: d.lines.filter((l) => norm(l.group) === 'BEDFRAME') }))
    .filter((d) => d.lines.length);
  line(`   ${docs.length} supplier document(s) carry a bedframe`);

  const b = { noPo: 0, noLines: 0, sizes: [], variants: [], agree: 0, specialsOnly: 0 };

  for (const d of docs) {
    const ref = d.ourPoRef;
    if (!ref) { b.noPo += 1; continue; }
    const po = (await sql`SELECT id, po_number FROM scm.purchase_orders
                           WHERE company_id = ${CO} AND linked_ac_docno = ${ref}`)[0]
      ?? (await sql`SELECT id, po_number FROM scm.purchase_orders
                     WHERE company_id = ${CO} AND po_number = ${ref}`)[0];
    if (!po) { b.noPo += 1; continue; }

    const ours = (await sql`
      SELECT i.item_code, i.variants, i.description2, coalesce(i.item_group,'') AS grp,
             coalesce(i.received_qty,0) AS received
        FROM scm.purchase_order_items i
       WHERE i.purchase_order_id = ${po.id}
       ORDER BY i.id`).filter((r) => norm(r.grp) === 'BEDFRAME');
    if (!ours.length) { b.noLines += 1; continue; }

    const theirSizes = d.lines.map((l) => sizeOf(l.code));
    const ourSizes = ours.map((r) => sizeOf(r.item_code));
    const received = ours.reduce((a, r) => a + Number(r.received || 0), 0);

    if (bag(theirSizes) !== bag(ourSizes)) {
      b.sizes.push({ po: po.po_number, ref, theirs: theirSizes, ours: ourSizes, received });
      continue;
    }

    /* Same sizes - now the three numbers, matched by SIZE rather than by row
       position, because sequence carries no meaning here. */
    const diffs = [];
    const bySize = new Map();
    for (const r of ours) {
      const k = sizeOf(r.item_code);
      if (!bySize.has(k)) bySize.set(k, []);
      bySize.get(k).push(r);
    }
    let specials = 0;
    for (const l of d.lines) {
      const want = bedVariants(l.desc2);
      specials += bedSpecials(l.desc2).length;
      const pool = bySize.get(sizeOf(l.code));
      if (!pool || !pool.length) continue;
      const r = pool.shift();
      const got = r.variants || {};
      const map = { div: ['divanHeight', 'divan'], gap: ['gap'], leg: ['legHeight', 'leg'] };
      for (const [k, names] of Object.entries(map)) {
        if (!(k in want)) continue;
        const mine = names.map((n) => got[n]).find((x) => x !== undefined && x !== null && String(x) !== '');
        if (inches(mine) !== inches(want[k])) {
          diffs.push(`${sizeOf(l.code)} ${k}: supplier ${want[k]} vs ours ${mine ?? '(blank)'}`);
        }
      }
    }
    if (diffs.length) b.variants.push({ po: po.po_number, diffs, received });
    else { b.agree += 1; if (specials) b.specialsOnly += 1; }
  }

  head('THE ANSWER - BEDFRAME');
  line(`   supplier documents with a bedframe      ${docs.length}`);
  line(`   no purchase order here (out of scope)   ${b.noPo}`);
  line(`   purchase order has no bedframe line     ${b.noLines}`);
  line(`   SIZES DIFFER (what was ordered)         ${b.sizes.length}   <- costs money`);
  line(`   sizes agree, div/gap/leg DIFFER         ${b.variants.length}`);
  line(`   agree                                   ${b.agree}`);
  line(`      of those, carrying a SPECIAL text    ${b.specialsOnly}   <- free text, not a variant`);

  if (b.sizes.length) {
    rule(); line(`SIZES DIFFER - ${b.sizes.length}`); rule();
    for (const r of b.sizes.slice(0, LIMIT)) {
      line(`   ${r.po.padEnd(16)} supplier ${r.theirs.join('+')}   ours ${r.ours.join('+')}`
        + `${r.received ? `   [${r.received} received]` : ''}`);
    }
  }
  if (b.variants.length) {
    rule(); line(`div / gap / leg DIFFER - ${b.variants.length}`); rule();
    for (const r of b.variants.slice(0, LIMIT)) {
      line(`   ${r.po.padEnd(16)} ${r.diffs.slice(0, 4).join(' ; ')}`
        + `${r.received ? `   [${r.received} received]` : ''}`);
    }
    if (b.variants.length > LIMIT) line(`   ... and ${b.variants.length - LIMIT} more`);
  }

  head('READ-ONLY. Nothing was written.');
} finally {
  await sql.end({ timeout: 5 });
}
