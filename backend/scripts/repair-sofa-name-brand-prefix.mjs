#!/usr/bin/env node
/* Sofa SKU names that still carry the brand in front: "2990S SOFA SOFA BANGGAU
   1A(LHF)" should read "SOFA BANGGAU 1A(LHF)".

   #4376 (2026-09-30) stopped the Model save and Generate SKUs from writing the
   brand into the name, but the rows minted before it kept it. Read from
   production 2026-10-05: 31 in 2990's Home (BANGGAU 14, KABBIN 14, TELLUC 3)
   and 2 in Houzs Century (8030-2B(LHF)/(RHF), "ZANOTTI SOFA SOFFIO ...").

   Every company is scanned; each row is written by id AND company_id. A row is
   renamed only when stripping its own branding leaves exactly
   `SOFA {model name} {compartment}` (lib/sofa-brandless-name.mjs); anything
   else is printed as REFUSED and left alone. Only scm.mfg_products.name
   changes: documents already issued keep the description they were saved with.

   MODE=plan (default) lists every row, from -> to, and writes nothing.
   MODE=apply needs CONFIRM="RENAME SOFA NAMES", then re-reads on a fresh
   connection that every renamed row now holds its target name.

   RE-RUN: inert. A renamed row no longer starts with its brand, so it is not selected again. */
import postgres from 'postgres';
import { brandlessSofaName } from './lib/sofa-brandless-name.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'RENAME SOFA NAMES';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const candidates = (client) => client`
  SELECT p.id, p.company_id, p.code, p.name, p.branding, m.name AS model_name
    FROM scm.mfg_products p
    LEFT JOIN scm.product_models m ON m.id::text = p.model_id::text AND m.company_id = p.company_id
   WHERE p.category = 'SOFA'
     AND coalesce(trim(p.branding), '') <> ''
     AND upper(p.name) LIKE upper(trim(p.branding)) || ' SOFA %'
   ORDER BY p.company_id, p.code`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}`);
  const rows = await candidates(sql);
  const fix = [], refuse = [];
  for (const r of rows) {
    const d = brandlessSofaName({ name: r.name, branding: r.branding, modelName: r.model_name, code: r.code });
    if (!d) continue;
    if (d.ok) fix.push({ ...r, to: d.to });
    else refuse.push({ ...r, why: d.why });
  }

  note(`\n=== SOFA NAMES CARRYING THE BRAND ===`);
  for (const r of fix) note(`  co=${r.company_id} ${r.code.padEnd(18)} "${r.name}" -> "${r.to}"`);
  for (const r of refuse) bad(`  co=${r.company_id} ${r.code.padEnd(18)} "${r.name}" REFUSED: ${r.why}`);
  note(`  to rename: ${fix.length}   refused: ${refuse.length}`);

  if (!APPLY || fix.length === 0) {
    if (!APPLY) note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  let wrote = 0;
  await sql.begin(async (tx) => {
    for (const r of fix) {
      const back = await tx`
        UPDATE scm.mfg_products SET name = ${r.to}, updated_at = now()
         WHERE id = ${r.id} AND company_id = ${r.company_id} AND name = ${r.name}
        RETURNING id`;
      wrote += back.length;
    }
  });
  note(`  written: ${wrote} of ${fix.length}`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let wrong = 0;
    for (const r of fix) {
      const [row] = await check`SELECT name FROM scm.mfg_products WHERE id = ${r.id} AND company_id = ${r.company_id}`;
      if (row?.name !== r.to) { wrong++; bad(`  co=${r.company_id} ${r.code} reads "${row?.name}", expected "${r.to}"`); }
    }
    const left = (await candidates(check)).filter((r) =>
      brandlessSofaName({ name: r.name, branding: r.branding, modelName: r.model_name, code: r.code })?.ok);
    note(`  renamed rows holding their target name: ${fix.length - wrong} of ${fix.length}; fixable brand-prefixed names left: ${left.length}`);
    if (wrong || left.length) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
