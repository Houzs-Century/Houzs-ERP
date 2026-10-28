#!/usr/bin/env node
/* RECODE the 5562 sofa pieces off the stray `-1S-` prefix (DEV-29).

   WHY. 5562-1S was opened 2026-08-28 as a lone SOFA SKU with no base_model, and
   the BUG-31 Modular backfill keys such a SKU as its own Model, so 5562 became a
   Model coded `5562-1S` named "SOFA 5562 1S". On 2026-10-01 its compartments were
   switched on in Modular, which auto-creates `{model_code}-{comp}` named
   `SOFA {model name} {comp}`: 5562-1S-1A(LHF) "SOFA SOFA 5562 1S 1A(LHF)". The
   Model was then recoded to 5562 by hand, which does not carry to its SKUs.
   Owner (Sim, DEV-29): "remove the 1S, should be 5562-1A(LHF)".

   Measured first (probe-sofa-piece-coded-models.mjs, run 36813344240): the 14
   generated SKUs sit on NO document, stock row or movement; each holds one
   supplier binding and one binding price-history row. 5562-1S-1S would recode
   onto 5562-1S, which is the real one-seater (AutoCount HOK-5562 SOFA), so it is
   a duplicate and is DELETED with its binding rows instead.

   WHAT IT WRITES (company COMPANY_ID, default 1), one transaction:
     1  the 13 others: code 5562-1S-<comp> -> 5562-<comp> on every
        PRODUCT_CODE_CASCADE column (the same list PATCH /mfg-products renames),
        then the SKU row itself: code, name "SOFA 5562 <comp>", base_model 5562
     2  5562-1S-1S: its supplier_binding_price_history + supplier_material_bindings
        rows, then the SKU — refused if anything else references it
     3  5562-1S: base_model 5562 (it was NULL, which is what keyed it as a Model)
     4  Model 5562: name "5562", so the next auto-created piece reads
        "SOFA 5562 <comp>" and not "SOFA SOFA 5562 <comp>"
     5  the generated bindings' supplier_sku HOK-5562-1S-<comp> -> HOK-5562-<comp>:
        the cascade keeps supplier_sku (the supplier's code), but these were
        stamped from our wrong code on 2026-10-01 and print on the Hookka PO
   It refuses unless every source SKU is still exactly as measured: on model 5562,
   used nowhere but its binding rows, and its target code free.

   MODE=plan (default) prints the plan and writes nothing. MODE=apply needs
   CONFIRM="RECODE 5562 SOFA SKUS", then re-reads on a FRESH connection.
   RE-RUN: inert — after the first apply no `5562-1S-%` code is left to match. */
