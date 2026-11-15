import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  planFabricCodeRename, readRenameState, resolveRenameCarriers, applyFabricCodeRename, shapeOfRenamedLines,
  scanEveryColumn,
  // @ts-expect-error - plain .mjs, the writer behind rename-fabric-codes.mjs
} from '../scripts/lib/fabric-code-rename.mjs';

/* rename-fabric-codes.mjs against real PostgreSQL.
 *
 * The planner's unit suite (tests/fabricCodeRenamePlan.test.mjs) pins what is
 * planned and refused. It cannot show what the DATABASE does with the sweeps:
 * whether a jsonb block survives as an object, whether a bounded match leaves
 * KN011 alone, whether another company's row of the same code is reached. So
 * the rename is executed here and every row is read back.
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const CO = 2;
const OTHER = 1;
const PAIRS = [{ from: 'KN01', to: 'EM-09' }, { from: 'KN07', to: 'EM-02' }];
const TABLES = [
  'fabric_colours', 'fabric_library', 'fabric_trackings', 'hr_item_kpi', 'product_models', 'product_request_lines',
  'mfg_sales_order_items', 'mfg_sales_orders', 'purchase_order_items', 'purchase_orders',
  'purchase_consignment_order_items', 'inventory_movements', 'inventory_lots', 'pos_carts',
];

let admin: Sql;

async function reset(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS ${TABLES.map((t) => `scm.${t}`).join(', ')} CASCADE;
    DROP TYPE IF EXISTS scm.t_fabric_price_tier, scm.t_hr_item_kpi_type CASCADE;
    CREATE TYPE scm.t_fabric_price_tier AS ENUM ('PRICE_1', 'PRICE_2', 'PRICE_3');
    CREATE TYPE scm.t_hr_item_kpi_type AS ENUM ('product', 'fabric', 'special', 'category');

    CREATE TABLE scm.fabric_trackings (
      id text NOT NULL, fabric_code text NOT NULL, fabric_description text, series text, supplier_code text,
      is_active boolean NOT NULL DEFAULT true, company_id bigint NOT NULL, PRIMARY KEY (company_id, id));
    CREATE TABLE scm.fabric_library (
      id text PRIMARY KEY, label text NOT NULL, tier text NOT NULL DEFAULT 'standard', default_surcharge integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0,
      sofa_tier scm.t_fabric_price_tier, bedframe_tier scm.t_fabric_price_tier, company_id bigint NOT NULL);
    CREATE TABLE scm.fabric_colours (
      fabric_id text NOT NULL REFERENCES scm.fabric_library(id) ON DELETE CASCADE, colour_id text NOT NULL, label text,
      active boolean NOT NULL DEFAULT true, company_id bigint NOT NULL, PRIMARY KEY (fabric_id, colour_id));
    CREATE TABLE scm.hr_item_kpi (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flag_type scm.t_hr_item_kpi_type NOT NULL, ref text NOT NULL,
      label text NOT NULL DEFAULT '', bonus_sen integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
      company_id bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.product_models (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint NOT NULL, model_code text NOT NULL, allowed_options jsonb);
    CREATE TABLE scm.product_request_lines (id serial PRIMARY KEY, company_id bigint NOT NULL, fabric_code text);

    CREATE TABLE scm.mfg_sales_orders (doc_no text PRIMARY KEY, company_id bigint NOT NULL);
    CREATE TABLE scm.mfg_sales_order_items (
      id serial PRIMARY KEY, doc_no text NOT NULL, company_id bigint NOT NULL, tag text, variants jsonb, description2 text);
    CREATE TABLE scm.purchase_orders (id serial PRIMARY KEY, company_id bigint NOT NULL);
    CREATE TABLE scm.purchase_order_items (
      id serial PRIMARY KEY, purchase_order_id integer NOT NULL, company_id bigint NOT NULL, variants jsonb, description2 text);
    CREATE TABLE scm.purchase_consignment_order_items (id serial PRIMARY KEY, company_id bigint NOT NULL, variants jsonb, description2 text);
    CREATE TABLE scm.inventory_movements (
      id serial PRIMARY KEY, company_id bigint NOT NULL, tag text, variant_key text, variants jsonb, description2 text);
    CREATE TABLE scm.inventory_lots (id serial PRIMARY KEY, company_id bigint NOT NULL, tag text, variant_key text);
    CREATE TABLE scm.pos_carts (id serial PRIMARY KEY, company_id bigint NOT NULL, lines jsonb);
  `);
}

/* Production's shapes on 2026-11-13: each KN code a selling series of its own,
   one item KPI rule per code, the POS and the back office each writing their
   own variants keys. Company 1 holds the SAME codes and must not be reached. */
