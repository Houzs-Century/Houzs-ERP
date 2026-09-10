/* Put the ACCOUNT BOOK's own spec text into the field the supplier's purchase
   order prints — for the pillow's colour, the SP mattress's size, and the
   dining款式.

   THE OWNER'S REQUEST, 2026-09-10, verbatim:

     「查回去autocount的记录看那些square pillow custom 和special order 的mattress
      和dining table diningleg 的spec全部放进去那个special custom的地方。这样子，
      当我们发给 Supplier PO 的时候，他才能看得到这个 pillow 是什么颜色的，然后
      mattress 是什么尺寸，以及我们的 dining table、dining leg、dining chair 是
      什么款式。」

   ── WHY THE FIELD IS `variants.extraAddonNote` AND NOTHING ELSE ──────────
   A purchase order line's Description 2 is stamped server-side from
   buildVariantSummary(item_group, variants) — mfg-purchase-orders.ts:2259 and
   :2394 build a PO line by copying the SO line's `variants` and composing
   description2 from them. buildVariantSummary appends `SPECIAL: <note>` from
   variants.extraAddonNote AFTER the per-group attribute branch, so a category
   that contributes no attributes still carries its note. That is the whole
   mechanism by which this backfill reaches the supplier.

   `variants.specials` would ALSO print — and must never be written here.
   computeVariantKey (scm/shared/variant-key.ts) folds normSpecials(specials)
   into the line's stock bucket, so a special SPLITS the bucket and stops an
   accessory line matching the stock and the purchase orders raised for it.
   extraAddonNote is read by NO branch of computeVariantKey. Describe freely,
   re-key never. `custom_specials` is DERIVED and self-erasing — never written
   anywhere, by anything.

   ── WHERE THE TEXT COMES FROM, IN PRECEDENCE ORDER ──────────────────────
   Established by preserve-autocount-desc2-in-remark.mjs on 2026-09-02 and
   re-verified against production before this script was written:

     1. scm.mfg_sales_order_items.description2 — the FRESHER book copy. The
        2026-08-28 re-import wrote it straight from the book.
     2. backend/scripts/data/ac-line-desc2.json.gz — AutoCount's own Desc2 by
        DtlKey, exported 2026-08-11. OLDER, but it recovers lines the re-import
        left blank. Neither source alone is complete.
     3. The `账本原文:` label that the precursor script wrote into
        scm.mfg_sales_order_items.remark. It RAN, twice, in APPLY mode against
        production — run 33855560127 (2026-09-04, wrote 4,139 rows) and run
        34132958644 (2026-09-07, wrote 200) — so on ~4,339 company-1 migrated
        lines the book's wording is sitting in `remark` today even where a save
        has since regenerated description2. That is exactly the case source 3
        exists for.

   The three are compared per line and any DISAGREEMENT is counted and printed,
   because a silent pick between two book copies that differ is a guess wearing
   a precedence order.

   ── THE GUARD THAT MAKES THIS A COPY AND NOT A RE-DERIVATION ────────────
   The migration's standing rule is COPY the book's value, never infer one.
   buildVariantSummary is re-run per line from that line's OWN item_group and
   variants, in both its bare and its `labelled` form, and a candidate that
   EXACTLY EQUALS our generated summary is EXCLUDED — that string is ours, not
   the book's. A candidate the line ALREADY PRINTS (contained in the generated
   summary, e.g. it is already a picked special) is excluded too: recording it
   again would print one request twice.

   ── THE JSONB TRAP, PAID FOR TWICE ALREADY ──────────────────────────────
   `variants` is a jsonb BAG. Rebuilding it deletes every key this script has
   not heard of, and binding a pre-serialized string to a jsonb parameter
   stores a jsonb STRING scalar rather than an object
   (docs/jsonb-double-encoding-coe.md — it recurred inside that COE's own
   repair). So the write is a MERGE — variants || tx.json({extraAddonNote}) —
   the bind goes through tx.json, and the verification re-reads on a fresh
   connection and asserts that EVERY key the line held before is still there
   with an EQUAL value. A row count is not a shape.

   ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────
   ONE key, `variants.extraAddonNote`, on company-1 sales-order lines only. It
   never writes description2, specials, custom_specials, remark, a money
   column, a quantity, a status or a header field. It never touches the
   AutoCount book: this is a Postgres write and the write-back is enqueued by
   the ROUTE layer, never by a database trigger.

   ── THE CONSEQUENCE THAT IS NOT OBVIOUS, MEASURED RATHER THAN ASSUMED ────
   description2 is regenerated from `variants` on every save
   (mfg-sales-orders.ts create/patch), so after this backfill the NEXT save of
   one of these orders puts `SPECIAL: <book text>` into description2, and the
   write-back sends description2 to the book. AutoCount refuses a document
   whose Desc2 is over nvarchar(100). abbreviateDesc2 + pointSpecialsAtTheErp
   (services/autocount-desc2-abbrev.ts) already handle that on the way out —
   the SPECIAL segment becomes the owner's own sentence `Special Order: Refer
   to ERP`. This script MEASURES how many lines land over 100 and how many are
   still over after that pointer, and prints both, so the risk is a number and
   not a hope.

   SAFETY (release discipline, CLAUDE.md):
     MODE=plan (default) runs every write inside ONE transaction and ROLLS BACK.
     MODE=apply additionally requires CONFIRM="I HAVE REVIEWED THE DRY-RUN".
     Every UPDATE is a FILL: it re-asserts that extraAddonNote is still empty
     and that variants is still an OBJECT, so a note somebody types between the
     SELECT and the UPDATE wins over the backfill instead of losing to it — the
     row does not match, the count check fails, and the whole run refuses.

   RE-RUN: safe and inert. A line whose extraAddonNote is non-empty is skipped,
   so a second run writes zero rows and reports them as already-done. Running
   with a wider CATEGORIES list later adds only the new categories' lines; it
   never revisits a line it has already filled.

   USAGE (under tsx — it imports the canonical buildVariantSummary from src/):
     DATABASE_URL=... npx tsx scripts/backfill-book-spec-into-extra-addon-note.mjs
     DATABASE_URL=... MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" \
       npx tsx scripts/backfill-book-spec-into-extra-addon-note.mjs

   Env: DATABASE_URL (required)  MODE=plan|apply  CONFIRM (on apply)
        COMPANY (default 1)  CATEGORIES (default accessory,mattress,others)
        SAMPLE (default 12) */

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
const SAMPLE = Number(process.env.SAMPLE || 12);
const CATEGORIES = String(process.env.CATEGORIES || 'accessory,mattress,others')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const LABEL = '账本原文:';
const AC_DESC2_MAX = 100;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/* Checked BEFORE a connection is opened, so a mistyped dispatch is refused
   without ever reaching production. */
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
if (!CATEGORIES.length) { bad('CATEGORIES resolved to an empty list'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLLBACK = Symbol('rollback');
const norm = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim();
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

/** AutoCount's own Desc2 keyed by DtlKey — the 2026-08-11 snapshot. */
function loadBookSnapshot() {
  const raw = gunzipSync(readFileSync(path.join(HERE, 'data', 'ac-line-desc2.json.gz'))).toString('utf8');
  const parsed = JSON.parse(raw);
  const so = new Map();
  for (const r of parsed.so) { const d = norm(r.d2); if (d) so.set(Number(r.k), d); }
  return { exportedAt: parsed.exportedAt, source: parsed.source, so };
}

/** The book's words as the precursor parked them in `remark`, label stripped. */
function fromRemarkLabel(remark) {
  const r = norm(remark);
  const at = r.indexOf(LABEL);
  if (at === -1) return '';
  return norm(r.slice(at + LABEL.length));
}

/* One line's decision, as a value, so the plan and the apply cannot diverge.
   `gen` is buildVariantSummary's output for THIS line — the exact string the
   next save would put in description2, and therefore the string that is OURS
   rather than the book's. */
function decide(row, gen, genLabelled, book) {
  if (norm(row.extra_addon_note)) return { action: 'skip', reason: 'the line already carries an extraAddonNote' };
  if (row.variants_type !== 'object') {
    return { action: 'skip', reason: `variants is jsonb ${row.variants_type ?? 'null'}, not an object — repair the shape first` };
  }

  const key = row.linked_ac_dtlkey == null ? null : Number(row.linked_ac_dtlkey);
  const candidates = [
    { origin: 'description2', text: norm(row.description2) },
    { origin: 'snapshot', text: key == null ? '' : (book.so.get(key) ?? '') },
    { origin: 'remark-label', text: fromRemarkLabel(row.remark) },
  ];

  /* THE GUARD. A candidate that IS our generated summary is our text, not the
     book's, and copying it back would be a re-derivation dressed as a copy. */
  const ours = new Set([norm(gen), norm(genLabelled)].filter(Boolean));
  const excluded = [];
  const usable = [];
  for (const c of candidates) {
    if (!c.text) continue;
    if (ours.has(c.text)) { excluded.push(c.origin); continue; }
    usable.push(c);
  }

  if (!usable.length) {
    return excluded.length
      ? { action: 'skip', reason: `every book copy is our own generated summary (${[...new Set(excluded)].join(', ')})`, excludedOurs: true }
      : { action: 'skip', reason: 'no book text on this line in any of the three sources' };
  }

  const chosen = usable[0];
  /* Already printed by the line — usually because the same request is already
     a picked special. Recording it again prints one request twice. */
  const genLower = norm(gen).toLowerCase();
  if (genLower && genLower.includes(chosen.text.toLowerCase())) {
    return { action: 'skip', reason: 'the line already prints this text', excludedOurs: excluded.length > 0 };
  }

  const distinct = new Set(usable.map((c) => c.text));
  return {
    action: 'fill',
    origin: chosen.origin,
    text: chosen.text,
    disagree: distinct.size > 1,
    others: usable.filter((c) => c.text !== chosen.text).map((c) => `${c.origin}=${JSON.stringify(c.text)}`),
    excludedOurs: excluded.length > 0,
  };
}

async function main() {
  const { buildVariantSummary } = await import('../src/scm/shared/variant-summary.ts');
  const { abbreviateDesc2 } = await import('../src/services/autocount-desc2-abbrev.ts');
  const book = loadBookSnapshot();

  note(`mode=${APPLY ? 'APPLY' : 'PLAN (everything rolls back)'} company=${CO}`);
  note(`write scope categories: ${CATEGORIES.join(', ')}`);
  note(`book snapshot: ${book.so.size} SO Desc2 values, exportedAt ${book.exportedAt} (${book.source})`);

  /* THE POPULATION: company-CO sales-order lines that came from the account
     book (a migrated order, or a line the precursor already labelled). A line
     the ERP created itself has no book text by definition — its description2
     IS our generated summary — so including it would only add rows the guard
     then throws away. The count of what that leaves out is printed below. */
  const rows = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_group, i.item_code,
           i.description2, i.remark, i.variants, i.linked_ac_dtlkey,
           jsonb_typeof(i.variants) AS variants_type,
           btrim(coalesce(i.variants->>'extraAddonNote','')) AS extra_addon_note,
           h.status AS so_status,
           lower(coalesce(p.category::text, i.item_group, '')) AS category
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
      LEFT JOIN LATERAL (
        SELECT pr.category FROM scm.mfg_products pr
         WHERE pr.code = i.item_code AND pr.company_id = i.company_id
         ORDER BY (pr.status = 'ACTIVE') DESC NULLS LAST
         LIMIT 1
      ) p ON true
     WHERE i.company_id = ${CO}
       AND (h.linked_ac_docno IS NOT NULL OR i.remark LIKE ${`%${LABEL}%`})
     ORDER BY i.doc_no, i.line_no`;

  const [{ outside }] = await sql`
    SELECT count(*)::int AS outside
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE i.company_id = ${CO}
       AND h.linked_ac_docno IS NULL
       AND coalesce(i.remark, '') NOT LIKE ${`%${LABEL}%`}`;

  note(`\n=== POPULATION (company ${CO}) ===`);
  note(`  book-sourced SO lines read      : ${rows.length}`);
  note(`  ERP-native lines NOT considered : ${outside}   (no book text exists for them)`);

  /* Every line is decided; only the in-scope categories are WRITTEN. The
     census over every category is what tells us where a category actually
     lives — e.g. whether dining SKUs sit under `others` or under their own
     `dining` value — instead of assuming it. */
  const perCat = new Map();
  const plan = [];
  const skips = new Map();
  const skipsInScope = new Map();
  let excludedOurs = 0;
  let notObjectShape = 0;

  for (const r of rows) {
    const gen = buildVariantSummary(String(r.item_group ?? ''), r.variants ?? null);
    const genLabelled = buildVariantSummary(String(r.item_group ?? ''), r.variants ?? null, { labelled: true });
    const d = decide(r, gen, genLabelled, book);
    if (d.excludedOurs) excludedOurs += 1;
    if (r.variants_type && r.variants_type !== 'object') notObjectShape += 1;

    const cat = r.category || '(no category)';
    if (!perCat.has(cat)) perCat.set(cat, { lines: 0, fillable: 0, alreadyNoted: 0 });
    const c = perCat.get(cat);
    c.lines += 1;
    if (d.action === 'fill') c.fillable += 1;
    if (norm(r.extra_addon_note)) c.alreadyNoted += 1;

    const inScope = CATEGORIES.includes(cat);
    if (d.action === 'skip') {
      bump(skips, d.reason);
      if (inScope) bump(skipsInScope, d.reason);
      continue;
    }
    if (!inScope) continue;

    /* What description2 BECOMES on the next save, and what AutoCount would be
       handed for it. Measured, not assumed — see the header. */
    const nextDesc2 = buildVariantSummary(
      String(r.item_group ?? ''),
      { ...(r.variants ?? {}), extraAddonNote: d.text },
    );
    plan.push({
      id: r.id, doc_no: r.doc_no, line_no: r.line_no, item_code: r.item_code,
      category: cat, so_status: String(r.so_status ?? ''), priorVariants: r.variants ?? {},
      nextDesc2, sentDesc2: abbreviateDesc2(nextDesc2, AC_DESC2_MAX), ...d,
    });
  }

  note('\n=== CENSUS BY CATEGORY — every category in the population, not only the write scope ===');
  note(`  ${'category'.padEnd(22)} ${'lines'.padStart(7)} ${'has a book text'.padStart(16)} ${'already noted'.padStart(14)}   in write scope`);
  for (const [cat, c] of [...perCat].sort((a, b) => b[1].fillable - a[1].fillable || b[1].lines - a[1].lines)) {
    note(`  ${cat.padEnd(22)} ${String(c.lines).padStart(7)} ${String(c.fillable).padStart(16)} ${String(c.alreadyNoted).padStart(14)}   ${CATEGORIES.includes(cat) ? 'YES' : '-'}`);
  }

  const byCat = new Map();
  const bySource = new Map();
  const byStatus = new Map();
  for (const p of plan) { bump(byCat, p.category); bump(bySource, p.origin); bump(byStatus, p.so_status || '(none)'); }
  const disagreeing = plan.filter((p) => p.disagree);
  const overMax = plan.filter((p) => p.nextDesc2.length > AC_DESC2_MAX);
  const stillOver = overMax.filter((p) => p.sentDesc2.length > AC_DESC2_MAX);

  note('\n=== PLAN — rows this run would write (ONE key: variants.extraAddonNote) ===');
  note(`  TOTAL : ${plan.length}`);
  for (const [cat, n] of [...byCat].sort((a, b) => b[1] - a[1])) note(`    category ${cat.padEnd(16)} ${String(n).padStart(6)}`);
  note('  by source:');
  for (const o of ['description2', 'snapshot', 'remark-label']) note(`    ${o.padEnd(16)} ${String(bySource.get(o) ?? 0).padStart(6)}`);
  note(`  book copies that DISAGREE with each other (first source wins) : ${disagreeing.length}`);
  note('\n=== THE GUARD — a value that is OUR OWN generated summary is not the book\'s ===');
  note(`  lines with at least one candidate EXCLUDED as our own summary : ${excludedOurs}`);
  note(`  lines whose variants jsonb is not an OBJECT (skipped)         : ${notObjectShape}`);
  note('\n=== SKIPPED, in the write-scope categories ===');
  for (const [reason, n] of [...skipsInScope].sort((a, b) => b[1] - a[1])) note(`    ${String(n).padStart(6)}  ${reason}`);
  note('  (whole population, every category)');
  for (const [reason, n] of [...skips].sort((a, b) => b[1] - a[1])) note(`    ${String(n).padStart(6)}  ${reason}`);

  note("\n=== THE OWNER'S DECISION (a): which ORDERS these lines sit on ===");
  for (const [st, n] of [...byStatus].sort((a, b) => b[1] - a[1])) note(`    ${st.padEnd(16)} ${String(n).padStart(6)}`);

  note('\n=== AUTOCOUNT Desc2 LENGTH, after the next save regenerates it ===');
  note(`  lines whose new description2 exceeds ${AC_DESC2_MAX} chars      : ${overMax.length}`);
  note(`  ...still over after abbreviate + "Special Order: Refer to ERP" : ${stillOver.length}`);
  for (const p of stillOver.slice(0, 5)) note(`    ${p.doc_no} line ${p.line_no}  ${p.sentDesc2.length} chars`);

  if (disagreeing.length) {
    note(`\n=== BOOK COPIES THAT DISAGREE — printed in full, first ${Math.min(10, disagreeing.length)} ===`);
    for (const p of disagreeing.slice(0, 10)) {
      note(`  ${p.doc_no} line ${p.line_no}  chose ${p.origin}=${JSON.stringify(p.text)}`);
      for (const o of p.others) note(`      other: ${o}`);
    }
  }

  note(`\n=== SAMPLE — the text this run would write (first ${SAMPLE}) ===`);
  for (const p of plan.slice(0, SAMPLE)) {
    note(`  ${p.doc_no} line ${p.line_no}  [${p.category}] ${p.item_code ?? ''}  from ${p.origin}`);
    note(`     extraAddonNote -> ${JSON.stringify(p.text)}`);
    note(`     PO Description 2 becomes: ${JSON.stringify(p.nextDesc2)}`);
  }

  if (!plan.length) { note('\nNothing to write.'); await sql.end({ timeout: 5 }); return; }

  let wrote = 0;
  try {
    await sql.begin(async (tx) => {
      for (const p of plan) {
        /* MERGE, never rebuild: `variants || patch` overwrites only the one key
           and leaves every other key of the bag alone. `tx.json` is the bind
           that survives the jsonb double-encoding COE — a JSON.stringify'd
           value on a jsonb parameter stores a jsonb STRING scalar.
           The predicate re-asserts the two facts the decision was made on, so a
           note somebody typed in between wins over the backfill. */
        const back = await tx`
          UPDATE scm.mfg_sales_order_items
             SET variants = variants || ${tx.json({ extraAddonNote: p.text })}
           WHERE id = ${p.id}
             AND company_id = ${CO}
             AND jsonb_typeof(variants) = 'object'
             AND coalesce(btrim(variants->>'extraAddonNote'), '') = ''
          RETURNING id`;
        wrote += back.length;
      }
      note(`\n${APPLY ? 'wrote' : 'would write'}: ${wrote} row(s)`);
      if (wrote !== plan.length) throw new Error(`expected ${plan.length}, wrote ${wrote} — refusing`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note('PLAN: transaction rolled back, nothing was written.');
    await sql.end({ timeout: 5 });
    await verify(plan, { expectWritten: false });
    note(`\nRe-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to keep it.`);
    return;
  }

  await sql.end({ timeout: 5 });
  await verify(plan, { expectWritten: true });
}

/* VERIFY ON A FRESH CONNECTION, ASSERTING THE SHAPE.
   A row count is not a shape, and the shape this script can plausibly break is
   the BAG: a rebuild deletes keys it never heard of. So the questions asked
   here are (1) is variants still a jsonb OBJECT, (2) does extraAddonNote read
   back byte-for-byte, and (3) is every key the line held BEFORE still present
   with an EQUAL value. */
async function verify(plan, { expectWritten }) {
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const ids = plan.map((p) => p.id);
    const after = await check`
      SELECT id, doc_no, line_no, variants, jsonb_typeof(variants) AS variants_type,
             description2, remark
        FROM scm.mfg_sales_order_items
       WHERE id = ANY(${ids}) AND company_id = ${CO}`;
    const byId = new Map(after.map((r) => [String(r.id), r]));

    let noted = 0, untouched = 0, missing = 0, notObject = 0, keysLost = 0, keysChanged = 0;
    const problems = [];
    for (const want of plan) {
      const got = byId.get(String(want.id));
      if (!got) { missing += 1; problems.push(`${want.doc_no} line ${want.line_no}: row disappeared`); continue; }
      if (got.variants_type !== 'object') {
        notObject += 1;
        problems.push(`${want.doc_no} line ${want.line_no}: variants is jsonb ${got.variants_type}, not an object`);
        continue;
      }
      const now = got.variants ?? {};
      for (const [k, v] of Object.entries(want.priorVariants)) {
        if (!(k in now)) { keysLost += 1; if (problems.length < 8) problems.push(`${want.doc_no} line ${want.line_no}: key "${k}" is GONE from variants`); continue; }
        if (k === 'extraAddonNote') continue;
        if (JSON.stringify(now[k]) !== JSON.stringify(v)) {
          keysChanged += 1;
          if (problems.length < 8) problems.push(`${want.doc_no} line ${want.line_no}: key "${k}" changed value`);
        }
      }
      const gotNote = norm(now.extraAddonNote);
      if (gotNote === norm(want.text)) noted += 1;
      else if (gotNote === '') untouched += 1;
      else problems.push(`${want.doc_no} line ${want.line_no}: extraAddonNote is neither the before nor the after value`);
    }

    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    note(`  rows re-read                              : ${after.length} of ${ids.length}`);
    note(`  extraAddonNote reads back byte-for-byte   : ${noted}`);
    note(`  extraAddonNote still empty (untouched)    : ${untouched}`);
    note(`  variants is still a jsonb OBJECT          : ${after.length - notObject} of ${after.length}`);
    note(`  pre-existing variant keys LOST            : ${keysLost}`);
    note(`  pre-existing variant keys CHANGED         : ${keysChanged}`);
    note(`  rows missing                              : ${missing}`);
    note(`  sample value shape: ${JSON.stringify({ variants: after[0]?.variants_type, extraAddonNote: typeof (after[0]?.variants ?? {}).extraAddonNote })}`);

    if (notObject) bad(`${notObject} row(s) hold a non-object variants — the merge did not land as an object`);
    if (keysLost) bad(`${keysLost} pre-existing variant key(s) were deleted — this script must only MERGE`);
    if (keysChanged) bad(`${keysChanged} pre-existing variant key(s) changed value`);
    for (const p of problems.slice(0, 8)) bad(p);

    if (expectWritten && noted !== ids.length) {
      bad(`expected ${ids.length} note(s) on a fresh connection, found ${noted}`);
    }
    if (!expectWritten) {
      if (noted !== 0) bad(`PLAN rolled back, yet ${noted} row(s) already carry the note — the rollback did not hold`);
      else if (untouched === ids.length) note('  the rollback HELD: every planned row is exactly as it was.');
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
