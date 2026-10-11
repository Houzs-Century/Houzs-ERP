import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* END-TO-END PROOF of the receipt ceiling, against real Postgres.
 *
 * The claim to settle: a PO line's received total is capped by the DATABASE, not
 * only by grns.ts's nine qty_exceeds_remaining 409s. That distinction is the
 * whole point — production's 65 over-received lines (73 excess units) were
 * written by cutover scripts that open their own postgres() connection and
 * UPDATE purchase_order_items directly, so not one line of the route code ran.
 *
 * The FIRST test is a NEGATIVE CONTROL and is the load-bearing one: it drops the
 * triggers, replays the exact production write, and asserts the bad state
 * LANDS. Without it, every "raises" assertion below could be passing for some
 * unrelated reason and nobody would know. The two tests together quote the same
 * number both ways — 2 received against an ordered 1 with the guards off, and a
 * refusal with them on.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function ceilingMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_receipt_ceiling.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_receipt_ceiling.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

const PO_LINE = '11111111-1111-1111-1111-111111111111';
const PO_LINE10 = '11111111-1111-1111-1111-101010101010';
const GRN_A = '33333333-3333-3333-3333-333333333333';
const GRN_B = '33333333-3333-3333-3333-444444444444';
const STAFF = '44444444-4444-4444-4444-444444444444';

let admin: Sql;

/* Only the referenced shapes, cut to the columns the migration touches. The
 * over_receipt_* columns are deliberately NOT created here: the migration's
 * ALTER has to be what puts them there, so a broken file fails HERE rather than
 * in a deploy. */
