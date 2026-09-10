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
 *     SEAT 26 / LEG 2" / SPECIAL: 1+1NA+L(26/28'Inch)/Col:KIV/Bottom upgrade…
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

/* ── THE SPLITTING TEST ────────────────────────────────────────────────────
   An EXACT-STRING match between the book text and our summary is NOT a
   sufficient test and must not be used as one: the two say overlapping things
   in different words — the book writes `L(26/28'Inch)`, we write `SEAT 26` —
   so an exact comparison would put almost every line in "carries something
   new" and prove nothing. Measured in section 2 below and printed, so the
   claim is not taken on trust.

   What is measured instead is RESIDUE AFTER COVERAGE:

     1. the book text is cut into ATOMS on `/`, `,`, `;` and newline, but only
        OUTSIDE brackets — so `L(26/28'Inch)` stays one atom and does not shred;
     2. a COVERAGE bag is built from the line's own generated summary
        (NARROW = exactly what description2 prints) and, separately, from the
        summary plus the item codes on the same order (WIDE = what the whole
        document says, since the PO also lists the codes);
     3. an atom is COVERED when its letters-and-digits identity is contained in
        the coverage identity (3 chars or more, so `NA` cannot match inside
        `NAVY`), or when EVERY significant token of the atom appears as a whole
        token in the coverage bag;
     4. RESIDUE = the atoms left over. Empty residue -> shape A, the book says
        nothing the document does not already say. Non-empty -> shape B.

   ITS ERROR DIRECTIONS, both real:

     * FALSE POSITIVES INTO B (the dominant one). The test compares SURFACE
       TOKENS, so the same fact in different words lands in B — the book's
       `1+1NA+L` describes the same build the ERP holds as separate piece lines
       with their own item codes, and `26/28'Inch` is the seat depth we print as
       `SEAT 26`. So B is an UPPER BOUND on how much genuinely new information
       there is. WIDE coverage exists to bound it from the other side.
     * FALSE NEGATIVES INTO A. An atom whose words happen to appear in the
       summary for another reason reads as covered — e.g. a book note naming a
       fabric code the fabric segment already carries, where the note was
       actually asking for a CHANGE to it. Shape A is therefore a slight
       over-count and shape B a slight under-count on that axis.

   Neither direction is fixable without reading each line, which is what the
   worked examples in section 4 are for. */
const ALNUM = (s) => String(s).toUpperCase().replace(/NILON/g, 'NYLON').replace(/[^A-Z0-9]/g, '');
const TOKENS = (s) => String(s).toUpperCase().replace(/NILON/g, 'NYLON').split(/[^A-Z0-9]+/).filter(Boolean);
/* Deliberately tiny. A unit word and a bare conjunction carry no specification;
   everything else — including NO, WITHOUT, CHANGE — is information and stays. */
const STOP = new Set(['INCH', 'INCHES', 'CM', 'MM', 'FT', 'COL', 'COLOR', 'COLOUR', 'AND', 'THE', 'TO', 'OF', 'X']);

function atomsOf(text) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of String(text)) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === '/' || ch === ',' || ch === ';' || ch === '\n')) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function coverageBag(text) {
  return { id: ALNUM(text), toks: new Set(TOKENS(text)) };
}

function isCovered(atom, bag) {
  const id = ALNUM(atom);
  if (!id) return true;
  if (id.length >= 3 && bag.id.includes(id)) return true;
  const toks = TOKENS(atom).filter((t) => !STOP.has(t));
  if (toks.length === 0) return true;
  return toks.every((t) => bag.toks.has(t));
}

const residueOf = (book, bag) => atomsOf(book).filter((a) => !isCovered(a, bag));

/* Named shapes for the residue, so the report says WHAT is new and not only how
   much. Ordered: the first test that matches wins.

   THE BUILD TEST IS CHECKED BEFORE THE MEASUREMENT TEST on purpose. A sofa
   build like `1+1NA+L(26/28'Inch)` contains a measurement, so a measurement-
   first order would file the whole build under "a measurement in words" and
   hide the single most common residue there is. A build is recognised
   structurally instead: it joins its parts with `+`, and every letter-run in it
   is a short piece code (NA, L, CNR, ER, ELT, INCH) rather than a word. */
const isBuildList = (atom) =>
  atom.includes('+') && (atom.match(/[A-Za-z]+/g) ?? []).every((w) => w.length <= 5);
