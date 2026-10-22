import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* mig *_scm_rename_sofa_compartment_scoped against real Postgres. The old
 * cascade renamed a compartment in EVERY company and rewrote SKU codes and
 * historical doc lines but not stock. The new one is one company, preview
 * first, and refuses a compartment that anything of that company still uses.
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function migrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_rename_sofa_compartment_scoped.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_rename_sofa_compartment_scoped.sql, found ${files.join(', ')}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

const ITEM_CODE_TABLES = [
  'mfg_sales_order_items', 'mfg_so_price_overrides', 'delivery_order_items', 'delivery_return_items',
  'sales_invoice_items', 'consignment_sales_order_items', 'consignment_delivery_order_items',
  'consignment_delivery_return_items', 'purchase_order_items', 'grn_items', 'purchase_invoice_items',
  'purchase_return_items', 'purchase_consignment_order_items', 'purchase_consignment_receive_items',
  'purchase_consignment_return_items', 'supplier_material_bindings', 'inventory_movements',
  'inventory_balances', 'inventory_lots', 'stock_transfer_lines', 'stock_take_lines', 'warehouse_rack_items',
];
const OWN_TABLES = [
  ...ITEM_CODE_TABLES, 'mfg_products', 'pwp_codes', 'product_compartments', 'pos_sofa_combos',
  'sofa_personal_quick_picks', 'maintenance_config_history', 'product_models', 'sofa_combo_pricing',
  'sofa_quick_picks',
];

let admin: Sql;

async function reset(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');

  await sql.unsafe(`
    DO $roles$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $roles$;
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP FUNCTION IF EXISTS scm.rename_sofa_compartment(bigint, text, text, boolean), scm.rename_sofa_compartment(text, text),
      scm.jsonb_replace_string_value(jsonb, text, text) CASCADE;
    DROP TABLE IF EXISTS ${OWN_TABLES.map((t) => `scm.${t}`).join(', ')} CASCADE;
    ${ITEM_CODE_TABLES.map((t) => `CREATE TABLE scm.${t} (company_id bigint NOT NULL, item_code text);`).join('\n')}
    CREATE TABLE scm.mfg_products (company_id bigint NOT NULL, code text NOT NULL, name text, category text);
    CREATE TABLE scm.pwp_codes (company_id bigint NOT NULL, trigger_item_code text, redeemed_item_code text);
    CREATE TABLE scm.product_compartments (company_id bigint NOT NULL, compartment_id text);
    CREATE TABLE scm.pos_sofa_combos (company_id bigint NOT NULL, modules jsonb);
    CREATE TABLE scm.sofa_personal_quick_picks (id serial PRIMARY KEY, staff_id int, base_model text, modules jsonb);
    CREATE TABLE scm.product_models (id serial PRIMARY KEY, company_id bigint NOT NULL, model_code text, category text, allowed_options jsonb);
    CREATE TABLE scm.sofa_combo_pricing (id serial PRIMARY KEY, company_id bigint NOT NULL, base_model text, modules jsonb);
    CREATE TABLE scm.sofa_quick_picks (id serial PRIMARY KEY, company_id bigint NOT NULL, base_model text, modules jsonb);
    CREATE TABLE scm.maintenance_config_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint NOT NULL, scope text NOT NULL,
      config jsonb NOT NULL, effective_from date NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

    -- Both companies: "Consle" is a typo nobody has used; "Console" is in use.
    INSERT INTO scm.maintenance_config_history (company_id, scope, config, effective_from) VALUES
      (1, 'master', '{"sofaCompartments":["1A(LHF)","Console","Consle"],
                      "sofaCompartmentMeta":{"Consle":{"description":"Consle","imageKey":"sofa-compartments/Consle/a.jpg"},
                                             "Console":{"description":"cup holder"}},
                      "fabrics":["Consle"]}', '2026-01-01'),
      (1, 'supplier:s1', '{"sofaCompartments":["Consle"]}', '2026-01-01'),
      (2, 'master', '{"sofaCompartments":["Console","Consle"],
                      "sofaCompartmentMeta":{"Consle":{"imageKey":"sofa-compartments/Consle/b.jpg"}}}', '2026-01-01');
    INSERT INTO scm.product_models (company_id, model_code, category, allowed_options) VALUES
      (1, '8030', 'SOFA', '{"compartments":["Console","Consle"],"note":"Consle"}'),
      (2, 'X2', 'SOFA', '{"compartments":["Consle"]}');
    INSERT INTO scm.sofa_combo_pricing (company_id, base_model, modules) VALUES
      (1, '8030', '[["1A(LHF)"],["Consle"]]'), (2, 'X2', '[["Consle"]]');
    INSERT INTO scm.sofa_quick_picks (company_id, base_model, modules) VALUES
      (1, '8030', '[["Consle","Consle2"]]'), (2, 'X2', '[["Consle"]]');
    INSERT INTO scm.mfg_products (company_id, code, name, category) VALUES
      (1, '8030-Console', 'SOFA 8030 CONSOLE FABRIC', 'SOFA'), (2, 'X2-Consle', 'SOFA X2 Consle', 'SOFA');
    INSERT INTO scm.mfg_sales_order_items VALUES (1, '8030-Console');
    INSERT INTO scm.inventory_movements VALUES (1, '8030-Console');
  `);
}