async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;

    DROP TABLE IF EXISTS scm.grn_items CASCADE;
    DROP TABLE IF EXISTS scm.grns CASCADE;
    DROP TABLE IF EXISTS scm.purchase_order_items CASCADE;

    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id bigint NOT NULL DEFAULT 1,
      material_code text,
      qty integer NOT NULL,
      received_qty integer NOT NULL DEFAULT 0,
      unit_price_centi integer NOT NULL DEFAULT 0
    );

    CREATE TABLE scm.grns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id bigint NOT NULL DEFAULT 1,
      grn_number text,
      status text NOT NULL DEFAULT 'DRAFT',
      migrated_no_stock boolean NOT NULL DEFAULT false
    );

    CREATE TABLE scm.grn_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id bigint NOT NULL DEFAULT 1,
      grn_id uuid NOT NULL REFERENCES scm.grns(id) ON DELETE CASCADE,
      purchase_order_item_id uuid REFERENCES scm.purchase_order_items(id) ON DELETE SET NULL,
      qty_received integer NOT NULL DEFAULT 0,
      qty_accepted integer NOT NULL DEFAULT 0,
      qty_rejected integer NOT NULL DEFAULT 0,
      returned_qty integer NOT NULL DEFAULT 0,
      line_total_centi bigint NOT NULL DEFAULT 0
    );

    -- HC-PO-009018's shape: ordered 1. And a qty-10 line for batch receiving.
    INSERT INTO scm.purchase_order_items (id, material_code, qty) VALUES
      ('${PO_LINE}',   '9028-1A(RHF)', 1),
      ('${PO_LINE10}', 'BATCH-10',    10);

    INSERT INTO scm.grns (id, grn_number, status, migrated_no_stock) VALUES
      ('${GRN_A}', 'HC-GR-004913', 'POSTED', true),
      ('${GRN_B}', 'HC-GR-000002', 'POSTED', false);
  `);

  await sql.unsafe(await ceilingMigrationSql());
}

/** The receipt the cutover script made: one GRN posting 2 against a line that ordered 1. */
const postReceipt = (sql: Sql, line: string, grn: string, accepted: number) =>
  sql`
    INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_received, qty_accepted)
    VALUES (${grn}::uuid, ${line}::uuid, ${accepted}, ${accepted})
  `;

describePg('receipt ceiling (mig *_scm_receipt_ceiling) against real Postgres', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 4, onnotice: () => {} });
  });
  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await resetFixture(admin);
  });

  test('NEGATIVE CONTROL — with the guards dropped, the production bug lands exactly as it did', async () => {
    await admin.unsafe(`
      DROP TRIGGER IF EXISTS trg_po_item_received_guard ON scm.purchase_order_items;
      DROP TRIGGER IF EXISTS trg_grn_item_receipt_guard ON scm.grn_items;
    `);

    // The importer's write: received_qty := the group rollup, straight onto the line.
    await admin`UPDATE scm.purchase_order_items SET received_qty = 2 WHERE id = ${PO_LINE}::uuid`;
    // create-migrated-documents mirroring it into the GRN.
    await postReceipt(admin, PO_LINE, GRN_A, 2);

    const [row] = await admin`
      SELECT qty, received_qty FROM scm.purchase_order_items WHERE id = ${PO_LINE}::uuid
    `;
    // This is the defect, reproduced: ordered 1, received 2.
    expect(row!.qty).toBe(1);
    expect(row!.received_qty).toBe(2);

    const [g] = await admin`
      SELECT qty_accepted FROM scm.grn_items WHERE purchase_order_item_id = ${PO_LINE}::uuid
    `;
    expect(g!.qty_accepted).toBe(2);
  });

  test('WITH the guards, the identical importer write is refused', async () => {
    await expect(
      admin`UPDATE scm.purchase_order_items SET received_qty = 2 WHERE id = ${PO_LINE}::uuid`,
    ).rejects.toThrow(/receipt_exceeds_ordered_qty/);

    const [row] = await admin`
      SELECT qty, received_qty FROM scm.purchase_order_items WHERE id = ${PO_LINE}::uuid
    `;
    expect(row!.qty).toBe(1);
    expect(row!.received_qty).toBe(0); // unchanged — ordered 1, received 0
  });

  test('WITH the guards, the mirrored GRN line is refused too', async () => {
    await expect(postReceipt(admin, PO_LINE, GRN_A, 2)).rejects.toThrow(/receipt_exceeds_ordered_qty/);
  });

  test('a migrated_no_stock GRN is NOT exempt — it is the population that broke', async () => {
    const [g] = await admin`SELECT migrated_no_stock FROM scm.grns WHERE id = ${GRN_A}::uuid`;
    expect(g!.migrated_no_stock).toBe(true);
    await expect(postReceipt(admin, PO_LINE, GRN_A, 2)).rejects.toThrow(/receipt_exceeds_ordered_qty/);
  });

  test('BATCH RECEIVING is untouched: 2 + 3 + 5 against a qty-10 line all pass, the 11th unit fails', async () => {
    await postReceipt(admin, PO_LINE10, GRN_A, 2);
    await postReceipt(admin, PO_LINE10, GRN_A, 3);
    await postReceipt(admin, PO_LINE10, GRN_B, 5);
    const [{ total }] = await admin`
      SELECT SUM(qty_accepted)::int AS total FROM scm.grn_items
       WHERE purchase_order_item_id = ${PO_LINE10}::uuid
    `;
    expect(total).toBe(10); // the cap is on the TOTAL, never on one receipt

    await expect(postReceipt(admin, PO_LINE10, GRN_B, 1)).rejects.toThrow(
      /receipt_exceeds_ordered_qty/,
    );
  });

  test('an over-receipt STAGED in a draft cannot survive being posted', async () => {
    // A DRAFT commits no receipt, so staging it is allowed...
    await admin`UPDATE scm.grns SET status = 'DRAFT' WHERE id = ${GRN_B}::uuid`;
    await postReceipt(admin, PO_LINE, GRN_B, 5);

    // ...but the transition that makes it real is refused. Without guard 3 this
    // would slip through: posting writes no row to grn_items at all.
    await expect(
      admin`UPDATE scm.grns SET status = 'POSTED' WHERE id = ${GRN_B}::uuid`,
    ).rejects.toThrow(/receipt_exceeds_ordered_qty/);
  });

  test('a CANCELLED GRN frees the line again', async () => {
    await postReceipt(admin, PO_LINE, GRN_A, 1);
    await expect(postReceipt(admin, PO_LINE, GRN_B, 1)).rejects.toThrow(
      /receipt_exceeds_ordered_qty/,
    );
    await admin`UPDATE scm.grns SET status = 'CANCELLED' WHERE id = ${GRN_A}::uuid`;
    await expect(postReceipt(admin, PO_LINE, GRN_B, 1)).resolves.toBeDefined();
  });

  test('a return nets out, so a replacement shipment is receivable', async () => {
    await postReceipt(admin, PO_LINE10, GRN_A, 10);
    await expect(postReceipt(admin, PO_LINE10, GRN_B, 2)).rejects.toThrow(
      /receipt_exceeds_ordered_qty/,
    );
    // Send 2 back to the supplier; the line re-opens for exactly 2.
    await admin`
      UPDATE scm.grn_items SET returned_qty = 2
       WHERE grn_id = ${GRN_A}::uuid AND purchase_order_item_id = ${PO_LINE10}::uuid
    `;
    await expect(postReceipt(admin, PO_LINE10, GRN_B, 2)).resolves.toBeDefined();
  });

  describe('a genuine supplier over-shipment is allowed — explicitly, and recorded', () => {
    test('headroom cannot be granted without a reason and an author', async () => {
      await expect(
        admin`
          UPDATE scm.purchase_order_items SET over_receipt_allowed_qty = 1
           WHERE id = ${PO_LINE}::uuid
        `,
      ).rejects.toThrow(/po_item_over_receipt_attributed/);

      // A reason with no author is still not attributable.
      await expect(
        admin`
          UPDATE scm.purchase_order_items
             SET over_receipt_allowed_qty = 1, over_receipt_reason = 'supplier over-shipped'
           WHERE id = ${PO_LINE}::uuid
        `,
      ).rejects.toThrow(/po_item_over_receipt_attributed/);

      // ...and neither is an empty reason.
      await expect(
        admin`
          UPDATE scm.purchase_order_items
             SET over_receipt_allowed_qty = 1, over_receipt_reason = '   ',
                 over_receipt_by = ${STAFF}::uuid
           WHERE id = ${PO_LINE}::uuid
        `,
      ).rejects.toThrow(/po_item_over_receipt_attributed/);
    });

    test('granted headroom lets the receipt through, and only up to the granted amount', async () => {
      await admin`
        UPDATE scm.purchase_order_items
           SET over_receipt_allowed_qty = 1,
               over_receipt_reason = 'supplier shipped a spare stool, owner accepted',
               over_receipt_by = ${STAFF}::uuid,
               over_receipt_at = now()
         WHERE id = ${PO_LINE}::uuid
      `;
      // Ordered 1 + 1 granted = 2 receivable.
      await expect(postReceipt(admin, PO_LINE, GRN_A, 2)).resolves.toBeDefined();
      // The third unit is still refused — headroom is a number, not a waiver.
      await expect(postReceipt(admin, PO_LINE, GRN_B, 1)).rejects.toThrow(
        /receipt_exceeds_ordered_qty/,
      );
    });

    test('the grant is attributable after the fact', async () => {
      await admin`
        UPDATE scm.purchase_order_items
           SET over_receipt_allowed_qty = 1,
               over_receipt_reason = 'supplier shipped a spare stool, owner accepted',
               over_receipt_by = ${STAFF}::uuid,
               over_receipt_at = now()
         WHERE id = ${PO_LINE}::uuid
      `;
      const [r] = await admin`
        SELECT over_receipt_allowed_qty AS q, over_receipt_reason AS reason,
               over_receipt_by AS staff, over_receipt_at IS NOT NULL AS stamped
          FROM scm.purchase_order_items WHERE id = ${PO_LINE}::uuid
      `;
      expect(r!.q).toBe(1);
      expect(r!.reason).toMatch(/spare stool/);
      expect(r!.staff).toBe(STAFF);
      expect(r!.stamped).toBe(true);
    });
  });

  test('the REPAIR direction is allowed: a legacy violating row can be brought back down', async () => {
    // Recreate a legacy row the way it exists in production today, guards off...
    await admin.unsafe(`
      ALTER TABLE scm.purchase_order_items DISABLE TRIGGER trg_po_item_received_guard;
      ALTER TABLE scm.grn_items DISABLE TRIGGER trg_grn_item_receipt_guard;
    `);
    await admin`UPDATE scm.purchase_order_items SET received_qty = 2 WHERE id = ${PO_LINE}::uuid`;
    await postReceipt(admin, PO_LINE, GRN_A, 2);
    await admin.unsafe(`
      ALTER TABLE scm.purchase_order_items ENABLE TRIGGER trg_po_item_received_guard;
      ALTER TABLE scm.grn_items ENABLE TRIGGER trg_grn_item_receipt_guard;
    `);

    // ...then repair it in the order the repair script uses. Both writes move
    // DOWNWARD, so neither trips the guards.
    await admin`
      UPDATE scm.grn_items SET qty_accepted = 1, qty_received = 1
       WHERE purchase_order_item_id = ${PO_LINE}::uuid
    `;
    await admin`
      UPDATE scm.purchase_order_items SET received_qty = 1 WHERE id = ${PO_LINE}::uuid
    `;
    const [row] = await admin`
      SELECT qty, received_qty FROM scm.purchase_order_items WHERE id = ${PO_LINE}::uuid
    `;
    expect([row!.qty, row!.received_qty]).toEqual([1, 1]);
  });

  test('the migration is idempotent — applying it twice changes nothing and fails nothing', async () => {
    await admin.unsafe(await ceilingMigrationSql());
    await expect(postReceipt(admin, PO_LINE, GRN_A, 2)).rejects.toThrow(
      /receipt_exceeds_ordered_qty/,
    );
  });
});
