import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { outstandingCommitments, type CommittedShipmentRow } from '../src/scm/lib/ship-commitment';
import { hardenSoPoLinks } from '../src/scm/lib/harden-so-po-link';
import { resolveExpectedBatchBySoItem } from '../src/scm/lib/dropship-batch';

/* END-TO-END PROOF of the ship-before-arrival binding, against real Postgres.
 *
 * The claim this suite has to settle is the whole point of the change: ship a
 * line short, bind it to its incoming PO, receive the GRN, and watch
 * scm.fn_reconcile_dropship_batch net the shipment and land the real cost on it.
 * Before mig 0230 that could only happen when delivery_orders.is_dropship was
 * TRUE — a HEADER flag that a plain "Ship anyway" never sets — which is why the
 * prod detector found 3 short OUTs and 0 claimable on 2026-07-30/31.
 *
 * It also proves the two NEGATIVES that make the widening safe:
 *   · an OUT carrying neither claim signal (the accidental short-ship 0088
 *     hardened against) still cannot steal the arriving lot;
 *   · fn_reconcile_uncosted_out (0154), which is batch-AGNOSTIC, now steps over
 *     a line-committed OUT — otherwise it would race the batched reconcile and
 *     cost a bound sofa from a different dye lot, the exact colour-mixing the
 *     binding exists to prevent.
 *
 * Finally it closes the loop with the MRP side: the SAME rows, fed through the
 * pure outstandingCommitments, stop being a commitment the moment the reconcile
 * consumes them. That is what makes the supply deduction impossible to
 * double-count — nothing has to be un-set.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function commitmentMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_ship_commitment_binding.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_ship_commitment_binding.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

const WH = '11111111-1111-1111-1111-111111111111';
const ACTOR = '22222222-2222-2222-2222-222222222222';
const CODE = 'TRION-(K)';
const VKEY = '';
const BATCH = '2990-PO-2607-009';

let admin: Sql;

/* The scm objects the two functions touch, cut to the columns they read/write.
 * delivery_order_items is created WITHOUT committed_po_batch_no on purpose: the
 * migration's ALTER has to be what puts it there, so a broken ALTER fails here
 * rather than in a deploy. */
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

    DROP TABLE IF EXISTS scm.purchase_order_items CASCADE;
    DROP TABLE IF EXISTS scm.purchase_orders CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_order_items CASCADE;
    DROP TABLE IF EXISTS scm.inventory_lot_consumptions CASCADE;
    DROP TABLE IF EXISTS scm.inventory_lots CASCADE;
    DROP TABLE IF EXISTS scm.inventory_movements CASCADE;
    DROP TABLE IF EXISTS scm.delivery_order_items CASCADE;
    DROP TABLE IF EXISTS scm.delivery_orders CASCADE;

    CREATE TABLE scm.delivery_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      do_number text,
      status text NOT NULL DEFAULT 'DISPATCHED',
      is_dropship boolean NOT NULL DEFAULT false
    );

    CREATE TABLE scm.delivery_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      delivery_order_id uuid REFERENCES scm.delivery_orders(id) ON DELETE CASCADE,
      item_code text,
      qty integer
    );

    CREATE TABLE scm.inventory_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_type text,
      warehouse_id uuid,
      product_code text,
      variant_key text,
      product_name text,
      qty integer,
      batch_no text,
      source_doc_type text,
      source_doc_id uuid,
      source_doc_no text,
      total_cost_sen integer DEFAULT 0,
      unit_cost_sen integer DEFAULT 0,
      performed_by uuid,
      company_id integer DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE scm.inventory_lots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id uuid,
      product_code text,
      variant_key text,
      qty_received integer,
      qty_remaining integer,
      unit_cost_sen integer,
      batch_no text,
      received_at timestamptz NOT NULL DEFAULT now(),
      movement_id uuid,
      company_id integer DEFAULT 1
    );

    CREATE TABLE scm.inventory_lot_consumptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lot_id uuid,
      warehouse_id uuid,
      product_code text,
      variant_key text,
      qty_consumed integer,
      unit_cost_sen integer,
      total_cost_sen integer,
      source_doc_type text,
      source_doc_id uuid,
      source_doc_no text,
      movement_id uuid,
      created_by uuid,
      company_id integer DEFAULT 1
    );

    -- The SO->PO side, so the SOFT-to-HARD step can be proven end to end.
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_no text,
      item_code text
    );
    -- Dates as text on purpose: PostgREST delivers a date column to the app as
    -- an ISO STRING, and dropship-batch.ts sorts them as strings. A real date
    -- column here would hand the module a JS Date the production client never
    -- gives it, and the fixture would be testing the driver, not the code.
    CREATE TABLE scm.purchase_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      po_number text,
      status text,
      expected_at text,
      supplier_delivery_date_2 text,
      supplier_delivery_date_3 text,
      supplier_delivery_date_4 text
    );
    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_order_id uuid REFERENCES scm.purchase_orders(id) ON DELETE CASCADE,
      material_code text,
      qty integer,
      received_qty integer DEFAULT 0,
      so_item_id uuid REFERENCES scm.mfg_sales_order_items(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await sql.unsafe(await commitmentMigrationSql());
}

