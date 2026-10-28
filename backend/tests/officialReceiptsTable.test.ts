/* docs/bugs/0658 — the Official Receipt module never had its table. Its
   migration (20260905T1800) said `CREATE TABLE IF NOT EXISTS scm.acc_receipts`
   on a name 0351 had already given the general money-in receipt, so on every
   database the statement was a silent no-op, the tracker called the file
   applied, and or_number / payment_source / payment_id never existed: every
   receipt birth failed best-effort and /scm/official-receipts could not load.
   The fake client cannot see a table's shape, so this pins the SOURCE:
     • no two pg migrations may CREATE the same scm table name (the one
       historical collision is named here, and nowhere else may appear);
     • a migration creates scm.acc_official_receipts with the OR columns;
     • the OR module reads acc_official_receipts and never acc_receipts, and
       the general receipt route keeps acc_receipts and never the OR table.
   RED on the unfixed tree (no acc_official_receipts anywhere; the OR module
   on acc_receipts), green after. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const migDir = path.resolve(root, 'src/db/migrations-pg');
const read = (rel: string): string => readFileSync(path.resolve(root, rel), 'utf8');

/** The one collision history already holds — 0351 took the name, 20260905T1800
    silently lost it (docs/bugs/0658). Nothing else may join this list. */
const KNOWN_COLLISION: Record<string, string[]> = {
  acc_receipts: ['0351_acc_general_receipts.sql', '20260905T1800_official_receipts.sql'],
};

/** SQL with its `--` comment lines gone — a REVERSAL note or a WHY paragraph
    that QUOTES a CREATE TABLE (0332 does, and so does 20260907T1600) is not a
    statement. */
const statementsOnly = (sql: string): string => sql.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');

/** Every `CREATE TABLE [IF NOT EXISTS] scm.<name>` across the pg migrations → the files that say it. */
function createdScmTables(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(migDir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = statementsOnly(readFileSync(path.join(migDir, f), 'utf8'));
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:scm|"scm")\s*\.\s*"?([a-z_][a-z0-9_]*)"?/gi)) {
      const name = m[1]!.toLowerCase();
      const files = out.get(name) ?? [];
      if (!files.includes(f)) files.push(f);
      out.set(name, files);
    }
  }
  return out;
}

describe('one scm table name, one migration (docs/bugs/0658)', () => {
  const created = createdScmTables();

  it('no two pg migrations create the same scm table, beyond the one collision history holds', () => {
    const dupes: string[] = [];
    for (const [name, files] of created) {
      if (files.length < 2) continue;
      const known = KNOWN_COLLISION[name];
      if (known && known.length === files.length && known.every((k) => files.includes(k))) continue;
      dupes.push(`${name}: ${files.join(' + ')}`);
    }
    expect(dupes, 'a second CREATE TABLE IF NOT EXISTS on a taken name is a silent no-op — give the table its own name').toEqual([]);
  });

  it('the known collision is still exactly the two files this test names', () => {
    expect(created.get('acc_receipts')).toEqual(KNOWN_COLLISION.acc_receipts);
  });

  it('a migration creates scm.acc_official_receipts with the OR columns', () => {
    const files = created.get('acc_official_receipts') ?? [];
    expect(files, 'no migration creates scm.acc_official_receipts').toHaveLength(1);
    const sql = readFileSync(path.join(migDir, files[0]!), 'utf8');
    const block = sql.slice(sql.search(/create\s+table\s+if\s+not\s+exists\s+scm\.acc_official_receipts/i));
    for (const col of ['or_number', 'payment_source', 'payment_id', 'channel_account_code', 'issued_at', 'amount_sen']) {
      expect(block, `column ${col}`).toMatch(new RegExp(`^\\s*${col}\\s`, 'm'));
    }
    expect(block).toMatch(/UNIQUE\s*\(\s*payment_source\s*,\s*payment_id\s*\)/);
    expect(sql).toMatch(/^-- REVERSAL:/m);
  });
});

describe('the Official Receipt module reads its own table (docs/bugs/0658)', () => {
  for (const f of ['src/acc/receipts.ts', 'src/scm/routes/accounting-receipts.ts']) {
    it(`${f} names acc_official_receipts and never acc_receipts`, () => {
      const src = read(f);
      expect(src).toContain("'acc_official_receipts'");
      expect(src, `${f} still reads the general receipt table`).not.toMatch(/'acc_receipts'/);
    });
  }

  it('the general receipt route keeps acc_receipts and never touches the OR table', () => {
    const src = read('src/scm/routes/receipts.ts');
    expect(src).toContain("'acc_receipts'");
    expect(src).not.toContain('acc_official_receipts');
  });
});