import postgres from 'postgres';
import { PRODUCT_CODE_CASCADE } from '../src/scm/lib/product-code-rename.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply' || process.env.APPLY === '1';
const PHRASE = 'RECODE 5562 SOFA SKUS';
if (APPLY && process.env.CONFIRM !== PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${PHRASE}" — refusing.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const MODEL = '5562';
const OLD_PREFIX = `${MODEL}-1S-`;
const ONE_SEATER = `${MODEL}-1S`;
const say = (m = '') => console.log(process.env.GITHUB_ACTIONS && m.startsWith('=') ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/* The binding rows the generated SKUs carry; the doomed duplicate's are deleted. */
const BINDING_TABLES = new Set(['supplier_material_bindings', 'supplier_binding_price_history']);

async function usage(tx, code) {
  const out = {};
  for (const t of PRODUCT_CODE_CASCADE) {
    const [r] = await tx.unsafe(
      `SELECT count(*)::int AS n FROM scm.${t.table} WHERE company_id = $1 AND ${t.col} = $2${t.kind ? " AND material_kind = 'mfg_product'" : ''}`,
      [CO, code]);
    if (r.n) out[`${t.table}.${t.col}`] = r.n;
  }
  return out;
}

async function fkRefs(tx, relation, id) {
  const fks = await tx`
    SELECT c.conrelid::regclass::text AS rel, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = ${relation}::regclass`;
  const out = {};
  for (const f of fks) {
    const [r] = await tx.unsafe(`SELECT count(*)::int AS n FROM ${f.rel} WHERE "${f.col}"::text = $1`, [id]);
    if (r.n) out[`${f.rel}.${f.col}`] = r.n;
  }
  return out;
}

const sql = postgres(DSN, { ssl: 'require', max: 1, prepare: false });
let planned = [];
try {
  await sql.begin(async (tx) => {
    if (!APPLY) await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    say(`=== mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} ===`);

    const [model] = await tx`
      SELECT id::text AS id, model_code, name FROM scm.product_models
       WHERE company_id = ${CO} AND category = 'SOFA' AND model_code = ${MODEL}`;
    if (!model) throw new Error(`no SOFA model ${MODEL} on company ${CO}`);
    say(`  model ${model.model_code} id=${model.id} name="${model.name}"`);

    const skus = await tx`
      SELECT id::text AS id, code, name, base_model, model_id::text AS model_id
        FROM scm.mfg_products
       WHERE company_id = ${CO} AND category = 'SOFA' AND code LIKE ${OLD_PREFIX + '%'}
       ORDER BY code`;
    if (skus.length === 0) { say('  nothing on the 5562-1S- prefix — already recoded.'); return; }

    const problems = [];
    for (const s of skus) {
      const comp = s.code.slice(OLD_PREFIX.length);
      const target = `${MODEL}-${comp}`;
      if (s.model_id !== model.id) problems.push(`${s.code} belongs to model ${s.model_id}, not ${model.id}`);
      const used = await usage(tx, s.code);
      const elsewhere = Object.keys(used).filter((k) => !BINDING_TABLES.has(k.split('.')[0]));
      if (elsewhere.length) problems.push(`${s.code} is used by ${elsewhere.map((k) => `${k}=${used[k]}`).join(', ')}`);
      const [taken] = await tx`SELECT id::text AS id FROM scm.mfg_products WHERE company_id = ${CO} AND code = ${target}`;
      const action = target === ONE_SEATER ? 'delete' : 'recode';
      if (action === 'recode' && taken) problems.push(`${target} is already taken`);
      if (action === 'delete') {
        if (!taken) problems.push(`${ONE_SEATER} is missing — refusing to delete its duplicate`);
        const refs = await fkRefs(tx, 'scm.mfg_products', s.id);
        if (Object.keys(refs).length) problems.push(`${s.code} id is referenced by ${JSON.stringify(refs)}`);
      }
      const name = `SOFA ${MODEL} ${comp}`;
      const supSkus = action === 'recode' ? (await tx`
        SELECT DISTINCT supplier_sku FROM scm.supplier_material_bindings
         WHERE company_id = ${CO} AND item_code = ${s.code} AND material_kind = 'mfg_product'
           AND supplier_sku LIKE ${'%' + OLD_PREFIX + '%'}`).map((r) => r.supplier_sku) : [];
      planned.push({ ...s, comp, target, name, action, used, supSkus });
      say(`  ${action === 'delete' ? 'DELETE' : 'RECODE'} ${s.code} "${s.name}"${action === 'recode' ? ` -> ${target} "${name}"` : ` (duplicate of ${ONE_SEATER})`}  [${Object.entries(used).map(([k, n]) => `${k}=${n}`).join(', ') || 'unused'}]`);
      for (const sk of supSkus) say(`      supplier_sku ${sk} -> ${sk.replace(OLD_PREFIX, `${MODEL}-`)}`);
    }
    const [one] = await tx`
      SELECT id::text AS id, base_model, model_id::text AS model_id FROM scm.mfg_products
       WHERE company_id = ${CO} AND code = ${ONE_SEATER}`;
    if (!one) problems.push(`${ONE_SEATER} not found`);
    else if (one.model_id !== model.id) problems.push(`${ONE_SEATER} belongs to model ${one.model_id}, not ${model.id}`);
    else say(`  SET ${ONE_SEATER} base_model ${one.base_model ?? 'NULL'} -> ${MODEL}`);
    say(`  SET model ${MODEL} name "${model.name}" -> "${MODEL}"`);

    if (problems.length) { for (const p of problems) bad(`  REFUSED: ${p}`); throw new Error(`${problems.length} precondition(s) failed — nothing written`); }
    if (!APPLY) { say(`=== PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${PHRASE}". ===`); return; }

    for (const p of planned) {
      if (p.action === 'delete') {
        const h = await tx`DELETE FROM scm.supplier_binding_price_history WHERE company_id = ${CO} AND item_code = ${p.code} AND material_kind = 'mfg_product'`;
        const b = await tx`DELETE FROM scm.supplier_material_bindings WHERE company_id = ${CO} AND item_code = ${p.code} AND material_kind = 'mfg_product'`;
        const d = await tx`DELETE FROM scm.mfg_products WHERE company_id = ${CO} AND id = ${p.id}`;
        say(`  deleted ${p.code}: price history ${h.count}, bindings ${b.count}, sku ${d.count}`);
        continue;
      }
      for (const t of PRODUCT_CODE_CASCADE) {
        const r = await tx.unsafe(
          `UPDATE scm.${t.table} SET ${t.col} = $1 WHERE company_id = $2 AND ${t.col} = $3${t.kind ? " AND material_kind = 'mfg_product'" : ''}`,
          [p.target, CO, p.code]);
        if (r.count) say(`    ${t.table}.${t.col}: ${r.count}`);
      }
      for (const sk of p.supSkus) {
        const r = await tx`
          UPDATE scm.supplier_material_bindings SET supplier_sku = ${sk.replace(OLD_PREFIX, `${MODEL}-`)}
           WHERE company_id = ${CO} AND item_code = ${p.target} AND material_kind = 'mfg_product' AND supplier_sku = ${sk}`;
        say(`    supplier_sku ${sk}: ${r.count}`);
      }
      const u = await tx`
        UPDATE scm.mfg_products SET code = ${p.target}, name = ${p.name}, base_model = ${MODEL}, updated_at = now()
         WHERE company_id = ${CO} AND id = ${p.id}`;
      say(`  recoded ${p.code} -> ${p.target} (${u.count})`);
    }
    await tx`UPDATE scm.mfg_products SET base_model = ${MODEL}, updated_at = now() WHERE company_id = ${CO} AND code = ${ONE_SEATER}`;
    await tx`UPDATE scm.product_models SET name = ${MODEL}, updated_at = now() WHERE company_id = ${CO} AND id = ${model.id}`;
    say('=== committed ===');
  });
} catch (e) {
  bad(e.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

if (APPLY && process.exitCode !== 1 && planned.length) {
  const verify = postgres(DSN, { ssl: 'require', max: 1, prepare: false });
  try {
    say('=== VERIFIED ON A FRESH CONNECTION ===');
    const fails = [];
    const [{ n: left }] = await verify`
      SELECT count(*)::int AS n FROM scm.mfg_products WHERE company_id = ${CO} AND code LIKE ${OLD_PREFIX + '%'}`;
    if (left) fails.push(`${left} SKU(s) still on ${OLD_PREFIX}`);
    const [{ n: supLeft }] = await verify`
      SELECT count(*)::int AS n FROM scm.supplier_material_bindings WHERE company_id = ${CO} AND supplier_sku LIKE ${'%' + OLD_PREFIX + '%'}`;
    if (supLeft) fails.push(`${supLeft} binding(s) still carry supplier_sku *${OLD_PREFIX}*`);
    for (const p of planned) {
      const [row] = await verify`
        SELECT code, name, base_model, model_id::text AS model_id FROM scm.mfg_products WHERE company_id = ${CO} AND id = ${p.id}`;
      if (p.action === 'delete') {
        if (row) fails.push(`${p.code} still exists`);
        const [{ n }] = await verify`SELECT count(*)::int AS n FROM scm.supplier_material_bindings WHERE company_id = ${CO} AND item_code = ${p.code}`;
        if (n) fails.push(`${p.code} still has ${n} binding(s)`);
        continue;
      }
      const ok = row && row.code === p.target && row.name === p.name && row.base_model === MODEL && row.model_id === p.model_id;
      if (!ok) fails.push(`${p.code}: got ${JSON.stringify(row)}`);
      const moved = await usage(verify, p.target);
      for (const [k, n] of Object.entries(p.used)) if (moved[k] !== n) fails.push(`${p.target} ${k}: expected ${n}, got ${moved[k] ?? 0}`);
      say(`  ${row?.code} "${row?.name}" base_model=${row?.base_model} ${ok ? 'OK' : 'MISMATCH'}`);
    }
    const [one] = await verify`SELECT base_model FROM scm.mfg_products WHERE company_id = ${CO} AND code = ${ONE_SEATER}`;
    if (one?.base_model !== MODEL) fails.push(`${ONE_SEATER} base_model is ${one?.base_model}`);
    const [m] = await verify`SELECT name FROM scm.product_models WHERE company_id = ${CO} AND category = 'SOFA' AND model_code = ${MODEL}`;
    if (m?.name !== MODEL) fails.push(`model name is "${m?.name}"`);
    for (const f of fails) bad(`  ${f}`);
    say(fails.length ? `=== ${fails.length} verification failure(s) ===` : '=== all rows have the expected shape ===');
    if (fails.length) process.exitCode = 1;
  } finally {
    await verify.end({ timeout: 5 });
  }
}
