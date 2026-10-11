/* EXECUTES every query behind `scripts/probe-transfer-census.mjs` against real
 * Postgres, for EVERY pair in the frozen pair table — not a shape test, not a
 * regex over the source. The statements run.
 *
 * WHY THIS EXISTS, precisely. A `workflow_dispatch` probe cannot be dispatched
 * until it is on the default branch, and there is no local database, so
 * `node --check` is the only evidence a probe has before its first production
 * run. That was not enough for `probe-undated-demand.mjs`: on its first dispatch
 * (run 31962771658, 2026-08-16) it died mid-run with
 *
 *     FAIL subquery uses ungrouped column "h.created_at" from outer query
 *
 * costing company 2's answer entirely plus a second dispatch of the owner's
 * time. `node --check` cannot see it, typecheck cannot see it, and vitest's
 * Worker pool has no Postgres. Only Postgres can parse Postgres, and CI already
 * runs one (`backend-postgres`'s postgres:16 service).
 *
 * This probe is MORE exposed than that one, for two reasons this suite answers:
 *
 *  · Its census SQL is GENERIC over ten pairs, built by interpolating
 *    identifiers. A typo in one pair's column name is a runtime error that only
 *    that pair's arm reaches — so the loop below runs EVERY pair, and refuses to
 *    pass if the pair count drops.
 *  · `scm`'s DDL is not in this repo. `scripts/scm-schema/2990s-full-schema.sql`
 *    is a dump of the 2990 SOURCE system and is already known to be behind
 *    production: it has no `sales_invoice_items.do_item_id`, a column the SI
 *    converter writes on every DO-derived line. So the fixture below is built
 *    from the pair table itself rather than from that dump, and the probe checks
 *    the real columns at runtime via hasColumn/hasTable — which are also tested
 *    here, in BOTH directions, because a gate that always answers "present" is
 *    the same as no gate.
 *
 * SKIPPED, not failed, without TEST_DATABASE_URL, matching the other pg suites.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Q from '../scripts/lib/transfer-census-queries.mjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let sql: Sql;

type Pair = (typeof Q.PAIRS)[number];

/* The schema is DERIVED FROM THE PAIR TABLE, not hand-listed. A pair added to
   that table without a column here would otherwise fail as "relation does not
   exist" and read like a broken test rather than a missing declaration; built
   this way, the fixture cannot fall behind the thing it exists to exercise. */
