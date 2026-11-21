// Sales order margin fields follow cost the way a save writes them (owner
// 2026-11-21, option A). Before: the nightly cost fill and the AutoCount import
// stamp wrote a line's cost without its margin, the fill wrote the header margin
// without the margin basis, recomputeTotals wrote a line margin only for a sofa
// set's spread, and the go-live import left imported orders' revenue at 0.
// Figures are made up.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { recomputeTotals } from '../src/scm/routes/mfg-sales-orders';
import {
  headerMarginOff, lineMarginSen, marginPctBasis, planOrderMargins, savedRevenueSen,
} from '../scripts/lib/so-margin.mjs';

/* Chainable supabase stub, as in soComboCostOrderDate.test.ts. */
function makeSb(resolve: (table: string, select: string, single: boolean) => unknown) {
  const updates: Array<{ table: string; patch: Record<string, unknown>; eqs: Array<[string, unknown]> }> = [];
  const makeBuilder = (table: string): unknown => {
    let select = '';
    let current: { table: string; patch: Record<string, unknown>; eqs: Array<[string, unknown]> } | null = null;
    const builder: any = new Proxy(() => undefined, {
      get(_t, prop: string) {
        if (prop === 'then') {
          const result = resolve(table, select, false);
          return (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(resolve(table, select, true));
        return (...args: unknown[]) => {
          if (prop === 'select') select = String(args[0] ?? '');
          if (prop === 'update') { current = { table, patch: (args[0] ?? {}) as Record<string, unknown>, eqs: [] }; updates.push(current); }
          if (prop === 'eq' && current) current.eqs.push([String(args[0]), args[1]]);
          return builder;
        };
      },
    });
    return builder;
  };
  return { sb: { from: (table: string) => makeBuilder(table), rpc: () => Promise.resolve({ data: null, error: null }) }, updates };
}

const ctx = { get: () => undefined } as any;

function orderWith(lines: Array<Record<string, unknown>>) {
  return makeSb((table, _select, single) => {
    if (table === 'mfg_sales_order_items') return { data: lines.map((l) => ({ ...l })), error: null };
    return single ? { data: null, error: null } : { data: [], error: null };
  });
}

const marginWrites = (updates: ReturnType<typeof makeSb>['updates']) =>
  updates.filter((u) => u.table === 'mfg_sales_order_items')
    .map((u) => ({ id: u.eqs.find(([k]) => k === 'id')?.[1], ...u.patch }));
const header = (updates: ReturnType<typeof makeSb>['updates']) =>
  updates.find((u) => u.table === 'mfg_sales_orders' && 'total_margin_sen' in u.patch)?.patch;

describe('recomputeTotals writes every line margin, not only a sofa spread', () => {
  test('a line costed by the nightly fill loses its full-price margin on the next save', async () => {
    const { sb, updates } = orderWith([
      // The mattress carries the bundle price; the fill stamped its cost and left the margin at the price.
      { id: 'mattress', item_code: 'M-1(K)', item_group: 'mattress', variants: null, qty: 1, total_sen: 308800, line_cost_sen: 130000, line_margin_sen: 308800 },
      // A RM 0 bundle line the fill costed: its margin is minus its cost.
      { id: 'pillow', item_code: 'P-1', item_group: 'accessories', variants: null, qty: 2, total_sen: 0, line_cost_sen: 4000, line_margin_sen: 0 },
      // Already right: not written.
      { id: 'frame', item_code: 'B-1(K)', item_group: 'bedframe', variants: null, qty: 1, total_sen: 50000, line_cost_sen: 20000, line_margin_sen: 30000 },
    ]);
    await recomputeTotals(sb, 'HC-SO-TEST-1', ctx);
    expect(marginWrites(updates)).toEqual([
      { id: 'mattress', line_margin_sen: 178800 },
      { id: 'pillow', line_margin_sen: -4000 },
    ]);
    expect(header(updates)).toMatchObject({
      total_revenue_sen: 358800, total_cost_sen: 154000, total_margin_sen: 204800, margin_pct_basis: 5708,
    });
  });

  test('an order whose line margins are right writes no line', async () => {
    const { sb, updates } = orderWith([
      { id: 'a', item_code: 'M-1(K)', item_group: 'mattress', variants: null, qty: 1, total_sen: 100000, line_cost_sen: 40000, line_margin_sen: 60000 },
    ]);
    await recomputeTotals(sb, 'HC-SO-TEST-2', ctx);
    expect(marginWrites(updates)).toEqual([]);
    expect(header(updates)).toMatchObject({ total_margin_sen: 60000, margin_pct_basis: 6000 });
  });
});

describe('lib/so-margin: the formulas a save uses', () => {
  test('margin basis is margin over revenue in basis points, 0 with no revenue', () => {
    expect(marginPctBasis(53000, 100000)).toBe(5300);
    expect(marginPctBasis(1, 3)).toBe(3333);
    expect(marginPctBasis(-50000, 100000)).toBe(-5000);
    expect(marginPctBasis(-40000, 0)).toBe(0);
  });

  test('a line margin is its total less its cost', () => {
    expect(lineMarginSen({ total_sen: 90000, line_cost_sen: 50000 })).toBe(40000);
    expect(lineMarginSen({ total_sen: 0, line_cost_sen: 3000 })).toBe(-3000);
  });

  test('headerMarginOff names a header whose margin or basis does not follow revenue and cost', () => {
    expect(headerMarginOff({ total_revenue_sen: 100000, total_cost_sen: 47000, total_margin_sen: 53000, margin_pct_basis: 5300 })).toBe(false);
    expect(headerMarginOff({ total_revenue_sen: 100000, total_cost_sen: 47000, total_margin_sen: 53000, margin_pct_basis: 9510 })).toBe(true);
    expect(headerMarginOff({ total_revenue_sen: 100000, total_cost_sen: 47000, total_margin_sen: 100000, margin_pct_basis: 5300 })).toBe(true);
  });

  test('revenue is the live lines, plus the header fee only when no fee line carries it', () => {
    const lines = [{ item_code: 'M-1', total_sen: 100000 }, { item_code: 'svc-delivery', total_sen: 5000 }];
    expect(savedRevenueSen({ delivery_fee_sen: 5000 }, lines)).toBe(105000);
    expect(savedRevenueSen({ delivery_fee_sen: 5000 }, [lines[0]])).toBe(105000);
    expect(savedRevenueSen({ delivery_fee_sen: 0 }, [lines[0]])).toBe(100000);
  });
});

const imported = {
  doc_no: 'HC-SO-000001', status: 'DELIVERED', local_total_sen: 100000, total_revenue_sen: 0,
  total_cost_sen: 47000, total_margin_sen: -47000, margin_pct_basis: 0, delivery_fee_sen: 0,
};
const importedLines = [
  { id: 'l1', item_code: 'M-1(K)', total_sen: 100000, line_cost_sen: 40000, line_margin_sen: 0, cancelled: false },
  { id: 'l2', item_code: 'P-1', total_sen: 0, line_cost_sen: 7000, line_margin_sen: 0, cancelled: false },
];

describe('planOrderMargins: what the repair writes', () => {
  test('an imported order takes its order total as revenue, and its lines their margins', () => {
    expect(planOrderMargins(imported, importedLines)).toEqual({
      status: 'ok',
      header: { total_revenue_sen: 100000, total_margin_sen: 53000, margin_pct_basis: 5300 },
      revenueFilled: true,
      lines: [{ id: 'l1', from: 0, to: 60000 }, { id: 'l2', from: 0, to: -7000 }],
    });
  });

  test('revenue 0 whose lines do not add up to the order total is refused, not guessed', () => {
    const lines = [{ ...importedLines[0], total_sen: 80000 }, importedLines[1]];
    expect(planOrderMargins(imported, lines)).toEqual({ status: 'refused', why: 'its revenue is 0 and its lines do not add up to its order total' });
  });

  test('a header cost that is not the sum of its lines is refused', () => {
    expect(planOrderMargins({ ...imported, total_cost_sen: 50000 }, importedLines).status).toBe('refused');
  });

  test('a revenue that differs from the order total any other way is refused', () => {
    expect(planOrderMargins({ ...imported, total_revenue_sen: 90000 }, importedLines)).toEqual({ status: 'refused', why: 'its revenue is not its order total' });
  });

  test('a stale margin basis alone moves only the basis', () => {
    const h = { ...imported, total_revenue_sen: 100000, total_margin_sen: 53000, margin_pct_basis: 9510 };
    const lines = [{ ...importedLines[0], line_margin_sen: 60000 }, { ...importedLines[1], line_margin_sen: -7000 }];
    expect(planOrderMargins(h, lines)).toEqual({
      status: 'ok', header: { total_revenue_sen: 100000, total_margin_sen: 53000, margin_pct_basis: 5300 }, revenueFilled: false, lines: [],
    });
  });

  test('an order already right plans nothing, so a second run writes nothing', () => {
    const h = { ...imported, total_revenue_sen: 100000, total_margin_sen: 53000, margin_pct_basis: 5300 };
    const lines = [{ ...importedLines[0], line_margin_sen: 60000 }, { ...importedLines[1], line_margin_sen: -7000 }];
    expect(planOrderMargins(h, lines)).toEqual({ status: 'ok', header: null, revenueFilled: false, lines: [] });
  });

  test('an order with no total keeps revenue 0, as a save would', () => {
    const h = { ...imported, local_total_sen: 0 };
    const lines = [{ ...importedLines[1] }];
    expect(planOrderMargins({ ...h, total_cost_sen: 7000, total_margin_sen: -7000 }, lines)).toEqual({
      status: 'ok', header: null, revenueFilled: false, lines: [{ id: 'l2', from: 0, to: -7000 }],
    });
  });

  test('a cancelled line is not part of the order', () => {
    const lines = [...importedLines, { id: 'gone', item_code: 'X', total_sen: 999, line_cost_sen: 5, line_margin_sen: 0, cancelled: true }];
    const plan = planOrderMargins(imported, lines);
    expect(plan.status === 'ok' && plan.lines.map((l) => l.id)).toEqual(['l1', 'l2']);
  });
});

/* Every script that writes a sales order line's cost writes its margin, and
   every one that writes a header margin writes the margin basis. This is what
   the nightly fill and the import stamp did not do. */
describe('scripts writing sales order cost keep the margins with it', () => {
  const dir = fileURLToPath(new URL('../scripts', import.meta.url));
  const files = [
    ...readdirSync(dir).filter((f) => /\.(m?js|mts|ts)$/.test(f)),
    ...readdirSync(join(dir, 'lib')).filter((f) => /\.(m?js|mts|ts)$/.test(f)).map((f) => `lib/${f}`),
  ];
  const statements = files.flatMap((f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    return [...src.matchAll(/UPDATE\s+(?:scm\.)?(mfg_sales_order_items|mfg_sales_orders)\b[\s\S]*?(?:`|;|\$\$)/gi)]
      .map((m) => ({ file: f, table: m[1].toLowerCase(), text: m[0] }));
  });

  test('the scan sees the writers it guards', () => {
    const seen = [...new Set(statements.map((s) => s.file))];
    for (const f of ['restamp-so-cost-from-product.mjs', 'restamp-imported-so-costs.mjs', 'lib/so-margin-repair.mjs']) expect(seen).toContain(f);
  });

  test('a line cost write sets line_margin_sen', () => {
    const missing = statements
      .filter((s) => s.table === 'mfg_sales_order_items' && /\bline_cost_sen\s*=/.test(s.text) && !/\bline_margin_sen\s*=/.test(s.text))
      .map((s) => s.file);
    expect(missing).toEqual([]);
  });

  test('a header margin write sets margin_pct_basis', () => {
    const missing = statements
      .filter((s) => s.table === 'mfg_sales_orders' && /\btotal_margin_sen\s*=/.test(s.text) && !/\bmargin_pct_basis\b/.test(s.text))
      .map((s) => s.file);
    expect(missing).toEqual([]);
  });

  test('the go-live importer writes revenue, margin and line margin with the totals', () => {
    const src = readFileSync(join(dir, 'import-ac-outstanding-so.mjs'), 'utf8');
    const hcols = /const HCOLS = "\(([^)]*)\)"/.exec(src)?.[1].split(',') ?? [];
    const icols = /const ICOLS = "\(([^)]*)\)"/.exec(src)?.[1].split(',') ?? [];
    expect(hcols).toEqual(expect.arrayContaining(['local_total_sen', 'total_revenue_sen', 'total_margin_sen', 'margin_pct_basis']));
    expect(icols).toEqual(expect.arrayContaining(['total_sen', 'line_margin_sen']));
  });
});
