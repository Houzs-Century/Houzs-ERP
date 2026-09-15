// ----------------------------------------------------------------------------
// A money column that shows RM on screen must EXPORT ringgit, formatted.
//
// Owner 2026-09-15: 「我看到amount是那种150000，全部amount需要跟Autocount 的一样」.
// A grid column keeps its money in sen for sorting and filtering. The Export
// used to read that sort value (1500000 for RM 15,000.00), or the cell's text
// ("RM 15,000.00", which a sheet cannot sum), or nothing at all when the cell
// renders JSX. The fix is per column: `exportValue` returns ringgit and
// `exportFormat` says money/rate. This file finds every DataGrid column whose
// cell calls a money formatter and fails when either is missing, so a new
// column cannot bring the bug back.
// docs/bugs/0928-datagrid-export-wrote-money-as-rm-text-or-blank-cells-and-ha.md
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = 'src';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** A cell that prints money calls one of these. */
export const MONEY_CALL = /\b(fmtRm|fmtRM|fmtSen|fmtMoney|fmtMoneySen|formatCurrency|fmtAmt|rmField|money|rm)\s*\(/;

type Col = { file: string; line: number; key: string; props: Set<string>; accessorText: string };

function gridColumns(file: string): Col[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('accessor')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Col[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map<string, ts.ObjectLiteralElementLike>();
      for (const p of n.properties) if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) props.set(p.name.text, p);
      const acc = props.get('accessor');
      const key = props.get('key');
      if (acc && key && ts.isPropertyAssignment(key)) {
        out.push({
          file: file.replace(/\\/g, '/'),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          key: key.initializer.getText(sf),
          props: new Set(props.keys()),
          accessorText: acc.getText(sf),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/* A column whose cell mentions money but whose VALUE is not an amount. Each entry
   says why; a stale entry fails the test below. */
const NOT_A_MONEY_COLUMN: Record<string, string> = {
  "src/pages/scm-v2/PaymentVouchers.tsx|'status'": 'the status pill; the open-advance amount is a sub-caption, and the export is the queue word',
};

const all = walk(ROOT).flatMap(gridColumns);
const money = all.filter((c) => MONEY_CALL.test(c.accessorText) && !(`${c.file}|${c.key}` in NOT_A_MONEY_COLUMN));

describe('a DataGrid money column exports ringgit, formatted', () => {
  test('the scan finds grid columns and money among them — a matcher that reads nothing must not pass', () => {
    expect(all.length).toBeGreaterThan(200);
    expect(money.length).toBeGreaterThan(30);
  });

  test('the matcher recognises the shapes it is written for', () => {
    expect(MONEY_CALL.test('accessor: (r) => fmtRm(r.total_sen)')).toBe(true);
    expect(MONEY_CALL.test('accessor: (r) => <b>{fmtMoney(r.total_sen, r.currency)}</b>')).toBe(true);
    expect(MONEY_CALL.test('accessor: (r) => r.doc_no')).toBe(false);
  });

  test('no stale NOT_A_MONEY_COLUMN entry', () => {
    const present = new Set(all.map((c) => `${c.file}|${c.key}`));
    expect(Object.keys(NOT_A_MONEY_COLUMN).filter((k) => !present.has(k))).toEqual([]);
  });

  test('every money column has exportValue and exportFormat', () => {
    const missing = money
      .filter((c) => !c.props.has('exportValue') || !c.props.has('exportFormat'))
      .map((c) => `${c.file}:${c.line} ${c.key} — ${!c.props.has('exportValue') ? 'no exportValue' : 'no exportFormat'}`);
    expect(missing).toEqual([]);
  });
});
