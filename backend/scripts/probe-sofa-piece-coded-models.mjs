#!/usr/bin/env node
/* READ-ONLY. Sofa Models whose model_code is a PIECE code (`5562-1S`), and what a
   recode of them would touch (DEV-29).

   WHY. 5562-1S was opened on 2026-08-28 as a lone SOFA SKU with no base_model.
   The BUG-31 backfill (backfill-missing-product-models.mjs) keys a SKU with no
   base_model as its own 1:1 Model, so it created a SOFA Model coded `5562-1S`
   named "SOFA 5562 1S". "Add codes" on that Model then stamped
   `{model_code}-{compartment}` = `5562-1S-1A(LHF)` named
   "SOFA SOFA 5562 1S 1A(LHF)". The owner wants 5562-1A(LHF).

   WHAT IT PRINTS (COMPANY_ID, default 1; MODEL_PREFIX optional, e.g. 5562)
     1  every SOFA Model whose model_code ends in `-<piece>` (piece = 1S, 1A(LHF), ...),
        plus whether a Model on the bare code already exists
     2  for each, its SKUs: code, name, base_model, status, created_at
     3  for each SKU, the rows in every PRODUCT_CODE_CASCADE column that hold its
        code, and its AutoCount binding (ac_item_code) — a recode re-points those
     4  whether the recoded target code is already taken by another SKU

   Writes nothing: one READ ONLY transaction of SELECTs. RE-RUN: stateless. */
import postgres from 'postgres';
import { PRODUCT_CODE_CASCADE } from '../src/scm/lib/product-code-rename.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const PREFIX = (process.env.MODEL_PREFIX || '').trim();
const say = (m = '') => console.log(process.env.GITHUB_ACTIONS && m.startsWith('=') ? `::notice::${m}` : m);