const KINDS = [
  ['colour or size not yet decided (KIV / TBC)', /\b(KIV|TBC|TBA|PENDING)\b/i],
  ['a fabric or material note', /\b(FABRIC|NYLON|NILON|LEATHER|PU|COTTON|LINEN|UMBRELLA|VELVET|CANVAS|MATERIAL|CUSHION|FOAM)\b/i],
  ['an instruction to change / add / remove', /\b(UPGRADE|CHANGE|ADD|ADDITIONAL|EXTRA|REMOVE|WITHOUT|NO|NONE|NON|INSTEAD|SWAP|REPLACE|CUSTOM|SPECIAL)\b/i],
  ['a build / piece list', isBuildList],
  ['a measurement in words', /\d\s*(?:"|''|INCH|INCHES|CM|MM|FT|'|”)/i],
];
const kindOf = (atom) => (KINDS.find(([, t]) => (typeof t === 'function' ? t(atom) : t.test(atom)))
  ?? ['something else', null])[0];

/* The book's own Desc2, keyed by DtlKey — the OLDER of the two book copies.
   See preserve-autocount-desc2-in-remark.mjs for why neither source alone is
   complete. Absent file is a finding, not a crash. */
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
    : `book snapshot UNREADABLE (${snap.reason}) — the snapshot column of this report will read 0. That is a gap, not a zero.`);

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
    log('NO ROWS. Either company ' + CO + ' has no sofa/bedframe lines or item_group is spelled');
    log('differently there. That is the finding; nothing here is broken.');
    return;
  }

  const census = new Map();
  for (const r of rows) census.set(r.so_status || '(blank)', (census.get(r.so_status || '(blank)') ?? 0) + 1);
  log('order-status census (raw, nothing folded):');
  for (const [s, n] of [...census].sort((a, b) => b[1] - a[1])) log(`  ${pad(n)}  ${s}`);
  log(`lines on a CANCELLED line flag: ${rows.filter((r) => r.cancelled).length}`);
  log(`lines on an order linked to AutoCount: ${rows.filter((r) => r.linked_ac_docno).length}`);
  log('');

  const { buildVariantSummary } = await import('../src/scm/shared/variant-summary.ts');

  /* Sibling item codes per order — the WIDE coverage bag. The purchase order
     lists the codes as well as description2, so a build the book spells out in
     words may already be on the document as separate coded lines. */
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
    const wide = coverageBag(`${generated} ${r.item_code ?? ''} ${(siblings.get(r.doc_no) ?? []).join(' ')}`);
    const resN = book ? residueOf(book, narrow) : [];
    const resW = book ? residueOf(book, wide) : [];

    const delivered = Number(r.net_delivered) > 0 && Number(r.net_delivered) >= Number(r.qty);
    const bucket = (r.cancelled || TERMINAL.has(r.so_status)) ? 'closed'
      : (NOT_YET.has(r.so_status) ? 'notyet' : (delivered ? 'closed' : 'open'));

    const noteAlready = norm(variants.extraAddonNote);
    const projected = book ? (generated ? `${generated} / SPECIAL: ${book}` : `SPECIAL: ${book}`) : generated;

    facts.push({
      ...r, generated, src, excluded, winner, book, resN, resW, bucket, noteAlready,
      genLen: generated.length, projLen: projected.length, projected,
      shape: book ? (resN.length === 0 ? 'A' : 'B') : '-',
      shapeWide: book ? (resW.length === 0 ? 'A' : 'B') : '-',
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
    const note = k === '---' ? '   no book text on this line at all' : '';
    log(`    ${k}  ${pad(n)}${note}`);
  }
  log('');
  log(`  lines carrying a book text from ANY source     : ${pad(any.length)} of ${f.length}`);
  log(`    where description2 is the source that wins   : ${pad(any.filter((r) => r.winner === 'description2').length)}`);
  log(`    where the remark RECOVERS it (d2 is gone)    : ${pad(any.filter((r) => r.winner === 'remark').length)}`);
  log(`    where only the snapshot has it               : ${pad(any.filter((r) => r.winner === 'snapshot').length)}`);
  log('');
  log('  excluded by the copy-not-derive guard (the value EXACTLY equals our own');
  log('  buildVariantSummary output, so it is our text and not the book\'s):');
  log(`    description2 : ${pad(f.filter((r) => r.excluded.description2).length)}`);
  log(`    remark       : ${pad(f.filter((r) => r.excluded.remark).length)}`);
  log(`    snapshot     : ${pad(f.filter((r) => r.excluded.snapshot).length)}`);
  log('');
  log(`  lines that ALREADY carry variants.extraAddonNote (a backfill would skip these):`
    + ` ${f.filter((r) => r.noteAlready).length}`);
  log('');
}

