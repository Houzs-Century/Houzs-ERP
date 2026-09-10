#!/usr/bin/env node
/* MEASURE-ONLY. Sofa and bedframe: what does AutoCount's own spec text say that
   the ERP's purchase order does NOT already say?
 *
 * THE OWNER'S ASK, 2026-09-10: 「ok 包过sofa bedframe也是要检查」 — extend the
 * `variants.extraAddonNote` backfill (pillows / SP mattresses / dining) to sofa
 * and bedframe, so the supplier's purchase order states what was ordered.
 *
 * WHY SOFA AND BEDFRAME ARE NOT THE SAME PROBLEM, and why this script exists
 * instead of a backfill. Their spec is ALREADY STRUCTURED. fabricCode,
 * colourLabel, seatHeight, legHeight, divanHeight, gap and totalHeight live in
 * `variants`, and `buildVariantSummary` already prints them as the Fabric /
 * SEAT / LEG / DIVAN / GAP / T.Heights segments that ARE `description2` on
 * every purchase order (src/services/autocount-writeback.ts:952 and every
 * `description2:` assignment under src/scm). So the book's line
 *
 *     1+1NA+L(26/28'Inch)/Col:KIV/Bottom upgrade to umbrella fabric
 *
 * copied WHOLE into the note makes the supplier's document read
 *
 *     SEAT 26 / LEG 2" / SPECIAL: 1+1NA+L(26/28'Inch)/Col:KIV/Bottom upgrade...
 *
 * — and part of that the document already said. Noise on a supplier document is
 * how a real instruction gets skipped. That is a trade-off with a cost on both
 * sides, so this script MEASURES it and the decision stays the owner's.
 *
 * IT WRITES NOTHING. SELECTs only, no DDL, no transaction, no UPDATE anywhere
 * in the file. Exit 0 for every legitimate answer including "no rows" — the
 * ANSWER is the output, and a red job reads as "the check broke".
 *
 * RE-RUN: read-only and stateless. A second run reports whatever is true then.
 *
 * USAGE (tsx, because it imports the canonical buildVariantSummary from src/):
 *     npx tsx scripts/check-sofa-bedframe-book-text.mjs
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1 (Houzs Century)
 *   EXAMPLES       how many worked examples per shape (default 10)
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';
import { coverageBag, residueOf, kindOf, sizeTokensFromItemCode } from './lib/book-text-residue.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL is not set. Aborting.'); process.exit(1); }

const CO = Number(process.env.COMPANY_ID ?? 1);
const EXAMPLES = Math.max(1, Number(process.env.EXAMPLES ?? 10));
const LABEL = '账本原文:';
/* src/services/autocount-sofa-collapse.ts:251 — AutoCount stores Desc2 as
   nvarchar(100) and refuses the whole document rather than truncating. */