async function schema(db: Sql) {
  const cols = new Map<string, Set<string>>();
  const need = (t: string, c: string) => {
    if (!cols.has(t)) cols.set(t, new Set(['id']));
    cols.get(t)!.add(c);
  };
  for (const p of Q.PAIRS as readonly Pair[]) {
    need(p.srcTable, p.srcQty); need(p.srcTable, 'company_id');
    need(p.dstTable, p.dstQty); need(p.dstTable, p.binding); need(p.dstTable, 'company_id');
    need(p.dstTable, p.dstParentFk); need(p.dstParent, 'status');
  }
  // The window / histogram / doc-no queries touch these directly.
  need('purchase_order_items', 'qty'); need('purchase_order_items', 'received_qty');
  need('purchase_order_items', 'purchase_order_id'); need('purchase_order_items', 'material_code');
  need('purchase_orders', 'status'); need('purchase_orders', 'po_number');
  need('purchase_orders', 'company_id');
  need('grn_items', 'purchase_order_item_id');

  const numeric = new Set(['company_id']);
  const ddl = [...cols.entries()].map(([t, cs]) => {
    const defs = [...cs].map((c) => {
      if (c === 'id') return 'id uuid PRIMARY KEY DEFAULT gen_random_uuid()';
      if (numeric.has(c)) return `${c} int`;
      if (c === 'status' || c === 'po_number' || c === 'material_code') return `${c} text`;
      if (c.endsWith('_id')) return `${c} uuid`;
      return `${c} numeric`;            // every qty / tally column
    });
    return `CREATE TABLE scm.${t} (${defs.join(', ')});`;
  }).join('\n');

  await db.unsafe(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    CREATE TABLE IF NOT EXISTS public.companies (
      id int PRIMARY KEY, code text, name text, is_active int
    );
    ${ddl}
  `);
}

/* Two companies, so every figure is proved to be SCOPED — a census that sums
   across books is the correction CLAUDE.md records against audit numbers. */
async function seedCompanies(db: Sql) {
  await db.unsafe(`
    INSERT INTO public.companies (id, code, name, is_active) VALUES
      (1, 'HOUZS', 'Houzs Century', 1),
      (2, '2990',  '2990 Furniture', 1)
    ON CONFLICT (id) DO NOTHING;
  `);
}

/* A PO fixture with the exact shape the owner reported: an outstanding PO that
   the OLD window could not reach. `purchase_order_id` is chosen so that ordering
   by it DESC puts the offender LAST — that is the whole mechanism. */
async function seedPoWindow(db: Sql) {
  await db.unsafe(`
    -- Two POs. 'ffff…' sorts FIRST under DESC, '0000…' sorts LAST.
    INSERT INTO scm.purchase_orders (id, po_number, status, company_id) VALUES
      ('ffffffff-0000-0000-0000-000000000001', 'PO-NEWEST',  'SUBMITTED',          1),
      ('00000000-0000-0000-0000-000000000001', 'PO-HIDDEN',  'SUBMITTED',          1),
      ('00000000-0000-0000-0000-000000000002', 'PO-DRAFT',   'DRAFT',              1),
      ('00000000-0000-0000-0000-000000000003', 'PO-DONE',    'RECEIVED',           1),
      ('00000000-0000-0000-0000-000000000004', 'PO-OTHERCO', 'SUBMITTED',          2);

    -- PO-NEWEST: three FULLY RECEIVED lines. They are not outstanding, but under
    -- the old query they still consumed the window, because the remaining-qty
    -- filter ran in JavaScript AFTER the limit. This is mechanism #1.
    INSERT INTO scm.purchase_order_items (purchase_order_id, qty, received_qty, company_id, material_code) VALUES
      ('ffffffff-0000-0000-0000-000000000001', 5, 5, 1, 'AAA'),
      ('ffffffff-0000-0000-0000-000000000001', 5, 5, 1, 'BBB'),
      ('ffffffff-0000-0000-0000-000000000001', 5, 5, 1, 'CCC'),
      -- PO-HIDDEN: genuinely outstanding, never received, sorts last.
      ('00000000-0000-0000-0000-000000000001', 4, 0, 1, 'HID1'),
      ('00000000-0000-0000-0000-000000000001', 2, 1, 1, 'HID2'),
      -- a DRAFT parent: unreceived, and correctly excluded by the status filter
      ('00000000-0000-0000-0000-000000000002', 9, 0, 1, 'DRF1'),
      -- a RECEIVED parent holding an unreceived line: the status filter hides it
      -- and the operator is told the goods arrived. Mechanism #2.
      ('00000000-0000-0000-0000-000000000003', 7, 3, 1, 'RCV1'),
      -- company 2, must never appear in company 1's figures
      ('00000000-0000-0000-0000-000000000004', 6, 0, 2, 'OTH1');
  `);
}

/* One deliberate DOUBLE TRANSFER and one deliberate UNBOUND line on the PO->GRN
   pair, so the census is proved non-vacuous rather than merely non-crashing. */
async function seedDoubleTransfer(db: Sql) {
  await db.unsafe(`
    INSERT INTO scm.grns (id, status) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', 'POSTED'),
      ('aaaaaaaa-0000-0000-0000-000000000002', 'POSTED'),
      ('aaaaaaaa-0000-0000-0000-000000000003', 'CANCELLED');

    -- HID1 has qty 4. Two POSTED GRNs take 4 and 3 → 7 moved, over by 3.
    INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted, company_id)
    SELECT 'aaaaaaaa-0000-0000-0000-000000000001', i.id, 4, 1
      FROM scm.purchase_order_items i WHERE i.material_code = 'HID1';
    INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted, company_id)
    SELECT 'aaaaaaaa-0000-0000-0000-000000000002', i.id, 3, 1
      FROM scm.purchase_order_items i WHERE i.material_code = 'HID1';

    -- A CANCELLED GRN takes 99 and must NOT count: every converter releases it.
    INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted, company_id)
    SELECT 'aaaaaaaa-0000-0000-0000-000000000003', i.id, 99, 1
      FROM scm.purchase_order_items i WHERE i.material_code = 'HID2';

    -- An UNBOUND GRN line: takes stock in, ticks nothing off, invisible to the
    -- ceiling. One of the two KNOWN EXPOSURES in convert-ceilings.test.ts.
    INSERT INTO scm.grn_items (grn_id, purchase_order_item_id, qty_accepted, company_id)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', NULL, 8, 1);
  `);
}

describePg('probe-transfer-census SQL — every statement runs on real Postgres', () => {
  beforeAll(async () => {
    sql = postgres(url, { max: 1, prepare: false });
    await schema(sql);
    await seedCompanies(sql);
    await seedPoWindow(sql);
    await seedDoubleTransfer(sql);
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  test('the pair table is frozen and did not shrink', () => {
    expect(Q.PAIRS.length).toBe(10);
    expect(Object.isFrozen(Q.PAIRS)).toBe(true);
    // SO -> PO is absent by the owner's 2026-08-17 ruling, not by oversight.
    expect(Q.PAIRS.map((p) => p.key)).not.toContain('so_to_po');
  });

  test('EVERY pair executes both censuses — a generic query is only as sound as its worst pair', async () => {
    for (const pair of Q.PAIRS as readonly Pair[]) {
      const over = await Q.doubleTransferred(sql, pair, 1);
      expect(Array.isArray(over), `${pair.key}: doubleTransferred returned a non-array`).toBe(true);
      expect(over[0], `${pair.key}: no row`).toHaveProperty('lines_over');
      const rows = await Q.doubleTransferredRows(sql, pair, 1, 5);
      expect(Array.isArray(rows), `${pair.key}: doubleTransferredRows`).toBe(true);
      const bind = await Q.unboundDestLines(sql, pair, 1);
      expect(bind[0], `${pair.key}: unboundDestLines`).toHaveProperty('unbound');
    }
  });

  test('pairIdentifiers names every identifier the census interpolates', async () => {
    for (const pair of Q.PAIRS as readonly Pair[]) {
      const ids = Q.pairIdentifiers(pair);
      // The fixture is built from the same table, so every one must resolve.
      for (const { table, column } of ids) {
        const [r] = column === null
          ? await Q.hasTable(sql, 'scm', table)
          : await Q.hasColumn(sql, 'scm', table, column);
        expect(r!.n, `${pair.key}: scm.${table}${column ? `.${column}` : ''} not found`).toBe(1);
      }
    }
  });

  test('hasColumn / hasTable answer truthfully in BOTH directions', async () => {
    // A gate that always says "present" is the same as no gate at all.
    expect((await Q.hasColumn(sql, 'scm', 'purchase_order_items', 'received_qty'))[0]!.n).toBe(1);
    expect((await Q.hasColumn(sql, 'scm', 'purchase_order_items', 'no_such_col'))[0]!.n).toBe(0);
    expect((await Q.hasTable(sql, 'scm', 'grn_items'))[0]!.n).toBe(1);
    expect((await Q.hasTable(sql, 'scm', 'no_such_table'))[0]!.n).toBe(0);
  });

  test('companies executes and is ordered', async () => {
    const rows = await Q.companies(sql);
    expect(rows.map((r) => (r as { id: number }).id)).toEqual([1, 2]);
  });

  // ── The figures, not just the execution ─────────────────────────────────
  describe('the old window — the owner\'s zero-row screen, reproduced', () => {
    test('at LIMIT 3 the outstanding PO is COMPLETELY hidden, which is the bug', async () => {
      // Three fully-received lines on the highest-sorting PO eat the whole
      // window; PO-HIDDEN's two outstanding lines never arrive.
      const [w] = await Q.oldWindowBlastRadius(sql, 1, 3);
      expect(w!.outstanding_total).toBe(2);        // HID1 + HID2
      expect(w!.outstanding_in_window).toBe(0);    // the picker saw NONE of them
      expect(w!.outstanding_hidden).toBe(2);
      expect(w!.pos_with_outstanding).toBe(1);
      expect(w!.pos_hidden).toBe(1);               // PO-HIDDEN, entirely invisible
    });

    test('at a LIMIT big enough for the whole table nothing is hidden', async () => {
      const [w] = await Q.oldWindowBlastRadius(sql, 1, 1000);
      expect(w!.outstanding_hidden).toBe(0);
      expect(w!.pos_hidden).toBe(0);
      expect(w!.outstanding_in_window).toBe(2);
    });

    test('the window is scoped per company — company 2 is measured on its own', async () => {
      const [w] = await Q.oldWindowBlastRadius(sql, 2, 500);
      expect(w!.po_lines_total).toBe(1);
      expect(w!.outstanding_total).toBe(1);
    });

    test('a DRAFT or RECEIVED parent is NOT counted as outstanding by this query', async () => {
      // DRF1 (9 unreceived) and RCV1 (4 unreceived) exist, and outstanding_total
      // is 2 — so the status filter is doing real work here, not nothing.
      const [w] = await Q.oldWindowBlastRadius(sql, 1, 1000);
      expect(w!.outstanding_total).toBe(2);
    });
  });

  describe('the status histogram', () => {
    test('reports every status holding unreceived lines and marks the excluded ones', async () => {
      const rows = await Q.poStatusHistogram(sql, 1) as unknown as Array<{
        status: string; pos: number; unreceived_lines: number; excluded_by_picker: boolean;
      }>;
      const byStatus = new Map(rows.map((r) => [r.status, r]));
      expect(byStatus.get('SUBMITTED')!.excluded_by_picker).toBe(false);
      expect(byStatus.get('DRAFT')!.excluded_by_picker).toBe(true);
      // THE FINDING SHAPE: a RECEIVED PO holding an unreceived line. The picker
      // hides it and used to say the goods had arrived.
      expect(byStatus.get('RECEIVED')!.excluded_by_picker).toBe(true);
      expect(byStatus.get('RECEIVED')!.unreceived_lines).toBe(1);
    });

    test('a NULL status is reported as (null) rather than silently dropped', async () => {
      await sql.unsafe(`
        INSERT INTO scm.purchase_orders (id, po_number, status, company_id)
        VALUES ('00000000-0000-0000-0000-0000000000ff', 'PO-NULLSTATUS', NULL, 1);
        INSERT INTO scm.purchase_order_items (purchase_order_id, qty, received_qty, company_id, material_code)
        VALUES ('00000000-0000-0000-0000-0000000000ff', 3, 0, 1, 'NUL1');
      `);
      const rows = await Q.poStatusHistogram(sql, 1) as unknown as Array<{
        status: string; excluded_by_picker: boolean;
      }>;
      const nul = rows.find((r) => r.status === '(null)');
      expect(nul, 'a NULL-status PO vanished from the histogram').toBeDefined();
      expect(nul!.excluded_by_picker).toBe(true);
      await sql.unsafe(`
        DELETE FROM scm.purchase_order_items WHERE material_code = 'NUL1';
        DELETE FROM scm.purchase_orders WHERE po_number = 'PO-NULLSTATUS';
      `);
    });
  });

  describe('the double-transfer census is non-vacuous', () => {
    test('a line transferred PAST its own quantity is found, with the overshoot', async () => {
      const pair = (Q.PAIRS as readonly Pair[]).find((p) => p.key === 'po_to_grn')!;
      const [r] = await Q.doubleTransferred(sql, pair, 1) as unknown as Array<{
        lines_over: number; units_over: string; worst_line: string;
      }>;
      expect(r!.lines_over).toBe(1);          // HID1: qty 4, moved 4 + 3 = 7
      expect(Number(r!.units_over)).toBe(3);
      expect(Number(r!.worst_line)).toBe(3);
    });

    test('a CANCELLED destination document does NOT count — it released its qty', async () => {
      // HID2 has qty 2 and a CANCELLED GRN line for 99. Counting it would report
      // a 97-unit overshoot that does not exist.
      const pair = (Q.PAIRS as readonly Pair[]).find((p) => p.key === 'po_to_grn')!;
      const rows = await Q.doubleTransferredRows(sql, pair, 1, 10) as unknown as Array<{ over_by: string }>;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.over_by)).toBe(3);
    });

    test('the offender rows name the source line and are ordered worst-first', async () => {
      const pair = (Q.PAIRS as readonly Pair[]).find((p) => p.key === 'po_to_grn')!;
      const rows = await Q.doubleTransferredRows(sql, pair, 1, 10) as unknown as Array<{
        src_id: string; src_qty: string; qty_moved: string;
      }>;
      expect(Number(rows[0]!.src_qty)).toBe(4);
      expect(Number(rows[0]!.qty_moved)).toBe(7);
      expect(rows[0]!.src_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('the census is scoped per company', async () => {
      const pair = (Q.PAIRS as readonly Pair[]).find((p) => p.key === 'po_to_grn')!;
      const [r] = await Q.doubleTransferred(sql, pair, 2) as unknown as Array<{ lines_over: number }>;
      expect(r!.lines_over).toBe(0);
    });
  });

  describe('the unbound-binding census is non-vacuous', () => {
    test('a NULL binding on a live destination line is counted', async () => {
      const pair = (Q.PAIRS as readonly Pair[]).find((p) => p.key === 'po_to_grn')!;
      const [r] = await Q.unboundDestLines(sql, pair, 1) as unknown as Array<{
        total: number; unbound: number; bound: number;
      }>;
      // Three lines sit on POSTED GRNs (4, 3, and the unbound 8). The 99 sits on
      // a CANCELLED one and is outside the live set entirely.
      expect(r!.total).toBe(3);
      expect(r!.unbound).toBe(1);
      expect(r!.bound).toBe(2);
      expect(r!.bound + r!.unbound).toBe(r!.total);
    });
  });

  describe('the screenshot lookup', () => {
    test('an outstanding, receivable PO is returned line by line', async () => {
      const rows = await Q.poByDocNo(sql, 'PO-HIDDEN') as unknown as Array<{
        status: string; material_code: string; remaining: string; grn_lines: number;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.status).toBe('SUBMITTED');
      expect(rows.map((r) => r.material_code)).toEqual(['HID1', 'HID2']);
      expect(Number(rows.find((r) => r.material_code === 'HID1')!.remaining)).toBe(4);
    });

    test('the lookup is case-insensitive on the document number', async () => {
      expect(await Q.poByDocNo(sql, 'po-hidden')).toHaveLength(2);
    });

    test('a PO with no line items still returns its HEADER, not an empty set', async () => {
      // Otherwise "this PO does not exist" and "this PO has no lines" collapse
      // into one answer, which is the class of bug this whole probe is about.
      await sql.unsafe(`
        INSERT INTO scm.purchase_orders (id, po_number, status, company_id)
        VALUES ('00000000-0000-0000-0000-0000000000ee', 'PO-EMPTY', 'SUBMITTED', 1);
      `);
      const rows = await Q.poByDocNo(sql, 'PO-EMPTY') as unknown as Array<{
        po_item_id: string | null; status: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.po_item_id).toBeNull();
      expect(rows[0]!.status).toBe('SUBMITTED');
    });

    test('an unknown document number returns nothing, which the probe reports as its own outcome', async () => {
      expect(await Q.poByDocNo(sql, 'PO-DOES-NOT-EXIST')).toHaveLength(0);
    });
  });
});