/* A minimal PostgREST-shaped adapter over the real connection, carrying exactly
   the calls harden-so-po-link and dropship-batch make. The point is to drive
   BOTH modules unchanged against a real database — the soft-to-hard step and the
   resolver that reads its result are the two halves that have to agree. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pgRest(sql: Sql): any {
  const allowed = new Set(['purchase_orders', 'purchase_order_items']);
  return {
    from(table: string) {
      if (!allowed.has(table)) throw new Error(`unexpected table ${table}`);
      const where: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any[] = [];
      let patch: Record<string, string> | null = null;
      const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
      const run = async () => {
        const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        if (patch) {
          const sets = Object.keys(patch).map((k) => `${k} = ${p(patch![k])}::uuid`).join(', ');
          await sql.unsafe(`UPDATE scm.${table} SET ${sets} ${clause}`, params);
          return { data: null, error: null };
        }
        const data = await sql.unsafe(`SELECT * FROM scm.${table} ${clause}`, params);
        return { data, error: null };
      };
      const q = {
        select: () => q,
        update: (nextPatch: Record<string, string>) => { patch = nextPatch; return q; },
        // `::text` on both sides so one comparator serves uuid and text columns.
        in: (col: string, vals: unknown[]) => {
          where.push(`${col}::text = ANY(${p(vals.map(String))}::text[])`);
          return q;
        },
        eq: (col: string, val: unknown) => { where.push(`${col}::text = ${p(String(val))}`); return q; },
        is: (col: string, val: unknown) => {
          where.push(val === null ? `${col} IS NULL` : `${col} IS NOT NULL`);
          return run();
        },
        not: (col: string, _op: string, val: unknown) => {
          where.push(val === null ? `${col} IS NOT NULL` : `${col} IS NULL`);
          return q;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (res: any, rej: any) => run().then(res, rej),
      };
      return q;
    },
  };
}

type ShipOpts = { isDropship?: boolean; commitLine?: boolean; status?: string; qty?: number };

/** One "shipped before it arrived" DO: a negative OUT stamped with the incoming
 *  PO's batch, and (optionally) the per-line commitment marker mig 0230 adds. */
async function shipShort(sql: Sql, opts: ShipOpts = {}): Promise<{ doId: string; movId: string }> {
  const { isDropship = false, commitLine = true, status = 'DISPATCHED', qty = 1 } = opts;
  const [doRow] = await sql<Array<{ id: string }>>`
    insert into scm.delivery_orders (do_number, status, is_dropship)
    values ('2990-DO-2607-009', ${status}, ${isDropship}) returning id`;
  const doId = doRow!.id;
  await sql`
    insert into scm.delivery_order_items (delivery_order_id, item_code, qty, committed_po_batch_no)
    values (${doId}::uuid, ${CODE}, ${qty}, ${commitLine ? BATCH : null})`;
  const [mov] = await sql<Array<{ id: string }>>`
    insert into scm.inventory_movements
      (movement_type, warehouse_id, product_code, variant_key, qty, batch_no,
       source_doc_type, source_doc_id, source_doc_no, total_cost_sen, unit_cost_sen)
    values ('OUT', ${WH}::uuid, ${CODE}, ${VKEY}, ${qty}, ${BATCH},
            'DO', ${doId}::uuid, '2990-DO-2607-009', 0, 0)
    returning id`;
  return { doId, movId: mov!.id };
}

