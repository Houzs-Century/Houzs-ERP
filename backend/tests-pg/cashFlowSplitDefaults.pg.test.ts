import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';
import { validateLayout, type Layout, type LayoutCategory, type LayoutItem } from '../src/acc/report-layout';

/* Migration *_acc_cash_flow_split_defaults.sql on real Postgres (owner 2026-11-09: each
 * group's Settlement / Deposit column as his workbook has it, set on the saved Cash Flow
 * tree). Proves: the seven categories get their parts wherever they sit in the tree; a
 * split already there is kept; nothing else changes; the tree still validates; a second
 * run changes nothing; the other reports' trees are not touched.
 * SKIPPED without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const migration = (): string => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('_acc_cash_flow_split_defaults.sql'));
  if (files.length !== 1) throw new Error(`expected one *_acc_cash_flow_split_defaults.sql, found ${files.length}`);
  return readFileSync(join(migrationsDir, files[0]!), 'utf8');
};

const cat = (id: string, label: string, children: unknown[], extra: Record<string, unknown> = {}) => ({ kind: 'category', id, label, ...extra, children });
const acc = (code: string, flow = 'net') => ({ kind: 'account', code, flow });
const TREE = {
  version: 1,
  blocks: {
    accounts: [
      cat('cf:in', 'CASH IN', [cat('cf:in:deposit', 'DEPOSIT RECEIVED', [acc('300-0000', 'in')])], { flow: 'in', totalLabel: 'Total Cash In' }),
      cat('cf:ops', 'OPERATIONS OUTFLOWS', [
        cat('cf:ops:cost', 'COST OF FUNDS', [cat('cf:ops:cost:purchases', 'PURCHASES', [acc('601-0003')])]),
        cat('cf:ops:exh', 'EXHIBITION & ROADSHOW EXPENSE', [acc('900-R031'), cat('cf:ops:cost:transport', 'TRANSPORT & LOGISTICS', [acc('900-T004')])]),
        /* The owner already set this one: it stays. */
        cat('cf:ops:warehouse', 'WAREHOUSE EXPENSE', [acc('900-R002')], { split: { settlement: 1, deposit: 1 } }),
        cat('cf:ops:general', 'GENERAL EXPENSES', [acc('900-S001')]),
        cat('cf:ops:showroom', 'SHOWROOMS EXPENSE', [acc('900-R048')]),
      ], { flow: 'out' }),
      { kind: 'subtotal', id: 'cf:sub:ops', label: 'NET OPERATION SURPLUS / (DEFICIT)' },
      cat('cf:tax', 'TAXATION', [acc('910-0000', 'out')], { flow: 'out' }),
    ],
  },
};
let sql: Sql;

const find = (items: LayoutItem[], id: string): LayoutCategory | null => {
  for (const it of items) {
    if (it.kind !== 'category') continue;
    if (it.id === id) return it;
    const hit = find(it.children, id);
    if (hit) return hit;
  }
  return null;
};

describePg('Cash Flow split defaults on the saved tree', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS scm;
      DROP TABLE IF EXISTS scm.acc_report_layouts CASCADE;
      CREATE TABLE scm.acc_report_layouts (report text PRIMARY KEY, tree jsonb NOT NULL, updated_at timestamptz, updated_by text);
    `);
    await sql`INSERT INTO scm.acc_report_layouts (report, tree, updated_at, updated_by) VALUES
      ('rp', ${sql.json(TREE)}, '2026-11-05T07:04:03Z', 'Chew'),
      ('pnl', ${sql.json({ version: 1, blocks: { expenses: [cat('cf:ops', 'Not the cash flow', [])] } })}, null, null)`;
    await sql.unsafe(migration());
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe('DROP TABLE IF EXISTS scm.acc_report_layouts CASCADE');
    await sql.end();
  });

  test('the seven groups get their parts wherever they sit; a split already set is kept; the tree still validates', async () => {
    const [row] = await sql`SELECT tree, updated_by FROM scm.acc_report_layouts WHERE report = 'rp'`;
    const items = (row!.tree as Layout).blocks.accounts!;
    const split = (id: string) => find(items, id)?.split ?? null;
    expect(split('cf:in')).toEqual({ settlement: 0, deposit: 1 });
    expect(split('cf:ops')).toEqual({ settlement: 1, deposit: 2 });
    expect(split('cf:ops:cost')).toEqual({ settlement: 1, deposit: 0 });
    expect(split('cf:ops:exh')).toEqual({ settlement: 0, deposit: 1 });
    expect(split('cf:ops:warehouse')).toEqual({ settlement: 1, deposit: 1 });
    expect(split('cf:ops:general')).toEqual({ settlement: 1, deposit: 2 });
    expect(split('cf:ops:showroom')).toEqual({ settlement: 0, deposit: 1 });
    /* Nested groups follow their parent; below the operations nothing is split. */
    expect([split('cf:in:deposit'), split('cf:ops:cost:purchases'), split('cf:ops:cost:transport'), split('cf:tax')]).toEqual([null, null, null, null]);
    expect(row!.updated_by).toBe('Chew');
    expect(validateLayout('rp', row!.tree).ok).toBe(true);
  });

  test('a second run changes nothing; the P&L tree is not touched', async () => {
    const [before] = await sql`SELECT tree FROM scm.acc_report_layouts WHERE report = 'rp'`;
    await sql.unsafe(migration());
    const [after] = await sql`SELECT tree FROM scm.acc_report_layouts WHERE report = 'rp'`;
    expect(after!.tree).toEqual(before!.tree);
    const [pnl] = await sql`SELECT tree FROM scm.acc_report_layouts WHERE report = 'pnl'`;
    expect(JSON.stringify(pnl!.tree)).not.toContain('split');
  });
});
