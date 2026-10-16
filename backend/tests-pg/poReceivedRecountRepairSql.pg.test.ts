import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types.
import { planPoStatuses, planStaleReceived } from '../scripts/lib/po-received-recount.mjs';
// @ts-expect-error — plain .mjs helper, no types.
import { readPoLines, readStaleState, writeRepair } from '../scripts/lib/po-received-recount-sql.mjs';

/* HC-0106 — repair-hc0106-stale-po-received.mjs's SQL on a real postgres:16
 * with the status columns as ENUMS, as they are in production. The first prod
 * apply died before writing on `COALESCE(g.status, '')`: '' is not a
 * scm.grn_status label, which no fake client could have shown.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0106_po_received_repair';
const CO = 1;

const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TYPE scm.grn_status AS ENUM ('DRAFT','POSTED','CLOSED','CANCELLED','ON_HOLD');
  CREATE TYPE scm.po_status AS ENUM ('DRAFT','SUBMITTED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED','ON_HOLD');
  CREATE TABLE scm.mfg_sales_order_items (id uuid PRIMARY KEY, doc_no text NOT NULL, stock_status text);
  CREATE TABLE scm.purchase_orders (
    id uuid PRIMARY KEY, po_number text NOT NULL, company_id bigint NOT NULL,
    status scm.po_status NOT NULL DEFAULT 'SUBMITTED', linked_ac_docno text,
    received_at timestamptz, updated_at timestamptz
  );
  CREATE TABLE scm.purchase_order_items (
    id uuid PRIMARY KEY, purchase_order_id uuid NOT NULL REFERENCES scm.purchase_orders(id),
    item_code text NOT NULL, qty numeric NOT NULL, received_qty numeric, so_item_id uuid
  );
  CREATE TABLE scm.grns (id uuid PRIMARY KEY, grn_number text NOT NULL, status scm.grn_status NOT NULL);
  CREATE TABLE scm.grn_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), grn_id uuid NOT NULL REFERENCES scm.grns(id),
    purchase_order_item_id uuid, qty_accepted numeric NOT NULL, returned_qty numeric NOT NULL DEFAULT 0
  );
  CREATE TABLE scm.stock_allocation_recompute_queue (
    job_key text PRIMARY KEY, request_token uuid, requested_at timestamptz, reason text
  );
`;

const PO_263 = '00000000-0000-0000-0000-0000000002a1';
const PO_263_K = '00000000-0000-0000-0000-0000000002b1';
const PO_263_Q = '00000000-0000-0000-0000-0000000002b2';
const PO_AC = '00000000-0000-0000-0000-0000000010a1';
const PO_AC_LINE = '00000000-0000-0000-0000-0000000010b1';
const SO_K = '00000000-0000-0000-0000-0000000003c1';
const GRN_002 = '00000000-0000-0000-0000-0000000004d1';
const GRN_048 = '00000000-0000-0000-0000-0000000004d2';
const GRN_AC = '00000000-0000-0000-0000-0000000004d3';

let admin: Sql;
let db: Sql;

function urlFor(name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/* The two production shapes of 2026-10-15: HC-PO-2609-263 (no AutoCount link,
 * its only GRN cancelled) and HC-PO-010080 (AutoCount cutover, a cancelled
 * ERP GRN beside the migrated receipt). */
async function seedProdShape(sql: Sql): Promise<void> {
  await sql`INSERT INTO scm.mfg_sales_order_items (id, doc_no, stock_status) VALUES (${SO_K}, 'HC-SO-2609-164', 'READY')`;
  await sql`INSERT INTO scm.purchase_orders (id, po_number, company_id, status, linked_ac_docno) VALUES
    (${PO_263}, 'HC-PO-2609-263', ${CO}, 'PARTIALLY_RECEIVED', NULL),
    (${PO_AC}, 'HC-PO-010080', ${CO}, 'RECEIVED', 'PO-010080')`;
  await sql`INSERT INTO scm.purchase_order_items (id, purchase_order_id, item_code, qty, received_qty, so_item_id) VALUES
    (${PO_263_K}, ${PO_263}, 'ELEPHANE-(K)', 1, 1, ${SO_K}),
    (${PO_263_Q}, ${PO_263}, 'ELEPHANE-(Q)', 2, 0, NULL),
    (${PO_AC_LINE}, ${PO_AC}, '9058-2S', 1, 1, NULL)`;
  await sql`INSERT INTO scm.grns (id, grn_number, status) VALUES
    (${GRN_002}, 'HC-GRN-2610-002', 'CANCELLED'),
    (${GRN_048}, 'HC-GRN-2610-048', 'CANCELLED'),
    (${GRN_AC}, 'HC-GRN-MIGRATED', 'POSTED')`;
  await sql`INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted) VALUES
    (${GRN_002}, ${PO_263_K}, 1), (${GRN_048}, ${PO_AC_LINE}, 1)`;
}

