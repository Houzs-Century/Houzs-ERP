import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types.
import { readConfirmShape, writeProcessingDate } from '../scripts/lib/hc0113-processing-date-sql.mjs';

/* HC-0113 — repair-hc0113-processing-date.mjs's SQL on a real postgres with
 * the SO status as the scm.mfg_so_status enum it is in production, so the
 * ::text comparisons are exercised (HC-0106 died on an enum compare no fake
 * client could show).
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0113_processing_date_repair';
const CO = 1;
const SO = 'HC-SO-2609-077';

const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.mfg_so_status AS ENUM ('DRAFT','CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED','INVOICED','CLOSED','CANCELLED','ON_HOLD');
  CREATE TYPE scm.so_audit_action AS ENUM ('CREATE','UPDATE','UPDATE_DETAILS','UPDATE_STATUS');
  CREATE TABLE scm.mfg_sales_orders (
    doc_no text NOT NULL, company_id bigint NOT NULL, status scm.mfg_so_status NOT NULL,
    version integer NOT NULL DEFAULT 1, processing_date date, customer_delivery_date date,
    updated_at timestamptz
  );
  CREATE TABLE scm.mfg_so_status_changes (
    id serial PRIMARY KEY, company_id bigint NOT NULL, doc_no text NOT NULL,
    from_status text, to_status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  );
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

/* Production on 2026-10-16: drafted 18/9, Mei Ting confirmed 13/10 17:14 MYT. */
async function seedProdShape(sql: Sql): Promise<void> {
  await sql`INSERT INTO scm.mfg_sales_orders (doc_no, company_id, status, version, processing_date, customer_delivery_date)
    VALUES (${SO}, ${CO}, 'CONFIRMED', 9, '2026-09-18', '2026-10-26'),
           ('HC-SO-2609-078', ${CO}, 'CONFIRMED', 2, '2026-09-18', '2026-10-26')`;
  await sql`INSERT INTO scm.mfg_so_status_changes (company_id, doc_no, from_status, to_status, created_at)
    VALUES (${CO}, ${SO}, 'DRAFT', 'CONFIRMED', '2026-10-13T09:14:00Z')`;
  await sql`INSERT INTO scm.mfg_so_audit_log (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, created_at)
    VALUES (${SO}, ${CO}, 'UPDATE_STATUS', 'Mei Ting', ${sql.json([{ field: 'status', from: 'DRAFT', to: 'CONFIRMED' }])}, 'CONFIRMED', '2026-10-13T09:14:00Z'),
           (${SO}, ${CO}, 'UPDATE_DETAILS', 'Mei Ting', ${sql.json([{ field: 'debtorName', from: 'a', to: 'b' }])}, 'DRAFT', '2026-09-18T08:43:00Z')`;
}

const write = (sql: Sql, from = '2026-09-18') =>
  sql.begin((tx) => writeProcessingDate(tx, { companyId: CO, docNo: SO, from, to: '2026-10-13', status: 'CONFIRMED', note: 'HC-0113 test' }));

describePg('HC-0113 — Processing Date to the confirm day, on real enum columns', () => {
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
    await seedProdShape(db);
  });

  test('the read finds the order and its one confirm day in MYT, from both records', async () => {
    const { so, changes, audits } = await readConfirmShape(db, CO, SO);
    expect(so).toMatchObject({ status: 'CONFIRMED', processing_date: '2026-09-18', customer_delivery_date: '2026-10-26' });
    expect(changes).toEqual([{ day: '2026-10-13', to_status: 'CONFIRMED' }]);
    expect(audits).toEqual([{ day: '2026-10-13', actor: 'Mei Ting' }]);
  });

  test('apply moves only HC-SO-2609-077, bumps its version, and writes one history row', async () => {
    expect(await write(db)).toBe(1);
    const rows = await db`SELECT doc_no, processing_date::text AS p, version, updated_at FROM scm.mfg_sales_orders ORDER BY doc_no`;
    expect(rows[0]).toMatchObject({ doc_no: SO, p: '2026-10-13', version: 10 });
    expect(rows[0]!.updated_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ doc_no: 'HC-SO-2609-078', p: '2026-09-18', version: 2, updated_at: null });
    const [audit] = await db`SELECT action::text AS action, field_changes, status_snapshot::text AS s FROM scm.mfg_so_audit_log WHERE action = 'UPDATE'`;
    expect(audit).toMatchObject({ action: 'UPDATE', s: 'CONFIRMED', field_changes: [{ field: 'processing_date', from: '2026-09-18', to: '2026-10-13' }] });
  });

  test('a second apply, or a date moved since, writes nothing', async () => {
    expect(await write(db)).toBe(1);
    expect(await write(db)).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM scm.mfg_so_audit_log WHERE action = 'UPDATE'`)[0]!.n).toBe(1);
    expect((await db`SELECT version FROM scm.mfg_sales_orders WHERE doc_no = ${SO}`)[0]!.version).toBe(10);
  });
});