const sql = postgres(DSN, { ssl: 'require', max: 1, prepare: false });
try {
  await sql.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL statement_timeout = '300s'`;

    const models = await tx`
      SELECT id::text AS id, model_code, name, branding, active, allowed_options, created_at
        FROM scm.product_models
       WHERE company_id = ${CO} AND category = 'SOFA'
         AND model_code ~* '-(1S|2S|3S|1A\\(LHF\\)|1A\\(RHF\\)|1NA|2NA|2A\\(LHF\\)|2A\\(RHF\\)|CNR|L\\(LHF\\)|L\\(RHF\\)|STOOL|CONSOLE)$'
         AND (${PREFIX} = '' OR model_code LIKE ${PREFIX + '%'})
       ORDER BY model_code`;
    say(`=== 1. company ${CO}: ${models.length} SOFA model(s) coded like a piece ===`);

    for (const m of models) {
      const bare = m.model_code.replace(/-[^-]+$/, '');
      const [twin] = await tx`
        SELECT id::text AS id, model_code, name FROM scm.product_models
         WHERE company_id = ${CO} AND category = 'SOFA' AND model_code = ${bare}`;
      say(`=== MODEL ${m.model_code} | name="${m.name}" | active=${m.active} | created=${m.created_at?.toISOString?.() ?? m.created_at} | id=${m.id}`);
      say(`    allowed_options=${JSON.stringify(m.allowed_options)}`);
      say(`    bare code "${bare}": ${twin ? `MODEL EXISTS id=${twin.id} name="${twin.name}"` : 'no model'}`);

      const skus = await tx`
        SELECT id::text AS id, code, name, base_model, status, pos_active, created_at
          FROM scm.mfg_products
         WHERE company_id = ${CO} AND (model_id::text = ${m.id} OR code = ${m.model_code} OR code LIKE ${m.model_code + '-%'})
         ORDER BY code`;
      say(`    ${skus.length} SKU(s):`);
      for (const s of skus) {
        const target = s.code.startsWith(`${m.model_code}-`) ? `${bare}-${s.code.slice(m.model_code.length + 1)}` : s.code;
        const [taken] = target === s.code ? [] : await tx`
          SELECT code FROM scm.mfg_products WHERE company_id = ${CO} AND code = ${target}`;
        const uses = [];
        for (const t of PRODUCT_CODE_CASCADE) {
          try {
            await tx`SAVEPOINT p`;
            const [r] = await tx.unsafe(
              `SELECT count(*)::int AS n FROM scm.${t.table} WHERE company_id = $1 AND ${t.col} = $2${t.kind ? " AND material_kind = 'mfg_product'" : ''}`,
              [CO, s.code]);
            await tx`RELEASE SAVEPOINT p`;
            if (r.n) uses.push(`${t.table}.${t.col}=${r.n}`);
          } catch (e) { await tx`ROLLBACK TO SAVEPOINT p`; uses.push(`${t.table}: ${e.message}`); }
        }
        const binds = await tx`
          SELECT ac_item_code, supplier_sku FROM scm.supplier_material_bindings
           WHERE company_id = ${CO} AND item_code = ${s.code} AND material_kind = 'mfg_product'`;
        say(`      ${s.code} | "${s.name}" | base_model=${s.base_model ?? 'NULL'} | ${s.status} | pos_active=${s.pos_active} | created=${s.created_at?.toISOString?.() ?? s.created_at}`);
        say(`        -> ${target}${taken ? '  ** TARGET CODE ALREADY TAKEN **' : ''}`);
        say(`        used: ${uses.length ? uses.join(', ') : 'nowhere'}`);
        if (binds.length) say(`        bindings: ${binds.map((b) => `ac=${b.ac_item_code ?? '-'} sup=${b.supplier_sku ?? '-'}`).join('; ')}`);
      }
    }

    /* A Model recoded by hand (5562-1S -> 5562) leaves its generated SKUs on the
       old prefix: `5562-1S-1A(LHF)` under model 5562. */
    const doubled = await tx`
      SELECT s.id::text AS id, s.code, s.name, s.base_model, s.status, s.created_at,
             m.model_code, m.name AS model_name
        FROM scm.mfg_products s
        LEFT JOIN scm.product_models m ON m.id = s.model_id
       WHERE s.company_id = ${CO} AND s.category = 'SOFA'
         AND s.code ~* '-1S-.+$'
         AND (${PREFIX} = '' OR s.code LIKE ${PREFIX + '%'})
       ORDER BY s.code`;
    say(`=== 2. company ${CO}: ${doubled.length} SOFA SKU(s) coded <model>-1S-<piece> ===`);
    for (const s of doubled) {
      const target = s.code.replace(/-1S-(?=.+$)/i, '-');
      const [taken] = await tx`SELECT code, name, model_id::text AS model_id FROM scm.mfg_products WHERE company_id = ${CO} AND code = ${target}`;
      const uses = [];
      for (const t of PRODUCT_CODE_CASCADE) {
        try {
          await tx`SAVEPOINT q`;
          const [r] = await tx.unsafe(
            `SELECT count(*)::int AS n FROM scm.${t.table} WHERE company_id = $1 AND ${t.col} = $2${t.kind ? " AND material_kind = 'mfg_product'" : ''}`,
            [CO, s.code]);
          await tx`RELEASE SAVEPOINT q`;
          if (r.n) uses.push(`${t.table}.${t.col}=${r.n}`);
        } catch (e) { await tx`ROLLBACK TO SAVEPOINT q`; uses.push(`${t.table}: ${e.message}`); }
      }
      say(`  ${s.code} | "${s.name}" | model=${s.model_code ?? 'NONE'} ("${s.model_name ?? ''}") | base_model=${s.base_model ?? 'NULL'} | ${s.status} | created=${s.created_at?.toISOString?.() ?? s.created_at}`);
      say(`    -> ${target}${taken ? `  ** TAKEN by "${taken.name}" model_id=${taken.model_id} **` : ''}`);
      say(`    used: ${uses.length ? uses.join(', ') : 'nowhere'}`);
    }
    /* NEEDLE (e.g. 5562-1S-): every text / json / array column in scm + public
       whose value CONTAINS it — catches what the cascade list does not name
       (jsonb builds, AutoCount outbox payloads, POS catalogue, kept columns). */
    const NEEDLE = (process.env.NEEDLE || '').trim();
    if (NEEDLE) {
      const cols = await tx`
        SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS col
          FROM information_schema.columns c
          JOIN pg_namespace n ON n.nspname = c.table_schema
          JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = n.oid AND k.relkind IN ('r', 'p')
         WHERE c.table_schema IN ('scm', 'public')
           AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY'))
         ORDER BY 1, 2, 3`;
      const byTable = new Map();
      for (const c of cols) {
        const key = `"${c.s}"."${c.t}"`;
        if (!byTable.has(key)) byTable.set(key, []);
        byTable.get(key).push(c.col);
      }
      say(`=== 4. sweep for "${NEEDLE}" across ${byTable.size} tables / ${cols.length} columns ===`);
      let hits = 0;
      for (const [rel, list] of byTable) {
        if (rel === '"scm"."mfg_products"') continue;
        try {
          await tx`SAVEPOINT w`;
          const sel = list.map((c) => `count(*) FILTER (WHERE "${c}"::text LIKE $1)::int AS "${c}"`).join(', ');
          const [r] = await tx.unsafe(`SELECT ${sel} FROM ${rel}`, [`%${NEEDLE}%`]);
          await tx`RELEASE SAVEPOINT w`;
          for (const [c, n] of Object.entries(r)) if (n) { hits += 1; say(`  ${rel}.${c}: ${n} row(s)`); }
        } catch (e) { await tx`ROLLBACK TO SAVEPOINT w`; say(`  ${rel}: sweep failed: ${e.message}`); }
      }
      say(`  ${hits} column(s) outside mfg_products hold "${NEEDLE}"`);
      const binds = await tx`
        SELECT b.item_code, b.ac_item_code, b.supplier_sku, b.supplier_id::text AS supplier_id, b.created_at
          FROM scm.supplier_material_bindings b
         WHERE b.company_id = ${CO} AND b.item_code LIKE ${'%' + NEEDLE + '%'} ORDER BY b.item_code`;
      for (const b of binds) say(`  binding ${b.item_code}: ac_item_code=${b.ac_item_code ?? 'NULL'} supplier_sku=${b.supplier_sku ?? 'NULL'} supplier=${b.supplier_id} created=${b.created_at?.toISOString?.() ?? b.created_at}`);
    }
    if (PREFIX) {
      const [m] = await tx`
        SELECT id::text AS id, model_code, name, branding, active, allowed_options, updated_at
          FROM scm.product_models WHERE company_id = ${CO} AND category = 'SOFA' AND model_code = ${PREFIX}`;
      say(`=== 3. model ${PREFIX}: ${m ? `id=${m.id} name="${m.name}" branding=${m.branding ?? 'NULL'} active=${m.active} updated=${m.updated_at?.toISOString?.() ?? m.updated_at}` : 'NONE'} ===`);
      if (m) {
        say(`    allowed_options=${JSON.stringify(m.allowed_options)}`);
        const skus = await tx`
          SELECT code, name, base_model, status FROM scm.mfg_products
           WHERE company_id = ${CO} AND (model_id::text = ${m.id} OR code LIKE ${PREFIX + '-%'}) ORDER BY code`;
        for (const s of skus) say(`    ${s.code} | "${s.name}" | base_model=${s.base_model ?? 'NULL'} | ${s.status}`);
      }
    }
  });
} finally {
  await sql.end();
}
console.log('READ-ONLY — nothing was written to the database.');
