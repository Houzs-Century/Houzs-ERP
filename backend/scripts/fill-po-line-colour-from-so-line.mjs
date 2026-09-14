/* Put the SALES-ORDER line's Special note (the pillow's colour) onto a named
   purchase-order line that was raised before the note existed.

   THE OWNER, 2026-09-14: 「有一张枕头采购单没写颜色，找不出吗」.

   ── WHY A PO LINE CAN LACK IT ────────────────────────────────────────────
   A purchase-order line COPIES its sales-order line's `variants` at the moment
   it is raised and stamps description2 from buildVariantSummary(item_group,
   variants) (lib/po-convert-line.ts). PR #3526 put the book's spec text into
   the SALES-ORDER line's `variants.extraAddonNote`, which is what makes a PO
   raised AFTER it print `SPECIAL: <colour>`. A PO raised BEFORE that copy ran
   holds the old, empty bag and nothing ever refreshes it. HC-PO-2609-056 was
   raised from the MRP page at 2026-09-10 03:20Z; #3526 merged 14:50Z that day.

   ── WHAT IT WRITES — the same field and format #3526 writes ─────────────
   On each named, live, un-received PO line whose own note is empty and whose
   linked SO line (so_item_id) carries a non-empty note for the SAME item code:
     variants     = coalesce(variants,'{}') || {extraAddonNote: <SO line note>}
     description2 = buildVariantSummary(item_group, <merged variants>)
   description2 is recomputed exactly as PATCH /:id/items/:itemId does
   (mfg-purchase-orders.ts, "Description 2 is server-owned"), so the row reads
   as if an operator had typed the note in the PO editor. One entity_audit_log
   row per line (source 'repair') records the before/after of description2.

   It never writes qty, price, discount, totals, item code, supplier SKU,
   notes, so_item_id, status or any header field, never `variants.specials`
   (that key enters computeVariantKey and would re-key the line), and never
   touches AutoCount: this is a Postgres write, and the write-back is enqueued
   by the ROUTE layer, never by a trigger.

   SAFETY (release discipline, CLAUDE.md):
     MODE=plan (default) runs every write inside ONE transaction and ROLLS BACK.
     MODE=apply additionally requires CONFIRM="I HAVE REVIEWED THE DRY-RUN".
     PO_NUMBERS is REQUIRED — there is no population default.
     EXPECT_ROWS is REQUIRED — a plan that would write any other number of
     lines refuses, so a wider match than the one reviewed cannot commit.
     Each UPDATE re-asserts the facts the plan was made on (note still empty,
     variants still an object/NULL, qty/price/code unchanged, nothing received).
   VERIFY: re-reads on a FRESH connection and asserts the SHAPE — variants is a
   jsonb object, the note reads back byte-for-byte, every pre-existing variant
   key survives with an equal value, description2 equals the planned string,
   and qty / price / total / item code / notes / so_item_id are unchanged.

   RE-RUN: inert. A line whose extraAddonNote is already non-empty is skipped,
   so a second run plans zero rows (and with EXPECT_ROWS=1 it says so and
   refuses rather than pretending to write).

   USAGE (under tsx — imports the canonical buildVariantSummary from src/):
     DATABASE_URL=... PO_NUMBERS=HC-PO-2609-056 EXPECT_ROWS=1 \
       npx tsx scripts/fill-po-line-colour-from-so-line.mjs
     ... MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" ...

   Env: DATABASE_URL  PO_NUMBERS  EXPECT_ROWS  MODE=plan|apply  CONFIRM
        COMPANY (default 1) */

import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
const GH = !!process.env.GITHUB_ACTIONS;
const note = (m) => console.log(GH ? `::notice::${m}` : m);
const bad = (m) => console.log(GH ? `::error::${m}` : `ERROR ${m}`);
const say = (m = '') => console.log(m);

