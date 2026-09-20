/* EXECUTES the 2990 retail-price sentinel's SQL (scripts/lib/retail-price-sentinel.mjs)
 * against real Postgres, including against PLANTED DAMAGE.
 *
 * Two reasons this file exists rather than a unit test over fixtures:
 *
 * 1. The statements lean on Postgres-only shapes the workers suite's D1 cannot
 *    parse — `DISTINCT ON`, `jsonb_array_elements` in a LATERAL, `split_part`,
 *    `count(*) FILTER`, `IS DISTINCT FROM`, `to_regclass`. Without this file
 *    their first contact with a Postgres parser would be production, at 01:00,
 *    in the one run that was supposed to catch a price being deleted.
 *
 * 2. A checker that has only ever seen a healthy database is not known to
 *    detect anything. Each case below deletes, changes or hides exactly one
 *    thing and asserts the sentinel says so — and the healthy fixture asserts
 *    it stays quiet, because an alarm that always fires is turned off by the
 *    person reading it.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  DERIVE_FLAG_SQL,
  FLAT_COUNTS_SQL,
  FLAT_OFFENDERS_SQL,
  GUARD_COUNT_SQL,
  GUARD_LOG_SQL,
  GUARD_ROWS_SQL,
  SEAT_COUNTS_SQL,
  SEAT_OFFENDERS_SQL,
  flagIsOn,
  verdict,
} from '../scripts/lib/retail-price-sentinel.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const CO = 2; // the company whose retail prices are authored elsewhere
const OTHER = 1; // …and the one whose catalogue is ours, which must never be swept in

let sql: Sql;

async function resetFixture(s: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  await s.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS scm.retail_price_guard_log CASCADE;
    DROP TABLE IF EXISTS scm.master_price_history CASCADE;
    DROP TABLE IF EXISTS scm.app_config CASCADE;
    DROP TABLE IF EXISTS scm.mfg_products CASCADE;
    CREATE TABLE scm.mfg_products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id bigint NOT NULL,
      code text NOT NULL,
      sell_price_sen integer,
      pwp_price_sen integer,
      seat_height_prices jsonb
    );
    CREATE TABLE scm.master_price_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id bigint NOT NULL,
      item_code text NOT NULL,
      field text NOT NULL,
      old_value_sen integer,
      new_value_sen integer,
      changed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE scm.app_config (company_id bigint NOT NULL, key text NOT NULL, value text);
    CREATE TABLE scm.retail_price_guard_log (
      id bigserial PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT now(),
      company_id bigint NOT NULL,
      item_code text NOT NULL,
      slots_carried_forward integer NOT NULL DEFAULT 0,
      slots_readded integer NOT NULL DEFAULT 0
    );

    /* A healthy picture: two company-2 SOFA SKUs whose seat grid carries COST
       (priceSen) beside RETAIL (sellingPriceSen), one flat-priced SKU, and a
       company-1 SKU that is in breach on purpose — it must never be counted,
       because company 1's catalogue is ours to change. */
    INSERT INTO scm.mfg_products (company_id, code, sell_price_sen, pwp_price_sen, seat_height_prices) VALUES
      (${CO}, 'BOOQIT-1A', NULL, NULL,
        '[{"height":"24","tier":"PRICE_2","priceSen":51975},
          {"height":"24","tier":"PRICE_1","sellingPriceSen":99000},
          {"height":"26","tier":"PRICE_1","sellingPriceSen":149000}]'::jsonb),
      (${CO}, 'PANTTI-1A', NULL, NULL,
        '[{"height":"24","tier":"PRICE_1","sellingPriceSen":149000}]'::jsonb),
      (${CO}, 'FLAT-ONLY', 299000, 99000, NULL),
      (${OTHER}, 'HOUZS-1A', 111100, NULL,
        '[{"height":"24","tier":"PRICE_1","sellingPriceSen":123400}]'::jsonb);

    /* The audit trail. BOOQIT's 24" slot was repriced once — the newest row is
       what the sentinel must believe, which is what pins the DISTINCT ON. */
    INSERT INTO scm.master_price_history (company_id, item_code, field, new_value_sen, changed_at) VALUES
      (${CO}, 'BOOQIT-1A', 'seat_height_selling:24|PRICE_1', 79000, now() - interval '9 days'),
      (${CO}, 'BOOQIT-1A', 'seat_height_selling:24|PRICE_1', 99000, now() - interval '2 days'),
      (${CO}, 'BOOQIT-1A', 'seat_height_selling:26|PRICE_1', 149000, now() - interval '2 days'),
      (${CO}, 'PANTTI-1A', 'seat_height_selling:24|PRICE_1', 149000, now() - interval '3 days'),
      /* Cleared by hand: newest is NULL, so it is NOT expected on the row. */
      (${CO}, 'PANTTI-1A', 'seat_height_selling:26|PRICE_1', 189000, now() - interval '8 days'),
      (${CO}, 'PANTTI-1A', 'seat_height_selling:26|PRICE_1', NULL, now() - interval '1 day'),
      /* COST history, which this sentinel must ignore entirely. */
      (${CO}, 'BOOQIT-1A', 'seat_height:24|PRICE_2', 51975, now() - interval '2 days'),
      (${CO}, 'FLAT-ONLY', 'sell_price_sen', 299000, now() - interval '4 days'),
      (${CO}, 'FLAT-ONLY', 'pwp_price_sen', 99000, now() - interval '4 days'),
      /* Company 1's own history — a different tenant, never swept in. */
      (${OTHER}, 'HOUZS-1A', 'sell_price_sen', 999999, now() - interval '4 days'),
      (${OTHER}, 'HOUZS-1A', 'seat_height_selling:24|PRICE_1', 999999, now() - interval '4 days');

    INSERT INTO scm.app_config (company_id, key, value) VALUES (${OTHER}, 'scm.auto_derive_product_cost', 'off');
  `);
}

/** Run every query the CLI runs and hand the pure verdict the same shape. */
async function run(companyId = CO) {
  const [seat] = await sql.unsafe(SEAT_COUNTS_SQL, [companyId]);
  const seatOffenders = await sql.unsafe(SEAT_OFFENDERS_SQL, [companyId]);
  const flat = await sql.unsafe(FLAT_COUNTS_SQL, [companyId]);
  const flatOffenders = await sql.unsafe(FLAT_OFFENDERS_SQL, [companyId]);
  const [{ present }] = await sql.unsafe(GUARD_LOG_SQL);
  const guard = present
    ? { present, ...(await sql.unsafe(GUARD_COUNT_SQL, [companyId]))[0] }
    : { present, rows: 0, newest: null };
  const guardRows = present ? await sql.unsafe(GUARD_ROWS_SQL, [companyId]) : [];
  const flags = await sql.unsafe(DERIVE_FLAG_SQL);
  return { seat, seatOffenders, flat, flatOffenders, guard, guardRows, flags, ...verdict({ companyId, seat, flat, guard, flags }) };
}

describePg('the 2990 retail-price sentinel, against real Postgres', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false });
    await resetFixture(sql);
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await resetFixture(sql);
  });

  test('a healthy database is silent, and says what it compared', async () => {
    const r = await run();
    expect(r.alarms).toEqual([]);
    expect(r.ok).toBe(true);
    // 3 retail slots expected (BOOQIT 24 + 26, PANTTI 24) — the cleared PANTTI
    // 26 is not one of them, and the cost slot is not one of them either.
    expect(Number(r.seat.expected_slots)).toBe(3);
    expect(Number(r.seat.live_slots)).toBe(3);
    expect(Number(r.seat.unaudited)).toBe(0);
    expect(r.flat.map((f) => f.field)).toEqual(['pwp_price_sen', 'sell_price_sen']);
  });

  test('the newest audited value wins, so a superseded price is not a finding', async () => {
    // BOOQIT 24" was RM 790 nine days ago and RM 990 two days ago; the row holds
    // RM 990. Reading the OLDER row would report a disagreement that is not one.
    const r = await run();
    expect(r.seatOffenders).toEqual([]);
  });

  test('a DELETED seat retail price is caught — the 2026-09-16 shape', async () => {
    // Exactly what writeProductCost() did: the derived cost-only array assigned
    // over the top, so the retail slots simply cease to exist.
    await sql`UPDATE scm.mfg_products
                 SET seat_height_prices = '[{"height":"24","tier":"PRICE_2","priceSen":51975}]'::jsonb
               WHERE company_id = ${CO} AND code = 'BOOQIT-1A'`;
    const r = await run();
    expect(Number(r.seat.missing)).toBe(2);
    expect(r.seatOffenders.map((o) => `${o.kind}:${o.item_code}:${o.height}`)).toEqual([
      'missing:BOOQIT-1A:24',
      'missing:BOOQIT-1A:26',
    ]);
    expect(r.alarms.join(' ')).toMatch(/2 seat retail price\(s\).*GONE/);
    expect(r.ok).toBe(false);
  });

  test('a CHANGED seat retail price is caught, and the alarm carries both numbers', async () => {
    await sql`UPDATE scm.mfg_products
                 SET seat_height_prices = '[{"height":"24","tier":"PRICE_1","sellingPriceSen":1},
                                            {"height":"26","tier":"PRICE_1","sellingPriceSen":149000}]'::jsonb
               WHERE company_id = ${CO} AND code = 'BOOQIT-1A'`;
    const r = await run();
    expect(Number(r.seat.disagreeing)).toBe(1);
    expect(r.seatOffenders).toHaveLength(1);
    expect(r.seatOffenders[0]).toMatchObject({ kind: 'disagreeing', item_code: 'BOOQIT-1A' });
    // int8 arrives as a string from postgres.js; the sentinel compares in SQL
    // and only ever formats in JS, so this is the shape, not a bug to fix here.
    expect(Number(r.seatOffenders[0].want_sen)).toBe(99000);
    expect(Number(r.seatOffenders[0].have_sen)).toBe(1);
    expect(r.ok).toBe(false);
  });

  test('a price that appears with no audit row behind it is REPORTED, not alarmed', async () => {
    // A hand repair looks like this, and so does a price older than the trail.
    // Alarming here would make the sentinel fire on its own incident response.
    await sql`UPDATE scm.mfg_products
                 SET seat_height_prices = seat_height_prices ||
                     '[{"height":"28","tier":"PRICE_1","sellingPriceSen":199000}]'::jsonb
               WHERE company_id = ${CO} AND code = 'PANTTI-1A'`;
    const r = await run();
    expect(Number(r.seat.unaudited)).toBe(1);
    expect(r.alarms).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/no history row behind them/);
  });

  test('a cleared price stays cleared — a NULL newest value is not "missing"', async () => {
    // PANTTI 26" was priced, then cleared by hand. "Restoring" it would be the
    // sentinel overruling the operator.
    const r = await run();
    expect(r.seatOffenders.some((o) => o.item_code === 'PANTTI-1A' && o.height === '26')).toBe(false);
  });

  test('the flat columns are watched: a wiped sell_price_sen alarms', async () => {
    await sql`UPDATE scm.mfg_products SET sell_price_sen = NULL WHERE company_id = ${CO} AND code = 'FLAT-ONLY'`;
    const r = await run();
    expect(Number(r.flat.find((f) => f.field === 'sell_price_sen')?.missing)).toBe(1);
    expect(r.flatOffenders).toHaveLength(1);
    expect(r.flatOffenders[0]).toMatchObject({ kind: 'missing', item_code: 'FLAT-ONLY' });
    expect(Number(r.flatOffenders[0].want_sen)).toBe(299000);
    expect(r.ok).toBe(false);
  });

  test('the flat columns are watched: an unaudited pwp_price_sen edit alarms', async () => {
    await sql`UPDATE scm.mfg_products SET pwp_price_sen = 1 WHERE company_id = ${CO} AND code = 'FLAT-ONLY'`;
    const r = await run();
    expect(Number(r.flat.find((f) => f.field === 'pwp_price_sen')?.disagreeing)).toBe(1);
    expect(r.alarms.join(' ')).toMatch(/pwp_price_sen that no audited change accounts for/);
  });

  test('an intervention by the database trigger is an alarm, not a comfort', async () => {
    // The guard putting a price back means some writer is STILL rewriting them.
    await sql`INSERT INTO scm.retail_price_guard_log (company_id, item_code, slots_carried_forward, slots_readded)
              VALUES (${CO}, 'BOOQIT-1A', 2, 1)`;
    const r = await run();
    expect(Number(r.guard.rows)).toBe(1);
    expect(r.guardRows).toHaveLength(1);
    expect(r.alarms.join(' ')).toMatch(/had to put a retail price back/);
    expect(r.ok).toBe(false);
  });

  test('the guard log missing is a NOTE, so this runs before the migration lands', async () => {
    await sql.unsafe('DROP TABLE scm.retail_price_guard_log');
    const r = await run();
    expect(r.guard.present).toBe(false);
    expect(r.alarms).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/was not checked/);
  });

  test('auto-derive switched on for company 2 is an alarm — their catalogue is not ours to derive', async () => {
    await sql`INSERT INTO scm.app_config (company_id, key, value) VALUES (${CO}, 'scm.auto_derive_product_cost', 'on')`;
    const r = await run();
    expect(r.alarms.join(' ')).toMatch(/must never be derived/);
    expect(r.ok).toBe(false);
  });

  test('company 1 having it on is NOT an alarm for company 2', async () => {
    await sql`UPDATE scm.app_config SET value = 'on' WHERE company_id = ${OTHER}`;
    const r = await run();
    expect(r.alarms).toEqual([]);
    expect(flagIsOn('on')).toBe(true);
    expect(flagIsOn('yes-please')).toBe(false);
  });

  test("company 1's own breach is invisible here — the sweep is one tenant wide", async () => {
    await sql`UPDATE scm.mfg_products SET sell_price_sen = 1, seat_height_prices = '[]'::jsonb
               WHERE company_id = ${OTHER}`;
    const r = await run(); // still company 2
    expect(r.alarms).toEqual([]);
    // …and pointed AT company 1 it is found, so the silence above is scoping,
    // not blindness.
    const other = await run(OTHER);
    expect(other.ok).toBe(false);
  });

  test('an empty population REFUSES a verdict instead of passing', async () => {
    // A company with no audited retail history compares nothing. Reporting that
    // as "clean" is the failure mode this repo keeps meeting; it must alarm.
    const r = await run(999);
    expect(Number(r.seat.history_rows)).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.alarms.join(' ')).toMatch(/nothing to compare/);
  });
});
