import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types.
import { readFreezeTargets, freezeExemptionExpiry } from '../scripts/lib/hc0122-exemption-expiry-sql.mjs';

/* HC-0122 — repair-hc0122-exemption-expiry.mjs's SQL on a real postgres with
 * the SO status as the scm.mfg_so_status enum it is in production, and the
 * AutoCount mirror's expiry_date as the text column it is.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0122_exemption_expiry_repair';

const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  DROP TABLE IF EXISTS public.sales_orders;
  CREATE TYPE scm.mfg_so_status AS ENUM ('DRAFT','CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED','INVOICED','CLOSED','CANCELLED','ON_HOLD');
  CREATE TYPE scm.so_audit_action AS ENUM ('CREATE','UPDATE','UPDATE_DETAILS','UPDATE_STATUS');
  CREATE TABLE scm.mfg_sales_orders (
    doc_no text NOT NULL, company_id bigint NOT NULL, status scm.mfg_so_status NOT NULL,
    version integer NOT NULL DEFAULT 1, customer_delivery_date date, sales_exemption_expiry date,
    linked_ac_docno text, updated_at timestamptz
  );
  CREATE TABLE public.sales_orders (doc_no text PRIMARY KEY, company_id bigint NOT NULL, expiry_date text);
  CREATE TABLE scm.mfg_so_audit_log (
    id serial PRIMARY KEY, so_doc_no text NOT NULL, company_id bigint NOT NULL,
    action scm.so_audit_action NOT NULL, actor_name_snapshot text, field_changes jsonb,
    status_snapshot scm.mfg_so_status, source text, note text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

let admin: Sql;
let db: Sql;

function urlFor(name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/* The three ticket orders as production had them on 2026-10-19, plus the shapes
 * the repair must leave alone or source from AutoCount. */
async function seed(sql: Sql): Promise<void> {
  await sql`INSERT INTO scm.mfg_sales_orders (doc_no, company_id, status, customer_delivery_date, sales_exemption_expiry, linked_ac_docno) VALUES
    ('HC-SO-008230',     1, 'READY_TO_SHIP', '2026-10-23', NULL,         NULL),
    ('2990-SO-2608-053', 2, 'READY_TO_SHIP', '2026-10-30', NULL,         NULL),
    ('2990-SO-2608-040', 2, 'READY_TO_SHIP', '2026-10-30', NULL,         NULL),
    ('HC-SO-013100',     1, 'CONFIRMED',     '2026-11-05', NULL,         'SO-013100'),
    ('HC-SO-013101',     1, 'CONFIRMED',     '2026-11-05', NULL,         'SO-013101'),
    ('HC-SO-013200',     1, 'CONFIRMED',     '2026-11-20', '2026-10-25', NULL),
    ('HC-SO-013300',     1, 'DRAFT',         '2026-11-01', NULL,         NULL),
    ('HC-SO-013301',     1, 'CANCELLED',     '2026-11-01', NULL,         NULL),
    ('HC-SO-013302',     1, 'CONFIRMED',     NULL,         NULL,         NULL)`;
  await sql`INSERT INTO public.sales_orders (doc_no, company_id, expiry_date) VALUES
    ('SO-013100', 1, '2026-10-28'),
    ('SO-013101', 1, '')`;
}

const NOTE = 'HC-0122 test';

describePg('HC-0122 — freeze the Sales Exemption Expiry Date, on real enum columns', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('refusing a non-local TEST_DATABASE_URL');
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    db = postgres(urlFor(DB), { max: 1, prepare: false });
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.unsafe(FIXTURE);
    await seed(db);
  });

  test('targets only processed orders still NULL; AutoCount value first, else the delivery date', async () => {
    const rows = await readFreezeTargets(db, [1, 2]);
    expect(rows.map((r: { doc_no: string; freeze_to: string; source: string }) => [r.doc_no, r.freeze_to, r.source])).toEqual([
      ['HC-SO-008230', '2026-10-23', 'delivery_date'],
      ['HC-SO-013100', '2026-10-28', 'autocount'],
      ['HC-SO-013101', '2026-11-05', 'delivery_date'],
      ['2990-SO-2608-040', '2026-10-30', 'delivery_date'],
      ['2990-SO-2608-053', '2026-10-30', 'delivery_date'],
    ]);
  });

  test('apply freezes the column, writes one history row each, and leaves version / updated_at / delivery date alone', async () => {
    const targets = await readFreezeTargets(db, [1, 2]);
    const done = await db.begin((tx) => freezeExemptionExpiry(tx, targets, NOTE));
    expect(done).toHaveLength(5);
    const rows = await db`SELECT doc_no, sales_exemption_expiry::text AS e, customer_delivery_date::text AS d, version, updated_at FROM scm.mfg_sales_orders ORDER BY doc_no`;
    const by = Object.fromEntries(rows.map((r) => [r.doc_no, r]));
    expect(by['HC-SO-008230']).toMatchObject({ e: '2026-10-23', d: '2026-10-23', version: 1, updated_at: null });
    expect(by['2990-SO-2608-053']).toMatchObject({ e: '2026-10-30' });
    expect(by['HC-SO-013100']).toMatchObject({ e: '2026-10-28', d: '2026-11-05' });
    expect(by['HC-SO-013200']).toMatchObject({ e: '2026-10-25' });
    expect(by['HC-SO-013300']).toMatchObject({ e: null });
    expect(by['HC-SO-013301']).toMatchObject({ e: null });
    expect(by['HC-SO-013302']).toMatchObject({ e: null });
    const audits = await db`SELECT so_doc_no, company_id::int AS co, status_snapshot::text AS s, field_changes FROM scm.mfg_so_audit_log ORDER BY so_doc_no`;
    expect(audits).toHaveLength(5);
    expect(audits.find((a) => a.so_doc_no === '2990-SO-2608-040')).toMatchObject({
      co: 2, s: 'READY_TO_SHIP', field_changes: [{ field: 'sales_exemption_expiry', from: null, to: '2026-10-30', source: 'delivery_date' }],
    });
  });

  test('a value seeded since the read is never overwritten, and a re-run finds nothing', async () => {
    const targets = await readFreezeTargets(db, [1, 2]);
    await db`UPDATE scm.mfg_sales_orders SET sales_exemption_expiry = '2026-10-21' WHERE doc_no = 'HC-SO-008230'`;
    const done = await db.begin((tx) => freezeExemptionExpiry(tx, targets, NOTE));
    expect(done).not.toContain('HC-SO-008230');
    expect((await db`SELECT sales_exemption_expiry::text AS e FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-008230'`)[0]!.e).toBe('2026-10-21');
    expect(await readFreezeTargets(db, [1, 2])).toHaveLength(0);
  });
});