/** The GRN landing: one open lot for the batch, at its real landed cost. */
async function receive(sql: Sql, qty: number, unitCostSen: number): Promise<string> {
  const [lot] = await sql<Array<{ id: string }>>`
    insert into scm.inventory_lots
      (warehouse_id, product_code, variant_key, qty_received, qty_remaining, unit_cost_sen, batch_no)
    values (${WH}::uuid, ${CODE}, ${VKEY}, ${qty}, ${qty}, ${unitCostSen}, ${BATCH})
    returning id`;
  return lot!.id;
}

const reconcileBatch = (sql: Sql) => sql<Array<{ n: number }>>`
  select scm.fn_reconcile_dropship_batch(
    ${WH}::uuid, ${CODE}, ${VKEY}, ${BATCH}, ${ACTOR}::uuid) as n`;

const reconcileUncosted = (sql: Sql) => sql<Array<{ n: number }>>`
  select scm.fn_reconcile_uncosted_out(
    ${WH}::uuid, ${CODE}, ${VKEY}, now(), ${ACTOR}::uuid) as n`;

async function movementCost(sql: Sql, movId: string) {
  const [r] = await sql<Array<{ total_cost_sen: number; unit_cost_sen: number }>>`
    select total_cost_sen, unit_cost_sen from scm.inventory_movements where id = ${movId}::uuid`;
  return r!;
}

/** The MRP side, built from the same rows the route reads. */
async function commitmentsFromDb(sql: Sql): Promise<Map<string, number>> {
  const rows = await sql<Array<{
    bucket: string; batch_no: string; out_qty: number; consumed: number;
    status: string; is_dropship: boolean; line_committed: boolean;
  }>>`
    select (m.warehouse_id::text || '|' || m.product_code || '|' || coalesce(m.variant_key,'')) as bucket,
           m.batch_no,
           abs(m.qty) as out_qty,
           coalesce((select sum(c.qty_consumed) from scm.inventory_lot_consumptions c
                      where c.movement_id = m.id), 0) as consumed,
           d.status, d.is_dropship,
           exists (select 1 from scm.delivery_order_items di
                    where di.delivery_order_id = d.id
                      and di.committed_po_batch_no = m.batch_no
                      and di.item_code = m.product_code) as line_committed
      from scm.inventory_movements m
      join scm.delivery_orders d on d.id = m.source_doc_id
     where m.movement_type = 'OUT' and m.source_doc_type = 'DO' and m.batch_no is not null`;
  const model: CommittedShipmentRow[] = rows.map((r) => ({
    bucketKey: r.bucket,
    batchNo: r.batch_no,
    outQty: Number(r.out_qty),
    consumedQty: Number(r.consumed),
    cancelled: (r.status ?? '').toUpperCase() === 'CANCELLED',
    headerDropship: r.is_dropship === true,
    lineCommitted: r.line_committed === true,
  }));
  return outstandingCommitments(model);
}