const AC_DESC2_MAX = 100;

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const raw = (m = '') => console.log(m);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const norm = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim();
const pad = (n, w = 6) => String(n).padStart(w);
const pct = (n, d) => (d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`);

/* THE SPLITTING TEST lives in scripts/lib/book-text-residue.mjs — read that
   file's header for what it measures, why an exact-string match is NOT a
   sufficient test here, and both of its error directions. It is a library and
   not a local helper so that a local re-analysis of an exported corpus and this
   production probe compute the same answer from the same code. */

const KIV = 'colour or size not yet decided (KIV / TBC)';
const BUILD = 'a build / piece list';
/* Which ONE kind best describes a line, when its leftover carries several. A
   free-text instruction outranks a repeated measurement, because it is the kind
   that is lost if we do not carry it. */
const PRIORITY = [
  'an instruction to change / add / remove',
  'a fabric or material note',
  'something else',
  'a measurement in words',
  BUILD,
  KIV,
];
const dominantKind = (r) => {
  const ks = new Set(r.resS.map(kindOf));
  return PRIORITY.find((p) => ks.has(p)) ?? '(none)';
};

/* The book's own Desc2, keyed by DtlKey — the OLDER of the two book copies.
   See preserve-autocount-desc2-in-remark.mjs for why neither source alone is
   complete. An absent file is a finding, not a crash. */
function loadSnapshot() {
  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(path.join(HERE, 'data', 'ac-line-desc2.json.gz'))).toString('utf8'));
    const so = new Map();
    for (const r of parsed.so ?? []) { const d = norm(r.d2); if (d) so.set(Number(r.k), d); }
    return { ok: true, exportedAt: parsed.exportedAt, source: parsed.source, so };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), so: new Map() };
  }
}

/* Header statuses in which the order no longer creates demand. Union of
   scripts/lib/so-terminal-states.mjs and check-delivered-but-open.mjs's DONE —
   the two lists differ, and taking the union means a line is only called OPEN
   when BOTH readings agree it is. */
const TERMINAL = new Set(['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'COMPLETED', 'FULLY_DELIVERED']);
const NOT_YET = new Set(['DRAFT']);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  const snap = loadSnapshot();
  log('=== 0. SCOPE ===');
  log(`company=${CO}   groups=sofa,bedframe   source=live production, read-only`);
  log(snap.ok
    ? `book snapshot ac-line-desc2.json.gz: ${snap.so.size} SO Desc2 values, exportedAt ${snap.exportedAt} (${snap.source})`
    : `book snapshot UNREADABLE (${snap.reason}) — the snapshot column reads 0. That is a gap, not a zero.`);

  const rows = await sql`
    SELECT i.id::text                                  AS id,
           i.doc_no, i.line_no, i.item_code,
           LOWER(COALESCE(i.item_group, ''))           AS item_group,
           i.description2, i.remark, i.variants, i.linked_ac_dtlkey,
           COALESCE(i.qty, 0)::numeric                 AS qty,
           COALESCE(i.cancelled, false)                AS cancelled,
           UPPER(COALESCE(h.status::text, ''))         AS so_status,
           h.linked_ac_docno,
           COALESCE(d.net_delivered, 0)::numeric       AS net_delivered
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      LEFT JOIN (
        SELECT doi.so_item_id, SUM(doi.qty)::numeric AS net_delivered
          FROM scm.delivery_order_items doi
          JOIN scm.delivery_orders dd ON dd.id = doi.delivery_order_id
         WHERE doi.so_item_id IS NOT NULL
           AND UPPER(COALESCE(dd.status::text, '')) NOT IN ('DRAFT', 'CANCELLED')
         GROUP BY doi.so_item_id
      ) d ON d.so_item_id = i.id
     WHERE h.company_id = ${CO}
       AND LOWER(COALESCE(i.item_group, '')) IN ('sofa', 'bedframe')
     ORDER BY i.doc_no, i.line_no`;

  log(`sofa + bedframe sales-order lines: ${rows.length}`
    + `  (sofa ${rows.filter((r) => r.item_group === 'sofa').length},`
    + ` bedframe ${rows.filter((r) => r.item_group === 'bedframe').length})`);
  if (rows.length === 0) {
    log(`NO ROWS. Either company ${CO} has no sofa/bedframe lines or item_group is spelled`);
    log('differently there. That is the finding; nothing here is broken.');
    return;
  }

  const census = new Map();
  for (const r of rows) census.set(r.so_status || '(blank)', (census.get(r.so_status || '(blank)') ?? 0) + 1);
  log('order-status census (raw, nothing folded):');
  for (const [s, n] of [...census].sort((a, b) => b[1] - a[1])) log(`  ${pad(n)}  ${s}`);
  log(`lines with the CANCELLED line flag: ${rows.filter((r) => r.cancelled).length}`);
  log(`lines on an order linked to AutoCount: ${rows.filter((r) => r.linked_ac_docno).length}`);
  log('');

  const { buildVariantSummary } = await import('../src/scm/shared/variant-summary.ts');

  /* Sibling item codes per order — part of the WIDE coverage bag. */
  const siblings = new Map();
  for (const r of rows) {
    if (!siblings.has(r.doc_no)) siblings.set(r.doc_no, []);
    siblings.get(r.doc_no).push(String(r.item_code ?? ''));
  }

  const facts = [];
  for (const r of rows) {
    const generated = norm(buildVariantSummary(String(r.item_group ?? ''), r.variants ?? null));
    const variants = (r.variants && typeof r.variants === 'object') ? r.variants : {};

    const d2 = norm(r.description2);
    const remark = norm(r.remark);
    const idx = remark.lastIndexOf(LABEL);
    const fromRemark = idx === -1 ? '' : norm(remark.slice(idx + LABEL.length));
    const key = r.linked_ac_dtlkey == null ? null : Number(r.linked_ac_dtlkey);
    const fromSnap = key == null ? '' : (snap.so.get(key) ?? '');

    /* The guard that makes this a COPY and not a re-derivation, applied to all
       three sources alike: a value that EXACTLY equals our generated summary is
       OUR text, not the book's, and is not counted as book text. */
    const isOurs = (v) => Boolean(v) && Boolean(generated) && v === generated;
    const src = {
      description2: d2 && !isOurs(d2) ? d2 : '',
      remark: fromRemark && !isOurs(fromRemark) ? fromRemark : '',
      snapshot: fromSnap && !isOurs(fromSnap) ? fromSnap : '',
    };
    const excluded = {
      description2: Boolean(d2) && isOurs(d2),
      remark: Boolean(fromRemark) && isOurs(fromRemark),
      snapshot: Boolean(fromSnap) && isOurs(fromSnap),
    };

    const winner = src.description2 ? 'description2' : (src.remark ? 'remark' : (src.snapshot ? 'snapshot' : ''));
    const book = winner ? src[winner] : '';

    const narrow = coverageBag(generated);
    /* WIDE — what the whole purchase order says, not only its Description 2:
       the document also lists the item CODES, and a sofa's build is held in the
       ERP as separate piece lines with their own codes. `(K)` on a bedframe code
       is the reason the book's `KING SIZE` is not new information. */
    const wide = coverageBag(`${generated} ${r.item_code ?? ''} `
      + `${(siblings.get(r.doc_no) ?? []).join(' ')} ${sizeTokensFromItemCode(r.item_code)}`);
    const resN = book ? residueOf(book, narrow, false) : [];
    const resW = book ? residueOf(book, wide, false) : [];
    const resS = book ? residueOf(book, wide, true) : [];

    const delivered = Number(r.net_delivered) > 0 && Number(r.net_delivered) >= Number(r.qty);
    const bucket = (r.cancelled || TERMINAL.has(r.so_status)) ? 'closed'
      : (NOT_YET.has(r.so_status) ? 'notyet' : (delivered ? 'closed' : 'open'));

    const noteAlready = norm(variants.extraAddonNote);
    const whole = book ? (generated ? `${generated} / SPECIAL: ${book}` : `SPECIAL: ${book}`) : generated;
    const onlyNew = resS.length
      ? (generated ? `${generated} / SPECIAL: ${resS.join(' / ')}` : `SPECIAL: ${resS.join(' / ')}`)
      : generated;

    facts.push({
      ...r, generated, src, excluded, winner, book, resN, resW, resS, bucket, noteAlready,
      genLen: generated.length, wholeLen: whole.length, onlyNewLen: onlyNew.length, whole, onlyNew,
      shape: book ? (resN.length === 0 ? 'A' : 'B') : '-',
      shapeWide: book ? (resW.length === 0 ? 'A' : 'B') : '-',
      shapeLabel: book ? (resS.length === 0 ? 'A' : 'B') : '-',
    });
  }

  section1(facts);
  section2(facts);
  section3(facts);
  section4(facts);
  section5(facts);
}

/* ── 1. WHERE THE BOOK TEXT IS, AND HOW MUCH THE THREE SOURCES OVERLAP ───── */
function section1(f) {
  const has = (k) => f.filter((r) => r.src[k]);
  const any = f.filter((r) => r.book);
  log('=== 1. WHERE THE BOOK TEXT IS ===');
  log('Three candidate copies. They are NOT independent: the 账本原文 remark was written');
  log('FROM the other two on 2026-09-04 (preserve-autocount-desc2-in-remark.mjs), so the');
  log('question that matters is what each one RECOVERS that the others no longer hold —');
  log('description2 is server-generated on every save, so a line saved since the re-import');
  log('has lost the book text there while the remark still carries it.');
  log('');
  log(`  description2 holds book text (not our summary) : ${pad(has('description2').length)}`);
  log(`  remark carries the 账本原文 label               : ${pad(has('remark').length)}`);
  log(`  gz snapshot has a Desc2 for this DtlKey        : ${pad(has('snapshot').length)}`);
  log('');
  const key = (r) => `${r.src.description2 ? 'D' : '-'}${r.src.remark ? 'R' : '-'}${r.src.snapshot ? 'S' : '-'}`;
  const venn = new Map();
  for (const r of f) venn.set(key(r), (venn.get(key(r)) ?? 0) + 1);
  log('  OVERLAP (D = description2, R = remark label, S = snapshot; - = absent):');
  for (const [k, n] of [...venn].sort((a, b) => b[1] - a[1])) {
    log(`    ${k}  ${pad(n)}${k === '---' ? '   no book text on this line at all' : ''}`);
  }
  log('');
  log(`  lines carrying a book text from ANY source     : ${pad(any.length)} of ${f.length}`);
  log(`    where description2 is the source that wins   : ${pad(any.filter((r) => r.winner === 'description2').length)}`);
  log(`    where the remark RECOVERS it (d2 is gone)    : ${pad(any.filter((r) => r.winner === 'remark').length)}`);
  log(`    where only the snapshot has it               : ${pad(any.filter((r) => r.winner === 'snapshot').length)}`);
  log('');
  log('  excluded by the copy-not-derive guard (the value EXACTLY equals our own');
  log("  buildVariantSummary output, so it is our text and not the book's):");
  log(`    description2 : ${pad(f.filter((r) => r.excluded.description2).length)}`);
  log(`    remark       : ${pad(f.filter((r) => r.excluded.remark).length)}`);
  log(`    snapshot     : ${pad(f.filter((r) => r.excluded.snapshot).length)}`);
  log('');
  log('  lines that ALREADY carry variants.extraAddonNote (a backfill would skip these):'
    + ` ${f.filter((r) => r.noteAlready).length}`);
  log('');
}

/* ── 2. THE TWO POPULATIONS, UNDER THREE READINGS ─────────────────────────── */
function section2(f) {
  const any = f.filter((r) => r.book);
  log('=== 2. THE SPLIT: does the book say anything the document does not already say? ===');
  log('');
  log('FIRST, WHY EXACT MATCHING IS NOT THE TEST. Read the next two numbers with their');
  log('circularity stated: the copy-not-derive guard has ALREADY removed the lines whose');
  log('text exactly equals our summary (they are our text, not the book\'s), and section 1');
  log('reports how many that was. So the first line below is 0 by construction. The second');
  log('is not, and it is the one that carries the argument — relaxing the comparison to');
  log('ignore case and whitespace recovers almost nothing, which is what says the two');
  log('sides differ in WORDING and not merely in spacing.');
  const flat = (s) => s.toUpperCase().replace(/\s+/g, ' ').trim();
  log(`  book text EXACTLY equals our summary            : ${pad(any.filter((r) => r.book === r.generated).length)} of ${any.length}   (0 by construction)`);
  log(`  ...ignoring case and whitespace                 : ${pad(any.filter((r) => flat(r.book) === flat(r.generated)).length)} of ${any.length}`);
  log('  An exact test would therefore call every one of these lines "carries something');
  log('  new" and would be measuring spelling. The test below is used instead.');
  log('');
  log('THE TEST — residue after coverage. scripts/lib/book-text-residue.mjs states it in');
  log('full, with both of its error directions. Three readings, deliberately, because one');
  log('number here would be a false precision:');
  log('  NARROW  coverage = the generated summary alone — exactly what description2 says.');
  log('  WIDE    coverage = that plus the item codes on the same order and the bed size the');
  log('          code already states, which the purchase order also prints.');
  log('  LABEL   = WIDE, plus the words BOTH systems use as segment LABELS dropped, so the');
  log('          book\'s "M.GAP: 12 INCH" is compared against our "GAP 12" on the NUMBER.');
  log('  NARROW is the UPPER bound on "carries something new"; LABEL is the LOWER bound.');
  log('');
  const row = (name, key) => {
    const a = any.filter((r) => r[key] === 'A').length;
    const b = any.filter((r) => r[key] === 'B').length;
    log(`  ${name.padEnd(8)} A (says nothing new) ${pad(a)} (${pct(a, any.length)})`
      + `   B (carries something new) ${pad(b)} (${pct(b, any.length)})`);
  };
  row('NARROW', 'shape');
  row('WIDE', 'shapeWide');
  row('LABEL', 'shapeLabel');
  log('');
  const b = any.filter((r) => r.shapeLabel === 'B');
  const kinds = new Map();
  for (const r of b) for (const k of new Set(r.resS.map(kindOf))) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  log('  WHAT the LABEL-reading leftover is (a line counted once per kind it carries):');
  for (const [k, n] of [...kinds].sort((x, y) => y[1] - x[1])) log(`    ${pad(n)}  ${k}`);
  log('');
  log('  and the ONE kind that best describes each line, by this priority:');
  log(`    ${PRIORITY.join(' > ')}`);
  const dom = new Map();
  for (const r of b) { const d = dominantKind(r); dom.set(d, (dom.get(d) ?? 0) + 1); }
  for (const k of PRIORITY) if (dom.get(k)) log(`    ${pad(dom.get(k))}  ${k}`);
  log('');
  for (const g of ['sofa', 'bedframe']) {
    const sub = any.filter((r) => r.item_group === g);
    log(`  ${g.padEnd(9)} LABEL A ${pad(sub.filter((r) => r.shapeLabel === 'A').length)}`
      + `   LABEL B ${pad(sub.filter((r) => r.shapeLabel === 'B').length)}   (of ${sub.length} with book text)`);
  }
  log('');
}

/* ── 3. OPEN vs DELIVERED / CLOSED ────────────────────────────────────────── */
function section3(f) {
  log('=== 3. OPEN vs DELIVERED / CLOSED ===');
  log('OPEN      = the order header is in none of CANCELLED / CLOSED / SHIPPED / DELIVERED /');
  log('            INVOICED / COMPLETED / FULLY_DELIVERED, the line is not cancelled, and its');
  log('            delivered quantity (delivery_order_items on a DO that is not DRAFT or');
  log('            CANCELLED) is short of the ordered quantity.');
  log('CLOSED    = a terminal header status, a cancelled line, or delivery already covering');
  log('            the ordered quantity.');
  log('NOT YET   = DRAFT, on its own row: a draft order has not been placed, so it is neither');
  log('            outstanding work nor finished work.');
  log('');
  log('Split by the LABEL reading (the lower bound — the lines where the book most');
  log('defensibly knows something the document does not).');
  log('');
  const cell = (bkt, shape) => f.filter((r) => r.bucket === bkt && r.shapeLabel === shape).length;
  log('                        shape A      shape B     no book text     total');
  for (const bkt of ['open', 'closed', 'notyet']) {
    const all = f.filter((r) => r.bucket === bkt);
    log(`  ${bkt.padEnd(20)}${pad(cell(bkt, 'A'), 8)}${pad(cell(bkt, 'B'), 13)}${pad(cell(bkt, '-'), 13)}${pad(all.length, 12)}`);
  }
  log('');
  for (const bkt of ['open', 'closed']) {
    const sub = f.filter((r) => r.bucket === bkt && r.shapeLabel === 'B');
    log(`  ${bkt.toUpperCase()} lines carrying something new, by dominant kind (${sub.length}):`);
    const dom = new Map();
    for (const r of sub) { const d = dominantKind(r); dom.set(d, (dom.get(d) ?? 0) + 1); }
    for (const k of PRIORITY) if (dom.get(k)) log(`    ${pad(dom.get(k))}  ${k}`);
    log(`    of which the leftover is ONLY "${KIV}": ${sub.filter((r) => r.resS.every((a) => kindOf(a) === KIV)).length}`);
    log(`    of which the leftover is ONLY "${BUILD}": ${sub.filter((r) => r.resS.every((a) => kindOf(a) === BUILD)).length}`);
    log('');
  }
}

/* ── 4. WORKED EXAMPLES ───────────────────────────────────────────────────── */
function section4(f) {
  log('=== 4. WORKED EXAMPLES — real rows, side by side ===');
  log('Each example prints the book text, the string our summary produces for that line');
  log('TODAY (which is what description2 and the purchase order say), what the LABEL');
  log('reading found left over, and what the purchase order would read under each option.');
  log('');
  const spread = (list, n) => {
    if (list.length <= n) return list;
    const step = list.length / n;
    return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
  };
  const show = (r, idx) => {
    raw(`  [${idx}] ${r.doc_no} line ${r.line_no}  ${r.item_group}  ${r.item_code ?? '(no code)'}`
      + `  qty ${Number(r.qty)}  ${r.bucket.toUpperCase()}  (source: ${r.winner})`);
    raw(`      book text  : ${r.book}`);
    raw(`      ERP today  : ${r.generated || '(the summary is EMPTY for this line)'}`);
    raw(`      left over  : ${r.resS.length ? r.resS.map((a) => JSON.stringify(a)).join('  |  ') : '(nothing — shape A)'}`);
    raw(`      copy WHOLE : ${r.whole}${r.wholeLen > AC_DESC2_MAX ? `   [${r.wholeLen} chars — over AutoCount's ${AC_DESC2_MAX}]` : ''}`);
    if (r.resS.length) {
      raw(`      copy NEW   : ${r.onlyNew}${r.onlyNewLen > AC_DESC2_MAX ? `   [${r.onlyNewLen} chars]` : ''}`);
    }
    raw('');
  };
  const a = f.filter((r) => r.shapeLabel === 'A');
  log(`--- SHAPE A: the book says nothing the document does not already say (${a.length} lines) ---`);
  log('If the owner picks "copy whole", these are the lines whose purchase order gains a');
  log('SPECIAL segment that only repeats itself.');
  log('');
  spread(a, EXAMPLES).forEach((r, i) => show(r, i + 1));

  const b = f.filter((r) => r.shapeLabel === 'B');
  log(`--- SHAPE B: the book carries something the document does NOT say (${b.length} lines) ---`);
  log('One example per dominant kind first, then a spread across the rest.');
  log('');
  const picked = [];
  const seen = new Set();
  for (const r of b) {
    const k = dominantKind(r);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(r);
  }
  for (const r of spread(b.filter((x) => !picked.includes(x)), Math.max(0, EXAMPLES - picked.length))) picked.push(r);
  picked.slice(0, Math.max(EXAMPLES, seen.size)).forEach((r, i) => show(r, i + 1));

  log('--- The most common leftovers across the whole corpus, so the shapes are nameable ---');
  const atoms = new Map();
  for (const r of b) {
    for (const at of r.resS) {
      const k = at.toUpperCase().replace(/\s+/g, ' ').trim();
      atoms.set(k, (atoms.get(k) ?? 0) + 1);
    }
  }
  for (const [at, n] of [...atoms].sort((x, y) => y[1] - x[1]).slice(0, 30)) {
    raw(`  ${pad(n, 5)}  ${kindOf(at).padEnd(42)} ${JSON.stringify(at)}`);
  }
  raw(`  distinct leftover phrases: ${atoms.size}`);
  raw('');
}

/* ── 5. WHAT COPYING WOULD COST THE DOCUMENT ──────────────────────────────── */
function section5(f) {
  const any = f.filter((r) => r.book);
  const b = f.filter((r) => r.shapeLabel === 'B');
  log('=== 5. THE COST, IN CHARACTERS ON THE DOCUMENT ===');
  log('description2 is what the supplier reads and it is also what the AutoCount write-back');
  log("sends as SODTL.Desc2 / PODTL.Desc2, an nvarchar(100). Over that, the abbreviator's");
  log("last rung replaces the whole SPECIAL segment with the owner's pointer sentence");
  log('"Special Order: Refer to ERP" (src/services/autocount-desc2-abbrev.ts), so AutoCount');
  log('gets the pointer instead of the text. The supplier PDF is not capped and keeps it all.');
  log('');
  const lenStats = (vals) => {
    if (!vals.length) return 'n/a';
    const s = [...vals].sort((x, y) => x - y);
    return `min ${s[0]}  median ${s[Math.floor(s.length / 2)]}  p90 ${s[Math.floor(s.length * 0.9)]}  max ${s[s.length - 1]}`;
  };
  log(`  description2 length TODAY (lines with book text) : ${lenStats(any.map((r) => r.genLen))}`);
  log(`  ...if the WHOLE book text is appended            : ${lenStats(any.map((r) => r.wholeLen))}`);
  log(`  ...if only the LEFTOVER is appended              : ${lenStats(b.map((r) => r.onlyNewLen))}`);
  log('');
  log(`  over ${AC_DESC2_MAX} chars today                          : ${pad(any.filter((r) => r.genLen > AC_DESC2_MAX).length)} of ${any.length}`);
  log(`  over ${AC_DESC2_MAX} after copying WHOLE                  : ${pad(any.filter((r) => r.wholeLen > AC_DESC2_MAX).length)} of ${any.length}`);
  log(`  over ${AC_DESC2_MAX} after copying only the LEFTOVER      : ${pad(b.filter((r) => r.onlyNewLen > AC_DESC2_MAX).length)} of ${b.length}`);
  log('  of the WHOLE-copy overflows, shape A (pure repetition, and the AutoCount copy');
  log(`  loses its text to the pointer for nothing)       : ${any.filter((r) => r.wholeLen > AC_DESC2_MAX && r.shapeLabel === 'A').length}`);
  log('');
}

main()
  .catch((e) => {
    /* A read-only probe exits non-zero ONLY when the database could not answer.
       Every legitimate answer, including "no rows", is a finding and exits 0. */
    console.error(`query failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(async () => { await sql.end({ timeout: 5 }); });
