/* Keep AutoCount's own Description 2 on the ERP PURCHASE-ORDER line, in a
   column the ERP never regenerates and never sends back to the account book.

   THE PURCHASE-SIDE TWIN of preserve-autocount-desc2-in-remark.mjs. When the
   owner asked for this on 2026-09-02 he was asked WHERE, and answered
   「SO line 和 PO line 的 remarks」 — both sides, not one. The sales side got
   its tool that day (docs/bugs/0639-*); the purchase side got only the three
   RENDER seams (docs/bugs/0640-*) because the data was already sitting in
   `notes` from the migration. That left the purchase side with no way to park
   the book's wording on a line the NEXT re-import brings in, which is exactly
   how the sales side went 4,139 -> +200 rows in three days.

   ── THE COLUMN, AND WHY IT IS `notes` AND NOT `description2` ─────────────
   A PO line has no `remark` column; its free-text field is `notes`
   (scm.purchase_order_items.notes, selected by ITEM_COLS at
   backend/src/scm/routes/mfg-purchase-orders.ts:369 and rendered on all three
   PO surfaces since 2026-09-04).

   `description2` is server-owned on this table exactly as it is on the sales
   table: the item PATCH recomputes it from buildVariantSummary on every write.
   It is also ON the AutoCount write-back path — PO_ITEM_COLS
   (backend/src/scm/lib/autocount-outbox.ts:396-397) is `id, item_code,
   item_group, description, description2, qty, unit_price_sen, variants,
   linked_ac_dtlkey, warehouse_id, delivery_date, photo_urls`. So one save can
   lose the book's wording on BOTH sides, the same two-sided loss 0639 traced
   on the sales table.

   `notes` is in neither list. PO_ITEM_COLS does not select it, so the outbox
   never reads it; the only `notes` the write-back sends is the HEADER's
   (purchase_orders.notes -> Description, autocount-outbox.ts:1478). A copy
   parked in the LINE's `notes` therefore survives every save and never reaches
   the account book.

   ── WHERE THE TEXT COMES FROM ────────────────────────────────────────────
   Identical rule to the sales twin, and for the same reason — the migration
   COPIES the book's value and never re-derives one:

     1. the line's own `description2` as it stands today, which the re-import
        wrote straight from the book, EXCEPT where it is provably our own
        generated summary (buildVariantSummary is re-run per line from that
        line's item_group + variants, and an exact match is excluded); then
     2. backend/scripts/data/ac-line-desc2.json.gz, keyed by DtlKey — the
        `po` array, 13,569 PODTL Desc2 values, exportedAt 2026-08-11T18:28:55,
        "AED_HOUZS live, read-only".

   Neither source alone is complete, which is why both are read.

   ── WHY THIS RUN WILL LOOK SMALL, AND WHY THAT IS CORRECT ────────────────
   Measured on production 2026-09-04 over the 1,117 migrated company-1 PO
   lines (docs/bugs/0640-*): 891 lines already hold `notes` byte-identical to
   `description2` and 32 hold it plus a suffix — 923 already carry the book's
   wording, put there by the migration itself. Those are SKIPPED, not
   relabelled: `decide()` skips when the existing note already CONTAINS the
   text, so this script will not churn 923 rows purely to prepend a label. The
   rows it acts on are the ones nothing has parked yet — 0640 measured 4 of
   them on that date, and the number grows with every re-import.

   ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────
   It writes ONE column, scm.purchase_order_items.notes. It never writes
   `description2` — that is the column the write-back reads, and re-deriving it
   is the bug this script exists to survive. It writes no money column, no
   quantity, no status, and no header field.

   ── THREE WRITE SHAPES ───────────────────────────────────────────────────
   SHAPE=overwrite (DEFAULT) — the owner's 2026-09-04 ruling
     「如果是我们导入的就不需要」 applied to this table too: where a note is
     occupied by our own importer text and does not already contain the book's
     words, the book's wording replaces it under the 账本原文: label. Every
     replaced value is printed IN FULL in the run log before the write, in the
     plan run and the apply run alike, so the log is the record of what was
     discarded. UNLIKE the sales table, the occupied notes here have NOT been
     grouped and shown to the owner — 0640 measured that 923 of them are the
     book's own text (and those are skipped, not replaced), but it did not
     enumerate what the remainder hold. READ THE DISCARD LIST IN THE PLAN RUN
     BEFORE APPLYING; if anything in it looks like a person's typing rather
     than an importer's, run SHAPE=append instead.
   SHAPE=append — keep the existing note first and add the book text under the
     label on a new line. Nothing is discarded.
   SHAPE=fill-only — write only where `notes` is empty.

   The label is 账本原文: on all three shapes, so a reader of the line card can
   tell the book's words from the machine's, and so a second run can recognise
   its own work.

   RE-RUN: safe and inert. Every write is guarded by the 账本原文: label — a
   line whose note already carries it is skipped, so a second run writes zero
   rows and reports them as already-done rather than writing the text a second
   time. A line whose note already CONTAINS the book text (the 923 the
   migration filled) is skipped on every run, labelled or not. Running
   fill-only first and overwrite later adds only the remaining occupied rows;
   it never revisits a line it has already labelled. And every UPDATE
   re-asserts the exact note the decision was made against, so a note a person
   types between the SELECT and the UPDATE does not match, the row count check
   fails, and the whole run refuses rather than clobbering it.

   USAGE (under tsx — it imports the canonical buildVariantSummary from src/):
     npx tsx scripts/preserve-autocount-desc2-in-po-notes.mjs
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

/* The book's own PODTL Desc2, keyed by DtlKey. Used ONLY where the ERP column
   is blank — the same precedence the sales twin uses, for the same reason: the
   re-import wrote description2 from the book seventeen days AFTER this file was
   cut, so the column is the fresher copy and the file is the older one. */
