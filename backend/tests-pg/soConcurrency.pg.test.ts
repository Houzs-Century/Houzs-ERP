import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { lockSoCommandLease, pgTransactionSupabase } from '../src/scm/lib/pg-supabase-transaction';
import { recordSoAudit } from '../src/scm/lib/so-audit';
import { snapshotSo } from '../src/scm/lib/so-revision';
import { enqueueStockAllocationRecompute } from '../src/scm/lib/stock-allocation-job';

const url = process.env.TEST_DATABASE_URL ?? '';
const enabled = Boolean(url);
const describePg = enabled ? describe : describe.skip;

let admin: Sql;

const migration = (name: string) => readFile(
  fileURLToPath(new URL(`../src/db/migrations-pg/${name}`, import.meta.url)),
  'utf8',
);

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'untrusted_test') THEN
        CREATE ROLE untrusted_test NOLOGIN;
      END IF;
    END $$;
    ALTER ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA scm TO service_role;
    GRANT USAGE ON SCHEMA scm TO untrusted_test;

    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY,
      version integer NOT NULL DEFAULT 1,
      revision integer NOT NULL DEFAULT 1,
      note text,
      customer_id uuid,
      company_id bigint
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_no text NOT NULL,
      item_code text,
      variants jsonb,
      custom_specials jsonb,
      photo_urls text[] NOT NULL DEFAULT '{}',
      line_no integer,
      total_centi integer NOT NULL DEFAULT 0 CHECK (total_centi >= 0),
      cancelled boolean NOT NULL DEFAULT false,
      warehouse_id uuid,
      line_delivery_date date,
      line_delivery_date_overridden boolean NOT NULL DEFAULT false
    );
    CREATE TABLE scm.pwp_codes (
      code text PRIMARY KEY,
      source_doc_no text,
      customer_id uuid,
      updated_at timestamptz
    );
    CREATE TABLE scm.mfg_sales_order_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE scm.purchase_order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      so_item_id uuid
    );
    CREATE TABLE scm.so_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      so_doc_no text NOT NULL,
      revision integer NOT NULL,
      snapshot jsonb NOT NULL,
      amendment_id uuid,
      created_by uuid,
      company_id bigint,
      UNIQUE (so_doc_no, revision)
    );
    CREATE TABLE scm.mfg_so_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      so_doc_no text NOT NULL,
      company_id bigint,
      action text NOT NULL,
      actor_id uuid,
      actor_name_snapshot text,
      field_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
      status_snapshot text,
      source text,
      note text
    );
    CREATE TABLE scm.so_amendments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      so_doc_no text,
      status text NOT NULL DEFAULT 'REQUESTED'
    );

    CREATE TABLE scm.customer_upsert_calls (
      id bigserial PRIMARY KEY,
      company_id bigint
    );
    -- Mirrors production AFTER migration 0164: p_company_id is the 4th
    -- argument with a DEFAULT, so a stale 3-argument caller still compiles and
    -- silently resolves against HOUZS. The stub records what it was given.
    CREATE OR REPLACE FUNCTION scm.upsert_customer_by_name_phone(
      p_name text, p_phone text, p_email text, p_company_id bigint DEFAULT NULL
    ) RETURNS uuid LANGUAGE plpgsql AS $fn$
    DECLARE v uuid := gen_random_uuid();
    BEGIN
      INSERT INTO scm.customer_upsert_calls (company_id) VALUES (p_company_id);
      RETURN v;
    END $fn$;
  `);
  await sql.unsafe(await migration('0172_scm_so_edit_lease_and_followers.sql'));
  await sql.unsafe(await migration('0173_scm_so_concurrency_domain_closure.sql'));
  await sql.unsafe(await migration('0174_scm_stock_allocation_recompute_queue.sql'));
}

async function callHeaderCas(
  sql: Sql,
  note: string,
  expectedVersion = 1,
  applyWarehouse = false,
) {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE service_role');
    return tx.unsafe<Array<{ applied: boolean; current_version: number; conflict_reason: string | null }>>(
      `SELECT * FROM scm.apply_so_header_cas(
        $1, $2, NULL, $3::jsonb, false, NULL, NULL, NULL, $4, $5::uuid, false, NULL
      )`,
      // postgres.js receives the server-described jsonb OID and serializes a
      // JavaScript object exactly once. Passing JSON.stringify here would be
      // serialized a second time and turn the patch into a JSON string.
      ['SO-PG-1', expectedVersion, { note, version: expectedVersion + 1 }, applyWarehouse, '00000000-0000-0000-0000-000000000001'],
    );
  });
}

async function dropFollowerFailureTrigger(): Promise<void> {
  await admin.unsafe(`
    DROP TRIGGER IF EXISTS fail_so_follower ON scm.mfg_sales_order_items;
    DROP FUNCTION IF EXISTS scm.fail_so_follower();
  `);
}

describePg('Sales Order PostgreSQL concurrency migration', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 4 });
    await resetFixture(admin);
  });

  afterAll(async () => {
    if (admin) await admin.end();
  });

  // A failed assertion must never leave the deliberate failure trigger behind
  // and turn every later integration test into a false negative.
  beforeEach(dropFollowerFailureTrigger);
  afterEach(dropFollowerFailureTrigger);

  test('SECURITY DEFINER function is callable only through its granted service role', async () => {
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, note) VALUES ('SO-PG-1', 'original')`;
    await expect(admin.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE untrusted_test');
      await tx.unsafe(
        `SELECT * FROM scm.apply_so_header_cas(
          $1, 1, NULL, $2::jsonb, false, NULL, NULL, NULL, false, NULL, false, NULL
        )`,
        ['SO-PG-1', { note: 'must not land', version: 2 }],
      );
    })).rejects.toThrow(/permission denied/i);
    const result = await callHeaderCas(admin, 'service write');
    expect(result[0]).toMatchObject({ applied: true, current_version: 2, conflict_reason: null });
    const [row] = await admin`SELECT note, version FROM scm.mfg_sales_orders WHERE doc_no = 'SO-PG-1'`;
    expect(row).toMatchObject({ note: 'service write', version: 2 });
  });

  test('two real connections racing at v1 produce exactly one winner and one conflict', async () => {
    await admin`TRUNCATE scm.mfg_sales_orders`;
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, note) VALUES ('SO-PG-1', 'original')`;
    const left = postgres(url, { max: 1 });
    const right = postgres(url, { max: 1 });
    try {
      const results = await Promise.all([
        callHeaderCas(left, 'left'),
        callHeaderCas(right, 'right'),
      ]);
      const outcomes = results.map((rows) => rows[0]?.applied).sort();
      expect(outcomes).toEqual([false, true]);
      const conflict = results.flat().find((row) => !row.applied);
      expect(conflict).toMatchObject({ current_version: 2, conflict_reason: 'version' });
      const [saved] = await admin`SELECT note, version FROM scm.mfg_sales_orders WHERE doc_no = 'SO-PG-1'`;
      expect(['left', 'right']).toContain(saved?.note);
      expect(saved?.version).toBe(2);
    } finally {
      await Promise.all([left.end(), right.end()]);
    }
  });

  test('header patch preserves omitted fields and treats explicit null as a clear', async () => {
    await admin`TRUNCATE scm.mfg_sales_orders`;
    await admin`
      INSERT INTO scm.mfg_sales_orders (doc_no, note, company_id)
      VALUES ('SO-PG-1', 'clear me', 7)
    `;
    await admin.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE service_role');
      await tx.unsafe(
        `SELECT * FROM scm.apply_so_header_cas(
          $1, 1, NULL, $2::jsonb, false, NULL, NULL, NULL, false, NULL, false, NULL
        )`,
        ['SO-PG-1', { note: null, version: 2 }],
      );
    });
    const [saved] = await admin`SELECT note, company_id, version FROM scm.mfg_sales_orders WHERE doc_no = 'SO-PG-1'`;
    // postgres.js intentionally returns int8 as text to avoid precision loss.
    expect(saved).toMatchObject({ note: null, company_id: '7', version: 2 });
  });

  test('a follower exception rolls back the already-attempted header update', async () => {
    await admin`TRUNCATE scm.mfg_sales_order_items, scm.mfg_sales_orders`;
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, note) VALUES ('SO-PG-1', 'before failure')`;
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no) VALUES ('SO-PG-1')`;
    await admin.unsafe(`
      CREATE OR REPLACE FUNCTION scm.fail_so_follower() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected follower failure'; END $$;
      CREATE TRIGGER fail_so_follower BEFORE UPDATE ON scm.mfg_sales_order_items
      FOR EACH ROW EXECUTE FUNCTION scm.fail_so_follower();
    `);

    try {
      await expect(callHeaderCas(admin, 'must rollback', 1, true)).rejects.toThrow(/injected follower failure/);
      const [saved] = await admin`SELECT note, version FROM scm.mfg_sales_orders WHERE doc_no = 'SO-PG-1'`;
      expect(saved).toMatchObject({ note: 'before failure', version: 1 });
    } finally {
      await dropFollowerFailureTrigger();
    }
  });

  test('the command adapter rolls every line write back when a later statement fails', async () => {
    await admin`TRUNCATE scm.mfg_sales_order_items, scm.mfg_sales_orders`;
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, note, edit_lease_token, edit_lease_expires_at)
      VALUES ('SO-PG-1', 'command', 'lease-a', now() + interval '5 minutes')
    `;
    const inserted = await admin`
      INSERT INTO scm.mfg_sales_order_items (doc_no, item_code, total_centi)
      VALUES ('SO-PG-1', 'A', 10), ('SO-PG-1', 'B', 10)
      RETURNING id, item_code
    `;
    await expect(admin.begin(async (tx) => {
      const lease = await lockSoCommandLease(tx as unknown as Sql, 'SO-PG-1', 'lease-a');
      expect(lease.ok).toBe(true);
      const sb = pgTransactionSupabase(tx as unknown as Sql);
      await sb.from('mfg_sales_order_items').update({ total_centi: 20 }).eq('id', inserted[0]!.id);
      // CHECK(total_centi >= 0) is a real mid-command database failure.
      await sb.from('mfg_sales_order_items').update({ total_centi: -1 }).eq('id', inserted[1]!.id);
    })).rejects.toThrow();
    const rows = await admin`
      SELECT item_code, total_centi FROM scm.mfg_sales_order_items
      WHERE doc_no = 'SO-PG-1' ORDER BY item_code
    `;
    expect(rows).toMatchObject([{ item_code: 'A', total_centi: 10 }, { item_code: 'B', total_centi: 10 }]);
  });

  test('two command connections serialize on the SO lease row and stale lease gets zero writes', async () => {
    await admin`TRUNCATE scm.mfg_sales_order_items, scm.mfg_sales_orders`;
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, note, edit_lease_token, edit_lease_expires_at)
      VALUES ('SO-PG-1', 'command', 'lease-a', now() + interval '5 minutes')
    `;
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no, item_code, total_centi) VALUES ('SO-PG-1', 'A', 10)`;
    const left = postgres(url, { max: 1 });
    const right = postgres(url, { max: 1 });
    const attempt = (sql: Sql, amount: number) => sql.begin(async (tx) => {
      const lease = await lockSoCommandLease(tx as unknown as Sql, 'SO-PG-1', 'lease-a');
      if (!lease.ok) return false;
      const sb = pgTransactionSupabase(tx as unknown as Sql);
      await sb.from('mfg_sales_order_items').update({ total_centi: amount }).eq('doc_no', 'SO-PG-1');
      // Models the composite command's final release: the waiting transaction
      // must re-read after the row lock and reject the now-stale token.
      await sb.from('mfg_sales_orders').update({ edit_lease_token: null, edit_lease_expires_at: null }).eq('doc_no', 'SO-PG-1');
      return true;
    });
    try {
      const outcomes = await Promise.all([attempt(left, 20), attempt(right, 30)]);
      expect(outcomes.sort()).toEqual([false, true]);
      const [row] = await admin`SELECT total_centi FROM scm.mfg_sales_order_items WHERE doc_no = 'SO-PG-1'`;
      expect([20, 30]).toContain(row?.total_centi);
    } finally {
      await Promise.all([left.end(), right.end()]);
    }
  });

  test('the command row lock cannot cross the active company boundary', async () => {
    await admin`TRUNCATE scm.mfg_sales_orders`;
    await admin`
      INSERT INTO scm.mfg_sales_orders
        (doc_no, company_id, edit_lease_token, edit_lease_expires_at)
      VALUES ('SO-PG-1', 7, 'lease-company', now() + interval '5 minutes')
    `;
    await admin.begin(async (tx) => {
      expect(await lockSoCommandLease(tx as unknown as Sql, 'SO-PG-1', 'lease-company', 8))
        .toEqual({ ok: false, reason: 'not_found' });
      expect(await lockSoCommandLease(tx as unknown as Sql, 'SO-PG-1', 'lease-company', 7))
        .toMatchObject({ ok: true, version: 1 });
    });
  });

  test('amendment version claim and all applied lines share one transaction', async () => {
    await admin`TRUNCATE scm.so_amendments, scm.mfg_sales_order_items, scm.mfg_sales_orders`;
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no) VALUES ('SO-PG-1')`;
    const [amendment] = await admin`
      INSERT INTO scm.so_amendments (so_doc_no, status)
      VALUES ('SO-PG-1', 'REQUESTED') RETURNING id
    `;
    await admin`INSERT INTO scm.mfg_sales_order_items (doc_no, item_code, total_centi) VALUES ('SO-PG-1', 'A', 10)`;
    const left = postgres(url, { max: 1 });
    const right = postgres(url, { max: 1 });
    const attempt = (sql: Sql, amount: number) => sql.begin(async (tx) => {
      const sb = pgTransactionSupabase(tx as unknown as Sql);
      const { data: claimed } = await sb.from('so_amendments')
        .update({ version: 2, status: 'SO_APPROVED' })
        .eq('id', amendment!.id).eq('version', 1).eq('status', 'REQUESTED')
        .select('id').maybeSingle();
      if (!claimed) return false;
      await sb.from('mfg_sales_order_items').update({ total_centi: amount }).eq('doc_no', 'SO-PG-1');
      return true;
    });
    try {
      const outcomes = await Promise.all([attempt(left, 20), attempt(right, 30)]);
      expect(outcomes.sort()).toEqual([false, true]);
      const [savedAmendment] = await admin`SELECT status, version FROM scm.so_amendments WHERE id = ${amendment!.id}`;
      expect(savedAmendment).toMatchObject({ status: 'SO_APPROVED', version: 2 });
      const [line] = await admin`SELECT total_centi FROM scm.mfg_sales_order_items WHERE doc_no = 'SO-PG-1'`;
      expect([20, 30]).toContain(line?.total_centi);
    } finally {
      await Promise.all([left.end(), right.end()]);
    }
  });

  test('real snapshot/audit helpers round-trip JSONB objects, JSON arrays, and text arrays', async () => {
    await admin`TRUNCATE scm.so_revisions, scm.mfg_so_audit_log, scm.purchase_order_items, scm.mfg_sales_order_items, scm.mfg_sales_orders`;
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, note, company_id) VALUES ('SO-JSON-1', 'json proof', 7)`;
    // Match getSql's production protocol settings exactly. In particular,
    // fetch_types:false means postgres.js has no discovered text[] serializer
    // or parser; the command adapter must supply both sides of that contract.
    const productionLike = postgres(url, { max: 1, prepare: false, fetch_types: false });
    try {
      await productionLike.begin(async (tx) => {
        const sb = pgTransactionSupabase(tx as unknown as Sql);
        await sb.from('mfg_sales_order_items').insert({
          doc_no: 'SO-JSON-1',
          item_code: 'SOFA-A',
          variants: { buildKey: 'BUILD-1', cells: [{ moduleId: 'LHF' }] },
          custom_specials: [{ code: 'ZIP', amount: 12 }],
          photo_urls: ['so/a"quote.jpg', 'so/back\\slash.jpg'],
          line_no: 1,
        });
        await recordSoAudit(sb as never, {
          docNo: 'SO-JSON-1',
          action: 'UPDATE_LINE',
          actorName: 'PG integration',
          fieldChanges: [{ field: 'variants', from: null, to: { buildKey: 'BUILD-1' } }],
        });
        expect(await snapshotSo(sb, 'SO-JSON-1')).toBe(2);
      });
    } finally {
      await productionLike.end();
    }

    const [line] = await admin`
      SELECT variants, custom_specials, photo_urls
      FROM scm.mfg_sales_order_items WHERE doc_no = 'SO-JSON-1'
    `;
    expect(line?.variants).toEqual({ buildKey: 'BUILD-1', cells: [{ moduleId: 'LHF' }] });
    expect(line?.custom_specials).toEqual([{ code: 'ZIP', amount: 12 }]);
    expect(line?.photo_urls).toEqual(['so/a"quote.jpg', 'so/back\\slash.jpg']);

    const [audit] = await admin`SELECT field_changes FROM scm.mfg_so_audit_log WHERE so_doc_no = 'SO-JSON-1'`;
    expect(audit?.field_changes).toEqual([{ field: 'variants', from: null, to: { buildKey: 'BUILD-1' } }]);
    const [revision] = await admin`SELECT snapshot FROM scm.so_revisions WHERE so_doc_no = 'SO-JSON-1'`;
    expect(typeof revision?.snapshot).toBe('object');
    expect(revision?.snapshot.lines[0].variants).toEqual({ buildKey: 'BUILD-1', cells: [{ moduleId: 'LHF' }] });
    expect(revision?.snapshot.lines[0].custom_specials).toEqual([{ code: 'ZIP', amount: 12 }]);
    expect(revision?.snapshot.lines[0].photo_urls).toEqual(['so/a"quote.jpg', 'so/back\\slash.jpg']);
  });

  test('the CAS customer upsert is resolved inside the caller company, not HOUZS', async () => {
    /* Migration 0164 made upsert_customer_by_name_phone company-scoped by
       adding a DEFAULTED 4th argument, so a 3-argument call still runs and
       silently pools every re-customer into HOUZS. PL/pgSQL resolves the call
       at RUNTIME, so only actually taking the p_recustomer branch proves the
       right overload is reached. */
    await admin.unsafe('DELETE FROM scm.customer_upsert_calls');
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, note, company_id) VALUES ('SO-PG-1', 'recustomer', 77)`;
    const expected = 1;
    const rows = await admin.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE service_role');
      return tx.unsafe<Array<{ applied: boolean; resolved_customer_id: string | null }>>(
        `SELECT * FROM scm.apply_so_header_cas(
          $1, $2, NULL, $3::jsonb, true, 'Ah Meng', '0123456789', NULL,
          false, NULL, false, NULL, $4::bigint
        )`,
        ['SO-PG-1', expected, { version: expected + 1 }, 77],
      );
    });
    expect(rows[0].applied).toBe(true);
    expect(rows[0].resolved_customer_id).toBeTruthy();
    const calls = await admin.unsafe<Array<{ company_id: string | number | null }>>(
      'SELECT company_id FROM scm.customer_upsert_calls',
    );
    expect(calls).toHaveLength(1);
    expect(Number(calls[0].company_id)).toBe(77);
  });
  test('service role can transactionally enqueue the durable allocation invalidation', async () => {
    await admin`TRUNCATE scm.stock_allocation_recompute_queue`;
    await admin.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE service_role');
      await enqueueStockAllocationRecompute(
        pgTransactionSupabase(tx as unknown as Sql),
        'pg-integration',
      );
    });
    const [job] = await admin`
      SELECT job_key, request_token, reason, attempts, last_error
      FROM scm.stock_allocation_recompute_queue
    `;
    expect(job).toMatchObject({ job_key: 'GLOBAL', reason: 'pg-integration', attempts: 0, last_error: null });
    expect(job?.request_token).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
