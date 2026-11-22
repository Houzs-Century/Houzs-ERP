#!/usr/bin/env node
/* normalize-houzs-hydraulic.mjs — make the HOUZS "hydraulic" special order read
   as proper text "Hydraulic" in the THREE places that must agree or the tick
   breaks. Owner 2026-10-29: "目前有了，但是帮我修改成 proper text" — the option
   shows as all-caps HYDRAULIC and old orders print it three ways (hydraulic /
   Hydraulic / HYDRAULIC).

   WHY ALL THREE TOGETHER:
     1. the catalogue option (scm.special_addons) — what the picker shows and
        what a NEW tick stores;
     2. the per-Model specials pool (scm.product_models.allowed_options.specials)
        — the SO picker intersects the catalogue code against this pool with an
        EXACT, case-sensitive match (SoLineCard.tsx), and 116 HOUZS Models pin
        "HYDRAULIC", so changing only the catalogue would make the tick VANISH on
        those Models;
     3. the stored Sales Order lines (variants.specials + the derived
        description2) — buildVariantSummary prints the stored specials value
        VERBATIM on the PDF, so an old line keeps its spelling until the stored
        value is fixed.

   SCOPE: company 1 (HOUZS) only — 2990 has its own Hydraulic / Power Hydraulic
   pair and is left alone. A "bare hydraulic" token is exactly "hydraulic" (any
   case); "Power Hydraulic" is never touched. The spelling rules are the pure,
   unit-tested scripts/lib/hydraulic-normalize.mjs.

   SAFE BY CONSTRUCTION:
     · variant_key folds specials to lower-case (shared/variant-key.ts `norm`),
       so a casing change never moves a stock bucket — allocation is untouched;
     · description2 is fixed by a WHOLE-WORD replace of the hydraulic token only,
       so a stale migrated summary keeps its shape apart from that one word;
       `description` never carries it and `remark` (账本原文 book text) is NOT
       touched — its hydraulic count is asserted UNCHANGED on verify;
     · price stays 0/0; no money moves.

   MODE=plan (default) reports counts and writes nothing. MODE=apply needs
   CONFIRM="NORMALIZE HOUZS HYDRAULIC", writes everything in ONE transaction, and
   verifies on a FRESH connection that no non-proper hydraulic token remains in
   the catalogue, the pools or the lines, and that the book-text count is intact.

   RE-RUN: inert. Every write targets the proper-case end state, so a second run
   finds nothing left to change and the same verification passes. */