function loadBookSnapshot() {
  const raw = gunzipSync(readFileSync(path.join(HERE, 'data', 'ac-line-desc2.json.gz'))).toString('utf8');
  const parsed = JSON.parse(raw);
  const po = new Map();
  for (const r of parsed.po) { const d = norm(r.d2); if (d) po.set(Number(r.k), d); }
  return { exportedAt: parsed.exportedAt, source: parsed.source, po };
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
    const fromBook = book.po.get(key);
    if (!fromBook) return { action: 'skip', reason: 'the book holds no Desc2 for this line' };
    text = fromBook; origin = 'snapshot';
  }

  const notes = norm(row.notes);
  if (notes.includes(LABEL)) return { action: 'skip', reason: 'already carries the 账本原文 label' };
  /* THE 923. The migration already wrote the book's own wording into `notes`
     on most of these lines — byte-identical on 891, plus a suffix on 32
     (docs/bugs/0640-*). Re-writing them to prepend a label would churn a
     thousand production rows to change nothing a reader can act on, so a note
     that already carries the words is done. */
  if (notes.includes(text)) return { action: 'skip', reason: 'the note already contains this text' };
  if (!notes) return { action: 'fill', origin, text, prior: '', next: `${LABEL} ${text}` };
  if (SHAPE === 'fill-only') return { action: 'skip', reason: 'note occupied and SHAPE=fill-only' };
  if (SHAPE === 'overwrite') return { action: 'replace', origin, text, prior: notes, next: `${LABEL} ${text}` };
  return { action: 'append', origin, text, prior: notes, next: `${notes}\n${LABEL} ${text}` };
}