const POS_LINE = {
  x: 178, summary: '2 + L (2A+L) · EMBRACE/KN07 Sand', buildKey: 'build-1', colourId: 'KN07', fabricId: 'KN07',
  fabricCode: 'KN07', seatHeight: '28', legHeight: '6"', colourLabel: 'KN07 Sand', fabricLabel: 'EMBRACE',
  specials: ['Nylon Fabric'], extraAddonAmountRM: 125,
};
const DESK_LINE = { colourId: 'KN07', fabricId: 'KN07', fabricCode: 'KN07', seatHeight: '28', colourLabel: 'Sand', fabricLabel: 'KN07' };
const KIV_LINE = { fabricId: 'KN01', fabricLabel: 'EMBRACE', seatHeight: '30' };
const OTHER_CO_LINE = { fabricId: 'KN01', fabricCode: 'KN01', colourLabel: 'KN01 Aegean' };
const LONGER_CODE_LINE = { fabricId: 'KN011', fabricCode: 'KN011', colourLabel: 'KN011 Slate' };

async function seed(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.fabric_trackings (id, fabric_code, fabric_description, series, supplier_code, company_id) VALUES
      ('KN01', 'KN01', 'EM-09 Aegean', 'EMBRACE', 'ALTA-09', ${CO}),
      ('KN07', 'KN07', 'EM-02 Sand', 'EMBRACE', 'ALTA-02', ${CO}),
      ('BROWNIE-01', 'BROWNIE-01', 'HOME-01 Cream', 'HOMELY', NULL, ${CO}),
      ('KN01', 'KN01', 'Their own KN01', NULL, NULL, ${OTHER});
    INSERT INTO scm.fabric_library (id, label, sort_order, sofa_tier, company_id) VALUES
      ('KN01', 'KN01', 80, 'PRICE_2', ${CO}), ('KN07', 'KN07', 20, 'PRICE_2', ${CO}),
      ('BROWNIE', 'BROWNIE', 20, 'PRICE_3', ${CO}), ('KN390', 'KN390', 0, NULL, ${OTHER});
    INSERT INTO scm.fabric_colours (fabric_id, colour_id, label, company_id) VALUES
      ('KN01', 'KN01', 'Aegean', ${CO}), ('KN07', 'KN07', 'Sand', ${CO}),
      ('BROWNIE', 'BROWNIE-01', 'Cream', ${CO}), ('KN390', 'KN390-01', 'KN390-01', ${OTHER});
    INSERT INTO scm.hr_item_kpi (id, flag_type, ref, label, bonus_sen, company_id, created_at) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'fabric', 'KN01', 'KN01', 12500, ${CO}, '2026-11-06 08:19:27+00'),
      ('00000000-0000-0000-0000-0000000000a7', 'fabric', 'KN07', 'KN07', 12500, ${CO}, '2026-11-06 08:33:44+00'),
      ('00000000-0000-0000-0000-0000000000b1', 'fabric', 'BROWNIE', 'BROWNIE', 20000, ${CO}, '2026-11-06 09:00:00+00'),
      ('00000000-0000-0000-0000-0000000000c1', 'product', 'KN01', 'a SKU that happens to be called KN01', 100, ${OTHER}, '2026-11-06 09:00:00+00'),
      ('00000000-0000-0000-0000-0000000000c2', 'fabric', 'KN01', 'their KN01', 999, ${OTHER}, '2026-11-06 09:00:00+00');
    INSERT INTO scm.product_request_lines (company_id, fabric_code) VALUES (${CO}, 'KN07'), (${CO}, 'BROWNIE-01'), (${OTHER}, 'KN07');
    INSERT INTO scm.mfg_sales_orders (doc_no, company_id) VALUES ('2990-SO-1', ${CO}), ('HC-SO-1', ${OTHER});
    INSERT INTO scm.purchase_orders (id, company_id) VALUES (1, ${CO});
    INSERT INTO scm.inventory_lots (company_id, tag, variant_key) VALUES
      (${CO}, 'sand', 'fabriccode=kn07|seatheight=28|legheight=6"'),
      (${CO}, 'longer', 'fabriccode=kn011|seatheight=28'),
      (${OTHER}, 'theirs', 'fabriccode=kn07|seatheight=28|legheight=6"');
    INSERT INTO scm.inventory_movements (company_id, tag, variant_key) VALUES
      (${CO}, 'sand', 'fabriccode=kn07|seatheight=28|legheight=6"'),
      (${CO}, 'aegean-only', 'fabriccode=kn01'),
      (${OTHER}, 'theirs', 'fabriccode=kn01|seatheight=30');
  `);
  await sql`INSERT INTO scm.product_models (company_id, model_code, allowed_options) VALUES
    (${CO}, 'BOOQIT', ${sql.json({ sizes: ['24', '28'], fabrics: ['CG-001', 'KN01', 'KN07', 'BROWNIE-01'] })}),
    (${CO}, 'PLAIN', ${sql.json({ fabrics: ['CG-001'] })}),
    (${OTHER}, 'THEIRS', ${sql.json({ fabrics: ['KN01', 'KN07'] })})`;
  await sql`INSERT INTO scm.mfg_sales_order_items (doc_no, company_id, tag, variants, description2) VALUES
    ('2990-SO-1', ${CO}, 'pos', ${sql.json(POS_LINE)}, 'KN07 Sand / SEAT 28 / LEG 6" / SPECIAL: Fabric'),
    ('2990-SO-1', ${CO}, 'desk', ${sql.json(DESK_LINE)}, 'KN07 Sand (ALTA-13) / SEAT 28'),
    ('2990-SO-1', ${CO}, 'kiv', ${sql.json(KIV_LINE)}, 'EMBRACE COLOUR KIV / SEAT 30'),
    ('2990-SO-1', ${CO}, 'longer', ${sql.json(LONGER_CODE_LINE)}, 'KN011 Slate / SEAT 28'),
    ('2990-SO-1', ${CO}, 'none', NULL, NULL),
    ('HC-SO-1', ${OTHER}, 'theirs', ${sql.json(OTHER_CO_LINE)}, 'KN01 Aegean / SEAT 28')`;
  await sql`INSERT INTO scm.purchase_order_items (purchase_order_id, company_id, variants, description2) VALUES
    (1, ${CO}, ${sql.json({ fabricCode: 'KN07', legHeight: 'DEFAULT', seatHeight: '25' })}, 'KN07 / SEAT 25 / LEG DEFAULT')`;
  await sql`INSERT INTO scm.purchase_consignment_order_items (company_id, variants, description2) VALUES
    (${CO}, ${sql.json({ fabricCode: 'KN01', seatHeight: '30', fabricSupplierCode: 'ALTA-09' })}, 'KN01 (ALTA-09) / SEAT 30 / SPECIAL: SIDE KN07'),
    (${OTHER}, ${sql.json({ fabricCode: 'KN01' })}, 'KN01 / SEAT 30')`;
}

async function planNow() {
  const { usable } = await resolveRenameCarriers(admin);
  const state = await readRenameState(admin, CO, PAIRS, usable);
  const plan = planFabricCodeRename({ companyId: CO, pairs: PAIRS, descriptionLeadsWithNewCode: true, stamp: '2026-11-13', state });
  return { plan, carriers: usable };
}
const apply = (plan: unknown, carriers: unknown) =>
  admin.begin((tx) => applyFabricCodeRename(tx, { companyId: CO, pairs: PAIRS, plan, carriers }));

const soLine = async (tag: string) =>
  (await admin`SELECT variants, description2, jsonb_typeof(variants) AS shape FROM scm.mfg_sales_order_items WHERE tag = ${tag}`)[0]!;

describePg('rename-fabric-codes against PostgreSQL', () => {
  beforeAll(() => { admin = postgres(url, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await reset(admin); await seed(admin); });

  test('the plan reads the masters and every carrier, and refuses nothing', async () => {
    const { plan } = await planNow();
    expect(plan.refusals).toEqual([]);
    expect(plan.masters).toBe('pending');
    expect(plan.target.create.templateId).toBe('KN07');
    const hits = Object.fromEntries(plan.hits.rewritten.map((c: { table: string; col: string; n: number }) => [`${c.table}.${c.col}`, c.n]));
    expect(hits).toMatchObject({
      'scm.mfg_sales_order_items.variants': 3,
      'scm.mfg_sales_order_items.description2': 2,
      'scm.purchase_order_items.variants': 1,
      'scm.purchase_consignment_order_items.variants': 1,
      'scm.purchase_consignment_order_items.description2': 1,
      'scm.inventory_lots.variant_key': 1,
      'scm.inventory_movements.variant_key': 2,
      'scm.product_request_lines.fabric_code': 1,
      'scm.hr_item_kpi.ref': 2,
      'scm.fabric_trackings.fabric_code': 2,
      'scm.fabric_colours.colour_id': 2,
    });
  });

  test('the Fabric Converter rows take the new code AND the new id; the other company keeps its own', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    expect(await admin`SELECT company_id::int AS co, id, fabric_code, fabric_description, supplier_code FROM scm.fabric_trackings ORDER BY company_id, id`).toEqual([
      { co: OTHER, id: 'KN01', fabric_code: 'KN01', fabric_description: 'Their own KN01', supplier_code: null },
      { co: CO, id: 'BROWNIE-01', fabric_code: 'BROWNIE-01', fabric_description: 'HOME-01 Cream', supplier_code: null },
      { co: CO, id: 'EM-02', fabric_code: 'EM-02', fabric_description: 'EM-02 Sand', supplier_code: 'ALTA-02' },
      { co: CO, id: 'EM-09', fabric_code: 'EM-09', fabric_description: 'EM-09 Aegean', supplier_code: 'ALTA-09' },
    ]);
  });

  test('one series EM holds both colours at the old tier; the old series stay, switched off', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    expect(await admin`SELECT id, label, active, sort_order, sofa_tier::text AS sofa_tier, bedframe_tier::text AS bedframe_tier, company_id::int AS co
                         FROM scm.fabric_library ORDER BY id`).toEqual([
      { id: 'BROWNIE', label: 'BROWNIE', active: true, sort_order: 20, sofa_tier: 'PRICE_3', bedframe_tier: null, co: CO },
      { id: 'EM', label: 'EM', active: true, sort_order: 20, sofa_tier: 'PRICE_2', bedframe_tier: null, co: CO },
      { id: 'KN01', label: 'KN01 [renamed to EM on 2026-11-13]', active: false, sort_order: 80, sofa_tier: 'PRICE_2', bedframe_tier: null, co: CO },
      { id: 'KN07', label: 'KN07 [renamed to EM on 2026-11-13]', active: false, sort_order: 20, sofa_tier: 'PRICE_2', bedframe_tier: null, co: CO },
      { id: 'KN390', label: 'KN390', active: true, sort_order: 0, sofa_tier: null, bedframe_tier: null, co: OTHER },
    ]);
    expect(await admin`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours ORDER BY fabric_id, colour_id`).toEqual([
      { fabric_id: 'BROWNIE', colour_id: 'BROWNIE-01', label: 'Cream', active: true },
      { fabric_id: 'EM', colour_id: 'EM-02', label: 'Sand', active: true },
      { fabric_id: 'EM', colour_id: 'EM-09', label: 'Aegean', active: true },
      { fabric_id: 'KN390', colour_id: 'KN390-01', label: 'KN390-01', active: true },
    ]);
  });

  test('a POS line: every key that held the code moves, every other key is untouched, and it is still an object', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    const line = await soLine('pos');
    expect(line.shape).toBe('object');
    expect(line.variants).toEqual({
      ...POS_LINE,
      colourId: 'EM-02', fabricCode: 'EM-02', fabricId: 'EM', colourLabel: 'EM-02 Sand',
      summary: '2 + L (2A+L) · EMBRACE/EM-02 Sand',
    });
    expect(line.description2).toBe('EM-02 Sand / SEAT 28 / LEG 6" / SPECIAL: Fabric');
  });

  test('a back-office line: the series label follows the series, the colour name stays', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    const line = await soLine('desk');
    expect(line.variants).toEqual({ ...DESK_LINE, colourId: 'EM-02', fabricCode: 'EM-02', fabricId: 'EM', fabricLabel: 'EM' });
    expect(line.description2).toBe('EM-02 Sand (ALTA-13) / SEAT 28');
  });

  test('a colour-KIV line moves to the series and gains no colour', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    const line = await soLine('kiv');
    expect(line.variants).toEqual({ fabricId: 'EM', fabricLabel: 'EMBRACE', seatHeight: '30' });
    expect(line.description2).toBe('EMBRACE COLOUR KIV / SEAT 30');
  });

  test('a longer code that starts the same, a line with no variants and the other company are not reached', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    expect((await soLine('longer')).variants).toEqual(LONGER_CODE_LINE);
    expect((await soLine('longer')).description2).toBe('KN011 Slate / SEAT 28');
    expect((await soLine('none')).variants).toBeNull();
    expect((await soLine('theirs')).variants).toEqual(OTHER_CO_LINE);
    expect((await soLine('theirs')).description2).toBe('KN01 Aegean / SEAT 28');
    expect(await admin`SELECT company_id::int AS co, variants, description2 FROM scm.purchase_consignment_order_items ORDER BY id`).toEqual([
      { co: CO, variants: { fabricCode: 'EM-09', seatHeight: '30', fabricSupplierCode: 'ALTA-09' }, description2: 'EM-09 (ALTA-09) / SEAT 30 / SPECIAL: SIDE EM-02' },
      { co: OTHER, variants: { fabricCode: 'KN01' }, description2: 'KN01 / SEAT 30' },
    ]);
    expect(await admin`SELECT variants, description2 FROM scm.purchase_order_items`).toEqual([
      { variants: { fabricCode: 'EM-02', legHeight: 'DEFAULT', seatHeight: '25' }, description2: 'EM-02 / SEAT 25 / LEG DEFAULT' },
    ]);
  });

  test('the stock buckets move with the order lines, in lower case, segment by segment', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    expect(await admin`SELECT company_id::int AS co, tag, variant_key FROM scm.inventory_lots ORDER BY id`).toEqual([
      { co: CO, tag: 'sand', variant_key: 'fabriccode=em-02|seatheight=28|legheight=6"' },
      { co: CO, tag: 'longer', variant_key: 'fabriccode=kn011|seatheight=28' },
      { co: OTHER, tag: 'theirs', variant_key: 'fabriccode=kn07|seatheight=28|legheight=6"' },
    ]);
    expect(await admin`SELECT tag, variant_key FROM scm.inventory_movements ORDER BY id`).toEqual([
      { tag: 'sand', variant_key: 'fabriccode=em-02|seatheight=28|legheight=6"' },
      { tag: 'aegean-only', variant_key: 'fabriccode=em-09' },
      { tag: 'theirs', variant_key: 'fabriccode=kn01|seatheight=30' },
    ]);
  });

  test('the Model pool keeps its order; a pool without the codes and the other company are untouched', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    expect(await admin`SELECT model_code, allowed_options FROM scm.product_models ORDER BY model_code`).toEqual([
      { model_code: 'BOOQIT', allowed_options: { sizes: ['24', '28'], fabrics: ['CG-001', 'EM-09', 'EM-02', 'BROWNIE-01'] } },
      { model_code: 'PLAIN', allowed_options: { fabrics: ['CG-001'] } },
      { model_code: 'THEIRS', allowed_options: { fabrics: ['KN01', 'KN07'] } },
    ]);
  });

  test('the two item KPI rules become ONE rule on EM at the same amount; every other rule stays', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    expect(await admin`SELECT id::text AS id, flag_type::text AS type, ref, label, bonus_sen, active, company_id::int AS co
                         FROM scm.hr_item_kpi ORDER BY id`).toEqual([
      { id: '00000000-0000-0000-0000-0000000000a1', type: 'fabric', ref: 'EM', label: 'EM', bonus_sen: 12500, active: true, co: CO },
      { id: '00000000-0000-0000-0000-0000000000b1', type: 'fabric', ref: 'BROWNIE', label: 'BROWNIE', bonus_sen: 20000, active: true, co: CO },
      { id: '00000000-0000-0000-0000-0000000000c1', type: 'product', ref: 'KN01', label: 'a SKU that happens to be called KN01', bonus_sen: 100, active: true, co: OTHER },
      { id: '00000000-0000-0000-0000-0000000000c2', type: 'fabric', ref: 'KN01', label: 'their KN01', bonus_sen: 999, active: true, co: OTHER },
    ]);
  });

  test('a product request follows the code, so its save still finds the fabric', async () => {
    const { plan, carriers } = await planNow();
    await apply(plan, carriers);
    expect(await admin`SELECT company_id::int AS co, fabric_code FROM scm.product_request_lines ORDER BY id`).toEqual([
      { co: CO, fabric_code: 'EM-02' }, { co: CO, fabric_code: 'BROWNIE-01' }, { co: OTHER, fabric_code: 'KN07' },
    ]);
  });

  test('a second plan finds nothing left, and the renamed lines read back as objects on series EM', async () => {
    const first = await planNow();
    await apply(first.plan, first.carriers);
    const { plan } = await planNow();
    expect(plan.refusals).toEqual([]);
    expect(plan.masters).toBe('done');
    expect(plan.work).toBe(false);
    expect(plan.hits.rewritten).toEqual([]);
    expect(plan.hits.retained.map((c: { col: string; n: number }) => [c.col, c.n])).toEqual([['id', 2], ['label', 2]]);
    expect(await shapeOfRenamedLines(admin, CO, PAIRS, 'EM')).toEqual([
      { arm: 'SO', lines: 2, not_object: 0, other_series: 0 },
      { arm: 'PO', lines: 1, not_object: 0, other_series: 0 },
      { arm: 'PCO', lines: 1, not_object: 0, other_series: 0 },
    ]);
  });

  test('a re-run moves an order saved on an old code in between, and leaves the masters alone', async () => {
    const first = await planNow();
    await apply(first.plan, first.carriers);
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no, company_id, tag, variants, description2)
                VALUES ('2990-SO-1', ${CO}, 'late', ${admin.json(DESK_LINE)}, 'KN07 Sand / SEAT 28')`;
    await admin`INSERT INTO scm.inventory_movements (company_id, tag, variant_key) VALUES (${CO}, 'late', 'fabriccode=kn07|seatheight=28')`;

    const { plan, carriers } = await planNow();
    expect(plan.refusals).toEqual([]);
    expect(plan.masters).toBe('done');
    expect(plan.work).toBe(true);
    await apply(plan, carriers);

    expect((await soLine('late')).variants).toEqual({ ...DESK_LINE, colourId: 'EM-02', fabricCode: 'EM-02', fabricId: 'EM', fabricLabel: 'EM' });
    expect((await soLine('late')).description2).toBe('EM-02 Sand / SEAT 28');
    expect(await admin`SELECT variant_key FROM scm.inventory_movements WHERE tag = 'late'`).toEqual([{ variant_key: 'fabriccode=em-02|seatheight=28' }]);
    expect(await admin`SELECT COUNT(*)::int AS n FROM scm.fabric_library WHERE id = 'EM'`).toEqual([{ n: 1 }]);
    expect((await planNow()).plan.work).toBe(false);
  });

  test('series on different tiers are refused, and a refused plan writes nothing', async () => {
    await admin`UPDATE scm.fabric_library SET sofa_tier = 'PRICE_3' WHERE id = 'KN01'`;
    const { plan, carriers } = await planNow();
    expect(plan.refusals.join(' | ')).toMatch(/do not share one selling tier/);
    await expect(apply(plan, carriers)).rejects.toThrow(/refusal/);
    expect(await admin`SELECT id FROM scm.fabric_trackings WHERE company_id = ${CO} ORDER BY id`).toEqual([{ id: 'BROWNIE-01' }, { id: 'KN01' }, { id: 'KN07' }]);
  });

  test('an open cart on an old code is refused: nothing rewrites a cart', async () => {
    await admin`INSERT INTO scm.pos_carts (company_id, lines) VALUES (${CO}, ${admin.json([{ fabricId: 'KN07', colourId: 'KN07' }])})`;
    const { plan } = await planNow();
    expect(plan.refusals.join(' | ')).toMatch(/1 row\(s\) of scm\.pos_carts\.lines name an old code/);
  });

  test('an old code under a key no sweep rewrites is refused at plan time', async () => {
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no, company_id, tag, variants)
                VALUES ('2990-SO-1', ${CO}, 'odd', ${admin.json({ remark: 'customer may switch to KN07' })})`;
    const { plan } = await planNow();
    expect(plan.refusals.join(' | ')).toMatch(/1 line\(s\) hold an old code under variants\.remark \(string\)/);
  });

  test('a row the sweeps cannot reach, saved after the plan, rolls the WHOLE rename back', async () => {
    const { plan, carriers } = await planNow();
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no, company_id, tag, variants)
                VALUES ('2990-SO-1', ${CO}, 'odd', ${admin.json({ remark: 'customer may switch to KN07' })})`;
    await expect(apply(plan, carriers)).rejects.toThrow(/scm\.mfg_sales_order_items\.variants still has 1.*Rolled back/);

    expect(await admin`SELECT id FROM scm.fabric_trackings WHERE company_id = ${CO} ORDER BY id`).toEqual([{ id: 'BROWNIE-01' }, { id: 'KN01' }, { id: 'KN07' }]);
    expect(await admin`SELECT COUNT(*)::int AS n FROM scm.fabric_library WHERE id = 'EM'`).toEqual([{ n: 0 }]);
    expect((await soLine('pos')).variants).toEqual(POS_LINE);
    expect(await admin`SELECT COUNT(*)::int AS n FROM scm.hr_item_kpi WHERE company_id = ${CO} AND ref IN ('KN01', 'KN07')`).toEqual([{ n: 2 }]);
  });

  test('the full scan counts the old codes in every column, and names one the carrier list does not know', async () => {
    await admin.unsafe(`
      DROP TABLE IF EXISTS scm.t_unlisted;
      CREATE TABLE scm.t_unlisted (id serial PRIMARY KEY, company_id bigint NOT NULL, note text, payload jsonb);
      INSERT INTO scm.t_unlisted (company_id, note, payload) VALUES
        (${CO}, 'fabric KN07', '{"colour": "KN01"}'), (${CO}, 'KN011', NULL), (${OTHER}, 'KN07', NULL);
    `);
    const scan = await scanEveryColumn(admin, CO, PAIRS.map((p) => p.from));
    expect(scan.failed).toEqual([]);
    const seen = Object.fromEntries(scan.hits.map((h: { table: string; col: string; n: number; listed: boolean }) => [`${h.table}.${h.col}`, [h.n, h.listed]]));
    expect(seen).toMatchObject({
      'scm.t_unlisted.note': [1, false],
      'scm.t_unlisted.payload': [1, false],
      'scm.mfg_sales_order_items.variants': [3, true],
      'scm.inventory_movements.variant_key': [2, true],
      'scm.product_models.allowed_options': [1, true],
      'scm.hr_item_kpi.ref': [2, true],
      'scm.fabric_library.id': [2, true],
    });
    await admin.unsafe('DROP TABLE scm.t_unlisted');
  });

  test('a Model pool ticked differently since the plan is not overwritten: the run stops and rolls back', async () => {
    const { plan, carriers } = await planNow();
    await admin`UPDATE scm.product_models SET allowed_options = ${admin.json({ fabrics: ['KN01', 'KN07'] })} WHERE model_code = 'BOOQIT'`;
    await expect(apply(plan, carriers)).rejects.toThrow(/fabric pool of model BOOQIT: 0 row\(s\) written, 1 planned/);
    expect(await admin`SELECT fabric_code FROM scm.fabric_trackings WHERE company_id = ${CO} AND id = 'KN07'`).toEqual([{ fabric_code: 'KN07' }]);
  });
});
