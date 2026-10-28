// The five statement layouts SHIPPED IN MIGRATION 0338, each run against the
// committed fixture it claims to read.
//
// Same shape and same reason as bankRecognitionSeed.test.mjs one file over: a
// layout that drifts from what the parser expects fails SILENTLY — the setup
// screen would say "taught" while every upload of that acquirer's real file
// is refused. Every other test supplies its own config; this one reads what
// actually ships to the database.
//
// tests/.mjs because it reads the migration off disk (node:fs — src/ compiles
// for Workers and may not).

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseStatement } from '../src/acc/settlement-parse';

const sql = readFileSync(
  new URL('../src/db/migrations-pg/0338_acc_acquirer_layout_seed.sql', import.meta.url),
  'utf8',
);

/* Pull each seeded VALUES row out of the migration:
     ('CODE', 'NAME', 'CSV', TRUE|FALSE, 'method', N, '{...}'::jsonb,
      <label|NULL>, <'{...}'::jsonb|NULL>, TRUE|FALSE, TRUE) */
const ROW_RE =
  /\('([A-Z]+)',\s*'[^']+',\s*'(CSV|XLSX|PDF)',\s*(TRUE|FALSE),\s*'([a-z-]+)',\s*(\d+),\s*'(\{[^}]*\})'::jsonb,\s*(NULL|'[^']*'),\s*(NULL|'(\{[^}]*\})'::jsonb),\s*(TRUE|FALSE),\s*TRUE\)/g;

const seeded = [...sql.matchAll(ROW_RE)].map((m) => ({
  code: m[1],
  statement_format: m[2],
  has_unique_ref: m[3] === 'TRUE',
  fee_method: m[4],
  date_tolerance_days: Number(m[5]),
  column_map: JSON.parse(m[6]),
  total_net_label: m[7] === 'NULL' ? null : m[7].slice(1, -1),
  summary_totals: m[9] ? JSON.parse(m[9]) : null,
  dates_have_no_year: m[10] === 'TRUE',
}));

const byCode = Object.fromEntries(seeded.map((s) => [s.code, s]));
const fixture = (name) =>
  readFileSync(new URL(`../../demo-statements/${name}`, import.meta.url), 'utf8');

const cfg = (code, extra = {}) => ({ ...byCode[code], ...extra });

describe('the layouts migration 0338 actually seeds', () => {
  it('seeds exactly the five acquirers, each fully taught', () => {
    expect(seeded.map((s) => s.code).sort()).toEqual(['AEON', 'GHL', 'HLB', 'MBB', 'PBB']);
    for (const s of seeded) {
      expect(s.column_map.date, `${s.code} date column`).toBeTruthy();
      expect(s.column_map.gross, `${s.code} gross column`).toBeTruthy();
    }
  });

  it('never overwrites a taught row — the update is scoped to statement_format IS NULL', () => {
    expect(sql).toMatch(/WHERE scm\.acc_acquirer_config\.statement_format IS NULL/);
    /* And display_name is not in the update list: it is what the sales panel
       stores in merchant_provider, never this migration's to change. */
    const updateClause = sql.slice(sql.indexOf('ON CONFLICT'));
    expect(updateClause).not.toMatch(/display_name\s*=/);
  });

  it('HLB: the seeded layout reads the committed HLB fixture', () => {
    const r = parseStatement(cfg('HLB', { statementMonth: '2026-08' }), fixture('HLB-Aug.csv'));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("MBB: the seeded summary_totals reads the fee off the file's own TOTAL row", () => {
    const r = parseStatement(cfg('MBB'), fixture('MBB-credit-Aug.csv'));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
    /* prorated-summary: every line's fee comes from the summary figure */
    expect(r.rows.reduce((s, x) => s + x.feeSen, 0)).toBeGreaterThan(0);
  });

  it('GHL: the seeded layout reads the committed GHL fixture', () => {
    const r = parseStatement(cfg('GHL'), fixture('GHL-Aug.csv'));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('PBB: gross-minus-net on the quoted DDMMYYYY layout, to the sen', () => {
    const r = parseStatement(cfg('PBB'), fixture('PBB-2990HOME-Jun.csv'));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.feeSen, `${row.ref} fee = gross - net`).toBe(row.grossSen - row.netSen);
    }
  });

  it("AEON: the seeded total_net_label makes the file's own stated total the check", () => {
    const r = parseStatement(cfg('AEON'), fixture('AEON-Aug.csv'));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.statedNetSen, 'the statement-level net was read').not.toBeNull();
  });
});
