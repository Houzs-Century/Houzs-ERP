import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  snapshotSoLineLinks,
  planSoLineRelink,
  applySoLineRelink,
} from '../src/scm/lib/so-line-relink';

/* Real PostgreSQL proof that a delete-and-reinsert of SO lines silently nulls
   every downstream so_item_id, and that the snapshot / plan / apply sequence
   carries them across.

   The premise is the whole reason the TBC sofa exchange loses SO<->PO bindings,
   and it is stated in a checked-in schema DUMP
   (backend/scripts/scm-schema/2990s-full-schema.sql:1651 / :1747 / :1767).
   The CLAUDE.md lesson from the system-foundation COE is exactly about that:
   verify schema claims against a database, not a migration file. So this suite
   creates the three FKs with the same `ON DELETE SET NULL` declaration and
   makes Postgres demonstrate the wipe before proving the fix.

   Runs against CI's postgres:16 service container (`backend-postgres` ->
   `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let admin: Sql;

/* A minimal PostgREST-shaped adapter over the real connection, carrying exactly
   the two operations so-line-relink performs. The point is to drive the module
   unchanged against a real database rather than a fake store. */
function pgSb(sql: Sql) {
  const allowed = new Set(['purchase_order_items', 'delivery_order_items', 'sales_invoice_items']);
  return {
    from(table: string) {
      if (!allowed.has(table)) throw new Error(`unexpected table ${table}`);
      return {
        select(_cols: string) {
          return {
            async in(col: string, values: string[]) {
              if (values.length === 0) return { data: [], error: null };
              const data = await sql`
                select id, so_item_id from scm.${sql(table)}
                where ${sql(col)} = any(${values}::uuid[])
                order by id
              `;
              return { data, error: null };
            },
          };
        },
        update(patch: { so_item_id: string }) {
          return {
            async eq(col: string, value: string) {
              await sql`
                update scm.${sql(table)} set so_item_id = ${patch.so_item_id}::uuid
                where ${sql(col)} = ${value}::uuid
              `;
              return { error: null };
            },
          };
        },
      };
    },
  };
}

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  /* The FK declarations are copied verbatim in SHAPE from
     2990s-full-schema.sql — same referenced column, same ON DELETE action. */
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;

    DROP TABLE IF EXISTS scm.purchase_order_items CASCADE;
    DROP TABLE IF EXISTS scm.delivery_order_items CASCADE;
    DROP TABLE IF EXISTS scm.sales_invoice_items CASCADE;
    DROP TABLE IF EXISTS scm.mfg_sales_order_items CASCADE;

    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_no text,
      item_code text,
      line_no integer
    );

    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      material_code text,
      so_item_id uuid REFERENCES scm.mfg_sales_order_items(id) ON DELETE SET NULL
    );
    CREATE TABLE scm.delivery_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      item_code text,
      so_item_id uuid REFERENCES scm.mfg_sales_order_items(id) ON DELETE SET NULL
    );
    CREATE TABLE scm.sales_invoice_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      item_code text,
      so_item_id uuid REFERENCES scm.mfg_sales_order_items(id) ON DELETE SET NULL
    );
  `);
}

/* Seed a two-module sofa build and bind one downstream row per FK table. */
async function seedBuild(sql: Sql): Promise<{ oldIds: string[]; links: Record<string, string> }> {
  const rows = await sql<Array<{ id: string; item_code: string }>>`
    insert into scm.mfg_sales_order_items (doc_no, item_code, line_no)
    values ('SO-1', 'BOOQIT-1B(LHF)', 1), ('SO-1', 'BOOQIT-CNR', 2)
    returning id, item_code
  `;
  const lhf = rows.find((r) => r.item_code === 'BOOQIT-1B(LHF)')!.id;
  const cnr = rows.find((r) => r.item_code === 'BOOQIT-CNR')!.id;
  const [po] = await sql<Array<{ id: string }>>`
    insert into scm.purchase_order_items (material_code, so_item_id)
    values ('BOOQIT-1B(LHF)', ${lhf}) returning id`;
  const [doItem] = await sql<Array<{ id: string }>>`
    insert into scm.delivery_order_items (item_code, so_item_id)
    values ('BOOQIT-CNR', ${cnr}) returning id`;
  const [si] = await sql<Array<{ id: string }>>`
    insert into scm.sales_invoice_items (item_code, so_item_id)
    values ('BOOQIT-CNR', ${cnr}) returning id`;
  return { oldIds: [lhf, cnr], links: { lhf, cnr, po: po.id, do: doItem.id, si: si.id } };
}

describePg('SO line delete nulls every downstream link (and so-line-relink carries them back)', () => {
  beforeAll(async () => { admin = postgres(url, { max: 4 }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetFixture(admin); });

  test('THE PREMISE: deleting an SO line SET NULLs purchase / delivery / invoice links', async () => {
    const { oldIds, links } = await seedBuild(admin);

    const before = await admin`
      select (select so_item_id from scm.purchase_order_items where id = ${links.po}::uuid) as po,
             (select so_item_id from scm.delivery_order_items where id = ${links.do}::uuid) as dor,
             (select so_item_id from scm.sales_invoice_items where id = ${links.si}::uuid) as si`;
    expect(before[0].po).toBe(links.lhf);
    expect(before[0].dor).toBe(links.cnr);
    expect(before[0].si).toBe(links.cnr);

    await admin`delete from scm.mfg_sales_order_items where id = any(${oldIds}::uuid[])`;

    const after = await admin`
      select (select so_item_id from scm.purchase_order_items where id = ${links.po}::uuid) as po,
             (select so_item_id from scm.delivery_order_items where id = ${links.do}::uuid) as dor,
             (select so_item_id from scm.sales_invoice_items where id = ${links.si}::uuid) as si,
             (select count(*) from scm.purchase_order_items) as po_rows`;
    // The rows SURVIVE — only the link is wiped. That is what makes this silent:
    // the PO line is still there, still on order, just no longer findable.
    expect(Number(after[0].po_rows)).toBe(1);
    expect(after[0].po).toBeNull();
    expect(after[0].dor).toBeNull();
    expect(after[0].si).toBeNull();
  });

  test('snapshot -> plan -> apply carries all three links onto the replacement lines', async () => {
    const { oldIds, links } = await seedBuild(admin);
    const sb = pgSb(admin);

    // 1. Freeze BEFORE the delete — the one moment the mapping still exists.
    const snapshot = await snapshotSoLineLinks(sb, oldIds);
    expect(snapshot).toHaveLength(3);

    // 2. The exchange: insert the replacement build (same module SKUs, the
    //    routine TBC fabric-confirm case), then delete the old set.
    const inserted = await admin<Array<{ id: string; item_code: string; line_no: number }>>`
      insert into scm.mfg_sales_order_items (doc_no, item_code, line_no)
      values ('SO-1', 'BOOQIT-1B(LHF)', 1), ('SO-1', 'BOOQIT-CNR', 2)
      returning id, item_code, line_no`;
    await admin`delete from scm.mfg_sales_order_items where id = any(${oldIds}::uuid[])`;

    const nulled = await admin`
      select so_item_id from scm.purchase_order_items where id = ${links.po}::uuid`;
    expect(nulled[0].so_item_id).toBeNull();

    // 3. Restore.
    const plan = planSoLineRelink(
      [
        { id: links.lhf, itemCode: 'BOOQIT-1B(LHF)', lineNo: 1 },
        { id: links.cnr, itemCode: 'BOOQIT-CNR', lineNo: 2 },
      ],
      inserted.map((r) => ({ id: r.id, itemCode: r.item_code, lineNo: r.line_no })),
      snapshot,
    );
    expect(plan.dropped).toEqual([]);
    const res = await applySoLineRelink(sb, plan, () => {});
    expect(res).toEqual({ restored: 3, dropped: 0 });

    const newLhf = inserted.find((r) => r.item_code === 'BOOQIT-1B(LHF)')!.id;
    const newCnr = inserted.find((r) => r.item_code === 'BOOQIT-CNR')!.id;
    const restored = await admin`
      select (select so_item_id from scm.purchase_order_items where id = ${links.po}::uuid) as po,
             (select so_item_id from scm.delivery_order_items where id = ${links.do}::uuid) as dor,
             (select so_item_id from scm.sales_invoice_items where id = ${links.si}::uuid) as si`;
    expect(restored[0].po).toBe(newLhf);
    expect(restored[0].dor).toBe(newCnr);
    expect(restored[0].si).toBe(newCnr);
  });

  test('a module SKU the new build does not carry stays NULL and is reported, not re-pointed', async () => {
    const { oldIds, links } = await seedBuild(admin);
    const sb = pgSb(admin);
    const snapshot = await snapshotSoLineLinks(sb, oldIds);

    // The corner module is gone from the replacement build.
    const inserted = await admin<Array<{ id: string; item_code: string; line_no: number }>>`
      insert into scm.mfg_sales_order_items (doc_no, item_code, line_no)
      values ('SO-1', 'BOOQIT-1B(LHF)', 1)
      returning id, item_code, line_no`;
    await admin`delete from scm.mfg_sales_order_items where id = any(${oldIds}::uuid[])`;

    const plan = planSoLineRelink(
      [
        { id: links.lhf, itemCode: 'BOOQIT-1B(LHF)', lineNo: 1 },
        { id: links.cnr, itemCode: 'BOOQIT-CNR', lineNo: 2 },
      ],
      inserted.map((r) => ({ id: r.id, itemCode: r.item_code, lineNo: r.line_no })),
      snapshot,
    );
    const res = await applySoLineRelink(sb, plan, () => {});
    expect(res).toEqual({ restored: 1, dropped: 2 });

    const after = await admin`
      select (select so_item_id from scm.purchase_order_items where id = ${links.po}::uuid) as po,
             (select so_item_id from scm.delivery_order_items where id = ${links.do}::uuid) as dor`;
    expect(after[0].po).toBe(inserted[0].id);
    expect(after[0].dor).toBeNull();
  });

  test('a restore that names a non-existent SO line is refused by the FK, never written', async () => {
    // The guard behind "never invent a link": even if the plan were wrong, the
    // database will not accept a dangling uuid.
    const { links } = await seedBuild(admin);
    const sb = pgSb(admin);
    await expect(applySoLineRelink(sb, {
      restore: [{
        table: 'purchase_order_items',
        rowId: links.po,
        soItemId: '00000000-0000-0000-0000-000000000000',
      }],
      dropped: [],
    }, () => {})).rejects.toThrow();
  });
});
