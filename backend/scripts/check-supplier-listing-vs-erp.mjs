#!/usr/bin/env node
/* check-supplier-listing-vs-erp - where our purchase orders disagree with the
 * SUPPLIER'S OWN listing of what it built. READ-ONLY. SELECTs only, no writes,
 * no DDL, no transaction.
 *
 * ── THE AUTHORITY, AND WHY IT IS NOT AUTOCOUNT ─────────────────────────────
 * The owner, 2026-09-10, handing over the export:
 *
 *     已经 Proceed 的 Order，你可以根据我的这个 Listing（这是 Supplier 给到我的，
 *     这个肯定准）去纠正我们的 SO 和 PO。你只要纠正了 PO，就知道整个
 *     Transaction Flow 怎么纠正了。
 *
 * The supplier's system records the sofa BY COMPARTMENT with every variant,
 * because it is the system that built the thing. AutoCount holds one line per
 * sofa and the drawing is a photograph, so on a PROCEEDED order this listing
 * beats both. Where our PO disagrees, OURS is wrong.
 *
 * That is the reverse of the stock rule (「跟 AutoCount 一样」) and it is not a
 * contradiction: that rule governs cost layers nobody here edits, this one
 * governs what was physically ordered.
 *
 * ── THE BRIDGE ─────────────────────────────────────────────────────────────
 * `ourPoRef` is our purchase order as the SUPPLIER holds it, and it comes in
 * two shapes: an AutoCount number (`PO-007937`) on a migrated order, our own
 * `po_number` (`HC-PO-2609-027`) on a new one. Both are tried -
 * `purchase_orders.linked_ac_docno` first, then `po_number` - because a
 * migrated order has both and only the AutoCount one appears in this file.
 *
 * Measured on the 2026-09-11 file: 144 supplier documents carry a sofa and they
 * map 1:1 to 144 PO references (no document spans two, no reference spans two
 * documents). 139 of the references are AutoCount numbers; the rest are our own
 * doc_no, one of them with the HC- prefix dropped - see the third lookup below.
 *
 * ── WHAT IT COMPARES, AND IN WHICH ORDER ───────────────────────────────────
 *   1. the piece MULTISET. Robust to row order, so a difference here is a
 *      difference in WHAT WAS ORDERED - a wrong piece, a missing piece, an
 *      extra one. This is the finding that costs money.
 *   2. the piece SEQUENCE - and a plain REVERSAL counts as AGREEMENT. One run
 *      written from the other end is the same sofa: reversing does not move a
 *      hand, and 1A(LHF) is a left-hand-facing arm wherever it appears. Only a
 *      genuine re-ordering (the corner at a different point in the run) is a
 *      difference. A MIRROR - reverse AND swap every hand - is a different sofa
 *      and shows up as a MULTISET difference, which is where it belongs
 *      (docs/bugs/0774, 0777).
 *   3. the VARIANTS carried in the supplier's `Detail Description 2`, parsed by
 *      lib/parse-sofa.mjs - the module that owns that grammar and the one
 *      backfill-sofa-variants-from-desc2.mjs uses. It is NOT re-spelled here;
 *      two readers of one string that disagree is how this repo got two
 *      different answers for the same sofa.
 *
 * A row-ORDER caveat, stated rather than assumed: the export carries no line
 * number, so sequence is the file's row order. That is why the multiset is
 * compared first and reported separately - a multiset finding survives the
 * caveat, a sequence finding does not on its own.
 *
 * IT WRITES NOTHING AND PROPOSES NOTHING. The repair is a separate plan-gated
 * tool, and it should be written against what this prints.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   LIST_LIMIT     optional, default 60 - documents to name per bucket
 *   GROUPS         optional, default SOFA. Comma-separated item groups, or ALL.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parseSofa, pieceSuffix } from './lib/parse-sofa.mjs';

const CO = Number(process.env.COMPANY_ID || 1);
const LIMIT = Number(process.env.LIST_LIMIT || 60);
const GROUPS = String(process.env.GROUPS || 'SOFA').toUpperCase();
const here = path.dirname(fileURLToPath(import.meta.url));

const line = (s = '') => console.log(`::notice::${s}`);
const rule = () => line('-'.repeat(78));
const head = (s) => { line('='.repeat(78)); line(s); line('='.repeat(78)); };

const gz = (f) => JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', f))).toString('utf8').replace(/^﻿/, ''),
);

const norm = (s) => String(s ?? '').trim().toUpperCase();
/* A HEIGHT compares as a NUMBER. The supplier states leg as `6`, we store it as
   `6"` - the same 6 inches, and on run 34563471672 two documents (HC-PO-009652,
   HC-PO-010146) were reported as DIFFERENT VARIANTS on the inch mark alone.
   Same class as the bedframe fix in PR #3614, now applied to the sofa side.
   Anything with no digit in it (`Default`) falls back to the plain string, so a
   word is still compared as a word. */
