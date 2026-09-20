#!/usr/bin/env node
// ----------------------------------------------------------------------------
// BACKFILL MISSING PRODUCT MODELS — every flat-category SKU gets a Model.
//
// WHY. The MODULAR / Product Models page reads scm.product_models; a SKU shows
// there only when its model_id points at a row. The New-SKU/Model dialog always
// created the model and linked its SKUs, but the bare create and the CSV batch
// import only set `base_model` and left model_id NULL — so every SKU imported
// that way never appeared under a Model. On company 1 that is 308 SKUs in the
// flat categories (base_model NULL, so each SKU is its own model):
//   ACCESSORY 108 · BEDLINES 85 · DINING 58 · DIFFUSER 39 · FABRIC_ACCESSORY 11
//   · SERVICE 5 · CARPET 2  = 308.
// SOFA / BEDFRAME / MATTRESS already carry models (modelled by a different
// process; the import merely linked), so they are NOT in scope here.
//
// The code path is fixed in the same PR (src/scm/lib/ensure-model-for-sku.ts,
// used by both create paths). This is the one-time backfill of the SKUs that
// were created before the fix. It uses the SAME find-or-create rule as the
// helper: modelCode = base_model when set, else the SKU's own code.
//
// WHAT IT DOES. For each company-1 SKU with model_id IS NULL in the flat
// categories: find-or-create its product_models row (ensureModelForSku, so the
// script and the routes key identically) and set the SKU's model_id. Never
// touches a SKU that already has a model_id (the UPDATE carries `model_id IS
// NULL`), so it cannot re-home a linked SKU.
//
// MODE=plan (default) prints the per-category count it WOULD backfill and writes
// NOTHING. MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes one
// SKU at a time, then verifies on a FRESH connection that every targeted SKU now
// carries a model_id whose product_models row matches (company, model_code,
// category).
//
// RE-RUN: safe and idempotent. Keyed on `model_id IS NULL`, which a successful
// backfill clears — a second run finds nothing to do, and where a SKU is
// re-seen the find-or-create LINKS to the model the first run made rather than
// creating a duplicate.
//
// Run: npx tsx scripts/backfill-missing-product-models.mjs                 (plan)
//      MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" npx tsx scripts/backfill-missing-product-models.mjs
// ----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { ensureModelForSku, modelCodeForSku } from '../src/scm/lib/ensure-model-for-sku.ts';

// The flat categories: base_model is NULL on these, so each SKU is its own
// 1:1 model. SOFA / BEDFRAME / MATTRESS are variant categories with models
// already and are deliberately excluded.
const FLAT_CATEGORIES = ['ACCESSORY', 'BEDLINES', 'DINING', 'DIFFUSER', 'CARPET', 'FABRIC_ACCESSORY', 'SERVICE'];

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY_ID || process.env.COMPANY || 1);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

function fromDevVars(field) {
  try {
    return readFileSync('.dev.vars', 'utf8').match(new RegExp(`^${field}="?([^"\\n]+)"?`, 'm'))?.[1];
  } catch { return undefined; }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars('DATABASE_URL');
if (!DATABASE_URL) { bad('DATABASE_URL not set (env var or .dev.vars)'); process.exit(2); }

const sql = postgres(DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  // The targets: company-scoped, flat categories, no model yet.
  const targets = await sql`
    SELECT id::text AS id, code, name, category::text AS category, base_model
      FROM scm.mfg_products
     WHERE company_id = ${CO}
       AND model_id IS NULL
       AND category::text = ANY(${FLAT_CATEGORIES})
     ORDER BY category, code`;

  note(`\n=== SKUs that WOULD get a Model, per category ===`);
  const perCat = new Map();
  for (const r of targets) perCat.set(r.category, (perCat.get(r.category) ?? 0) + 1);
  for (const cat of FLAT_CATEGORIES) note(`  ${cat.padEnd(18)} ${perCat.get(cat) ?? 0}`);
  note(`  ${'total'.padEnd(18)} ${targets.length}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  // The shim gives ensureModelForSku a supabase-js-shaped, scm-scoped client
  // over this connection. writeback stays the default "suppress" — this is a
  // catalog backfill, nothing to push to AutoCount.
  const sb = pgrestShim(sql, 'scm');

  note(`\n=== BACKFILLING ${targets.length} SKU(S) ===`);
  const done = [];
  const failures = [];
  for (const sku of targets) {
    const ensured = await ensureModelForSku(sb, {
      companyId: CO,
      code: sku.code,
      name: sku.name || sku.code,
      category: sku.category,
      baseModel: sku.base_model ?? null,
    });
    if (!ensured.ok) { failures.push({ code: sku.code, reason: ensured.reason }); continue; }
    // model_id IS NULL in the WHERE: never re-home a SKU that already has one,
    // so a concurrent linker or a re-run cannot overwrite a model.
    const wrote = await sql`
      UPDATE scm.mfg_products SET model_id = ${ensured.modelId}, updated_at = now()
       WHERE id = ${sku.id} AND company_id = ${CO} AND model_id IS NULL
      RETURNING id::text AS id`;
    if (wrote.length) done.push({ id: sku.id, code: sku.code });
    note(`  ${wrote.length ? 'OK  ' : 'SKIP'} ${sku.category.padEnd(16)} ${sku.code} -> model ${ensured.modelId}${ensured.created ? ' (created)' : ''}`);
  }
  for (const f of failures) bad(`  FAILED ${f.code}: ${f.reason}`);
  note(`\n  linked: ${done.length}   failed: ${failures.length}`);

  await sql.end({ timeout: 5 });

  // VERIFY on a fresh connection — the session that wrote is the worst witness
  // that the write landed. Assert the SHAPE (model_id present and its
  // product_models row matches the key), not a row count.
  const verify = postgres(DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const [{ n: stillNull }] = await verify`
      SELECT COUNT(*)::int AS n FROM scm.mfg_products
       WHERE company_id = ${CO} AND model_id IS NULL AND category::text = ANY(${FLAT_CATEGORIES})`;
    note(`  flat-category SKUs still without a Model: ${stillNull} (${failures.length} of those are the failures above)`);

    // Read the linked rows joined to their model and prove each one's shape:
    // model_id resolves, category matches, and model_code is the expected key.
    let mismatches = 0;
    let checked = 0;
    for (const d of done) {
      const [row] = await verify`
        SELECT p.code, p.base_model, p.model_id::text AS model_id,
               m.id::text AS model_row, m.model_code, m.category AS model_category
          FROM scm.mfg_products p
          LEFT JOIN scm.product_models m ON m.id = p.model_id AND m.company_id = ${CO}
         WHERE p.id = ${d.id} AND p.company_id = ${CO}`;
      checked += 1;
      const expectedCode = modelCodeForSku(row?.base_model ?? null, row?.code);
      const okShape = row && row.model_id && row.model_row
        && row.model_code === expectedCode
        && FLAT_CATEGORIES.includes(String(row.model_category));
      if (!okShape) {
        mismatches += 1;
        bad(`  SHAPE MISMATCH ${row?.code}: model_id=${row?.model_id} model_row=${row?.model_row} model_code=${row?.model_code} expected=${expectedCode} model_category=${row?.model_category}`);
      }
    }
    note(`  shape-verified ${checked - mismatches}/${checked} linked SKUs; mismatches: ${mismatches}`);
    if (mismatches > 0 || (failures.length === 0 && stillNull > 0)) {
      bad('verification found a problem — see the lines above');
      process.exitCode = 1;
    }
  } finally {
    await verify.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
