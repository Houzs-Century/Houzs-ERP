import { describe, expect, test } from 'vitest';
import migration0173 from '../src/db/migrations-pg/0173_scm_so_concurrency_domain_closure.sql?raw';
import migration0174 from '../src/db/migrations-pg/0174_scm_stock_allocation_recompute_queue.sql?raw';

describe('SO concurrency domain migration', () => {
  test('ships the transactional header CAS and payment/amendment row generations together', () => {
    expect(migration0173).toContain('CREATE OR REPLACE FUNCTION scm.apply_so_header_cas');
    expect(migration0173).toContain('FOR UPDATE');
    expect(migration0173).toContain('jsonb_populate_record');
    expect(migration0173).toContain("jsonb_typeof(p_patch) IS DISTINCT FROM 'object'");
    expect(migration0173).toContain('CASE WHEN $1 ?');
    expect(migration0173).toContain('FROM jsonb_populate_record(NULL::scm.mfg_sales_orders, $1) AS p');
    expect(migration0173).not.toContain('jsonb_populate_record(t, $1)');
    expect(migration0173).toContain('mfg_sales_order_payments');
    expect(migration0173).toContain('ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1');
    expect(migration0173).toContain('ALTER TABLE scm.so_amendments');
    expect(migration0173).toContain('REVOKE ALL ON FUNCTION scm.apply_so_header_cas');
  });

  test('the CAS RPC resolves its customer upsert inside the caller company', () => {
    // Migration 0164 made upsert_customer_by_name_phone company-scoped with a
    // DEFAULT NULL 4th argument, so a 3-argument call still compiles and
    // silently resolves every re-customer against HOUZS. Pin the 4-arg call.
    expect(migration0173).toContain('p_company_id bigint DEFAULT NULL');
    expect(migration0173).toContain('p_customer_name, p_customer_phone, p_customer_email, p_company_id');
    // CREATE OR REPLACE cannot change an argument list, so the old 12-arg shape
    // must be dropped or a positional call becomes ambiguous.
    expect(migration0173).toContain('DROP FUNCTION IF EXISTS scm.apply_so_header_cas');
    expect(migration0173).toContain(
      'text, integer, text, jsonb, boolean, text, text, text, boolean, uuid, boolean, date, bigint',
    );
  });

  test('allocation retries use a collision-proof generation fence and durable cross-request mutex', () => {
    expect(migration0174).toContain('request_token uuid NOT NULL DEFAULT gen_random_uuid()');
    expect(migration0174).toContain('CREATE TABLE IF NOT EXISTS scm.stock_allocation_recompute_lock');
    expect(migration0174).toContain("VALUES ('GLOBAL')");
    expect(migration0174).toContain('ENABLE ROW LEVEL SECURITY');
  });

  test('the queue carries a terminal state and a soft-deferral counter', () => {
    // A permanently failing job must be able to STOP and become visible, and a
    // soft deferral (a human holding an SO edit lease) must never count toward
    // that terminal state. See stock-allocation-job.ts.
    expect(migration0174).toContain("ADD COLUMN IF NOT EXISTS state            text NOT NULL DEFAULT 'PENDING'");
    expect(migration0174).toContain('ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz');
    expect(migration0174).toContain('ADD COLUMN IF NOT EXISTS deferrals        integer NOT NULL DEFAULT 0');
    expect(migration0174).toContain('ADD COLUMN IF NOT EXISTS next_attempt_at  timestamptz');
    expect(migration0174).toContain("CHECK (state IN ('PENDING', 'DEAD'))");
    // Re-runnable: the whole file must be idempotent because a failed migration
    // blocks every later one on the production deploy path.
    expect(migration0174).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
  });
});
