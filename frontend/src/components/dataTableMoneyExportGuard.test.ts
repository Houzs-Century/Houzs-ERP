// ----------------------------------------------------------------------------
// A DataTable money column exports RINGGIT, never the sen it sorts by.
//
// Owner 2026-09-15: 「我看到amount是那种150000，全部amount需要跟Autocount 的一样」 —
// the Purchase Order CSV held 1500000 for HC-PO-009304 (RM 15,000.00), because
// DataTable's Export writes `getValue`, and a money column keeps getValue in sen
// for sort and filter. `exportValue` (ringgit) + `exportFormat` (money/rate) is
// the per-column fix (#3935). This file finds every DataTable column whose cell
// renders money and fails when:
//   · it has no `exportFormat`, or
//   · its `getValue` reads a sen field and it has no `exportValue`.
// docs/bugs/0929-datatable-money-columns-exported-sen-integers-1500000-for-rm.md
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** A cell that prints money calls one of these. */
const MONEY_CALL = /\b(fmtRm|fmtRM|fmtSen|fmtMoney|fmtMoneySen|formatCurrency|fmtAmt|centiOrDash|money|rm)\s*\(/;
/** A getValue that returns sen. */
const SEN_READ = /(_sen|Sen)\b/;
/** …unless it already divides by 100 (that getValue is ringgit). */
const RINGGIT_ALREADY = /\/\s*100\b/;

type Col = { file: string; line: number; key: string; props: Set<string>; render: string; getValue: string };

function tableColumns(file: string): Col[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('getValue')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Col[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map<string, ts.ObjectLiteralElementLike>();
      for (const p of n.properties) if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) props.set(p.name.text, p);
      const render = props.get('render');
      const getValue = props.get('getValue');
      const key = props.get('key');
      if (render && getValue && key && ts.isPropertyAssignment(key) && !props.has('accessor')) {
        out.push({
          file: file.replace(/\\/g, '/'),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          key: key.initializer.getText(sf),
          props: new Set(props.keys()),
          render: render.getText(sf),
          getValue: getValue.getText(sf),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/* Lists another piece of parallel work is converting (owner 2026-09-15: SO/DO,
   GR/PI/SI, PO and returns each have an owner). An entry here is TEMPORARY: the
   stale-entry test fails the moment its file passes, so the exemption removes
   itself instead of outliving the work. */
const IN_FLIGHT_ELSEWHERE: Record<string, string> = {
  'src/pages/scm-v2/MfgSalesOrdersListV2.tsx': 'SO list export — owned by the SO/DO export work',
  'src/pages/scm-v2/MfgDeliveryOrdersListV2.tsx': 'DO list export — owned by the SO/DO export work',
  'src/pages/scm-v2/GoodsReceivedListV2.tsx': 'GR list export — owned by the GR/PI/SI export work',
  'src/pages/scm-v2/PurchaseInvoicesListV2.tsx': 'PI list export — owned by the GR/PI/SI export work',
  'src/pages/scm-v2/SalesInvoicesListV2.tsx': 'SI list export — owned by the GR/PI/SI export work',
  'src/pages/scm-v2/PurchaseOrdersListV2.tsx': 'PO list export — owned by the PO export work',
  'src/pages/scm-v2/PurchaseReturnsListV2.tsx': 'PR list export — owned by the returns export work',
  'src/pages/scm-v2/DeliveryReturnsListV2.tsx': 'DR list export — owned by the returns export work',
};

/* A column whose cell calls a money formatter but whose value is not an amount. */
const NOT_A_MONEY_COLUMN: Record<string, string> = {
  "src/pages/scm-v2/Inventory.tsx|'consignment'": 'a quantity of goods held for others; the cell only mentions value in its caption',
};

const all = walk('src').flatMap(tableColumns);
const money = all.filter((c) => MONEY_CALL.test(c.render) && !(`${c.file}|${c.key}` in NOT_A_MONEY_COLUMN));
const problem = (c: Col): string | null =>
  !c.props.has('exportFormat') ? 'no exportFormat'
    : SEN_READ.test(c.getValue) && !RINGGIT_ALREADY.test(c.getValue) && !c.props.has('exportValue') ? 'getValue reads sen and there is no exportValue'
      : null;

describe('a DataTable money column exports ringgit, formatted', () => {
  test('the scan finds table columns and money among them — a matcher that reads nothing must not pass', () => {
    expect(all.length).toBeGreaterThan(300);
    expect(money.length).toBeGreaterThan(80);
  });

  test('the matchers recognise the shapes they are written for', () => {
    expect(MONEY_CALL.test('render: (r) => <span>{fmtRm(r.total_sen)}</span>')).toBe(true);
    expect(MONEY_CALL.test('render: (r) => formatCurrency(r.rental)')).toBe(true);
    expect(MONEY_CALL.test('render: (r) => r.doc_no')).toBe(false);
    expect(SEN_READ.test('getValue: (r) => r.local_total_sen')).toBe(true);
    expect(SEN_READ.test('getValue: (r) => r.total_sales')).toBe(false);
  });

  test('no stale NOT_A_MONEY_COLUMN entry', () => {
    const present = new Set(all.map((c) => `${c.file}|${c.key}`));
    expect(Object.keys(NOT_A_MONEY_COLUMN).filter((k) => !present.has(k))).toEqual([]);
  });

  test('no IN_FLIGHT_ELSEWHERE entry has already been fixed (the exemption removes itself)', () => {
    const stillFailing = new Set(money.filter((c) => problem(c)).map((c) => c.file));
    expect(Object.keys(IN_FLIGHT_ELSEWHERE).filter((f) => !stillFailing.has(f))).toEqual([]);
  });

  test('every money column outside in-flight work has exportValue (when it sorts by sen) and exportFormat', () => {
    const missing = money
      .filter((c) => !(c.file in IN_FLIGHT_ELSEWHERE))
      .map((c) => [c, problem(c)] as const)
      .filter(([, p]) => p)
      .map(([c, p]) => `${c.file}:${c.line} ${c.key} — ${p}`);
    expect(missing).toEqual([]);
  });
});
