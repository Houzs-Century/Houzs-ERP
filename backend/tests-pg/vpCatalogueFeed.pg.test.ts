import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* EXECUTES the Venture Portal catalogue feed's SQL (migration
 * *_scm_vp_catalogue_feed.sql) against real Postgres.
 *
 * The property that matters is that NO PRICE OR COST LEAVES THE DATABASE, and
 * it is a property of SQL: the Worker only forwards what these functions
 * return. So every money column and every money-shaped JSON key in the
 * fixture carries a sentinel (7770xx), and the tests assert the sentinel and
 * the key names never appear in what is built — for the catalogue AND for the
 * order feed's new line variants.
 *
 * The migration file is located by SUFFIX, never by number: parallel PRs
 * renumber migrations. Runs against CI's postgres:16 (`npm run test:pg`);
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

const CO = 1;
const OTHER = 2;

/** Every money value planted in the fixture starts with this. */
const SENTINEL = '7770';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

let sql: Sql;

async function applyMigration(s: Sql): Promise<number> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_vp_catalogue_feed.sql'));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *_scm_vp_catalogue_feed.sql migration, found ${files.length}: ${files.join(', ')}`);
  }
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await s.begin(async (tx) => { for (const st of stmts) await tx.unsafe(st); });
  return stmts.length;
}

