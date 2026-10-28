import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { outstandingCommitments, type CommittedShipmentRow } from '../src/scm/lib/ship-commitment';

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
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replace(/\bproduct_code\b/g, 'item_code').replace(/\bmaterial_code\b/g, 'item_code');
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
      -- committed_po_batch_no / committed_variant_key / committed_batch_strict
      -- are deliberately absent: the migration's ALTERs have to be what put them
      -- there, so a broken ALTER fails HERE rather than in a deploy.
    );

    CREATE TABLE scm.inventory_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      movement_type text,
      warehouse_id uuid,
      item_code text,
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
      item_code text,
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
      item_code text,
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
  `);

  await sql.unsafe(await commitmentMigrationSql());
}

type ShipOpts = {
  isDropship?: boolean; commitLine?: boolean; status?: string; qty?: number;
  /** mig 0230 - is the committed batch a DYE LOT? Sofa TRUE, mattress FALSE.
   *  This is the ONLY thing that keeps the batch-agnostic retro-cost off the
   *  OUT, so it is what the FIX-1 cases below turn on and off. */
  strict?: boolean;
  /** The bucket the commitment was made in; must match the movement's. */
  variantKey?: string;
  movVariantKey?: string;
};

/** One "shipped before it arrived" DO: a negative OUT stamped with the incoming
 *  PO's batch, and (optionally) the per-line commitment marker mig 0230 adds. */
async function shipShort(sql: Sql, opts: ShipOpts = {}): Promise<{ doId: string; movId: string }> {
  const {
    isDropship = false, commitLine = true, status = 'DISPATCHED', qty = 1,
    strict = true, variantKey = VKEY, movVariantKey = variantKey,
  } = opts;
  const [doRow] = await sql<Array<{ id: string }>>`
    insert into scm.delivery_orders (do_number, status, is_dropship)
    values ('2990-DO-2607-009', ${status}, ${isDropship}) returning id`;
  const doId = doRow!.id;
  await sql`
    insert into scm.delivery_order_items
      (delivery_order_id, item_code, qty, committed_po_batch_no, committed_variant_key, committed_batch_strict)
    values (${doId}::uuid, ${CODE}, ${qty}, ${commitLine ? BATCH : null},
            ${commitLine ? variantKey : null}, ${commitLine ? strict : false})`;
  const [mov] = await sql<Array<{ id: string }>>`
    insert into scm.inventory_movements
      (movement_type, warehouse_id, item_code, variant_key, qty, batch_no,
       source_doc_type, source_doc_id, source_doc_no, total_cost_sen, unit_cost_sen)
    values ('OUT', ${WH}::uuid, ${CODE}, ${movVariantKey}, ${qty}, ${BATCH},
            'DO', ${doId}::uuid, '2990-DO-2607-009', 0, 0)
    returning id`;
  return { doId, movId: mov!.id };
}

/** The GRN landing: one open lot for the batch, at its real landed cost. */
async function receive(sql: Sql, qty: number, unitCostSen: number): Promise<string> {
  const [lot] = await sql<Array<{ id: string }>>`
    insert into scm.inventory_lots
      (warehouse_id, item_code, variant_key, qty_received, qty_remaining, unit_cost_sen, batch_no)
    values (${WH}::uuid, ${CODE}, ${VKEY}, ${qty}, ${qty}, ${unitCostSen}, ${BATCH})
    returning id`;
  return lot!.id;
}

const reconcileBatch = (sql: Sql, variantKey = VKEY) => sql<Array<{ n: number }>>`
  select scm.fn_reconcile_dropship_batch(
    ${WH}::uuid, ${CODE}, ${variantKey}, ${BATCH}, ${ACTOR}::uuid) as n`;

const reconcileUncosted = (sql: Sql, variantKey = VKEY) => sql<Array<{ n: number }>>`
  select scm.fn_reconcile_uncosted_out(
    ${WH}::uuid, ${CODE}, ${variantKey}, now(), ${ACTOR}::uuid) as n`;

/** Any UNRELATED stock landing in the bucket: an inter-warehouse transfer, a
 *  positive stock take, or the GRN of a re-raised PO. Deliberately NOT the
 *  committed batch - that is exactly what the FIX-1 cases turn on. */
const receiveUnrelated = (sql: Sql, qty: number, unitCostSen: number, variantKey = VKEY) => sql`
  insert into scm.inventory_lots
    (warehouse_id, item_code, variant_key, qty_received, qty_remaining, unit_cost_sen, batch_no)
  values (${WH}::uuid, ${CODE}, ${variantKey}, ${qty}, ${qty}, ${unitCostSen}, 'SOME-OTHER-PO')`;

async function movementCost(sql: Sql, movId: string) {
  const [r] = await sql<Array<{ total_cost_sen: number; unit_cost_sen: number }>>`
    select total_cost_sen, unit_cost_sen from scm.inventory_movements where id = ${movId}::uuid`;
  return r!;
}

/** The MRP side, built from the same rows the route reads. */
async function commitmentsFromDb(sql: Sql): Promise<Map<string, number>> {
  const rows = await sql<Array<{
    bucket: string; batch_no: string; warehouse_id: string; item_code: string;
    variant_key: string; out_qty: number; consumed: number;
    status: string; is_dropship: boolean; line_committed: boolean;
  }>>`
    select (m.warehouse_id::text || '|' || m.item_code || '|' || coalesce(m.variant_key,'')) as bucket,
           m.batch_no, m.warehouse_id, m.item_code, coalesce(m.variant_key,'') as variant_key,
           abs(m.qty) as out_qty,
           coalesce((select sum(c.qty_consumed) from scm.inventory_lot_consumptions c
                      where c.movement_id = m.id), 0) as consumed,
           d.status, d.is_dropship,
           exists (select 1 from scm.delivery_order_items di
                    where di.delivery_order_id = d.id
                      and di.committed_po_batch_no = m.batch_no
                      and di.item_code = m.item_code
                      and coalesce(di.committed_variant_key,'') = coalesce(m.variant_key,'')) as line_committed
      from scm.inventory_movements m
      join scm.delivery_orders d on d.id = m.source_doc_id
     where m.movement_type = 'OUT' and m.source_doc_type = 'DO' and m.batch_no is not null`;
  const model: CommittedShipmentRow[] = rows.map((r) => ({
    bucketKey: r.bucket,
    warehouseId: r.warehouse_id,
    itemCode: r.item_code,
    variantKey: r.variant_key,
    batchNo: r.batch_no,
    outQty: Number(r.out_qty),
    consumedQty: Number(r.consumed),
    cancelled: (r.status ?? '').toUpperCase() === 'CANCELLED',
    headerDropship: r.is_dropship === true,
    lineCommitted: r.line_committed === true,
  }));
  return new Map([...outstandingCommitments(model)].map(([k, v]) => [k, v.qty]));
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

  test('the batch-agnostic retro-cost STEPS OVER a STRICT (sofa) committed OUT', async () => {
    // Without this exclusion 0154 would cost the bound shipment from whatever lot
    // happens to be open — for a sofa, another dye lot. It must leave it to the
    // batched reconcile.
    const { movId } = await shipShort(admin, { commitLine: true, strict: true });
    await receiveUnrelated(admin, 9, 70_000);
    const [{ n }] = await reconcileUncosted(admin);
    expect(Number(n)).toBe(0);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(0);
  });

  test('an UNCOMMITTED short OUT is still repaired by the oversell retro-cost', async () => {
    // The 0154 path must keep working for everything this change does not bind.
    const { movId } = await shipShort(admin, { commitLine: false });
    await receiveUnrelated(admin, 9, 70_000);
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

  /* ── FIX 1 — BINDING A NON-SOFA MUST NOT STRAND ITS COGS ──────────────────
     The regression this suite exists to rule out. 0230 first excluded EVERY
     line-committed OUT from fn_reconcile_uncosted_out, on the argument that
     "costing them from an arbitrary dye lot is exactly the colour-mixing batch
     binding exists to prevent". That argument is about SOFA. A mattress has no
     dye lot, and the exclusion turned a repairable RM0 into a permanent one.

     The scenario, end to end: MAT-X, nothing on hand, one live PO-500. Ship 5
     anyway -> the OUT is stamped PO-500. Then PO-500 dies — cancelled, or the
     supplier re-ships under a re-raised number, or the goods arrive by
     inter-warehouse transfer or a stock take. No lot for PO-500 ever exists, so
     fn_reconcile_dropship_batch can never fire for it. On main that OUT was
     un-batched and ANY later stock-IN repaired it. It must still be repaired. */
  test('FIX 1: a NON-STRICT (mattress) committed OUT is repaired by later unrelated stock, even though its PO never arrives', async () => {
    const { movId } = await shipShort(admin, { commitLine: true, strict: false, qty: 5 });

    // The bound PO is dead: no lot under BATCH will ever open. Prove the batched
    // reconcile is genuinely a dead end for this OUT before relying on the other.
    expect(Number((await reconcileBatch(admin))[0]!.n)).toBe(0);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(0);

    // Something unrelated replenishes the shelf.
    await receiveUnrelated(admin, 5, 70_000);

    const [{ n }] = await reconcileUncosted(admin);
    expect(Number(n)).toBe(5);
    const cost = await movementCost(admin, movId);
    expect(cost.total_cost_sen).toBe(350_000);
    expect(cost.unit_cost_sen).toBe(70_000);
  });

  test('FIX 1: the SAME shipment marked STRICT is left at RM0 — the flag is the whole difference', async () => {
    // Identical rows, one field apart. If this ever starts costing, the dye-lot
    // protection is gone; if the case above ever stops, the mattress is stranded.
    const { movId } = await shipShort(admin, { commitLine: true, strict: true, qty: 5 });
    await receiveUnrelated(admin, 5, 70_000);
    expect(Number((await reconcileUncosted(admin))[0]!.n)).toBe(0);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(0);
  });

  test('FIX 1: a non-strict commitment still nets against its OWN batch when the PO does arrive', async () => {
    // Widening the retro-cost must not cost the batched path anything: the
    // correct GRN is still the one that claims it, at the real landed cost.
    const { movId } = await shipShort(admin, { commitLine: true, strict: false, qty: 2 });
    await receive(admin, 2, 120_000);
    expect(Number((await reconcileBatch(admin))[0]!.n)).toBe(2);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(240_000);

    // ...and being doubly eligible cannot double-cost it: both functions
    // recompute ABS(qty) - SUM(consumed), which is now zero.
    await receiveUnrelated(admin, 9, 70_000);
    expect(Number((await reconcileUncosted(admin))[0]!.n)).toBe(0);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(240_000);
  });

  /* ── FIX 5 — the per-line claim is scoped to the VARIANT ─────────────────── */
  test('FIX 5: a commitment in one variant does not let another variant claim the batch', async () => {
    // One DO, same item_code, two fabrics. Only the BF-01 line is committed; the
    // BF-99 OUT carries the same batch but no commitment of its own. Before the
    // variant scoping, the EXISTS matched on (DO, item_code, batch) alone and the
    // uncommitted variant was claimed on the back of its sibling.
    const { movId } = await shipShort(admin, {
      commitLine: true, strict: true, variantKey: 'fabriccode=bf-01', movVariantKey: 'fabriccode=bf-99',
    });
    await admin`
      insert into scm.inventory_lots
        (warehouse_id, item_code, variant_key, qty_received, qty_remaining, unit_cost_sen, batch_no)
      values (${WH}::uuid, ${CODE}, 'fabriccode=bf-99', 5, 5, 90_000, ${BATCH})`;
    const [{ n }] = await reconcileBatch(admin, 'fabriccode=bf-99');
    expect(Number(n)).toBe(0);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(0);
  });

  test('FIX 5: the MATCHING variant still claims normally', async () => {
    const { movId } = await shipShort(admin, {
      commitLine: true, strict: true, variantKey: 'fabriccode=bf-01', movVariantKey: 'fabriccode=bf-01',
    });
    await admin`
      insert into scm.inventory_lots
        (warehouse_id, item_code, variant_key, qty_received, qty_remaining, unit_cost_sen, batch_no)
      values (${WH}::uuid, ${CODE}, 'fabriccode=bf-01', 5, 5, 90_000, ${BATCH})`;
    expect(Number((await reconcileBatch(admin, 'fabriccode=bf-01'))[0]!.n)).toBe(1);
    expect((await movementCost(admin, movId)).total_cost_sen).toBe(90_000);
  });

  /* ── FIX 7 — the hot-path index ──────────────────────────────────────────── */
  test('FIX 7: the batch_no index the MRP commitment read depends on exists', async () => {
    const [{ n }] = await admin<Array<{ n: number }>>`
      select count(*)::int as n from pg_indexes
       where schemaname = 'scm' and indexname = 'idx_inv_mov_batch_out'`;
    expect(Number(n)).toBe(1);
  });

  test('re-applying the migration is a no-op (idempotent file)', async () => {
    await admin.unsafe(await commitmentMigrationSql());
    const [{ n }] = await admin<Array<{ n: number }>>`
      select count(*)::int as n from pg_indexes
       where schemaname = 'scm' and indexname = 'idx_doi_committed_po_batch'`;
    expect(Number(n)).toBe(1);
  });
});
