import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { planFollowerFlags, resetFollowerFlags, verifyFollowerFlags } from '../scripts/lib/so-line-follower-flags.mjs';

/*
 * reset-so-line-follower-flags.mjs: clears the hand-set flag only where the line
 * date equals its order's header Delivery Date, only inside the company asked for.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
let admin: Sql;

describePg('SO line follower-flag reset', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    }
    if (parsed.pathname !== '/houzs_test') {
      throw new Error('PG integration tests require the disposable houzs_test database');
    }
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`
      DROP SCHEMA IF EXISTS scm CASCADE;
      CREATE SCHEMA scm;
      CREATE TABLE scm.mfg_sales_orders (doc_no text PRIMARY KEY, company_id bigint, customer_delivery_date date);
      CREATE TABLE scm.mfg_sales_order_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, company_id bigint,
        item_code text, line_delivery_date date, line_delivery_date_overridden boolean NOT NULL DEFAULT false);
    `);
  });
  afterAll(async () => { await admin?.end(); });

  beforeEach(async () => {
    await admin.unsafe('TRUNCATE scm.mfg_sales_orders, scm.mfg_sales_order_items');
    await admin`INSERT INTO scm.mfg_sales_orders VALUES ('SO-1', 1, '2026-10-10'), ('SO-2', 1, NULL), ('SO-X', 2, '2026-10-10')`;
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no, company_id, item_code, line_delivery_date, line_delivery_date_overridden) VALUES
      ('SO-1', 1, 'ON-HEADER', '2026-10-10', true),
      ('SO-1', 1, 'HAND', '2026-10-15', true),
      ('SO-1', 1, 'FOLLOW', '2026-10-10', false),
      ('SO-2', 1, 'NO-HEADER', '2026-10-10', true),
      ('SO-X', 2, 'OTHER-CO', '2026-10-10', true)`;
  });

  const flags = async () => Object.fromEntries((await admin<{ item_code: string; f: boolean }[]>`
    SELECT item_code, line_delivery_date_overridden AS f FROM scm.mfg_sales_order_items`).map((r) => [r.item_code, r.f]));

  test('plan counts only flagged lines on their header date, in the company asked for', async () => {
    expect(await planFollowerFlags(admin, 1)).toEqual({ lines: 1, orders: 1 });
    expect(await flags()).toMatchObject({ 'ON-HEADER': true });
  });

  test('apply clears exactly those, keeps the date, and the fresh re-read finds the right shape', async () => {
    const touched = await resetFollowerFlags(admin, 1);
    expect(touched).toHaveLength(1);
    expect(await flags()).toEqual({ 'ON-HEADER': false, HAND: true, FOLLOW: false, 'NO-HEADER': true, 'OTHER-CO': true });
    expect(await verifyFollowerFlags(admin, 1, touched)).toEqual([]);
    expect(await planFollowerFlags(admin, 1)).toEqual({ lines: 0, orders: 0 });
  });

  test('verify names a line whose date moved after the reset', async () => {
    const touched = await resetFollowerFlags(admin, 1);
    await admin`UPDATE scm.mfg_sales_order_items SET line_delivery_date = '2026-10-11' WHERE item_code = 'ON-HEADER'`;
    expect((await verifyFollowerFlags(admin, 1, touched)).join('\n')).toContain('date moved');
  });
});