const num = (v) => {
  const s = norm(v);
  if (!s) return '';
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? String(Number(m[0])) : s;
};
/* 5540-1A(LHF) -> 1A(LHF). The same reader the corrections applier and the
   middle-reverser use, so the three cannot disagree about what a piece is. */
/* parse-sofa owns it. The supplier writes CSL where our catalogue mints
   CONSOLE - the same part (owner 2026-09-11) - and without that fold
   HC-PO-009986 and HC-PO-010145 read as DIFFERENT PIECES ("costs money") on two
   sofas that agree, which is exactly what they did on run 34563471672 AFTER the
   corrections had already landed. */
const suffix = pieceSuffix;
const modelOf = (code) => {
  const s = norm(code);
  const i = s.indexOf('-');
  return i < 0 ? s : s.slice(0, i);
};
const bag = (xs) => xs.slice().sort().join('|');

/* THE SAME SOFA, LISTED FROM THE OTHER END. The owner, 2026-09-10, on
 * HC-PO-009587 where I had called two readings a conflict:
 *
 *     你自己亲手重读那张图  1A(LHF)+1NA+L(RHF)
 *     供应商档案            L(RHF)+1NA+1A(LHF)
 *     「这两个一样啊」
 *
 * And they are. Reverse the second and the hands do not move:
 * L(RHF)+1NA+1A(LHF) reversed is 1A(LHF)+1NA+L(RHF), which is the first. A
 * piece's hand is intrinsic - 1A(LHF) is a left-hand-facing arm wherever it is
 * written - so a plain REVERSAL is one sofa written from the other end, not a
 * different sofa.
 *
 * A MIRROR is reverse AND swap every hand, and that IS a different sofa. The two
 * were being counted as one thing, which inflated "different order" with rows
 * that agree. */
const sameSofa = (a, b) => a.join('+') === b.join('+') || a.slice().reverse().join('+') === b.join('+');