const apply = async (sql: Sql) => sql.unsafe(await migrationSql());

async function rename(co: number, from: string, to: string, doApply: boolean): Promise<Record<string, unknown>> {
  const [r] = await admin.unsafe(`SELECT scm.rename_sofa_compartment($1, $2, $3, $4) AS r`, [co, from, to, doApply]);
  return r!.r as Record<string, unknown>;
}

async function fingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const t of OWN_TABLES) {
    const [r] = await admin.unsafe(`SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM scm.${t} x`);
    parts.push(`${t}:${r!.h}`);
  }
  return parts.join(',');
}

async function refused(q: string, params: unknown[]): Promise<string> {
  try {
    await admin.begin(async (tx) => { await tx.unsafe(q, params as never[]); });
  } catch (e) {
    return String((e as Error).message);
  }
  return '';
}

describePg('compartment rename is one company, preview first, unused codes only (mig *_scm_rename_sofa_compartment_scoped)', () => {
  beforeAll(async () => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await reset(admin); await apply(admin); });

  test('a preview writes nothing and reports what would change', async () => {
    const before = await fingerprint();
    const r = await rename(1, 'Consle', 'CNSL', false);
    expect(r).toMatchObject({ applied: false, refused: null, inUseTotal: 0, photoCleared: true });
    expect(r.changes).toEqual({ maintenance_config_history: 2, product_models: 1, sofa_combo_pricing: 1, sofa_quick_picks: 1 });
    expect(await fingerprint()).toBe(before);
  });

  test('a compartment the company still uses is refused, with counts, and nothing is written', async () => {
    const before = await fingerprint();
    const r = await rename(1, 'Console', 'ConsoleF', true);
    expect(r).toMatchObject({ applied: false, refused: 'in_use', inUseTotal: 3 });
    expect(r.inUse).toMatchObject({ 'mfg_products.code': 1, 'mfg_sales_order_items.item_code': 1, 'inventory_movements.item_code': 1 });
    expect(await fingerprint()).toBe(before);
  });

  test('another company using the same code does not block, and is never touched', async () => {
    // Company 2 has an X2-Consle SKU; company 1 does not.
    expect((await rename(2, 'Consle', 'CNSL', false)).refused).toBe('in_use');
    const r = await rename(1, 'Consle', 'CNSL', true);
    expect(r).toMatchObject({ applied: true, refused: null });

    const co2 = await admin.unsafe(`
      SELECT (SELECT config::text FROM scm.maintenance_config_history WHERE company_id = 2) AS cfg,
             (SELECT allowed_options::text FROM scm.product_models WHERE company_id = 2) AS ao,
             (SELECT modules::text FROM scm.sofa_combo_pricing WHERE company_id = 2) AS combo,
             (SELECT modules::text FROM scm.sofa_quick_picks WHERE company_id = 2) AS qp`);
    expect(co2[0]!.cfg).toContain('"Consle"');
    expect(co2[0]!.cfg).not.toContain('CNSL');
    expect(co2[0]!.ao).toBe('{"compartments": ["Consle"]}');
    expect(co2[0]!.combo).toBe('[["Consle"]]');
    expect(co2[0]!.qp).toBe('[["Consle"]]');
  });

  test('applies to the pool, its meta entry, Model ticks, combos and quick picks; exact values only', async () => {
    await rename(1, 'Consle', 'CNSL', true);
    const [m] = await admin.unsafe(`SELECT config FROM scm.maintenance_config_history WHERE company_id = 1 AND scope = 'master'`);
    const cfg = m!.config as Record<string, unknown>;
    expect(cfg.sofaCompartments).toEqual(['1A(LHF)', 'Console', 'CNSL']);
    // Uploaded photo is tied to the old code's prefix: dropped. Description stays.
    expect(cfg.sofaCompartmentMeta).toEqual({ CNSL: { description: 'Consle' }, Console: { description: 'cup holder' } });
    // Other config keys holding the same string are not the compartment pool.
    expect(cfg.fabrics).toEqual(['Consle']);
    const [s] = await admin.unsafe(`SELECT config FROM scm.maintenance_config_history WHERE scope = 'supplier:s1'`);
    expect((s!.config as Record<string, unknown>).sofaCompartments).toEqual(['CNSL']);

    const [ao] = await admin.unsafe(`SELECT allowed_options FROM scm.product_models WHERE company_id = 1`);
    expect(ao!.allowed_options).toEqual({ compartments: ['Console', 'CNSL'], note: 'Consle' });
    const [qp] = await admin.unsafe(`SELECT modules FROM scm.sofa_quick_picks WHERE company_id = 1`);
    expect(qp!.modules).toEqual([['CNSL', 'Consle2']]);
    const [combo] = await admin.unsafe(`SELECT modules FROM scm.sofa_combo_pricing WHERE company_id = 1`);
    expect(combo!.modules).toEqual([['1A(LHF)'], ['CNSL']]);
  });

  test('refuses a code with a space, one too long for an item code, and one already in the pool', async () => {
    const q = `SELECT scm.rename_sofa_compartment($1, $2, $3, $4)`;
    expect(await refused(q, [1, 'Consle', 'Console Fabric', false])).toMatch(/invalid_code/);
    // '8030-' + 26 chars = 31 > 30.
    expect(await refused(q, [1, 'Consle', 'A'.repeat(26), false])).toMatch(/code_too_long/);
    expect(await refused(q, [1, 'Consle', 'Console', false])).toMatch(/code_exists/);
    expect(await refused(q, [1, 'Consle', 'Consle', false])).toMatch(/same_code/);
    expect(await refused(q, [null, 'Consle', 'CNSL', false])).toMatch(/company_required/);
  });

  test('the unscoped 2-argument function is gone and only service_role may run the new one', async () => {
    const [g] = await admin.unsafe(`SELECT
      to_regprocedure('scm.rename_sofa_compartment(text, text)') IS NULL AS old_gone,
      has_function_privilege('service_role', 'scm.rename_sofa_compartment(bigint, text, text, boolean)', 'EXECUTE') AS svc,
      has_function_privilege('anon', 'scm.rename_sofa_compartment(bigint, text, text, boolean)', 'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated', 'scm.rename_sofa_compartment(bigint, text, text, boolean)', 'EXECUTE') AS auth_exec`);
    expect(g).toMatchObject({ old_gone: true, svc: true, anon_exec: false, auth_exec: false });
  });
});