/** Every key at every depth, as `a.b[].c`. */
function keyPaths(v: Json, prefix = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${prefix}[]`));
  if (v !== null && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => {
      const here = prefix ? `${prefix}.${k}` : k;
      return [here, ...keyPaths(x, here)];
    });
  }
  return [];
}

const MONEY_KEY = /price|cost|amount|surcharge|discount|margin|_sen$|Sen$|RM$/i;
/** The fabric tier names are LABELS (PRICE_1/2/3) the portal prices by, not money. */
const TIER_KEY = /^(sofa_|bedframe_)?price_tier$/;

const build = async (company: number): Promise<Obj> =>
  (await sql`SELECT scm.vp_build_catalogue(${company}::bigint) AS b`)[0]!.b as Obj;
const digest = async (company: number): Promise<string> =>
  (await sql`SELECT scm.vp_catalogue_digest(${company}::bigint) AS d`)[0]!.d as string;
const arr = (o: Obj, k: string): Obj[] => (o[k] ?? []) as Obj[];

/* Dropped before AND after: every suite in this directory shares houzs_test.
   The payment-totals relation is a VIEW, as it is in production and as
   soListLineFilterFields builds it, so either suite can drop the other's. */
const DROP_FIXTURE = `
  DROP TABLE IF EXISTS scm.venture_portal_catalogue_state CASCADE;
  DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals CASCADE;
  DROP TABLE IF EXISTS scm.mfg_products, scm.product_models, scm.maintenance_config_history,
    scm.special_addons, scm.fabric_trackings, scm.sofa_combo_pricing, scm.mfg_sales_orders,
    scm.staff, scm.mfg_sales_order_items, scm.mfg_sales_order_payments CASCADE;
  DROP TYPE IF EXISTS scm.vpc_category, scm.vpc_status, scm.vpc_tier CASCADE;
`;

describePg('the Venture Portal feeds, built in SQL', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS scm; ${DROP_FIXTURE}`);
    await sql.unsafe(`
      /* Enums as production has them: jsonb_build_object renders an enum
         through its output function, and a text fixture would not prove it. */
      CREATE TYPE scm.vpc_category AS ENUM ('SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY');
      CREATE TYPE scm.vpc_status AS ENUM ('ACTIVE', 'INACTIVE');
      CREATE TYPE scm.vpc_tier AS ENUM ('PRICE_1', 'PRICE_2', 'PRICE_3');

      CREATE TABLE scm.mfg_products (
        id text PRIMARY KEY, code text NOT NULL, name text NOT NULL, category scm.vpc_category NOT NULL,
        description text, base_model text, size_code text, size_label text, fabric_usage_sen integer,
        status scm.vpc_status NOT NULL, cost_price_sen integer, base_price_sen integer, price1_sen integer,
        sell_price_sen integer, pwp_price_sen integer, default_free_gifts jsonb, fabric_color text,
        branding text, barcode text, seat_height_prices jsonb, default_variants jsonb, model_id uuid,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), company_id bigint NOT NULL);
      CREATE TABLE scm.product_models (
        id uuid PRIMARY KEY, branding text, model_code text NOT NULL, name text NOT NULL,
        category scm.vpc_category NOT NULL, description text, photo_url text,
        allowed_options jsonb NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), company_id bigint NOT NULL);
      CREATE TABLE scm.maintenance_config_history (
        id text PRIMARY KEY, scope text NOT NULL, config jsonb NOT NULL, effective_from date NOT NULL,
        notes text, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, company_id bigint NOT NULL);
      CREATE TABLE scm.special_addons (
        id uuid PRIMARY KEY, code text NOT NULL, label text NOT NULL, so_description text,
        categories text[] NOT NULL, selling_price_sen integer, cost_price_sen integer, option_groups jsonb,
        active boolean NOT NULL, sort_order integer NOT NULL, company_id bigint NOT NULL);
      CREATE TABLE scm.fabric_trackings (
        id text PRIMARY KEY, fabric_code text NOT NULL, fabric_description text, fabric_category text,
        price_tier scm.vpc_tier, sofa_price_tier scm.vpc_tier, bedframe_price_tier scm.vpc_tier,
        price_sen integer, soh_sen integer, po_outstanding_sen integer, supplier text, supplier_code text,
        series text, is_active boolean NOT NULL, company_id bigint NOT NULL);
      CREATE TABLE scm.sofa_combo_pricing (
        id uuid PRIMARY KEY, base_model text NOT NULL, modules jsonb NOT NULL, tier scm.vpc_tier,
        customer_id uuid, supplier_id uuid, prices_by_height jsonb NOT NULL,
        selling_prices_by_height jsonb, pwp_prices_by_height jsonb, default_free_gifts jsonb, label text,
        effective_from date NOT NULL, deleted_at timestamptz, notes text,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), company_id bigint NOT NULL);

      /* The order feed's sources, reduced to what vp_build_payloads touches. */
      CREATE TABLE scm.mfg_sales_orders (
        doc_no text PRIMARY KEY, salesperson_id uuid, phone text, local_total_sen integer, company_id bigint);
      CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
        SELECT doc_no, salesperson_id, phone, local_total_sen, company_id FROM scm.mfg_sales_orders;
      CREATE TABLE scm.staff (id uuid PRIMARY KEY, name text, staff_code text, user_id integer);
      CREATE TABLE scm.mfg_sales_order_items (
        id uuid PRIMARY KEY, doc_no text NOT NULL, line_no integer, created_at timestamptz DEFAULT now(),
        item_code text, description2 text, remark text, line_cost_sen integer, variants jsonb);
      CREATE TABLE scm.mfg_sales_order_payments (
        id uuid PRIMARY KEY, so_doc_no text NOT NULL, paid_at date, amount_sen integer,
        created_at timestamptz DEFAULT now());
    `);

    await applyMigration(sql);

    await sql.unsafe(`
      INSERT INTO scm.mfg_products (id, code, name, category, status, base_model, size_code, size_label,
          branding, model_id, cost_price_sen, base_price_sen, price1_sen, sell_price_sen, pwp_price_sen,
          fabric_usage_sen, seat_height_prices, default_free_gifts, company_id) VALUES
        ('mfg-b', '8030-1A(LHF)', '8030 SOFFIO 1A LHF', 'SOFA', 'ACTIVE', '8030', '1A(LHF)', NULL, 'ZANOTTI',
          '00000000-0000-0000-0000-00000000000a', 777001, 777002, 777003, 777004, 777005, 777006,
          '[{"height":"24","tier":"PRICE_2","priceSen":777007,"sellingPriceSen":777008}]',
          '[{"code":"PILLOW","priceSen":777009}]', ${CO}),
        ('mfg-a', 'AK-ULTIMATE MATT (K)', 'AKEMI ULTIMATE (K)', 'MATTRESS', 'INACTIVE', 'AK-ULTIMATE', 'K',
          'King', 'AKEMI', NULL, 777010, NULL, NULL, 777011, NULL, NULL, NULL, NULL, ${CO}),
        ('mfg-other', 'OTHER-1', 'another company', 'SOFA', 'ACTIVE', NULL, NULL, NULL, NULL, NULL,
          777012, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${OTHER});

      INSERT INTO scm.product_models (id, model_code, name, category, branding, allowed_options, active, company_id) VALUES
        ('00000000-0000-0000-0000-00000000000a', '8030', '8030 SOFFIO', 'SOFA', 'ZANOTTI',
          '{"compartments":["1A(LHF)","2A"],"leg_heights":["4\\"","6\\""],"specials":["Arm Rest"],"mattress_thickness_cm":25}', true, ${CO}),
        ('00000000-0000-0000-0000-00000000000b', 'NB', 'NB BEDFRAME', 'BEDFRAME', NULL,
          '{"sizes":["Q","K"],"leg_heights":[{"value":"4\\"","priceSen":777013}],"price_override":777014,"deep":[[{"x":{"unit_cost_sen":777015,"keep":"yes"}}]]}', false, ${CO}),
        ('00000000-0000-0000-0000-00000000000c', 'OTHER', 'other company', 'SOFA', NULL, '{}', true, ${OTHER});

      INSERT INTO scm.maintenance_config_history (id, scope, config, effective_from, created_at, company_id) VALUES
        ('mch-old', 'master', '{"gaps":["OLD"]}', DATE '2020-01-01', now() - interval '9 days', ${CO}),
        ('mch-current', 'master', '{
            "divanHeights":[{"value":"8\\"","priceSen":777016},{"value":"10\\"","priceSen":777017,"active":false}],
            "totalHeights":[{"value":"24\\"","priceSen":777018}],
            "gaps":["12\\"",{"value":"14\\"","active":false}],
            "legHeights":[{"value":"4\\"","priceSen":777019,"packSeparately":true},{"priceSen":777020},null,{"value":6,"priceSen":777021}],
            "sofaSizes":["24","28"],
            "sofaLegHeights":[{"value":"6\\"","price":777022}],
            "bedframeSizes":["Q","K"],
            "specials":[{"value":"HB","priceSen":777023}],
            "brandings":["AKEMI"]}',
          (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, now() - interval '1 day', ${CO}),
        ('mch-future', 'master', '{"gaps":["FUTURE"]}', (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date + 1, now(), ${CO}),
        ('mch-supplier', 'supplier:abc', '{"gaps":["SUPPLIER"]}', (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, now(), ${CO}),
        ('mch-other', 'master', '{"gaps":["OTHER"]}', (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, now(), ${OTHER});

      INSERT INTO scm.special_addons (id, code, label, categories, selling_price_sen, cost_price_sen, option_groups, active, sort_order, company_id) VALUES
        ('00000000-0000-0000-0000-0000000000d1', 'LEFT_DRAWER', 'Left Drawer', ARRAY['BEDFRAME'], 777024, 777025,
          '[{"label":"x","priceSen":777026}]', true, 1, ${CO}),
        ('00000000-0000-0000-0000-0000000000d2', 'OTHER', 'Other', ARRAY['SOFA'], 777027, NULL, NULL, true, 0, ${OTHER});

      INSERT INTO scm.fabric_trackings (id, fabric_code, fabric_description, fabric_category, price_tier, sofa_price_tier,
          bedframe_price_tier, price_sen, soh_sen, po_outstanding_sen, supplier, supplier_code, series, is_active, company_id) VALUES
        ('fab-1', 'BF-01', 'BF-01 PEARL', 'B.M-FABR', NULL, 'PRICE_2', 'PRICE_2', 777028, 777029, 777030,
          'SUPPLIER CO', 'SUP-1', 'BF', true, ${CO}),
        ('fab-2', 'OT-01', 'other company', NULL, NULL, 'PRICE_1', NULL, 777031, NULL, NULL, NULL, NULL, NULL, true, ${OTHER});

      INSERT INTO scm.sofa_combo_pricing (id, base_model, modules, tier, customer_id, supplier_id, prices_by_height,
          selling_prices_by_height, pwp_prices_by_height, default_free_gifts, label, effective_from, deleted_at, company_id) VALUES
        ('00000000-0000-0000-0000-0000000000c1', '8030', '[["1A(LHF)"],["2A","2B"]]', 'PRICE_2', NULL, NULL,
          '{"30":777032,"24":777033,"28":777034}', '{"24":777035}', '{"24":777036}', '[{"priceSen":777037}]',
          '1A + 2A', DATE '2026-08-01', NULL, ${CO}),
        ('00000000-0000-0000-0000-0000000000c2', '8030', '[["1A(LHF)"]]', NULL, NULL, NULL, '{"24":777038}',
          NULL, NULL, NULL, 'retired', DATE '2026-07-01', now() - interval '3 days', ${CO}),
        ('00000000-0000-0000-0000-0000000000c3', '8030', '[["1A(LHF)"]]', 'PRICE_2', '00000000-0000-0000-0000-0000000000e1',
          NULL, '{"24":777039}', NULL, NULL, NULL, 'a customer deal', DATE '2026-08-01', NULL, ${CO}),
        ('00000000-0000-0000-0000-0000000000c4', '8030', '[["1A(LHF)"]]', 'PRICE_2', NULL,
          '00000000-0000-0000-0000-0000000000e2', '{"24":777040}', NULL, NULL, NULL, 'a supplier cost', DATE '2026-08-01', NULL, ${CO}),
        ('00000000-0000-0000-0000-0000000000c5', 'OT', '[["X"]]', NULL, NULL, NULL, '{"24":777041}', NULL, NULL, NULL,
          'other company', DATE '2026-08-01', NULL, ${OTHER});

      INSERT INTO scm.staff (id, name, staff_code, user_id)
        VALUES ('00000000-0000-0000-0000-0000000000f1', 'Lucas Tan', 'EMP-1', 90);
      INSERT INTO scm.mfg_sales_orders (doc_no, salesperson_id, phone, local_total_sen, company_id)
        VALUES ('HC-SO-1', '00000000-0000-0000-0000-0000000000f1', '012-3456789', 500000, ${CO});
      INSERT INTO scm.mfg_sales_order_items (id, doc_no, line_no, item_code, description2, remark, line_cost_sen, variants) VALUES
        ('00000000-0000-0000-0000-000000000101', 'HC-SO-1', 1, '8030-1A(LHF)', 'BF-01 PEARL / SEAT 30', 'line remark', 120000,
          '{"fabricCode":"BF-01","seatHeight":"30","legHeight":null,"specials":["Left Drawer",{"code":"X","priceSen":777050}],
            "extraAddonAmountRM":50,"extraAddonNote":"free text","remark":"more text","colourLabel":"PEARL","size":{"priceSen":777051}}'),
        ('00000000-0000-0000-0000-000000000102', 'HC-SO-1', 2, 'PILLOW', NULL, NULL, 1000,
          '{"remark":"only text","extraAddonAmountRM":10}'),
        ('00000000-0000-0000-0000-000000000103', 'HC-SO-1', 3, 'NB-Q', NULL, NULL, 2000, NULL),
        ('00000000-0000-0000-0000-000000000104', 'HC-SO-1', 4, 'NB-K', NULL, NULL, 3000,
          '{"divanHeight":"8\\"","gap":"12\\"","totalHeight":"24\\"","legHeight":"4\\"","size":"K","specials":[]}'),
        ('00000000-0000-0000-0000-000000000105', 'HC-SO-1', 5, 'EMPTY', NULL, NULL, 4000, '{}');
      INSERT INTO scm.mfg_sales_order_payments (id, so_doc_no, paid_at, amount_sen)
        VALUES ('00000000-0000-0000-0000-000000000201', 'HC-SO-1', DATE '2026-09-01', 100000);
    `);
  });

  afterAll(async () => {
    await sql.unsafe(DROP_FIXTURE);
    await sql.end({ timeout: 5 });
  });

  describe('the catalogue: items, never money', () => {
    test('every section of ONE company, in the receiver`s field names, ordered by id', async () => {
      const b = await build(CO);
      expect(b.companyId).toBe(CO);
      expect(b.full).toBe(true);

      /* mfg-a sorts before mfg-b; the INACTIVE one travels, carrying its status. */
      expect(arr(b, 'products').map((p) => p.id)).toEqual(['mfg-a', 'mfg-b']);
      expect(arr(b, 'products')[0]).toEqual({
        id: 'mfg-a', code: 'AK-ULTIMATE MATT (K)', name: 'AKEMI ULTIMATE (K)', category: 'MATTRESS',
        base_model: 'AK-ULTIMATE', size_code: 'K', size_label: 'King', branding: 'AKEMI', status: 'INACTIVE',
        updated_at: expect.any(String),
      });
      expect(arr(b, 'products')[1]).toMatchObject({ model_id: '00000000-0000-0000-0000-00000000000a', base_model: '8030' });

      expect(arr(b, 'models').map((m) => m.model_code)).toEqual(['8030', 'NB']);
      expect(arr(b, 'models')[1]).toMatchObject({ active: false, category: 'BEDFRAME' });
      expect(arr(b, 'specials')).toEqual([
        { id: '00000000-0000-0000-0000-0000000000d1', code: 'LEFT_DRAWER', label: 'Left Drawer',
          categories: ['BEDFRAME'], active: true, sort_order: 1 },
      ]);
      expect(arr(b, 'fabrics')).toEqual([
        { id: 'fab-1', fabric_code: 'BF-01', fabric_description: 'BF-01 PEARL', fabric_category: 'B.M-FABR',
          series: 'BF', sofa_price_tier: 'PRICE_2', bedframe_price_tier: 'PRICE_2', is_active: true },
      ]);
    });

    test('not one price or cost leaves: no money key at any depth, no planted value', async () => {
      for (const company of [CO, OTHER]) {
        const b = await build(company);
        const offenders = keyPaths(b).filter((p) => {
          const leaf = p.split(/\.|\[\]/).filter(Boolean).pop() ?? '';
          return MONEY_KEY.test(leaf) && !TIER_KEY.test(leaf);
        });
        expect(offenders).toEqual([]);
        expect(JSON.stringify(b)).not.toContain(SENTINEL);
      }
    });

    test('combos: master rows only, a soft-deleted one included, heights are the grid`s KEYS', async () => {
      const combos = arr(await build(CO), 'combos');
      expect(combos.map((c) => c.label)).toEqual(['1A + 2A', 'retired']);
      expect(combos[0]).toEqual({
        id: '00000000-0000-0000-0000-0000000000c1', base_model: '8030', tier: 'PRICE_2', label: '1A + 2A',
        effective_from: '2026-08-01', created_at: expect.any(String),
        heights: ['24', '28', '30'],
        modules: [['1A(LHF)'], ['2A', '2B']],
      });
      expect(combos[1]).toMatchObject({ heights: ['24'], deleted_at: expect.any(String) });
      expect(combos[1]).not.toHaveProperty('tier');
    });

    test('maintenance: the effective MASTER row as of today in Malaysia, six pools, priceSen gone', async () => {
      const m = (await build(CO)).maintenance as Obj;
      /* mch-future is dated tomorrow, mch-supplier is not master scope and
         mch-other is another company: none of them may win. */
      const today = (await sql`SELECT ((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)::text AS d`)[0]!.d as string;
      expect(m.effective_from).toBe(today);
      expect(m.pools).toEqual({
        divanHeights: [{ value: '8"', active: true }, { value: '10"', active: false }],
        totalHeights: [{ value: '24"', active: true }],
        gaps: ['12"', { value: '14"', active: false }],
        /* An entry with no value, and a null entry, are not options; a
           numeric value becomes the string the portal reads. */
        legHeights: [{ value: '4"', active: true }, { value: '6', active: true }],
        sofaSizes: ['24', '28'],
        sofaLegHeights: [{ value: '6"', active: true }],
      });
    });

    test('a company with no effective master row carries no maintenance section at all', async () => {
      await sql`UPDATE scm.maintenance_config_history SET scope = 'supplier:x' WHERE id = 'mch-other'`;
      try {
        expect(await build(OTHER)).not.toHaveProperty('maintenance');
      } finally {
        await sql`UPDATE scm.maintenance_config_history SET scope = 'master' WHERE id = 'mch-other'`;
      }
    });

    test('allowed_options arrive as stored, less any money-named key at any depth', async () => {
      const [plain, nested] = arr(await build(CO), 'models');
      expect(plain!.allowed_options).toEqual({
        compartments: ['1A(LHF)', '2A'], leg_heights: ['4"', '6"'], specials: ['Arm Rest'], mattress_thickness_cm: 25,
      });
      expect(nested!.allowed_options).toEqual({
        sizes: ['Q', 'K'], leg_heights: [{ value: '4"' }], deep: [[{ x: { keep: 'yes' } }]],
      });
    });

    test('the guard strips money-named keys and nothing that merely resembles one', async () => {
      /* sql.json, never a pre-serialized string: a string bound to a jsonb
         parameter arrives as a jsonb STRING (scripts/check-jsonb-binds.mjs). */
      const strip = async (v: Json): Promise<Json> =>
        (await sql`SELECT scm.vp_strip_money_keys(${sql.json(v)}) AS v`)[0]!.v as Json;
      expect(await strip({ a_sen: 1, a_senx: 2, xRM: 3, xRMy: 4, extraAddonAmountRM: 5, sellingPriceSen: 6, keep: 7 }))
        .toEqual({ a_senx: 2, xRMy: 4, keep: 7 });
      expect(await strip([['1A'], ['2A']])).toEqual([['1A'], ['2A']]);
      expect(await strip('plain')).toBe('plain');
      expect((await sql`SELECT scm.vp_strip_money_keys(NULL) AS v`)[0]!.v).toBeNull();
    });

    test('the digest is stable, matches the snapshot`s own, and moves exactly when the catalogue does', async () => {
      const d1 = await digest(CO);
      expect(d1).toMatch(/^[0-9a-f]{32}$/);
      expect(await digest(CO)).toBe(d1);

      const snap = (await sql`SELECT scm.vp_catalogue_snapshot(${CO}::bigint) AS s`)[0]!.s as Obj;
      expect(snap.digest).toBe(d1);
      expect(snap.body).toEqual(await build(CO));

      /* A price is not part of the catalogue, so repricing must NOT look like
         a change — or every cost update would re-send the catalogue for nothing. */
      await sql`UPDATE scm.mfg_products SET cost_price_sen = 777099, sell_price_sen = 777098 WHERE id = 'mfg-b'`;
      await sql`UPDATE scm.sofa_combo_pricing SET prices_by_height = '{"30":1,"24":2,"28":3}' WHERE label = '1A + 2A'`;
      expect(await digest(CO)).toBe(d1);

      await sql`UPDATE scm.mfg_products SET name = 'renamed' WHERE id = 'mfg-b'`;
      expect(await digest(CO)).not.toBe(d1);
      await sql`UPDATE scm.mfg_products SET name = '8030 SOFFIO 1A LHF' WHERE id = 'mfg-b'`;
      expect(await digest(CO)).toBe(d1);

      /* A new seat height on offer IS a change: the keys travel. */
      await sql`UPDATE scm.sofa_combo_pricing SET prices_by_height = '{"30":1,"24":2,"28":3,"32":4}' WHERE label = '1A + 2A'`;
      expect(await digest(CO)).not.toBe(d1);
      await sql`UPDATE scm.sofa_combo_pricing SET prices_by_height = '{"30":1,"24":2,"28":3}' WHERE label = '1A + 2A'`;

      /* Another company's edit is not this company's change. */
      await sql`UPDATE scm.mfg_products SET name = 'moved' WHERE id = 'mfg-other'`;
      expect(await digest(CO)).toBe(d1);
    });

    test('nobody but the service role may call the builders', async () => {
      const rows = await sql`
        SELECT p.proname, COALESCE(p.proacl::text, '') AS acl
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'scm'
           AND p.proname IN ('vp_strip_money_keys', 'vp_build_catalogue', 'vp_catalogue_digest', 'vp_catalogue_snapshot')`;
      expect(rows).toHaveLength(4);
      /* A PUBLIC grant renders as an entry with an empty grantee: `=X/owner`. */
      for (const r of rows) expect(String(r.acl)).not.toMatch(/(^|[{,])=/);
    });
  });

  describe('the order feed: lines carry an allowlisted variants object', () => {
    /* fetch_types is off (as in production), so postgres.js has no array type
       map: the list travels as one string and is split in SQL. */
    const payloads = async (docNos: string[]): Promise<Obj[]> =>
      (await sql`SELECT scm.vp_build_payloads(string_to_array(${docNos.join(',')}, ',')) AS p`)[0]!.p as Obj[];
    const items = async (): Promise<Obj[]> => ((await payloads(['HC-SO-1']))[0]!.items ?? []) as Obj[];

    test('only the option keys travel, and nothing can hide inside one', async () => {
      const [line1] = await items();
      expect(line1!.variants).toEqual({ fabricCode: 'BF-01', seatHeight: '30', legHeight: null, specials: ['Left Drawer'] });
      expect(JSON.stringify(line1!.variants)).not.toContain(SENTINEL);
    });

    test('a line whose variants hold nothing the portal parses carries no variants at all', async () => {
      const [, line2, line3, line4, line5] = await items();
      expect(line2).not.toHaveProperty('variants');
      expect(line3).not.toHaveProperty('variants');
      expect(line5).not.toHaveProperty('variants');
      expect(line4!.variants).toEqual({ divanHeight: '8"', gap: '12"', totalHeight: '24"', legHeight: '4"', size: 'K', specials: [] });
    });

    test('every other column of a line, and the header, payments and salesperson, are as before', async () => {
      const [doc, gone] = await payloads(['HC-SO-1', 'HC-SO-GONE']);
      expect(gone).toMatchObject({ docNo: 'HC-SO-GONE', deleted: true });
      expect(doc!.header).toEqual({
        doc_no: 'HC-SO-1', salesperson_id: '00000000-0000-0000-0000-0000000000f1', local_total_sen: 500000, company_id: CO,
      });
      expect(doc!.salesperson).toEqual({ id: '00000000-0000-0000-0000-0000000000f1', name: 'Lucas Tan', staff_code: 'EMP-1', user_id: 90 });
      expect((doc!.payments as Obj[]).map((p) => p.amount_sen)).toEqual([100000]);
      const [line1] = (doc!.items ?? []) as Obj[];
      /* The line's own remark COLUMN and its cost are the order feed's
         business (the portal pays commission on the margin); only `variants`
         was cut. */
      expect(line1).toMatchObject({ line_no: 1, item_code: '8030-1A(LHF)', remark: 'line remark', line_cost_sen: 120000 });
      expect(Object.keys(line1!).sort()).toEqual(
        ['created_at', 'description2', 'doc_no', 'id', 'item_code', 'line_cost_sen', 'line_no', 'remark', 'variants'],
      );
    });
  });

  /* Last on purpose: the only statements in this file that are MEANT to fail.
     Real Postgres does not care, but the local PGlite wire bridge garbles the
     answer to whatever query follows an error, so nothing follows these. */
  describe('what the sender last delivered', () => {
    test('one row per company, and an outcome outside classifyVpResponse`s vocabulary is refused', async () => {
      await sql`INSERT INTO scm.venture_portal_catalogue_state (company_id, last_outcome) VALUES (${CO}, 'sent')`;
      await expect(sql`INSERT INTO scm.venture_portal_catalogue_state (company_id, last_outcome) VALUES (${OTHER}, 'delivered')`)
        .rejects.toThrow(/check constraint/i);
      await expect(sql`INSERT INTO scm.venture_portal_catalogue_state (company_id) VALUES (${CO})`)
        .rejects.toThrow(/duplicate key/i);
    });
  });
});