if (!DSN) { bad('DATABASE_URL is not set'); process.exit(1); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY || 1);
const PO_NUMBERS = String(process.env.PO_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const EXPECT_ROWS = process.env.EXPECT_ROWS === undefined || process.env.EXPECT_ROWS === '' ? NaN : Number(process.env.EXPECT_ROWS);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
if (!PO_NUMBERS.length) { bad('PO_NUMBERS is required (comma-separated purchase-order numbers)'); process.exit(2); }
if (!Number.isInteger(EXPECT_ROWS) || EXPECT_ROWS < 0) { bad('EXPECT_ROWS is required (the number of lines the reviewed plan writes)'); process.exit(2); }

const norm = (v) => String(v ?? '').trim();
const ROLLBACK = Symbol('rollback');
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  const { buildVariantSummary } = await import('../src/scm/shared/variant-summary.ts');
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (everything rolls back)'} company=${CO} po_numbers=${PO_NUMBERS.join(',')} expect_rows=${EXPECT_ROWS}`);

  const rows = await sql`
    SELECT p.id AS po_id, p.po_number, p.status::text AS po_status, p.po_email_sent_at, p.po_email_sent_to,
           it.id, it.line_no, it.item_code, it.item_group, it.qty, it.unit_price_sen, it.line_total_sen,
           coalesce(it.received_qty, 0) AS received_qty, it.notes, it.description2, it.variants,
           jsonb_typeof(it.variants) AS variants_type, it.so_item_id,
           s.doc_no AS so_doc_no, s.line_no AS so_line_no, s.item_code AS so_item_code,
           btrim(coalesce(s.variants->>'extraAddonNote', '')) AS so_note
      FROM scm.purchase_orders p
      JOIN scm.purchase_order_items it ON it.purchase_order_id = p.id
      LEFT JOIN scm.mfg_sales_order_items s ON s.id = it.so_item_id AND s.company_id = p.company_id
     WHERE p.company_id = ${CO} AND p.po_number = ANY(${PO_NUMBERS})
     ORDER BY p.po_number, it.line_no`;

  const found = new Set(rows.map((r) => r.po_number));
  for (const n of PO_NUMBERS) if (!found.has(n)) bad(`${n}: no such purchase order in company ${CO}`);

  const plan = [];
  say('\n=== EVERY LINE ON THE NAMED PURCHASE ORDERS ===');
  for (const r of rows) {
    const poNote = norm(r.variants && typeof r.variants === 'object' ? r.variants.extraAddonNote : '');
    let reason = null;
    if (['CANCELLED', 'DRAFT'].includes(r.po_status)) reason = `PO is ${r.po_status}`;
    else if (Number(r.received_qty) > 0) reason = 'goods already received on this line';
    else if (!r.so_item_id) reason = 'no sales-order link';
    else if (!r.so_doc_no) reason = 'linked sales-order line not found in this company';
    else if (norm(r.so_item_code) !== norm(r.item_code)) reason = `item code differs from the SO line (${r.so_item_code})`;
    else if (!r.so_note) reason = 'the sales-order line has no Special note either';
    else if (poNote) reason = `PO line already carries a note ${JSON.stringify(poNote)}`;
    else if (r.variants_type != null && r.variants_type !== 'object') reason = `variants is a jsonb ${r.variants_type}, not an object`;

    say(`${r.po_number} ${r.po_status} ln ${r.line_no} ${r.item_code} qty ${r.qty} recv ${r.received_qty} price_sen ${r.unit_price_sen}`);
    say(`   PO  note ${JSON.stringify(poNote)} · description2 ${JSON.stringify(r.description2)} · remark ${JSON.stringify(r.notes)}`);
    say(`   SO  ${r.so_doc_no ?? 'NO LINK'} ln ${r.so_line_no ?? '-'} ${r.so_item_code ?? ''} note ${JSON.stringify(r.so_note ?? '')}`);
    say(`   PO emailed: ${r.po_email_sent_at ? `${r.po_email_sent_at} to ${r.po_email_sent_to}` : 'never (po_email_sent_at is empty)'}`);
    if (reason) { say(`   SKIP: ${reason}`); continue; }

    const prior = r.variants ?? {};
    const merged = { ...prior, extraAddonNote: r.so_note };
    const nextDesc2 = buildVariantSummary(String(r.item_group ?? ''), merged) || null;
    say(`   WRITE variants.extraAddonNote = ${JSON.stringify(r.so_note)}`);
    say(`         description2 ${JSON.stringify(r.description2)} -> ${JSON.stringify(nextDesc2)}`);
    plan.push({ ...r, prior, nextDesc2 });
  }

  note(`plan: ${plan.length} line(s) to write, expected ${EXPECT_ROWS}`);
  if (plan.length !== EXPECT_ROWS) {
    bad(`plan has ${plan.length} line(s) but EXPECT_ROWS=${EXPECT_ROWS} — refusing; review the lines above`);
    await sql.end({ timeout: 5 });
    process.exit(plan.length === 0 ? 0 : 3);
  }
  if (!plan.length) { note('Nothing to write.'); await sql.end({ timeout: 5 }); return; }

  let wrote = 0;
  try {
    await sql.begin(async (tx) => {
      for (const p of plan) {
        const back = await tx`
          UPDATE scm.purchase_order_items
             SET variants = coalesce(variants, '{}'::jsonb) || ${tx.json({ extraAddonNote: p.so_note })},
                 description2 = ${p.nextDesc2}
           WHERE id = ${p.id}
             AND company_id = ${CO}
             AND (variants IS NULL OR jsonb_typeof(variants) = 'object')
             AND coalesce(btrim(variants->>'extraAddonNote'), '') = ''
             AND qty = ${p.qty} AND unit_price_sen = ${p.unit_price_sen}
             AND item_code = ${p.item_code}
             AND coalesce(received_qty, 0) = 0
          RETURNING id`;
        wrote += back.length;
        await tx`
          INSERT INTO scm.entity_audit_log
            (entity_type, entity_id, entity_doc_no, company_id, action, actor_id, actor_name_snapshot,
             field_changes, status_snapshot, source, note)
          VALUES ('PURCHASE_ORDER', ${String(p.po_id)}, ${p.po_number}, ${CO}, 'UPDATE', NULL,
                  'fill-po-line-colour-from-so-line',
                  ${tx.json([{ field: 'description2', from: p.description2 ?? null, to: p.nextDesc2 }])},
                  ${p.po_status}, 'repair',
                  ${`Line edited: ${p.item_code} - Special note copied from ${p.so_doc_no} line ${p.so_line_no}`})`;
      }
      note(`${APPLY ? 'wrote' : 'would write'}: ${wrote} line(s)`);
      if (wrote !== plan.length) throw new Error(`expected ${plan.length}, wrote ${wrote} — refusing`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note('PLAN: transaction rolled back, nothing was written.');
    await sql.end({ timeout: 5 });
    await verify(plan, { expectWritten: false });
    note(`Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to keep it.`);
    return;
  }
  await sql.end({ timeout: 5 });
  await verify(plan, { expectWritten: true });
}

async function verify(plan, { expectWritten }) {
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failures = 0;
  const fail = (m) => { failures += 1; bad(m); };
  try {
    const ids = plan.map((p) => p.id);
    const after = await check`
      SELECT id, qty, unit_price_sen, line_total_sen, item_code, notes, so_item_id, item_group,
             description2, variants, jsonb_typeof(variants) AS variants_type
        FROM scm.purchase_order_items WHERE id = ANY(${ids}) AND company_id = ${CO}`;
    const byId = new Map(after.map((r) => [String(r.id), r]));
    say('\n=== VERIFIED ON A FRESH CONNECTION ===');
    for (const p of plan) {
      const got = byId.get(String(p.id));
      const tag = `${p.po_number} ln ${p.line_no}`;
      if (!got) { fail(`${tag}: row disappeared`); continue; }
      for (const k of ['qty', 'unit_price_sen', 'line_total_sen', 'item_code', 'notes', 'so_item_id', 'item_group']) {
        if (String(got[k] ?? '') !== String(p[k] ?? '')) fail(`${tag}: ${k} changed ${JSON.stringify(p[k])} -> ${JSON.stringify(got[k])}`);
      }
      if (got.variants_type != null && got.variants_type !== 'object') { fail(`${tag}: variants is jsonb ${got.variants_type}`); continue; }
      const now = got.variants ?? {};
      for (const [k, v] of Object.entries(p.prior)) {
        if (k === 'extraAddonNote') continue;
        if (!(k in now)) fail(`${tag}: variant key "${k}" is GONE`);
        else if (JSON.stringify(now[k]) !== JSON.stringify(v)) fail(`${tag}: variant key "${k}" changed`);
      }
      const gotNote = norm(now.extraAddonNote);
      if (expectWritten) {
        if (got.variants_type !== 'object') fail(`${tag}: variants is not a jsonb object after apply`);
        if (typeof now.extraAddonNote !== 'string' || gotNote !== p.so_note) fail(`${tag}: extraAddonNote reads ${JSON.stringify(now.extraAddonNote)}, wanted ${JSON.stringify(p.so_note)}`);
        if ((got.description2 ?? null) !== p.nextDesc2) fail(`${tag}: description2 reads ${JSON.stringify(got.description2)}, wanted ${JSON.stringify(p.nextDesc2)}`);
      } else {
        if (gotNote !== '') fail(`${tag}: PLAN rolled back, yet the note reads ${JSON.stringify(gotNote)}`);
        if ((got.description2 ?? null) !== (p.description2 ?? null)) fail(`${tag}: PLAN rolled back, yet description2 changed`);
      }
      say(`  ${tag}: variants=${got.variants_type ?? 'NULL'} extraAddonNote=${JSON.stringify(now.extraAddonNote ?? null)} description2=${JSON.stringify(got.description2)} qty=${got.qty} unit_price_sen=${got.unit_price_sen} item_code=${got.item_code} remark=${JSON.stringify(got.notes)}`);
    }
    if (expectWritten) {
      const [{ n }] = await check`
        SELECT count(*)::int AS n FROM scm.entity_audit_log
         WHERE source = 'repair' AND actor_name_snapshot = 'fill-po-line-colour-from-so-line'
           AND entity_id = ANY(${plan.map((p) => String(p.po_id))})`;
      say(`  audit rows for these POs from this script: ${n}`);
      if (n < plan.length) fail(`expected at least ${plan.length} audit row(s), found ${n}`);
    }
    if (failures) { bad(`${failures} verification failure(s)`); process.exitCode = 1; }
    else note(expectWritten ? 'VERIFIED: every planned line reads back as written, nothing else moved.' : 'the rollback HELD: every planned line is exactly as it was.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