const book = gz('supplier-so-detail-2026-09-11.json.gz');
const wantGroups = GROUPS === 'ALL' ? null : new Set(GROUPS.split(',').map((s) => s.trim()));

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  head('SUPPLIER LISTING vs OUR PURCHASE ORDERS');
  line(`   source: ${book._source}`);
  line(`   sha256 of the workbook: ${book._sha256}`);
  line(`   ${book._rows} row(s) across ${book._docs} supplier document(s)`);
  line(`   comparing item group(s): ${GROUPS}   company ${CO}`);
  line('   THE SUPPLIER IS THE AUTHORITY on a proceeded order. Where we disagree, WE are wrong.');

  const docs = book.documents
    .map((d) => ({ ...d, lines: d.lines.filter((l) => !wantGroups || wantGroups.has(norm(l.group))) }))
    .filter((d) => d.lines.length);
  line(`   ${docs.length} supplier document(s) carry a line in that group`);

  const buckets = { noRef: [], noPo: [], noLines: [], multiset: [], sequence: [], variants: [], variantsDeferred: [], agree: [] };
  /* The lowest and highest AutoCount purchase order we actually hold. The
     not-found bucket is meaningless without it: an unmatched reference below
     our floor is an order the cutover never took (scope was outstanding only),
     not a broken link. */
  const [range] = await sql`
    SELECT min(linked_ac_docno) AS lo, max(linked_ac_docno) AS hi, count(*)::int AS n
      FROM scm.purchase_orders
     WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  /* The AutoCount purchase orders we ACTUALLY hold, as numbers. min/max above is
     a TEXT min/max over mixed shapes (`HC-PO-2609-001` sorts before `PO-000254`),
     so it cannot answer "is this reference inside our range?" - and reading it as
     a floor is how the 2026-09-10 round wrote off 20 references that sit INSIDE
     the range as "below the floor". The cutover's scope was OUTSTANDING
     documents, not a cut-off number: our numbers are sparse (574 of the 9,917
     between the lowest and the highest), so a missing one in the middle is an
     order that was already closed when we cut over - still not work, but for the
     real reason. */
  const held = new Set((await sql`
    SELECT linked_ac_docno AS d FROM scm.purchase_orders
     WHERE company_id = ${CO} AND linked_ac_docno ~ '^PO-[0-9]+$'`).map((r) => Number(r.d.slice(3))));
  const acNum = (ref) => {
    const m = /^PO-0*([0-9]{4,})$/.exec(String(ref || ''));
    return m ? Number(m[1]) : null;
  };
  const lo = Math.min(...held);
  const hi = Math.max(...held);

  for (const d of docs) {
    const ref = d.ourPoRef;
    if (!ref) { buckets.noRef.push(d); continue; }

    /* AutoCount number first: a migrated order carries BOTH, and only the
       AutoCount one ever appears in this file. */
    let po = (await sql`SELECT id, po_number, linked_ac_docno, status::text AS status
                          FROM scm.purchase_orders
                         WHERE company_id = ${CO} AND linked_ac_docno = ${ref}`)[0];
    if (!po) {
      po = (await sql`SELECT id, po_number, linked_ac_docno, status::text AS status
                        FROM scm.purchase_orders
                       WHERE company_id = ${CO} AND po_number = ${ref}`)[0];
    }
    /* ... and a THIRD shape, measured on the 2026-09-11 export: the supplier's
       Customer PO column carries our own number with the company prefix dropped
       (`PO-2609-051` is our `HC-PO-2609-051`). Only tried for the OUR-doc shape
       (PO-YYMM-NNN), never for an AutoCount number, so it cannot invent a match
       for a migrated order that genuinely is not here. */
    if (!po && /^PO-\d{4}-\d+$/.test(ref)) {
      po = (await sql`SELECT id, po_number, linked_ac_docno, status::text AS status
                        FROM scm.purchase_orders
                       WHERE company_id = ${CO} AND po_number = ${'HC-' + ref}`)[0];
    }
    if (!po) { buckets.noPo.push({ ...d, why: `no purchase order matches ${ref} by linked_ac_docno or po_number` }); continue; }

    const allOurs = await sql`
      SELECT i.id, i.item_code, i.qty, i.variants, i.description2,
             coalesce(i.item_group, '') AS grp, i.so_item_id, i.received_qty
        FROM scm.purchase_order_items i
       WHERE i.purchase_order_id = ${po.id}
       ORDER BY i.id`;
    /* Filtered in JS, not in SQL: the group filter is a set and splicing one
       into a tagged template is where postgres.js binds a parameter where an
       identifier belongs. The row counts here are small. */
    const ours = wantGroups ? allOurs.filter((r) => wantGroups.has(norm(r.grp))) : allOurs;

    if (!ours.length) { buckets.noLines.push({ ...d, po, why: `purchase order ${po.po_number} holds no line in that group` }); continue; }

    const theirs = d.lines.map((l) => suffix(l.code));
    const mine = ours.map((r) => suffix(r.item_code));
    const rec = {
      ...d, po,
      theirs, mine,
      theirModels: [...new Set(d.lines.map((l) => modelOf(l.code)))],
      myModels: [...new Set(ours.map((r) => modelOf(r.item_code)))],
      received: ours.reduce((a, r) => a + Number(r.received_qty ?? 0), 0),
    };

    /* THE THREE FINDINGS ARE INDEPENDENT, and the first version of this script
       got that wrong: it `continue`d on a piece difference, so a document whose
       order disagreed never had its VARIANTS compared at all - 37 of 139 on the
       first production run (34453751607). A wrong leg height does not become
       irrelevant because the corner is also on the wrong side. A document is now
       reported under every bucket that applies. */
    const sameBag = bag(theirs) === bag(mine);
    /* Identical, or the same run written from the other end. Both are agreement. */
    const sameSeq = sameSofa(theirs, mine);

    /* Variants are compared only where the pieces MATCH POSITIONALLY, because
       that is the only case where line i on both sides is the same piece.
       Where they do not, the variant question is answered after the pieces are
       corrected, and saying so is better than comparing the wrong pair. */
    const diffs = [];
    for (let i = 0; i < d.lines.length && sameBag && sameSeq; i += 1) {
      const raw = d.lines[i].desc2;
      if (!raw) continue;
      /* parseSofa(d2, model) - the module that owns this grammar. Its shape is
         { pieces, size, color, leg, specials, ... }, NOT the ERP's variant
         keys, so the mapping onto seatHeight / legHeight / colour is spelled
         out here rather than assumed. */
      const want = parseSofa(raw, modelOf(d.lines[i].code));
      const got = ours[i].variants || {};
      const pairs = [
        ['seat height', want.size, got.seatHeight, num],
        ['leg height', want.leg === null || want.leg === undefined ? null : String(want.leg), got.legHeight, num],
        ['colour', want.color, got.colourLabel ?? got.colourId ?? got.fabricCode, norm],
      ];
      for (const [what, a, b, read] of pairs) {
        const A = read(a);
        if (!A) continue;                       // the supplier did not state it
        const B = read(b);
        if (A !== B) diffs.push(`${suffix(ours[i].item_code)} ${what}: supplier "${a}" vs ours "${b ?? ''}"`);
      }
    }
    if (!sameBag) buckets.multiset.push(rec);
    else if (!sameSeq) buckets.sequence.push(rec);
    if (sameBag && sameSeq && diffs.length) buckets.variants.push({ ...rec, diffs });
    if (sameBag && sameSeq && !diffs.length) buckets.agree.push(rec);
    if (!(sameBag && sameSeq)) buckets.variantsDeferred.push(rec);
  }

  const show = (name, list, fmt) => {
    rule();
    line(`${name} - ${list.length} document(s)`);
    rule();
    for (const r of list.slice(0, LIMIT)) line(`   ${fmt(r)}`);
    if (list.length > LIMIT) line(`   ... and ${list.length - LIMIT} more`);
  };

  head('THE ANSWER');
  line(`   supplier documents compared            ${docs.length}`);
  line(`   agree on pieces, order and variants    ${buckets.agree.length}`);
  line(`   DIFFERENT PIECES (what was ordered)    ${buckets.multiset.length}   <- costs money`);
  line(`   same pieces, DIFFERENT ORDER           ${buckets.sequence.length}   <- direction (a plain REVERSAL is NOT counted here: same sofa, other end)`);
  line(`   same build, DIFFERENT VARIANTS         ${buckets.variants.length}`);
  line(`   our purchase order not found           ${buckets.noPo.length}`);
  line(`   purchase order has no line in group    ${buckets.noLines.length}`);
  line(`   supplier row carries no PO reference   ${buckets.noRef.length}`);
  line(`   variants NOT compared (pieces differ)  ${buckets.variantsDeferred.length}   <- answered after the pieces are`);
  line('');
  const nf = { below: 0, inside: 0, above: 0, otherCompany: 0, unreadable: 0 };
  for (const d of buckets.noPo) {
    const ref = String(d.ourPoRef || '');
    const v = acNum(ref);
    if (/^2990-/i.test(ref)) nf.otherCompany += 1;
    else if (v === null) nf.unreadable += 1;
    else if (v < lo) nf.below += 1;
    else if (v > hi) nf.above += 1;
    else nf.inside += 1;
  }
  line(`   for the not-found bucket: we hold ${range?.n ?? 0} purchase order(s), of which ${held.size} `
    + `carry an AutoCount number, spanning PO-${String(lo).padStart(6, '0')} .. PO-${String(hi).padStart(6, '0')}.`);
  line(`   of the ${buckets.noPo.length} not found: ${nf.below} below our lowest, ${nf.inside} INSIDE that span, `
    + `${nf.above} above our highest, ${nf.otherCompany} another company (2990), ${nf.unreadable} unreadable.`);
  line('   None of those is a broken link. The cutover took OUTSTANDING documents only, so an');
  line('   order already closed when we cut over is absent whatever its number - which is why');
  line('   the inside-the-span count is NOT zero and must not be read as a missing migration.');

  show('DIFFERENT PIECES - the supplier built something else', buckets.multiset,
    (r) => `${(r.po.po_number || '').padEnd(16)} ${(r.ourPoRef || '').padEnd(14)} `
      + `supplier ${r.theirs.join('+')}   ours ${r.mine.join('+')}`
      + `${r.received ? `   [${r.received} already received]` : ''}`);

  show('SAME PIECES, DIFFERENT ORDER - direction', buckets.sequence,
    (r) => `${(r.po.po_number || '').padEnd(16)} ${(r.ourPoRef || '').padEnd(14)} `
      + `supplier ${r.theirs.join('+')}   ours ${r.mine.join('+')}`
      + `${r.received ? `   [${r.received} already received]` : ''}`);

  show('SAME BUILD, DIFFERENT VARIANTS', buckets.variants,
    (r) => `${(r.po.po_number || '').padEnd(16)} ${r.diffs.join(' ; ')}`);

  show('OUR PURCHASE ORDER NOT FOUND', buckets.noPo, (r) => `${(r.ourPoRef || '').padEnd(16)} ${r.why}`);
  show('NO LINE IN THAT GROUP', buckets.noLines, (r) => `${(r.po.po_number || '').padEnd(16)} ${r.why}`);

  /* ── THE OTHER DIRECTION, and the reason it exists ────────────────────────
     Everything above walks the SUPPLIER's documents and asks whether we hold
     them. That can never see a purchase order of OURS that the supplier does
     not carry - and that is the one the owner found by hand on 2026-09-11
     (HC-SO-013503 / HC-PO-2609-053: raised 09-10, three 8030 compartments, and
     absent from an export taken 09-11). "I don't know why it was missed" is
     answered here: nothing was looking this way.

     A purchase order missing from the listing is NOT automatically a defect -
     this file is one supplier's book, and we buy sofas from nine. So the answer
     is given PER SUPPLIER: a supplier the file does not cover at all is out of
     its scope, while a supplier it covers PARTLY is the chase list - documents
     they should hold and do not. */
  const oursRows = await sql`
    SELECT p.po_number, p.linked_ac_docno, p.status::text AS status,
           to_char(p.created_at, 'YYYY-MM-DD') AS created,
           coalesce(s.name, '(no supplier)') AS supplier,
           count(i.id)::int AS lines
      FROM scm.purchase_orders p
      JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
      LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
     WHERE p.company_id = ${CO}
       AND (${wantGroups ? 1 : 0} = 0 OR upper(coalesce(i.item_group, '')) = ANY(${[...(wantGroups ?? new Set())]}))
     GROUP BY 1, 2, 3, 4, 5, p.created_at
     ORDER BY p.created_at DESC`;
  const listed = new Set();
  for (const d of book.documents) {
    if (!d.ourPoRef) continue;
    listed.add(norm(d.ourPoRef));
    listed.add(norm(`HC-${d.ourPoRef}`));
  }
  const inFile = (r) => listed.has(norm(r.po_number)) || listed.has(norm(r.linked_ac_docno));
  const bySupplier = new Map();
  for (const r of oursRows) {
    const e = bySupplier.get(r.supplier) ?? { covered: 0, missing: [] };
    if (inFile(r)) e.covered += 1; else e.missing.push(r);
    bySupplier.set(r.supplier, e);
  }
  head('THE OTHER DIRECTION — OUR purchase orders the supplier listing does NOT carry');
  line(`   ${oursRows.length} purchase order(s) of ours carry a ${GROUPS} line.`);
  rule();
  for (const [supplier, e] of [...bySupplier].sort((a, b) => b[1].covered - a[1].covered)) {
    const total = e.covered + e.missing.length;
    if (!e.covered) { line(`   ${supplier.padEnd(34)} ${String(total).padStart(3)} of ours, NONE in this listing — this file is not their book`); continue; }
    if (!e.missing.length) { line(`   ${supplier.padEnd(34)} ${String(e.covered).padStart(3)} in the listing, none missing`); continue; }
    line(`   ${supplier.padEnd(34)} ${String(e.covered).padStart(3)} in the listing, ${e.missing.length} NOT — the chase list:`);
    for (const r of e.missing.slice(0, LIMIT)) line(`      ${r.created}  ${r.po_number.padEnd(17)} ${r.status.padEnd(10)} ${r.lines} line(s)`);
    if (e.missing.length > LIMIT) line(`      ... and ${e.missing.length - LIMIT} more`);
  }
  line('');
  line('   A document on a chase list is EITHER one the supplier has not keyed in yet, OR one');
  line('   they never received. Only they can say which — but until it is in their book, this');
  line('   check can say nothing about whether what they build will match what we ordered.');

  head('READ-ONLY. Nothing above was written.');
  line('The export carries no line number, so ORDER is the file\'s row order - which is');
  line('why the multiset is compared first and reported apart. A multiset finding stands');
  line('on its own; a sequence finding is read together with the drawing.');
} finally {
  await sql.end({ timeout: 5 });
}
