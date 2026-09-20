/* EXECUTES the HC Delivery sheet's Service-Case (ASSR) leg feed SQL
 * (src/lib/delivery-sheet-assr-feed.ts) against real Postgres. The own-team
 * gate is a three-branch OR the workers suite's D1 cannot parse, and `assr_cases`
 * lives in the PUBLIC schema, so this is where the predicate meets a Postgres
 * parser before the sheet's next pull does.
 *
 * Asserted: only OPEN cases (closed_at / archived_at NULL) with at least one
 * OWN-TEAM dated leg appear, scoped to the secret's company; a supplier / 3PL /
 * unconfirmed leg or a leg with no date is excluded; the cursor is strict; and
 * the mapper expands each returned case into the right leg rows.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { toPgPlaceholders } from '../src/db/d1-compat';
import { FEED_EPOCH } from '../src/lib/delivery-sheet-feed';
import { FEED_ASSR_LEGS_SQL, toAssrLegRecords, type AssrFeedRow } from '../src/lib/delivery-sheet-assr-feed';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

async function resetFixture(s: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  // Self-contained: assr_cases is a standalone PUBLIC table here, no FKs, so it
  // drops and rebuilds without touching the scm fixtures the other pg suite owns.
  await s.unsafe(`
    DROP TABLE IF EXISTS public.assr_cases CASCADE;
    CREATE TABLE public.assr_cases (
      id bigserial PRIMARY KEY, assr_no text NOT NULL, company_id bigint NOT NULL, status text,
      customer_name text, phone text, location text, sales_agent text, delivery_order text,
      addr1 text, addr2 text, addr3 text, addr4 text,
      inspection_by text, inspection_visit_at text,
      pickup_by text, customer_pickup_at text,
      delivery_by text, do_date text,
      closed_at text, archived_at text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.assr_cases
      (assr_no, company_id, status, customer_name, phone, location, sales_agent, delivery_order,
       addr1, addr2, addr3, addr4, inspection_by, inspection_visit_at, pickup_by, customer_pickup_at,
       delivery_by, do_date, closed_at, archived_at, updated_at)
    VALUES
      -- All three own-team legs, dated → 3 legs.
      ('ASSR/2609-010', 1, 'In Progress', 'Wendy', '60127712155', 'KL WAREHOUSE', 'LUCAS', 'HC-DO-2609-050',
       '12 Jalan Satu', 'Taman Dua', NULL, 'Selangor', 'own', '2026-09-20', 'customer', '2026-09-21',
       'own', '2026-09-25', NULL, NULL, '2026-09-10 00:00:00+00'),
      -- Only own-team pickup dated → 1 leg.
      ('ASSR/2609-011', 1, 'In Progress', 'Ali', '60130000000', 'PG WAREHOUSE', 'SALLY', NULL,
       'A', NULL, NULL, NULL, NULL, NULL, 'customer', '2026-09-22', NULL, NULL, NULL, NULL, '2026-09-11 00:00:00+00'),
      -- Every leg supplier-driven → excluded even though all dated.
      ('ASSR/2609-012', 1, 'In Progress', 'Sup', NULL, 'KL WAREHOUSE', NULL, NULL,
       NULL, NULL, NULL, NULL, 'supplier', '2026-09-20', 'supplier', '2026-09-21', 'supplier', '2026-09-25', NULL, NULL, '2026-09-12 00:00:00+00'),
      -- Own-team marks but no dates → excluded.
      ('ASSR/2609-013', 1, 'In Progress', 'NoDate', NULL, 'KL WAREHOUSE', NULL, NULL,
       NULL, NULL, NULL, NULL, 'own', NULL, 'customer', NULL, 'own', NULL, NULL, NULL, '2026-09-13 00:00:00+00'),
      -- Closed / archived cases → excluded even with an own-team dated leg.
      ('ASSR/2609-014', 1, 'Closed', 'Done', NULL, 'KL WAREHOUSE', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, 'customer', '2026-09-21', NULL, NULL, '2026-09-14 00:00:00+00', NULL, '2026-09-14 00:00:00+00'),
      ('ASSR/2609-015', 1, 'In Progress', 'Gone', NULL, 'KL WAREHOUSE', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'own', '2026-09-25', NULL, '2026-09-15 00:00:00+00', '2026-09-15 00:00:00+00'),
      -- Other company → excluded for company 1.
      ('ASSR/2609-016', 2, 'In Progress', 'OtherCo', NULL, 'KL WAREHOUSE', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, 'customer', '2026-09-21', NULL, NULL, NULL, NULL, '2026-09-16 00:00:00+00');
  `);
}

async function page(company: number, since: string, limit: number): Promise<AssrFeedRow[]> {
  return (await sql.unsafe(toPgPlaceholders(FEED_ASSR_LEGS_SQL), [company, since, limit] as never[])) as unknown as AssrFeedRow[];
}

describePg('HC Delivery sheet ASSR leg feed SQL — real Postgres', () => {
  beforeAll(async () => {
    sql = postgres(url, {
      max: 1,
      prepare: false,
      types: { bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number | string) => String(x) } },
    });
    await resetFixture(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  test('only open, own-team, dated cases of the company, oldest change first', async () => {
    const rows = await page(1, FEED_EPOCH, 10);
    // 012 (all supplier), 013 (no dates), 014 (closed), 015 (archived) are gone.
    expect(rows.map((r) => r.assr_no)).toEqual(['ASSR/2609-010', 'ASSR/2609-011']);
    expect(await page(2, FEED_EPOCH, 10)).toHaveLength(1);
  });

  test('the mapper expands the page into its legs', async () => {
    const rows = await page(1, FEED_EPOCH, 10);
    const legs = rows.flatMap(toAssrLegRecords);
    expect(legs.map((l) => l.DocNo)).toEqual([
      'ASSR/2609-010#INSPECT', 'ASSR/2609-010#PICKUP', 'ASSR/2609-010#DELIVERY',
      'ASSR/2609-011#PICKUP',
    ]);
    const del = legs.find((l) => l.Kind === 'DELIVERY')!;
    expect(del).toMatchObject({ TransferTo: 'HC-DO-2609-050', SalesExemptionExpiryDate: '2026-09-25', Region: 'WEST' });
  });

  test('the cursor is strict — a page never re-sends its own last case', async () => {
    const all = await page(1, FEED_EPOCH, 10);
    const last = all[all.length - 1]!.last_modified_text;
    expect(await page(1, last, 10)).toHaveLength(0);
    // A cursor between the two cases sends only the later one.
    expect((await page(1, all[0]!.last_modified_text, 10)).map((r) => r.assr_no)).toEqual(['ASSR/2609-011']);
  });

  test('limit pages by case', async () => {
    expect((await page(1, FEED_EPOCH, 1)).map((r) => r.assr_no)).toEqual(['ASSR/2609-010']);
  });
});