/* ── 2. THE TWO POPULATIONS ───────────────────────────────────────────────── */
function section2(f) {
  const any = f.filter((r) => r.book);
  log('=== 2. THE SPLIT: does the book say anything the document does not already say? ===');
  log('');
  log('FIRST, WHY EXACT MATCHING IS NOT THE TEST. Measured on these same rows:');
  const exact = any.filter((r) => r.book === r.generated).length;
  const ci = any.filter((r) => r.book.toUpperCase().replace(/\s+/g, ' ') === r.generated.toUpperCase().replace(/\s+/g, ' ')).length;
  log(`  book text EXACTLY equals our summary            : ${pad(exact)} of ${any.length}`);
  log(`  ...even ignoring case and whitespace            : ${pad(ci)} of ${any.length}`);
  log('  So an exact comparison would call almost every line "carries something new" and');
  log('  would be measuring spelling, not information. The test below is used instead.');
  log('');
  log('THE TEST — residue after coverage (the file header states it in full, with its');
  log('two error directions). NARROW coverage = the generated summary alone, which is');
  log('exactly what description2 prints. WIDE coverage = that plus the item codes on the');
  log('same order, which the purchase order also lists.');
  log('');
  const a = any.filter((r) => r.shape === 'A');
  const b = any.filter((r) => r.shape === 'B');
  const aw = any.filter((r) => r.shapeWide === 'A');
  const bw = any.filter((r) => r.shapeWide === 'B');
  log(`  NARROW  shape A — the book says nothing new     : ${pad(a.length)}  (${pct(a.length, any.length)})`);
  log(`  NARROW  shape B — the book carries something new: ${pad(b.length)}  (${pct(b.length, any.length)})`);
  log(`  WIDE    shape A                                 : ${pad(aw.length)}  (${pct(aw.length, any.length)})`);
  log(`  WIDE    shape B                                 : ${pad(bw.length)}  (${pct(bw.length, any.length)})`);
  log('  The gap between NARROW B and WIDE B is the text the DOCUMENT already carries');
  log('  through its item codes even though description2 does not spell it out.');
  log('');
  const kinds = new Map();
  for (const r of b) {
    const seen = new Set();
    for (const atom of r.resN) {
      const k = kindOf(atom);
      if (seen.has(k)) continue;
      seen.add(k);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
  }
  log('  WHAT the residue is, on the NARROW test (a line counted once per kind):');
  for (const [k, n] of [...kinds].sort((x, y) => y[1] - x[1])) log(`    ${pad(n)}  ${k}`);
  log('');
  for (const g of ['sofa', 'bedframe']) {
    const sub = any.filter((r) => r.item_group === g);
    log(`  ${g.padEnd(9)} A ${pad(sub.filter((r) => r.shape === 'A').length)}   B ${pad(sub.filter((r) => r.shape === 'B').length)}   (of ${sub.length} with book text)`);
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
  log('CLOSED    = anything else with a terminal header status, a cancelled line, or delivery');
  log('            already covering the ordered quantity.');
  log('NOT YET   = DRAFT. Printed on its own row rather than folded either way: a draft order');
  log('            has not been placed, so it is neither outstanding work nor finished work.');
  log('');
  const cell = (bucket, shape) => f.filter((r) => r.bucket === bucket && r.shape === shape).length;
  log('                        shape A      shape B     no book text     total');
  for (const bkt of ['open', 'closed', 'notyet']) {
    const all = f.filter((r) => r.bucket === bkt);
    log(`  ${bkt.padEnd(20)}${pad(cell(bkt, 'A'), 8)}${pad(cell(bkt, 'B'), 13)}${pad(cell(bkt, '-'), 13)}${pad(all.length, 12)}`);
  }
  log(`  ${'TOTAL'.padEnd(20)}${pad(f.filter((r) => r.shape === 'A').length, 8)}${pad(f.filter((r) => r.shape === 'B').length, 13)}${pad(f.filter((r) => r.shape === '-').length, 13)}${pad(f.length, 12)}`);
  log('');
  log('  The row that decides the size of the job is OPEN / shape B: those are the lines');
  log('  where a supplier still has to build something and the book knows a fact the');
  log('  document does not carry.');
  log('');
}

/* ── 4. WORKED EXAMPLES ───────────────────────────────────────────────────── */
function section4(f) {
  log('=== 4. WORKED EXAMPLES — real rows, side by side ===');
  log('Every example prints the book text, the string our summary produces for that same');
  log('line TODAY (which is what description2 and the purchase order say), the residue the');
  log('test found, and what the purchase order would read if the book text were copied');
  log('WHOLE into variants.extraAddonNote.');
  log('');
  const spread = (list, n) => {
    if (list.length <= n) return list;
    const step = list.length / n;
    return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
  };
  const show = (r, idx) => {
    raw(`  [${idx}] ${r.doc_no} line ${r.line_no}  ${r.item_group}  ${r.item_code ?? '(no code)'}  qty ${Number(r.qty)}  ${r.bucket.toUpperCase()}  (source: ${r.winner})`);
    raw(`      book text : ${r.book}`);
    raw(`      ERP today : ${r.generated || '(the summary is EMPTY for this line)'}`);
    raw(`      residue   : ${r.resN.length ? r.resN.map((a) => JSON.stringify(a)).join('  |  ') : '(none — shape A)'}`);
    raw(`      PO would  : ${r.projected}${r.projLen > AC_DESC2_MAX ? `   [${r.projLen} chars — over AutoCount's ${AC_DESC2_MAX}]` : ''}`);
    raw('');
  };
  const a = f.filter((r) => r.shape === 'A');
  log(`--- SHAPE A: the book says nothing the document does not already say (${a.length} lines) ---`);
  log('If the owner picks "copy whole", these are the lines whose purchase order gains');
  log('a SPECIAL segment that only repeats itself.');
  log('');
  spread(a, EXAMPLES).forEach((r, i) => show(r, i + 1));

  const b = f.filter((r) => r.shape === 'B');
  log(`--- SHAPE B: the book carries something the document does NOT say (${b.length} lines) ---`);
  log('One example per residue kind first, then a spread across the rest.');
  log('');
  const picked = [];
  const seen = new Set();
  for (const r of b) {
    const k = kindOf(r.resN[0]);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(r);
  }
  for (const r of spread(b.filter((x) => !picked.includes(x)), Math.max(0, EXAMPLES - picked.length))) picked.push(r);
  picked.slice(0, Math.max(EXAMPLES, seen.size)).forEach((r, i) => show(r, i + 1));
}

/* ── 5. WHAT COPYING WHOLE WOULD COST THE DOCUMENT ────────────────────────── */
function section5(f) {
  const any = f.filter((r) => r.book);
  log('=== 5. THE COST OF COPYING WHOLE, IN CHARACTERS ===');
  log('description2 is what the supplier reads and it is also what the AutoCount write-back');
  log('sends as SODTL.Desc2 / PODTL.Desc2, an nvarchar(100). Over that, the abbreviator\'s');
  log('last rung replaces the whole SPECIAL segment with the owner\'s pointer sentence');
  log('"Special Order: Refer to ERP" (src/services/autocount-desc2-abbrev.ts), so AutoCount');
  log('gets the pointer instead of the text. The supplier PDF is not capped and keeps it all.');
  log('');
  const lenStats = (vals) => {
    if (!vals.length) return 'n/a';
    const s = [...vals].sort((x, y) => x - y);
    return `min ${s[0]}  median ${s[Math.floor(s.length / 2)]}  p90 ${s[Math.floor(s.length * 0.9)]}  max ${s[s.length - 1]}`;
  };
  log(`  description2 length TODAY (lines with book text) : ${lenStats(any.map((r) => r.genLen))}`);
  log(`  description2 length if the book text is appended : ${lenStats(any.map((r) => r.projLen))}`);
  log(`  over ${AC_DESC2_MAX} chars today                          : ${pad(any.filter((r) => r.genLen > AC_DESC2_MAX).length)}`);
  log(`  over ${AC_DESC2_MAX} chars after copying whole            : ${pad(any.filter((r) => r.projLen > AC_DESC2_MAX).length)}`);
  log(`  ...of those, shape A (pure repetition, and it costs the AutoCount copy its text): `
    + `${any.filter((r) => r.projLen > AC_DESC2_MAX && r.shape === 'A').length}`);
  log('');
  const resLen = any.filter((r) => r.shape === 'B').map((r) => (r.generated ? `${r.generated} / SPECIAL: ${r.resN.join(' / ')}` : `SPECIAL: ${r.resN.join(' / ')}`).length);
  log(`  If only the RESIDUE were copied instead of the whole book text:`);
  log(`    description2 length                           : ${lenStats(resLen)}`);
  log(`    over ${AC_DESC2_MAX} chars                                 : ${resLen.filter((n) => n > AC_DESC2_MAX).length}`);
  log('');
}

const pct = (n, d) => (d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`);

main()
  .catch((e) => {
    /* A read-only probe exits non-zero ONLY when the database could not answer.
       Every legitimate answer, including "no rows", is a finding and exits 0. */
    console.error(`query failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(async () => { await sql.end({ timeout: 5 }); });