describePg('ship-before-arrival binding (migrations-pg *_scm_ship_commitment_binding.sql)', () => {
  beforeAll(async () => { admin = postgres(url, { max: 4 }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetFixture(admin); });

  test('the ALTER actually lands the per-line marker column', async () => {
    const [col] = await admin<Array<{ data_type: string }>>`
      select data_type from information_schema.columns
       where table_schema = 'scm' and table_name = 'delivery_order_items'
         and column_name = 'committed_po_batch_no'`;
    expect(col?.data_type).toBe('text');
  });

  test('THE PREMISE: without either claim signal the reconcile skips the OUT forever', async () => {
    // Exactly the prod shape measured 2026-07-30/31: is_dropship = N, plain
    // "Ship anyway", nothing bound. It stays at RM0.
    const { movId } = await shipShort(admin, { isDropship: false, commitLine: false });
    await receive(admin, 3, 120_000);
    const [{ n }] = await reconcileBatch(admin);
    expect(Number(n)).toBe(0);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(0);
  });

  test('a LINE-committed plain ship-anyway nets on receipt and the real cost lands', async () => {
    const { movId } = await shipShort(admin, { isDropship: false, commitLine: true, qty: 2 });
    const lotId = await receive(admin, 3, 120_000);

    const [{ n }] = await reconcileBatch(admin);
    expect(Number(n)).toBe(2);

    const cost = await movementCost(admin, movId);
    expect(cost.total_cost_sen).toBe(240_000);
    expect(cost.unit_cost_sen).toBe(120_000);

    const [lot] = await admin<Array<{ qty_remaining: number }>>`
      select qty_remaining from scm.inventory_lots where id = ${lotId}::uuid`;
    expect(Number(lot!.qty_remaining)).toBe(1); // 3 received, 2 already shipped

    const [con] = await admin<Array<{ n: number; total: number }>>`
      select count(*)::int as n, coalesce(sum(total_cost_sen),0)::int as total
        from scm.inventory_lot_consumptions where movement_id = ${movId}::uuid`;
    expect(Number(con!.n)).toBe(1);
    expect(Number(con!.total)).toBe(240_000);
  });

  test('the legacy is_dropship header still claims (0088 behaviour preserved)', async () => {
    await shipShort(admin, { isDropship: true, commitLine: false });
    await receive(admin, 1, 99_000);
    const [{ n }] = await reconcileBatch(admin);
    expect(Number(n)).toBe(1);
  });

  test('a CANCELLED DO claims nothing, even with the marker set', async () => {
    await shipShort(admin, { commitLine: true, status: 'CANCELLED' });
    await receive(admin, 5, 100_000);
    const [{ n }] = await reconcileBatch(admin);
    expect(Number(n)).toBe(0);
  });

  test('idempotent — a second receipt of the same batch consumes nothing extra', async () => {
    const { movId } = await shipShort(admin, { commitLine: true });
    await receive(admin, 1, 100_000);
    expect(Number((await reconcileBatch(admin))[0]!.n)).toBe(1);
    await receive(admin, 4, 111_000);
    expect(Number((await reconcileBatch(admin))[0]!.n)).toBe(0);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(100_000);
  });

  test('MIXED DO — a committed line nets while an unrelated uncommitted OUT does not', async () => {
    const committed = await shipShort(admin, { commitLine: true });
    // A second DO in the same bucket that bound nothing (no PO to resolve).
    const plain = await shipShort(admin, { commitLine: false });
    await receive(admin, 5, 100_000);
    const [{ n }] = await reconcileBatch(admin);
    expect(Number(n)).toBe(1);
    expect((await movementCost(admin, committed.movId)).total_cost_sen).toBe(100_000);
    expect((await movementCost(admin, plain.movId)).total_cost_sen).toBe(0);
  });

  test('the batch-agnostic oversell retro-cost STEPS OVER a committed OUT', async () => {
    // Without this exclusion 0154 would cost the bound shipment from whatever lot
    // happens to be open — for a sofa, another dye lot. It must leave it to the
    // batched reconcile.
    const { movId } = await shipShort(admin, { commitLine: true });
    await admin`
      insert into scm.inventory_lots
        (warehouse_id, product_code, variant_key, qty_received, qty_remaining, unit_cost_sen, batch_no)
      values (${WH}::uuid, ${CODE}, ${VKEY}, 9, 9, 70_000, 'SOME-OTHER-PO')`;
    const [{ n }] = await reconcileUncosted(admin);
    expect(Number(n)).toBe(0);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(0);
  });

  test('an UNCOMMITTED short OUT is still repaired by the oversell retro-cost', async () => {
    // The 0154 path must keep working for everything this change does not bind.
    const { movId } = await shipShort(admin, { commitLine: false });
    await admin`
      insert into scm.inventory_lots
        (warehouse_id, product_code, variant_key, qty_received, qty_remaining, unit_cost_sen, batch_no)
      values (${WH}::uuid, ${CODE}, ${VKEY}, 9, 9, 70_000, 'SOME-OTHER-PO')`;
    const [{ n }] = await reconcileUncosted(admin);
    expect(Number(n)).toBe(1);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(70_000);
  });

  test('MRP: the deduction exists while the shipment is owed, and vanishes once it is netted', async () => {
    await shipShort(admin, { commitLine: true, qty: 2 });

    const before = await commitmentsFromDb(admin);
    expect([...before.values()]).toEqual([2]);

    await receive(admin, 3, 120_000);
    await reconcileBatch(admin);

    // The receipt netted it — the same ABS(qty) - consumed subtraction now reads
    // zero, so the MRP supply deduction disappears without anything being unset.
    expect((await commitmentsFromDb(admin)).size).toBe(0);
  });

  test('MRP: a cancelled DO never holds a deduction', async () => {
    await shipShort(admin, { commitLine: true, status: 'CANCELLED' });
    expect((await commitmentsFromDb(admin)).size).toBe(0);
  });

  /* ── the SOFT -> HARD step, which is the point of the change ─────────────── */

  test('THE PREMISE: a SOFT MRP match resolves NO batch — the resolver only reads hard links', async () => {
    // The PO exists, it is live, it orders exactly this SKU, and MRP would name
    // it. But nothing has written so_item_id, so resolveExpectedBatchBySoItem —
    // which walks purchase_order_items.so_item_id and nothing else — finds it
    // NOT. This is why "bind the matched PO on ship-anyway" was a no-op.
    const [so] = await admin<Array<{ id: string }>>`
      insert into scm.mfg_sales_order_items (doc_no, item_code)
      values ('2990-SO-2607-005', ${CODE}) returning id`;
    const [po] = await admin<Array<{ id: string }>>`
      insert into scm.purchase_orders (po_number, status, expected_at)
      values (${BATCH}, 'SUBMITTED', '2026-08-14') returning id`;
    await admin`
      insert into scm.purchase_order_items (purchase_order_id, material_code, qty, received_qty)
      values (${po!.id}::uuid, ${CODE}, 3, 0)`;

    const sb = pgRest(admin);
    expect((await resolveExpectedBatchBySoItem(sb, [so!.id], { onMultiPo: 'block' })).size).toBe(0);
  });

  test('hardening the soft match makes the UNCHANGED resolver return the PO, and the batch is the PO number', async () => {
    const [so] = await admin<Array<{ id: string }>>`
      insert into scm.mfg_sales_order_items (doc_no, item_code)
      values ('2990-SO-2607-005', ${CODE}) returning id`;
    const [po] = await admin<Array<{ id: string }>>`
      insert into scm.purchase_orders (po_number, status, expected_at, supplier_delivery_date_2)
      values (${BATCH}, 'SUBMITTED', '2026-08-14', '2026-08-20') returning id`;
    await admin`
      insert into scm.purchase_order_items (purchase_order_id, material_code, qty, received_qty)
      values (${po!.id}::uuid, ${CODE}, 3, 0)`;

    const sb = pgRest(admin);
    const outcomes = await hardenSoPoLinks(sb, [{ soItemId: so!.id, itemCode: CODE, poNumber: BATCH }]);
    expect(outcomes[0]).toMatchObject({ hardened: true, reason: 'hardened' });

    const [row] = await admin`
      select so_item_id from scm.purchase_order_items where purchase_order_id = ${po!.id}::uuid`;
    expect(row!.so_item_id).toBe(so!.id);

    const resolved = await resolveExpectedBatchBySoItem(sb, [so!.id], { onMultiPo: 'block' });
    // batch_no IS the PO number (dropship-batch.ts), and the ETA is the latest
    // revised supplier date, not the original.
    expect(resolved.get(so!.id)).toEqual({ poNumber: BATCH, eta: '2026-08-20' });
  });

  test('hardening never binds a CANCELLED PO, so the resolver still finds nothing', async () => {
    const [so] = await admin<Array<{ id: string }>>`
      insert into scm.mfg_sales_order_items (doc_no, item_code)
      values ('2990-SO-2607-005', ${CODE}) returning id`;
    const [po] = await admin<Array<{ id: string }>>`
      insert into scm.purchase_orders (po_number, status) values (${BATCH}, 'CANCELLED') returning id`;
    await admin`
      insert into scm.purchase_order_items (purchase_order_id, material_code, qty, received_qty)
      values (${po!.id}::uuid, ${CODE}, 3, 0)`;

    const sb = pgRest(admin);
    expect((await hardenSoPoLinks(sb, [{ soItemId: so!.id, itemCode: CODE, poNumber: BATCH }]))[0])
      .toMatchObject({ hardened: false, reason: 'po_not_live' });
    const [row] = await admin`select so_item_id from scm.purchase_order_items limit 1`;
    expect(row!.so_item_id).toBeNull();
    expect((await resolveExpectedBatchBySoItem(sb, [so!.id], { onMultiPo: 'block' })).size).toBe(0);
  });

  test("hardening never steals another Sales Order's PO line", async () => {
    const rows = await admin<Array<{ id: string }>>`
      insert into scm.mfg_sales_order_items (doc_no, item_code)
      values ('2990-SO-2607-005', ${CODE}), ('2990-SO-2607-006', ${CODE}) returning id`;
    const [mine, theirs] = [rows[0]!.id, rows[1]!.id];
    const [po] = await admin<Array<{ id: string }>>`
      insert into scm.purchase_orders (po_number, status) values (${BATCH}, 'SUBMITTED') returning id`;
    await admin`
      insert into scm.purchase_order_items (purchase_order_id, material_code, qty, received_qty, so_item_id)
      values (${po!.id}::uuid, ${CODE}, 3, 0, ${theirs}::uuid)`;

    const sb = pgRest(admin);
    expect((await hardenSoPoLinks(sb, [{ soItemId: mine, itemCode: CODE, poNumber: BATCH }]))[0])
      .toMatchObject({ hardened: false, reason: 'taken_by_other_so' });
    const [row] = await admin`select so_item_id from scm.purchase_order_items limit 1`;
    expect(row!.so_item_id).toBe(theirs); // untouched
  });

  test('THE WHOLE CHAIN: soft match -> hardened -> batched OUT -> GRN -> reconciled, cost lands', async () => {
    // 1. The state the owner describes: MRP has soft-allocated this PO to this
    //    SO line and both screens show it, but nothing is written.
    const [so] = await admin<Array<{ id: string }>>`
      insert into scm.mfg_sales_order_items (doc_no, item_code)
      values ('2990-SO-2607-005', ${CODE}) returning id`;
    const [po] = await admin<Array<{ id: string }>>`
      insert into scm.purchase_orders (po_number, status, expected_at)
      values (${BATCH}, 'SUBMITTED', '2026-08-14') returning id`;
    await admin`
      insert into scm.purchase_order_items (purchase_order_id, material_code, qty, received_qty)
      values (${po!.id}::uuid, ${CODE}, 3, 0)`;
    const sb = pgRest(admin);

    // 2. The SO becomes a DO with nothing on hand: the match turns HARD.
    await hardenSoPoLinks(sb, [{ soItemId: so!.id, itemCode: CODE, poNumber: BATCH }]);
    const resolved = await resolveExpectedBatchBySoItem(sb, [so!.id], { onMultiPo: 'block' });
    const batch = resolved.get(so!.id)?.poNumber;
    expect(batch).toBe(BATCH);

    // 3. Ship 2 short against THAT batch, with the per-line commitment marker.
    const { movId } = await shipShort(admin, { isDropship: false, commitLine: true, qty: 2 });

    // MRP owes 2 units against this PO from this moment on.
    expect([...(await commitmentsFromDb(admin)).values()]).toEqual([2]);

    // 4. The GRN lands under the same number and the reconcile nets it.
    const lotId = await receive(admin, 3, 120_000);
    expect(Number((await reconcileBatch(admin))[0]!.n)).toBe(2);

    const cost = await movementCost(admin, movId);
    expect(cost.total_cost_sen).toBe(240_000);
    expect(cost.unit_cost_sen).toBe(120_000);
    const [lot] = await admin<Array<{ qty_remaining: number }>>`
      select qty_remaining from scm.inventory_lots where id = ${lotId}::uuid`;
    expect(Number(lot!.qty_remaining)).toBe(1);

    // 5. And the MRP deduction retires itself — no second bite.
    expect((await commitmentsFromDb(admin)).size).toBe(0);
  });

  test('re-applying the migration is a no-op (idempotent file)', async () => {
    await admin.unsafe(await commitmentMigrationSql());
    const [{ n }] = await admin<Array<{ n: number }>>`
      select count(*)::int as n from pg_indexes
       where schemaname = 'scm' and indexname = 'idx_doi_committed_po_batch'`;
    expect(Number(n)).toBe(1);
  });
});
