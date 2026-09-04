/* Keep AutoCount's own Description 2 on the ERP line, in a column the ERP
   never overwrites and never sends back to the account book.

   THE OWNER'S REQUEST, 2026-09-02, verbatim:

     "那个 description 2 也要记录进我们的 remarks 里面"

   ── WHY THIS IS NOT COSMETIC ─────────────────────────────────────────────
   AutoCount's SODTL.Desc2 is the CUSTOMER'S OWN SPEC TEXT on the line, in
   whatever words the salesperson wrote it:

     1+1NA+L(26/28'Inch)/Col:KIV/Bottom upgrade to umbrella fabric

   The ERP holds it today in scm.mfg_sales_order_items.description2 — but that
   column is SERVER-GENERATED on every write. mfg-sales-orders.ts:4315 (create)
   and :8581 (patch) both assign buildVariantSummary(itemGroup, variants), and
   NEITHER carries an exemption for a migrated line. So the first time anybody
   saves one of these lines, the book's wording is replaced by our computed
   summary — PC151-01 / DIVAN 8" + LEG 1" / GAP 14".

   And the loss is two-sided. scm.app_config 'scm.autocount_writeback' reads
   "1" (measured on production 2026-09-04), and composeDescription2()
   (autocount-writeback.ts:973-976) sends description2 straight back as the
   line's Desc2. So one save overwrites our copy, and the write-back then
   overwrites the book's.

   `remark` is the safe home because it is not on the write-back path AT ALL.
   The payload is ItemCode / Description / Desc2 / Qty / UnitPrice (+ optional
   Location, DeliveryDate, Photos) — autocount-writeback.ts:1036-1041 — and
   SO_ITEM_COLS, the column list the outbox reads off the ERP line
   (autocount-outbox.ts:382-383), does not select `remark`. A case-insensitive
   grep for remark over autocount-writeback.ts AND autocount-outbox.ts returns
   nothing at all.

   ── WHERE THE TEXT COMES FROM, AND WHY NOT ONLY THE FILE SNAPSHOT ────────
   The migration's standing rule is COPY the book's value, never re-derive one.
   Two candidate copies exist and the fresher one is NOT the file:

     * backend/scripts/data/ac-line-desc2.json.gz — AutoCount's own Desc2
       keyed by DtlKey, "AED_HOUZS live, read-only", exportedAt
       2026-08-11T18:28:55. 15,971 SO keys, every one non-empty.
     * scm.mfg_sales_order_items.description2 as it stands TODAY — written by
       the 2026-08-28 re-import straight from the book. Measured on production
       2026-09-04: 14,342 of the 14,445 migrated lines carry created_at
       2026-08-28, i.e. the whole corpus was re-imported SEVENTEEN DAYS AFTER
       the file snapshot was taken.

   So description2 is the fresher book copy, and the file is the older one.
   That does not license re-deriving: the guard is that a line is only taken
   from description2 when its value is provably NOT our generated summary —
   buildVariantSummary is re-run per line, from the line's own item_group and
   variants, and an exact match is EXCLUDED. Measured on production 2026-09-04,
   3 of 4,123 lines were excluded that way; the other 4,120 are book text.

   The file snapshot still earns its place: it recovers 5 lines whose Desc2 the
   book holds and the 2026-08-28 import left blank. Neither source alone is
   complete, so the script takes description2 first and falls back to the file.

   ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────
   It writes ONE column, scm.mfg_sales_order_items.remark. It never writes
   description2 — repairing that column would be re-derivation by another
   name, and it is the column the write-back reads. It writes no money column,
   no quantity, no status, and no header field.

   ── WHAT ALREADY OCCUPIES `remark`, AND THE OWNER'S RULING ON IT ─────────
   663 migrated lines already carry a remark. EVERY ONE OF THEM IS OUR OWN
   MACHINE NOTE — measured on production 2026-09-04, grouping all 663 by value
   (129 distinct strings):

       548  sofa: <importer seat-depth / arm substitution note>
        95  ... UNPARSED — 按图/原文补件: token "..."
        13  compartment corrected 2026-08-10
         7  name-matched from free-text

   Not one is customer text, and not one was typed by a person into the ERP.
   Told exactly that, the owner ruled on 2026-09-04: 「如果是我们导入的就不需要」
   — if it is our own import's note, it does not need keeping.

   ── THREE WRITE SHAPES ───────────────────────────────────────────────────
   SHAPE=overwrite (DEFAULT — the owner's ruling) — every line that has book
     text gets `账本原文: <book text>` as its remark, whether the field was
     empty or held one of the machine notes above. Measured 2026-09-04:
     3,474 empty + 654 machine-note lines = 4,128 lines. The machine note is
     replaced, not kept: that is what the ruling says to do. Every replaced
     value is printed in full in the run log before it is written, so the run
     itself is the record of what was discarded.
   SHAPE=append — keep the machine note first and add the book text under the
     label on a new line. Same 4,128 lines, nothing discarded. This was the
     recommendation BEFORE the owner ruled; it survives as an option.
   SHAPE=fill-only — write only where remark is empty. 3,474 lines, and the
     654 hardest-to-parse lines keep no copy of the book's words.

   The label is 账本原文: on all three shapes, so a reader of the line card can
   tell the book's words from the machine's, and so a second run can recognise
   its own work.

   RE-RUN: safe and inert. Every write is guarded by the 账本原文: label — a
   line whose remark already carries it is skipped, so a second run writes
   zero rows and reports them as already-done rather than writing the text a
   second time. Running fill-only first and overwrite later adds only the 654
   remaining rows; it never revisits a line it has already labelled. And every
   UPDATE re-asserts the exact remark the decision was made against, so a
   remark a person types between the SELECT and the UPDATE does not match, the
   row count check fails, and the whole run refuses rather than clobbering it.

   USAGE (under tsx — it imports the canonical buildVariantSummary from src/):
     npx tsx scripts/preserve-autocount-desc2-in-remark.mjs
   MODE=plan (default) runs every write inside a transaction and ROLLS BACK.
   MODE=apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN". */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.log('::error::DATABASE_URL is not set'); process.exit(1); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY || 1);