async function runRepair(sql: Sql) {
  const { poLines, grnLines } = await readStaleState(sql, CO);
  const fixes = planStaleReceived(poLines, grnLines);
  const poIds = [...new Set(fixes.map((f: { poId: string }) => f.poId))];
  const poPlan = planPoStatuses(fixes, await readPoLines(sql, CO, poIds));
  await sql.begin((tx) => writeRepair(tx, CO, fixes, poPlan, '00000000-0000-4000-8000-000000000106', 'HC-0106 test'));
  return { fixes, poPlan };
}

describePg('HC-0106 — cancelled-GRN PO recount repair, on real enum columns', () => {
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

  test('the read finds both PO lines with a cancelled GRN and the bound SO line', async () => {
    const { poLines, grnLines } = await readStaleState(db, CO);
    expect(poLines.map((p: { poNumber: string }) => p.poNumber).sort()).toEqual(['HC-PO-010080', 'HC-PO-2609-263']);
    expect(poLines.find((p: { itemCode: string }) => p.itemCode === 'ELEPHANE-(K)'))
      .toMatchObject({ poStatus: 'PARTIALLY_RECEIVED', soDocNo: 'HC-SO-2609-164', soStockStatus: 'READY', receivedQty: 1 });
    expect(grnLines).toHaveLength(2);
  });

  test('apply takes ELEPHANE-(K) back to 0, the PO back to SUBMITTED, and requests the re-walk', async () => {
    const { fixes, poPlan } = await runRepair(db);
    expect(fixes.map((f: { itemCode: string }) => f.itemCode)).toEqual(['ELEPHANE-(K)']);
    expect(poPlan).toEqual([{ poId: PO_263, from: 'PARTIALLY_RECEIVED', to: 'SUBMITTED', fully: false }]);

    const lines = await db`SELECT id::text, received_qty::float8 AS r FROM scm.purchase_order_items ORDER BY id`;
    expect(Object.fromEntries(lines.map((l) => [l.id, l.r]))).toEqual({ [PO_263_K]: 0, [PO_263_Q]: 0, [PO_AC_LINE]: 1 });
    const pos = await db`SELECT po_number, status::text AS s, received_at FROM scm.purchase_orders ORDER BY po_number`;
    expect(pos.map((p) => [p.po_number, p.s, p.received_at])).toEqual([
      ['HC-PO-010080', 'RECEIVED', null],
      ['HC-PO-2609-263', 'SUBMITTED', null],
    ]);
    const [q] = await db`SELECT request_token::text AS t, reason FROM scm.stock_allocation_recompute_queue WHERE job_key = 'GLOBAL'`;
    expect(q).toEqual({ t: '00000000-0000-4000-8000-000000000106', reason: 'HC-0106 test' });
  });

  test('a second run selects nothing', async () => {
    await runRepair(db);
    const { poLines, grnLines } = await readStaleState(db, CO);
    expect(planStaleReceived(poLines, grnLines)).toEqual([]);
  });

  test('a line that moved after the read rolls the whole write back', async () => {
    const { poLines, grnLines } = await readStaleState(db, CO);
    const fixes = planStaleReceived(poLines, grnLines);
    const poPlan = planPoStatuses(fixes, await readPoLines(db, CO, [PO_263]));
    await db`UPDATE scm.purchase_order_items SET received_qty = 0 WHERE id = ${PO_263_K}`;
    await expect(db.begin((tx) => writeRepair(tx, CO, fixes, poPlan, '00000000-0000-4000-8000-000000000107', 'x')))
      .rejects.toThrow(/changed since it was read/);
    const [po] = await db`SELECT status::text AS s FROM scm.purchase_orders WHERE id = ${PO_263}`;
    expect(po!.s).toBe('PARTIALLY_RECEIVED');
    const q = await db`SELECT 1 FROM scm.stock_allocation_recompute_queue`;
    expect(q).toHaveLength(0);
  });

  test('another company is not read', async () => {
    const { poLines } = await readStaleState(db, 2);
    expect(poLines).toEqual([]);
  });
});