async function main() {
  const { buildVariantSummary } = await import('../src/scm/shared/variant-summary.ts');
  const book = loadBookSnapshot();
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (everything rolls back)'} company=${CO} shape=${SHAPE}`);
  note(`book snapshot: ${book.po.size} PO Desc2 values, exportedAt ${book.exportedAt} (${book.source})`);

  const rows = await sql`
    SELECT i.id, h.po_number AS doc_no, i.item_group, i.item_code,
           i.description2, i.notes, i.variants, i.linked_ac_dtlkey
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
     ORDER BY h.po_number, i.id`;

  const before = {
    lines: rows.length,
    with_description2: rows.filter((r) => norm(r.description2)).length,
    with_notes: rows.filter((r) => norm(r.notes)).length,
    labelled: rows.filter((r) => norm(r.notes).includes(LABEL)).length,
  };
  note(`\n=== BEFORE (company ${CO}, migrated PO lines) ===`);
  note(`  lines                  ${before.lines}`);
  note(`  description2 non-empty ${before.with_description2}   (NEVER written by this script)`);
  note(`  notes non-empty        ${before.with_notes}`);
  note(`  notes already labelled ${before.labelled}`);

  const plan = [];
  const skips = new Map();
  for (const r of rows) {
    const generated = buildVariantSummary(String(r.item_group ?? ''), r.variants ?? null);
    const d = decide(r, generated, book);
    if (d.action === 'skip') { skips.set(d.reason, (skips.get(d.reason) ?? 0) + 1); continue; }
    plan.push({ id: r.id, doc_no: r.doc_no, ...d });
  }
  const fills = plan.filter((p) => p.action === 'fill').length;
  const appends = plan.filter((p) => p.action === 'append').length;
  const replaces = plan.filter((p) => p.action === 'replace');

  note(`\n=== PLAN (shape=${SHAPE}) ===`);
  note(`  fill    — note was empty                   : ${fills}`);
  note(`  replace — existing note dropped for the book: ${replaces.length}`);
  note(`  append  — existing note kept, book added   : ${appends}`);
  note(`  source = description2 (re-import)       : ${plan.filter((p) => p.origin === 'description2').length}`);
  note(`  source = ac-line-desc2.json.gz snapshot : ${plan.filter((p) => p.origin === 'snapshot').length}`);
  note(`  TOTAL rows this run would write      : ${plan.length}`);
  note(`\n  skipped:`);
  for (const [reason, n] of [...skips].sort((a, b) => b[1] - a[1])) note(`    ${String(n).padStart(6)}  ${reason}`);

  note(`\n=== AFTER, projected — notes is the ONLY column that moves ===`);
  note(`  notes non-empty  ${before.with_notes} -> ${before.with_notes + fills}`);
  note(`  notes labelled   ${before.labelled} -> ${before.labelled + plan.length}`);
  note(`  description2 non-empty ${before.with_description2} -> ${before.with_description2}   (unchanged, asserted below)`);

  /* THE RECORD OF WHAT IS DISCARDED. SHAPE=overwrite drops a value, so every
     dropped value is printed here IN FULL, before any write happens, and the
     PLAN run prints exactly the same list as the APPLY run. On this table the
     occupied notes have NOT been enumerated for the owner the way the sales
     table's 663 were, so this list is the review — read it before applying. */
  if (replaces.length) {
    const grouped = new Map();
    for (const p of replaces) grouped.set(p.prior, (grouped.get(p.prior) ?? 0) + 1);
    note(`\n=== DISCARDED BY shape=overwrite — ${replaces.length} note(s), ${grouped.size} distinct values ===`);
    note(`    READ THESE. If any is a person's typing rather than an importer's, re-run with SHAPE=append.`);
    if (process.env.GITHUB_ACTIONS) console.log('::group::every discarded note, in full');
    for (const p of replaces) console.log(`  ${p.doc_no}  was: ${JSON.stringify(p.prior)}`);
    if (process.env.GITHUB_ACTIONS) console.log('::endgroup::');
  }

  note(`\n=== SAMPLE (first 5) ===`);
  for (const p of plan.slice(0, 5)) {
    note(`  ${p.doc_no} [${p.action}, from ${p.origin}]`);
    note(`     notes -> ${JSON.stringify(p.next).slice(0, 220)}`);
  }

  if (!plan.length) { note('\nNothing to write.'); await sql.end({ timeout: 5 }); return; }

  let wrote = 0;
  try {
    await sql.begin(async (tx) => {
      for (const p of plan) {
        /* description2 is NOT in the SET list and never will be: it is the
           column the write-back reads, and re-deriving it is the bug this
           script exists to survive. The predicate re-asserts the note this
           decision was made against, so a note a person typed between the
           SELECT and the UPDATE wins over the backfill instead of losing to
           it — the row simply does not match and the count check refuses. */
        const back = p.action === 'fill'
          ? await tx`
              UPDATE scm.purchase_order_items
                 SET notes = ${p.next}
               WHERE id = ${p.id} AND coalesce(btrim(notes), '') = ''
              RETURNING id`
          : await tx`
              UPDATE scm.purchase_order_items
                 SET notes = ${p.next}
               WHERE id = ${p.id} AND btrim(notes) = ${p.prior}
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
   is the note a string, does it carry the label, does it END with the book
   text byte-for-byte, and — the one that matters most — is description2 still
   exactly the string the plan was computed from. */
async function verify(plan, { expectWritten }) {
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const ids = plan.map((p) => p.id);
    const after = await check`
      SELECT id, notes, description2
        FROM scm.purchase_order_items
       WHERE id = ANY(${ids})`;
    const byId = new Map(after.map((r) => [String(r.id), r]));

    let labelled = 0, endsWithBook = 0, wrongType = 0, desc2Moved = 0, untouched = 0, missing = 0;
    const problems = [];
    for (const want of plan) {
      const got = byId.get(String(want.id));
      if (!got) { missing += 1; problems.push(`${want.doc_no}: row disappeared`); continue; }
      if (got.notes !== null && typeof got.notes !== 'string') { wrongType += 1; continue; }
      /* Whatever the plan read out of description2 must still be there. For a
         snapshot-sourced row description2 was blank and must have stayed
         blank; for a description2-sourced row it must still equal p.text. */
      const expectDesc2 = want.origin === 'description2' ? want.text : '';
      if (norm(got.description2) !== expectDesc2) {
        desc2Moved += 1;
        if (problems.length < 5) problems.push(`${want.doc_no}: description2 is not what the plan read`);
      }
      const nts = norm(got.notes);
      if (nts === norm(want.next)) { labelled += 1; if (nts.endsWith(want.text)) endsWithBook += 1; }
      else if (nts === want.prior) untouched += 1;
      else problems.push(`${want.doc_no}: notes is neither the before nor the after value`);
    }

    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    note(`  rows re-read                        : ${after.length} of ${ids.length}`);
    note(`  notes now carries the book's words   : ${labelled}`);
    note(`  ...and ENDS with them byte-for-byte  : ${endsWithBook}`);
    note(`  notes still exactly as it was        : ${untouched}`);
    note(`  rows missing                         : ${missing}`);
    note(`  non-string notes values              : ${wrongType}`);
    note(`  description2 moved                   : ${desc2Moved}`);
    note(`  sample value shape: ${JSON.stringify({ notes: typeof after[0]?.notes, description2: typeof after[0]?.description2 })}`);

    if (wrongType) bad(`${wrongType} row(s) hold a non-string notes value`);
    if (desc2Moved) bad(`${desc2Moved} row(s) had description2 change — this script must never touch it`);
    for (const p of problems.slice(0, 5)) bad(p);

    if (expectWritten && labelled !== ids.length) {
      bad(`expected ${ids.length} labelled note(s) on a fresh connection, found ${labelled}`);
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
