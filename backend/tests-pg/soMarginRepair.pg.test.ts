/* EXECUTES the SQL behind `scripts/repair-so-margin-fields.mjs` against real
 * Postgres: the guarded line and header writes, company scope, the audit rows
 * (a jsonb ARRAY, never a jsonb string), the Venture Portal capture triggers
 * and the move of the repair's own queue rows to the reconcile lane, and that
 * a second plan finds nothing. SKIPPED without TEST_DATABASE_URL. Figures are
 * made up.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { PORTAL_HOLD_NOTE, planCompanyMargins, readOrderMargins, writeMarginChunk } from '../scripts/lib/so-margin-repair.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const LEFT_ALONE = new Set(['DRAFT', 'CANCELLED']);

let sql: Sql;

const L = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;

async function schema(db: Sql) {
  await db.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    -- status is an enum in production; a text fixture would hide a bad cast.
    CREATE TYPE scm.mfg_so_status AS ENUM ('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED');
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, company_id bigint NOT NULL, so_date date, status scm.mfg_so_status NOT NULL,
      local_total_sen integer NOT NULL DEFAULT 0, total_revenue_sen integer NOT NULL DEFAULT 0,
      total_cost_sen integer NOT NULL DEFAULT 0, total_margin_sen integer NOT NULL DEFAULT 0,
      margin_pct_basis integer NOT NULL DEFAULT 0, delivery_fee_sen integer NOT NULL DEFAULT 0
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY, doc_no text NOT NULL, company_id bigint NOT NULL, item_code text,
      total_sen integer NOT NULL DEFAULT 0, line_cost_sen integer NOT NULL DEFAULT 0,
      line_margin_sen integer NOT NULL DEFAULT 0, cancelled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE scm.mfg_so_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), so_doc_no text NOT NULL, company_id bigint NOT NULL DEFAULT 1,
      action text NOT NULL, actor_name_snapshot text, field_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
      status_snapshot text, source text DEFAULT 'web', note text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE scm.venture_portal_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, op text NOT NULL,
      status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      revision integer NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX venture_portal_outbox_pending_doc_idx ON scm.venture_portal_outbox (doc_no) WHERE status = 'pending';

    -- The production capture functions and triggers (20261013T1700 / 20260927T2100).
    CREATE FUNCTION scm.enqueue_vp_outbox() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO scm.venture_portal_outbox (doc_no, op) VALUES (COALESCE(NEW.doc_no, OLD.doc_no), TG_OP)
      ON CONFLICT (doc_no) WHERE status = 'pending'
      DO UPDATE SET revision = scm.venture_portal_outbox.revision + 1, updated_at = now();
      RETURN NULL;
    END $fn$;
    CREATE FUNCTION scm.enqueue_vp_outbox_child() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE dn text := COALESCE(to_jsonb(NEW) ->> TG_ARGV[0], to_jsonb(OLD) ->> TG_ARGV[0]);
    BEGIN
      IF dn IS NOT NULL THEN
        INSERT INTO scm.venture_portal_outbox (doc_no, op) VALUES (dn, TG_OP || ':' || TG_TABLE_NAME)
        ON CONFLICT (doc_no) WHERE status = 'pending'
        DO UPDATE SET revision = scm.venture_portal_outbox.revision + 1, updated_at = now();
      END IF;
      RETURN NULL;
    END $fn$;
    CREATE TRIGGER trg_vp_outbox_so AFTER INSERT OR DELETE OR UPDATE OF
      status, so_date, company_id, local_total_sen, delivery_fee_sen, total_cost_sen, total_margin_sen
      ON scm.mfg_sales_orders FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox();
    CREATE TRIGGER trg_vp_outbox_items AFTER INSERT OR DELETE OR UPDATE OF
      item_code, total_sen, cancelled, line_cost_sen, line_margin_sen
      ON scm.mfg_sales_order_items FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox_child('doc_no');
  `);
}

async function seed(db: Sql) {
  await db.unsafe(`
    INSERT INTO scm.mfg_sales_orders (doc_no, company_id, so_date, status, local_total_sen, total_revenue_sen, total_cost_sen, total_margin_sen, margin_pct_basis) VALUES
      -- AutoCount import: revenue 0, margin 0 - cost, lines never given a margin.
      ('HC-SO-000001', 1, '2025-03-01', 'DELIVERED', 100000, 0, 47000, -47000, 0),
      -- Opened in the app, then the nightly fill: margin right, basis stale, a line at full price.
      ('HC-SO-2609-013', 1, '2026-09-20', 'CONFIRMED', 200000, 200000, 94000, 106000, 9510),
      -- Already right.
      ('HC-SO-2610-001', 1, '2026-10-02', 'CONFIRMED', 50000, 50000, 20000, 30000, 6000),
      -- A draft is left alone.
      ('HC-SO-2611-900', 1, '2026-11-20', 'DRAFT', 50000, 50000, 20000, 30000, 9999),
      -- Header cost is not the sum of its lines: refused.
      ('HC-SO-000002', 1, '2025-04-01', 'DELIVERED', 80000, 0, 30000, -30000, 0),
      -- Another company with the same shape: never touched by a company 1 run.
      ('2990-SO-2610-001', 2, '2026-10-05', 'CONFIRMED', 60000, 60000, 25000, 35000, 5833);
    INSERT INTO scm.mfg_sales_order_items (id, doc_no, company_id, item_code, total_sen, line_cost_sen, line_margin_sen, cancelled) VALUES
      ('${L(1)}', 'HC-SO-000001', 1, 'M-1(K)', 100000, 40000, 0, false),
      ('${L(2)}', 'HC-SO-000001', 1, 'P-1', 0, 7000, 0, false),
      ('${L(3)}', 'HC-SO-2609-013', 1, 'M-2(Q)', 200000, 94000, 200000, false),
      ('${L(4)}', 'HC-SO-2610-001', 1, 'B-1', 50000, 20000, 30000, false),
      ('${L(5)}', 'HC-SO-2611-900', 1, 'B-1', 50000, 20000, 50000, false),
      ('${L(6)}', 'HC-SO-000002', 1, 'M-3', 80000, 20000, 0, false),
      ('${L(7)}', '2990-SO-2610-001', 2, 'S-1', 60000, 25000, 60000, false);
    -- Seeding queued rows of its own; clear them, then a live save's row from an hour ago.
    DELETE FROM scm.venture_portal_outbox;
    INSERT INTO scm.venture_portal_outbox (doc_no, op, created_at) VALUES ('HC-SO-2609-013', 'UPDATE', now() - interval '1 hour');
  `);
}

describePg('repair-so-margin-fields SQL on real Postgres', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, onnotice: () => undefined });
    await schema(sql);
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });
  beforeEach(async () => {
    await sql.unsafe('TRUNCATE scm.mfg_sales_orders, scm.mfg_sales_order_items, scm.mfg_so_audit_log, scm.venture_portal_outbox');
    await seed(sql);
  });

  test('plans the import gap, the stale basis and the full-price line; leaves drafts; refuses a bad header', async () => {
    const plan = planCompanyMargins(await readOrderMargins(sql, 1), LEFT_ALONE);
    expect(plan.todo.map((o) => o.h.doc_no)).toEqual(['HC-SO-000001', 'HC-SO-2609-013']);
    expect(plan.refused).toEqual([{ doc: 'HC-SO-000002', why: 'its header cost is not the sum of its lines; save the order in the app first' }]);
    expect(plan.leftAlone).toBe(1);
  });

  test('writes margins as a save would, audits them, and queues the portal in the background lane', async () => {
    const plan = planCompanyMargins(await readOrderMargins(sql, 1), LEFT_ALONE);
    const r = await sql.begin((tx) => writeMarginChunk(tx, 1, plan.todo, 'background'));
    expect({ lines: r.lines, heads: r.heads, orders: r.audited.length }).toEqual({ lines: 3, heads: 2, orders: 2 });

    const heads = await sql`SELECT doc_no, total_revenue_sen, total_margin_sen, margin_pct_basis FROM scm.mfg_sales_orders ORDER BY doc_no`;
    expect(heads.map((h) => [h.doc_no, h.total_revenue_sen, h.total_margin_sen, h.margin_pct_basis])).toEqual([
      ['2990-SO-2610-001', 60000, 35000, 5833],
      ['HC-SO-000001', 100000, 53000, 5300],
      ['HC-SO-000002', 0, -30000, 0],
      ['HC-SO-2609-013', 200000, 106000, 5300],
      ['HC-SO-2610-001', 50000, 30000, 6000],
      ['HC-SO-2611-900', 50000, 30000, 9999],
    ]);
    const lines = await sql`SELECT id::text AS id, line_margin_sen FROM scm.mfg_sales_order_items ORDER BY id`;
    expect(lines.map((l) => l.line_margin_sen)).toEqual([60000, -7000, 106000, 30000, 50000, 0, 60000]);

    const audit = await sql`SELECT so_doc_no, jsonb_typeof(field_changes) AS shape, field_changes, source, status_snapshot FROM scm.mfg_so_audit_log ORDER BY so_doc_no`;
    expect(audit.map((a) => [a.so_doc_no, a.shape, a.source, a.status_snapshot])).toEqual([
      ['HC-SO-000001', 'array', 'script:repair-so-margin-fields', 'DELIVERED'],
      ['HC-SO-2609-013', 'array', 'script:repair-so-margin-fields', 'CONFIRMED'],
    ]);
    expect(audit[0].field_changes).toEqual([
      { field: 'total_revenue_sen', from: 0, to: 100000 },
      { field: 'total_margin_sen', from: -47000, to: 53000 },
      { field: 'margin_pct_basis', from: 0, to: 5300 },
      { field: 'line_M-1(K)_line_margin_sen', from: 0, to: 60000, lineId: L(1) },
      { field: 'line_P-1_line_margin_sen', from: 0, to: -7000, lineId: L(2) },
    ]);

    // The repair's own row went to the reconcile lane; the live save's row kept its lane.
    const queue = await sql`SELECT doc_no, op, revision FROM scm.venture_portal_outbox WHERE status = 'pending' ORDER BY doc_no`;
    expect(queue.map((q) => [q.doc_no, q.op, q.revision > 0])).toEqual([
      ['HC-SO-000001', 'RECONCILE', true],
      ['HC-SO-2609-013', 'UPDATE', true],
    ]);
    expect(r.laned).toBe(1);

    // RE-RUN: nothing left to plan.
    expect(planCompanyMargins(await readOrderMargins(sql, 1), LEFT_ALONE).todo).toEqual([]);
  });

  // Owner 2026-11-21: fix the ERP first; whether to send is a separate decision.
  test('hold corrects the ERP and sends nothing: the repair\'s own queue rows are skipped with a note', async () => {
    const plan = planCompanyMargins(await readOrderMargins(sql, 1), LEFT_ALONE);
    const r = await sql.begin((tx) => writeMarginChunk(tx, 1, plan.todo, 'hold'));
    expect({ lines: r.lines, heads: r.heads, held: r.held, laned: r.laned }).toEqual({ lines: 3, heads: 2, held: 1, laned: 0 });
    const [h] = await sql`SELECT total_revenue_sen, total_margin_sen, margin_pct_basis FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-000001'`;
    expect([h.total_revenue_sen, h.total_margin_sen, h.margin_pct_basis]).toEqual([100000, 53000, 5300]);
    const rows = await sql`SELECT doc_no, op, status, last_error FROM scm.venture_portal_outbox ORDER BY doc_no`;
    expect(rows.map((q) => [q.doc_no, q.status, q.last_error])).toEqual([
      ['HC-SO-000001', 'skipped', PORTAL_HOLD_NOTE],
      // Queued by a live save before the repair: it sends the order as it stands, as any save does.
      ['HC-SO-2609-013', 'pending', null],
    ]);
    // A later save of the held order queues it again, as always.
    await sql`UPDATE scm.mfg_sales_order_items SET line_cost_sen = 41000, line_margin_sen = 59000 WHERE id = ${L(1)}`;
    const [again] = await sql`SELECT count(*)::int AS n FROM scm.venture_portal_outbox WHERE doc_no = 'HC-SO-000001' AND status = 'pending'`;
    expect(again.n).toBe(1);
  });

  test('the normal lane leaves the queue rows as the triggers wrote them', async () => {
    const plan = planCompanyMargins(await readOrderMargins(sql, 1), LEFT_ALONE);
    const r = await sql.begin((tx) => writeMarginChunk(tx, 1, plan.todo, 'normal'));
    expect(r.laned).toBe(0);
    const [row] = await sql`SELECT op FROM scm.venture_portal_outbox WHERE doc_no = 'HC-SO-000001' AND status = 'pending'`;
    expect(row.op).toBe('UPDATE:mfg_sales_order_items');
  });

  test('a line or header edited after the plan is left alone', async () => {
    const plan = planCompanyMargins(await readOrderMargins(sql, 1), LEFT_ALONE);
    // A save between the plan and the write: a new line cost, a new order total.
    await sql`UPDATE scm.mfg_sales_order_items SET line_cost_sen = 41000 WHERE id = ${L(1)}`;
    await sql`UPDATE scm.mfg_sales_orders SET local_total_sen = 110000 WHERE doc_no = 'HC-SO-000001'`;
    const r = await sql.begin((tx) => writeMarginChunk(tx, 1, plan.todo, 'background'));
    const [h] = await sql`SELECT total_revenue_sen, total_margin_sen FROM scm.mfg_sales_orders WHERE doc_no = 'HC-SO-000001'`;
    expect([h.total_revenue_sen, h.total_margin_sen]).toEqual([0, -47000]);
    const [l1] = await sql`SELECT line_margin_sen FROM scm.mfg_sales_order_items WHERE id = ${L(1)}`;
    expect(l1.line_margin_sen).toBe(0);
    const first = r.audited.find((a) => a.o.h.doc_no === 'HC-SO-000001');
    expect(first?.complete).toBe(false);
    expect(first?.fc).toEqual([{ field: 'line_P-1_line_margin_sen', from: 0, to: -7000, lineId: L(2) }]);
  });

  test('a company 1 chunk never writes another company', async () => {
    const plan = planCompanyMargins(await readOrderMargins(sql, 1), LEFT_ALONE);
    // Point a planned line at company 2's row: the company predicate must refuse it.
    const forged = [{ ...plan.todo[1], plan: { ...plan.todo[1].plan, header: null, lines: [{ id: L(7), from: 60000, to: 35000 }] } }];
    const r = await sql.begin((tx) => writeMarginChunk(tx, 1, forged, 'normal'));
    expect(r.lines).toBe(0);
    const [l7] = await sql`SELECT line_margin_sen FROM scm.mfg_sales_order_items WHERE id = ${L(7)}`;
    expect(l7.line_margin_sen).toBe(60000);
  });
});
