// Read-only: WHY does a SKU that HAS suppliers bound read as having none where
// it matters (the MRP row, the purchase-order picker)?
//
// The owner, 2026-09-10, on model 9058: the Product page lists its suppliers and
// the plan screen shows none. Both cannot be right, and which one is wrong
// decides whether this is a data repair or a code fix — so this script asks the
// database the SAME question in BOTH shapes the code asks it, side by side, and
// prints where they diverge.
//
// THE HYPOTHESIS THIS EXISTS TO REFUTE. The two readers do not carry the same
// predicates:
//
//   the SHARED reader — lib/supplier-bindings.ts, used by MRP, the PO picker,
//     so-revision and the AutoCount outbox — filters material_kind =
//     'mfg_product' AND company_id.
//   the PRODUCT page  — routes/mfg-products.ts GET /:id/suppliers — filters
//     company_id and NOT material_kind.
//
// So a binding row whose material_kind is anything else (or NULL) is VISIBLE on
// the product page and INVISIBLE everywhere a purchase order is raised, which
// would produce exactly this symptom. It is a hypothesis and nothing more until
// this runs: if every row comes back 'mfg_product', the hypothesis is REFUTED
// and the cause is elsewhere. Two other readings are printed so they can be told
// apart rather than assumed — the bindings sitting on the MODEL code while the
// demand rows carry the PIECE codes, and a binding whose supplier row is gone
// (MRP skips those silently, which also reads as "no supplier").
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer INCLUDING "no rows at all" — that is a finding, not a
// failure — so a red job means the database was unreachable, never that the
// answer was unwelcome. Nothing is inserted to make an answer tidy.
//
// RE-RUN: read-only and stateless. A second run reports whatever is true then.
//
//   DATABASE_URL   required
//   CODES          comma-separated item codes. Matched exactly AND by prefix,
//                  so a model name finds its pieces. Default: 9058
//   COMPANY_ID     default 1 (Houzs Century)
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(1);
}

const CO = Number(process.env.COMPANY_ID ?? 1);
const CODES = (process.env.CODES ?? '9058').split(',').map((s) => s.trim()).filter(Boolean);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  log(`company=${CO}  codes asked for: ${CODES.join(', ')}`);
  log('');

  /* 1. WHICH CODES EVEN EXIST. The owner names a MODEL; a sofa's demand and its
        purchase orders carry PIECE codes, so "9058 has suppliers" and "the row
        the plan drew has suppliers" can be statements about different codes.
        Match the prefix too, so both readings are on screen at once. */
  const products = await sql`
    SELECT code, name, category, company_id
      FROM scm.mfg_products
     WHERE company_id = ${CO}
       AND (code = ANY(${CODES})
            OR EXISTS (SELECT 1 FROM unnest(${CODES}::text[]) p WHERE code LIKE p || '%'))
     ORDER BY code`;
  log(`mfg_products rows matching (exact or prefix): ${products.length}`);
  for (const p of products) log(`  ${p.code}  [${p.category ?? 'no category'}]  ${p.name ?? ''}`);
  if (products.length === 0) {
    log('  NONE. Either the code is spelled differently in scm.mfg_products, or it');
    log('  belongs to another company. That is the finding.');
  }
  log('');

  const codeList = products.length > 0 ? products.map((p) => p.code) : CODES;

  /* 2. EVERY BINDING ROW, filtered by code ALONE. No company predicate and no
        material_kind predicate, deliberately: the point is to see what each
        reader throws away. */
  const binds = await sql`
    SELECT b.item_code, b.material_kind, b.company_id, b.supplier_id,
           b.is_main_supplier, b.supplier_sku,
           s.code AS supplier_code, s.name AS supplier_name
      FROM scm.supplier_material_bindings b
      LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.item_code = ANY(${codeList})
     ORDER BY b.item_code, b.is_main_supplier DESC, b.id`;
  log(`supplier_material_bindings rows for those codes, NO filters: ${binds.length}`);
  for (const b of binds) {
    log(`  ${b.item_code}  kind=${b.material_kind ?? 'NULL'}  company=${b.company_id ?? 'NULL'}`
      + `  main=${b.is_main_supplier}`
      + `  ${b.supplier_code ?? '(supplier row missing)'} ${b.supplier_name ?? ''}`);
  }
  log('');

  /* 3. THE TWO READERS, replayed over those same rows with the predicates each
        one actually carries. A gap between these two numbers IS the bug. */
  const asProductPage = binds.filter((b) => Number(b.company_id) === CO);
  const asSharedReader = binds.filter(
    (b) => Number(b.company_id) === CO && b.material_kind === 'mfg_product',
  );
  log(`the PRODUCT page would show (company only):             ${asProductPage.length}`);
  log(`the SHARED reader would return (company + mfg_product): ${asSharedReader.length}`);

  const hidden = asProductPage.filter((b) => b.material_kind !== 'mfg_product');
  if (hidden.length > 0) {
    log('');
    log(`HYPOTHESIS CONFIRMED for ${hidden.length} row(s): visible on the product page,`);
    log('invisible to the plan and the purchase-order picker. Their material_kind:');
    for (const b of hidden) {
      log(`  ${b.item_code}  kind=${b.material_kind ?? 'NULL'}  ${b.supplier_code ?? ''}`);
    }
  } else if (asProductPage.length > 0) {
    log('');
    log('HYPOTHESIS REFUTED: every binding this company can see already says');
    log('material_kind=mfg_product, so the shared reader returns all of them and');
    log('the two screens cannot disagree for THIS reason. Look elsewhere — the');
    log('next candidates are the code the demand row actually carries (section 1');
    log('lists the family) and a missing supplier row (section 4).');
  }

  /* 4. ORPHANS. Both readers join suppliers, and MRP drops a binding whose
        supplier row is gone ("orphaned binding — skip"), so a complete binding
        list with a deleted supplier reads as no supplier on that screen too. */
  const orphans = binds.filter((b) => !b.supplier_code);
  if (orphans.length > 0) {
    log('');
    log(`${orphans.length} binding(s) point at a supplier row that does not exist.`);
    log('MRP skips those silently, so they read as "no supplier" there as well.');
  }
} catch (err) {
  console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