import postgres from 'postgres';
import {
  HYD_TARGET,
  normalizeSpecialsArray,
  normalizeVariantsHydraulic,
  properHydraulicText,
} from './lib/hydraulic-normalize.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'NORMALIZE HOUZS HYDRAULIC';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} target="${HYD_TARGET}"`);

  // ── 1. Catalogue — the bare-hydraulic rows in scm.special_addons ──────────
  const catRows = await sql`
    SELECT id::text AS id, code, label, so_description, active
      FROM scm.special_addons
     WHERE company_id = ${CO} AND lower(btrim(code)) = 'hydraulic'`;
  // Keep the row that already spells it right (else the active one, else any);
  // make it the single active "Hydraulic"; retire every other bare row.
  const keeper = catRows.find((r) => r.code === HYD_TARGET)
    ?? catRows.find((r) => r.active)
    ?? catRows[0]
    ?? null;
  const catPlan = [];
  for (const r of catRows) {
    if (keeper && r.id === keeper.id) {
      const wants = !r.active || r.code !== HYD_TARGET || r.label !== HYD_TARGET || r.so_description !== HYD_TARGET;
      if (wants) catPlan.push({ id: r.id, op: 'keep-active', fromCode: r.code });
    } else if (r.active) {
      catPlan.push({ id: r.id, op: 'retire', fromCode: r.code });
    }
  }
  note(`\n[catalogue] bare-hydraulic rows: ${catRows.length}` +
    (catRows.length ? ` -> ${catRows.map((r) => `"${r.code}"(${r.active ? 'active' : 'retired'})`).join(', ')}` : ''));
  note(`[catalogue] keeper: ${keeper ? `"${keeper.code}"` : '(none found)'} ; changes: ${catPlan.length}`);

  // ── 2. Model pools — specials arrays that carry a non-proper hydraulic ────
  const poolRows = await sql`
    SELECT id::text AS id, allowed_options
      FROM scm.product_models
     WHERE company_id = ${CO}
       AND jsonb_typeof(allowed_options->'specials') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(allowed_options->'specials') s
          WHERE lower(btrim(s)) = 'hydraulic' AND s <> ${HYD_TARGET})`;
  const poolPlan = [];
  for (const r of poolRows) {
    const ao = r.allowed_options ?? {};
    const res = normalizeSpecialsArray(ao.specials);
    if (res.changed) poolPlan.push({ id: r.id, nextAllowedOptions: { ...ao, specials: res.next } });
  }
  note(`\n[pools] HOUZS models with a non-proper hydraulic in the pool: ${poolRows.length} ; changes: ${poolPlan.length}`);

  // ── 3. Lines — stored variants.specials + the derived description2 ────────
  const lineRows = await sql`
    SELECT li.id::text AS id, li.item_group, li.variants, li.description2
      FROM scm.mfg_sales_order_items li
      JOIN scm.mfg_sales_orders so ON so.doc_no = li.doc_no
     WHERE so.company_id = ${CO}
       AND (li.variants::text ILIKE '%hydraul%' OR li.description2 ILIKE '%hydraul%')`;
  const linePlan = [];
  for (const r of lineRows) {
    const v = normalizeVariantsHydraulic(r.variants);
    const d2 = properHydraulicText(r.description2);
    if (v.changed || d2.changed) {
      linePlan.push({ id: r.id, varsChanged: v.changed, nextVariants: v.next, d2Changed: d2.changed, nextDesc2: d2.next });
    }
  }
  const specialsChanges = linePlan.filter((o) => o.varsChanged).length;
  const desc2Changes = linePlan.filter((o) => o.d2Changed).length;
  note(`\n[lines] candidate lines: ${lineRows.length} ; lines to change: ${linePlan.length}` +
    ` (specials: ${specialsChanges}, description2: ${desc2Changes})`);

  // The book-text count we must leave exactly as it is.
  const [{ n: remarkBefore }] = await sql`
    SELECT count(*)::int AS n
      FROM scm.mfg_sales_order_items li
      JOIN scm.mfg_sales_orders so ON so.doc_no = li.doc_no
     WHERE so.company_id = ${CO} AND li.remark ILIKE '%hydraul%'`;
  note(`[lines] book-text (remark) hydraulic lines, left untouched: ${remarkBefore}`);

  const totalChanges = catPlan.length + poolPlan.length + linePlan.length;
  if (!totalChanges) { note(`\nAlready normalized — nothing to do.`); await sql.end({ timeout: 5 }); return; }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── APPLY — one transaction so the three surfaces can never disagree ──────
  note(`\n=== APPLYING: ${catPlan.length} catalogue, ${poolPlan.length} pools, ${linePlan.length} lines ===`);
  await sql.begin(async (tx) => {
    for (const c of catPlan) {
      if (c.op === 'keep-active') {
        await tx.unsafe(
          `UPDATE scm.special_addons SET active = true, code = $1, label = $1, so_description = $1 WHERE id = $2`,
          [HYD_TARGET, c.id]);
      } else {
        await tx.unsafe(`UPDATE scm.special_addons SET active = false WHERE id = $1`, [c.id]);
      }
    }
    for (const p of poolPlan) {
      await tx.unsafe(
        `UPDATE scm.product_models SET allowed_options = $1::text::jsonb WHERE id = $2`,
        [JSON.stringify(p.nextAllowedOptions), p.id]);
    }
    for (const o of linePlan) {
      if (o.varsChanged && o.d2Changed) {
        await tx.unsafe(
          `UPDATE scm.mfg_sales_order_items SET variants = $1::text::jsonb, description2 = $2 WHERE id = $3`,
          [JSON.stringify(o.nextVariants), o.nextDesc2, o.id]);
      } else if (o.varsChanged) {
        await tx.unsafe(
          `UPDATE scm.mfg_sales_order_items SET variants = $1::text::jsonb WHERE id = $2`,
          [JSON.stringify(o.nextVariants), o.id]);
      } else {
        await tx.unsafe(
          `UPDATE scm.mfg_sales_order_items SET description2 = $1 WHERE id = $2`,
          [o.nextDesc2, o.id]);
      }
    }
  });
  note(`  written.`);

  // ── VERIFY on a FRESH connection, asserting the SHAPE (not a row count) ───
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failed = 0;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);

    // Catalogue: exactly one ACTIVE bare-hydraulic row, and its code is proper.
    const catBack = await check`
      SELECT code, active
        FROM scm.special_addons
       WHERE company_id = ${CO} AND lower(btrim(code)) = 'hydraulic'`;
    const activeCat = catBack.filter((r) => r.active);
    const catOk = activeCat.length === 1 && activeCat[0].code === HYD_TARGET;
    if (!catOk) { failed++; bad(`  [catalogue] expected one active "${HYD_TARGET}", got ${JSON.stringify(activeCat.map((r) => r.code))}`); }
    else note(`  [catalogue] one active row, code "${activeCat[0].code}" — OK`);

    // Pools: no HOUZS model still carries a non-proper hydraulic in its pool.
    const [{ n: poolLeft }] = await check`
      SELECT count(*)::int AS n FROM scm.product_models
       WHERE company_id = ${CO}
         AND jsonb_typeof(allowed_options->'specials') = 'array'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(allowed_options->'specials') s
                      WHERE lower(btrim(s)) = 'hydraulic' AND s <> ${HYD_TARGET})`;
    const [{ n: poolProper }] = await check`
      SELECT count(*)::int AS n FROM scm.product_models
       WHERE company_id = ${CO}
         AND jsonb_typeof(allowed_options->'specials') = 'array'
         AND jsonb_exists(allowed_options->'specials', ${HYD_TARGET})`;
    if (poolLeft !== 0) { failed++; bad(`  [pools] ${poolLeft} model(s) still carry a non-proper hydraulic`); }
    else note(`  [pools] 0 non-proper left; ${poolProper} model(s) now pool "${HYD_TARGET}" — OK`);

    // Lines: re-read the candidates and prove each is fully normalized now.
    const lineBack = await check`
      SELECT li.id::text AS id, li.variants, li.description2
        FROM scm.mfg_sales_order_items li
        JOIN scm.mfg_sales_orders so ON so.doc_no = li.doc_no
       WHERE so.company_id = ${CO}
         AND (li.variants::text ILIKE '%hydraul%' OR li.description2 ILIKE '%hydraul%')`;
    let lineLeft = 0;
    for (const r of lineBack) {
      if (normalizeVariantsHydraulic(r.variants).changed || properHydraulicText(r.description2).changed) lineLeft++;
    }
    if (lineLeft !== 0) { failed++; bad(`  [lines] ${lineLeft} line(s) still carry a non-proper hydraulic`); }
    else note(`  [lines] ${lineBack.length} candidate(s) re-read, all proper — OK`);

    // Book text must be exactly as it was.
    const [{ n: remarkAfter }] = await check`
      SELECT count(*)::int AS n
        FROM scm.mfg_sales_order_items li
        JOIN scm.mfg_sales_orders so ON so.doc_no = li.doc_no
       WHERE so.company_id = ${CO} AND li.remark ILIKE '%hydraul%'`;
    if (remarkAfter !== remarkBefore) { failed++; bad(`  [remark] book-text count moved ${remarkBefore} -> ${remarkAfter} — it must not`); }
    else note(`  [remark] book-text count unchanged at ${remarkAfter} — OK`);
  } finally {
    await check.end({ timeout: 5 });
  }
  if (failed) process.exit(1);
  note(`\nAll checks passed.`);
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