const SHAPE = (process.env.SHAPE || 'overwrite').toLowerCase();
const SHAPES = ['overwrite', 'append', 'fill-only'];
const LABEL = '账本原文:';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/* Both gates are checked BEFORE a connection is opened, so a mistyped dispatch
   is refused without ever reaching production. */
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
if (!SHAPES.includes(SHAPE)) {
  bad(`SHAPE must be one of ${SHAPES.join(' / ')}, got "${SHAPE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLLBACK = Symbol('rollback');
const norm = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim();

/* The book's own Desc2, keyed by DtlKey. Used ONLY where the ERP column is
   blank — see the header: this file is the OLDER of the two book copies. */
function loadBookSnapshot() {
  const raw = gunzipSync(readFileSync(path.join(HERE, 'data', 'ac-line-desc2.json.gz'))).toString('utf8');
  const parsed = JSON.parse(raw);
  const so = new Map();
  for (const r of parsed.so) { const d = norm(r.d2); if (d) so.set(Number(r.k), d); }
  return { exportedAt: parsed.exportedAt, source: parsed.source, so };
}

/* One line's decision, as a value, so the plan and the apply cannot diverge:
   both read this. `generated` is buildVariantSummary's output for THIS line —
   the exact string the next save would put in description2. */
function decide(row, generated, book) {
  const current = norm(row.description2);
  const gen = norm(generated);
  let text = '';
  let origin = '';
  if (current && !(gen && current === gen)) { text = current; origin = 'description2'; }
  else if (current) return { action: 'skip', reason: 'description2 is already our generated summary' };
  else {
    const key = row.linked_ac_dtlkey == null ? null : Number(row.linked_ac_dtlkey);
    if (key == null) return { action: 'skip', reason: 'no AutoCount DtlKey stamped on this line' };
    const fromBook = book.so.get(key);
    if (!fromBook) return { action: 'skip', reason: 'the book holds no Desc2 for this line' };
    text = fromBook; origin = 'snapshot';
  }

  const remark = norm(row.remark);
  if (remark.includes(LABEL)) return { action: 'skip', reason: 'already carries the 账本原文 label' };
  if (remark.includes(text)) return { action: 'skip', reason: 'the remark already contains this text' };
  if (!remark) return { action: 'fill', origin, text, prior: '', next: `${LABEL} ${text}` };
  if (SHAPE === 'fill-only') return { action: 'skip', reason: 'remark occupied and SHAPE=fill-only' };
  /* SHAPE=overwrite is the owner's ruling of 2026-09-04: every one of the 663
     occupied remarks on these lines is our own importer's machine note (see
     the header for the measured breakdown), and 「如果是我们导入的就不需要」.
     The discarded value is carried on the plan as `prior`, so it is printed in
     full before the write AND re-asserted in the UPDATE predicate. */
  if (SHAPE === 'overwrite') return { action: 'replace', origin, text, prior: remark, next: `${LABEL} ${text}` };
  return { action: 'append', origin, text, prior: remark, next: `${remark}\n${LABEL} ${text}` };
}

async function main() {
  const { buildVariantSummary } = await import('../src/scm/shared/variant-summary.ts');
  const book = loadBookSnapshot();
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (everything rolls back)'} company=${CO} shape=${SHAPE}`);
  note(`book snapshot: ${book.so.size} SO Desc2 values, exportedAt ${book.exportedAt} (${book.source})`);

  const rows = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_group, i.item_code,
           i.description2, i.remark, i.variants, i.linked_ac_dtlkey
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
     ORDER BY i.doc_no, i.line_no`;

  const before = {
    lines: rows.length,
    with_description2: rows.filter((r) => norm(r.description2)).length,
    with_remark: rows.filter((r) => norm(r.remark)).length,
    labelled: rows.filter((r) => norm(r.remark).includes(LABEL)).length,
  };
  note(`\n=== BEFORE (company ${CO}, migrated SO lines) ===`);
  note(`  lines                  ${before.lines}`);
  note(`  description2 non-empty ${before.with_description2}   (NEVER written by this script)`);
  note(`  remark non-empty       ${before.with_remark}`);
  note(`  remark already labelled ${before.labelled}`);

  const plan = [];
  const skips = new Map();
  for (const r of rows) {
    const generated = buildVariantSummary(String(r.item_group ?? ''), r.variants ?? null);
    const d = decide(r, generated, book);
    if (d.action === 'skip') { skips.set(d.reason, (skips.get(d.reason) ?? 0) + 1); continue; }
    plan.push({ id: r.id, doc_no: r.doc_no, line_no: r.line_no, ...d });
  }
  const fills = plan.filter((p) => p.action === 'fill').length;
  const appends = plan.filter((p) => p.action === 'append').length;
  const replaces = plan.filter((p) => p.action === 'replace');

  note(`\n=== PLAN (shape=${SHAPE}) ===`);
  note(`  fill    — remark was empty                 : ${fills}`);
  note(`  replace — machine note dropped for the book: ${replaces.length}`);
  note(`  append  — machine note kept, book added    : ${appends}`);
  note(`  source = description2 (2026-08-28 pull) : ${plan.filter((p) => p.origin === 'description2').length}`);
  note(`  source = ac-line-desc2.json.gz snapshot : ${plan.filter((p) => p.origin === 'snapshot').length}`);
  note(`  TOTAL rows this run would write      : ${plan.length}`);
  note(`\n  skipped:`);
  for (const [reason, n] of [...skips].sort((a, b) => b[1] - a[1])) note(`    ${String(n).padStart(6)}  ${reason}`);

  note(`\n=== AFTER, projected — remark is the ONLY column that moves ===`);
  note(`  remark non-empty  ${before.with_remark} -> ${before.with_remark + fills}`);
  note(`  remark labelled   ${before.labelled} -> ${before.labelled + plan.length}`);
  note(`  description2 non-empty ${before.with_description2} -> ${before.with_description2}   (unchanged, asserted below)`);

  /* THE RECORD OF WHAT IS DISCARDED. SHAPE=overwrite drops a value, so every
     dropped value is printed here IN FULL, before any write happens, and the
     PLAN run prints exactly the same list as the APPLY run. The run log is
     therefore a complete transcript of what the machine note used to say. */
  if (replaces.length) {
    const grouped = new Map();
    for (const p of replaces) grouped.set(p.prior, (grouped.get(p.prior) ?? 0) + 1);
    note(`\n=== DISCARDED BY shape=overwrite — ${replaces.length} machine notes, ${grouped.size} distinct values ===`);
    note(`    (the owner's ruling 2026-09-04: 「如果是我们导入的就不需要」)`);
    if (process.env.GITHUB_ACTIONS) console.log('::group::every discarded remark, in full');
    for (const p of replaces) console.log(`  ${p.doc_no} line ${p.line_no}  was: ${JSON.stringify(p.prior)}`);
    if (process.env.GITHUB_ACTIONS) console.log('::endgroup::');
  }

  note(`\n=== SAMPLE (first 5) ===`);
  for (const p of plan.slice(0, 5)) {
    note(`  ${p.doc_no} line ${p.line_no} [${p.action}, from ${p.origin}]`);
    note(`     remark -> ${JSON.stringify(p.next).slice(0, 220)}`);
  }
  const sampleReplace = replaces.slice(0, 3);
  for (const p of sampleReplace) {
    note(`  ${p.doc_no} line ${p.line_no} [replace, from ${p.origin}]`);
    note(`     was    ${JSON.stringify(p.prior).slice(0, 220)}`);
    note(`     remark -> ${JSON.stringify(p.next).slice(0, 220)}`);
  }

  if (!plan.length) { note('\nNothing to write.'); await sql.end({ timeout: 5 }); return; }

  let wrote = 0;
  try {
    await sql.begin(async (tx) => {
      for (const p of plan) {
        /* description2 is NOT in the SET list and never will be: it is the
           column the write-back reads, and re-deriving it is the bug this
           script exists to survive. The predicate re-asserts the remark this
           decision was made against, so a remark a person typed between the
           SELECT and the UPDATE wins over the backfill instead of losing to
           it — the row simply does not match and the count check refuses. */
        const back = p.action === 'fill'
          ? await tx`
              UPDATE scm.mfg_sales_order_items
                 SET remark = ${p.next}
               WHERE id = ${p.id} AND coalesce(btrim(remark), '') = ''
              RETURNING id`
          : await tx`
              UPDATE scm.mfg_sales_order_items
                 SET remark = ${p.next}
               WHERE id = ${p.id} AND btrim(remark) = ${p.prior}
              RETURNING id`;
        wrote += back.length;
      }
      note(`\n${APPLY ? 'wrote' : 'would write'}: ${wrote} row(s)`);
      if (wrote !== plan.length) throw new Error(`expected ${plan.length}, wrote ${wrote} — refusing`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note(`PLAN: transaction rolled back, nothing was written.`);
    await sql.end({ timeout: 5 });
    await verify(plan, { expectWritten: false });
    note(`\nRe-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to keep it.`);
    return;
  }

  await sql.end({ timeout: 5 });
  await verify(plan, { expectWritten: true });
}

/* VERIFY ON A FRESH CONNECTION, ASSERTING THE SHAPE.
   A row count is not a shape. The questions asked here are about the VALUE:
   is the remark a string, does it carry the label, does it END with the book
   text byte-for-byte, and — the one that matters most — is description2 still
   exactly the string the plan was computed from. */
async function verify(plan, { expectWritten }) {
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const ids = plan.map((p) => p.id);
    const after = await check`
      SELECT id, doc_no, remark, description2
        FROM scm.mfg_sales_order_items
       WHERE id = ANY(${ids})`;
    const byId = new Map(after.map((r) => [String(r.id), r]));

    let labelled = 0, endsWithBook = 0, wrongType = 0, desc2Moved = 0, untouched = 0, missing = 0;
    const problems = [];
    for (const want of plan) {
      const got = byId.get(String(want.id));
      if (!got) { missing += 1; problems.push(`${want.doc_no}: row disappeared`); continue; }
      if (got.remark !== null && typeof got.remark !== 'string') { wrongType += 1; continue; }
      /* Whatever the plan read out of description2 must still be there. For a
         snapshot-sourced row description2 was blank and must have stayed
         blank; for a description2-sourced row it must still equal p.text. */
      const expectDesc2 = want.origin === 'description2' ? want.text : '';
      if (norm(got.description2) !== expectDesc2) {
        desc2Moved += 1;
        if (problems.length < 5) problems.push(`${want.doc_no}: description2 is not what the plan read`);
      }
      const rem = norm(got.remark);
      if (rem === norm(want.next)) { labelled += 1; if (rem.endsWith(want.text)) endsWithBook += 1; }
      else if (rem === want.prior) untouched += 1;
      else problems.push(`${want.doc_no}: remark is neither the before nor the after value`);
    }

    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    note(`  rows re-read                        : ${after.length} of ${ids.length}`);
    note(`  remark now carries the book's words  : ${labelled}`);
    note(`  ...and ENDS with them byte-for-byte  : ${endsWithBook}`);
    note(`  remark still exactly as it was       : ${untouched}`);
    note(`  rows missing                         : ${missing}`);
    note(`  non-string remark values             : ${wrongType}`);
    note(`  description2 moved                   : ${desc2Moved}`);
    note(`  sample value shape: ${JSON.stringify({ remark: typeof after[0]?.remark, description2: typeof after[0]?.description2 })}`);

    if (wrongType) bad(`${wrongType} row(s) hold a non-string remark`);
    if (desc2Moved) bad(`${desc2Moved} row(s) had description2 change — this script must never touch it`);
    for (const p of problems.slice(0, 5)) bad(p);

    if (expectWritten && labelled !== ids.length) {
      bad(`expected ${ids.length} labelled remark(s) on a fresh connection, found ${labelled}`);
    }
    if (!expectWritten) {
      if (labelled !== 0) bad(`PLAN rolled back, yet ${labelled} row(s) already carry the label — the rollback did not hold`);
      else if (untouched === ids.length) note(`  the rollback HELD: every planned row is exactly as it was.`);
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
