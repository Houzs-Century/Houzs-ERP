// ----------------------------------------------------------------------------
// cashFlowSplit — the Cash Flow's Settlement / Deposit view (owner 2026-11-09, his
// Receipt & Payment workbook: 「houzs 的cash flow 我想要这样呈现…就是一行settlement一行
// deposit」). The By month reads, laid out his way: Total leftmost and whole (its % of
// the side beside it), then each month, newest first, as two columns under the
// month's name — Settlement, Deposit. The server says how each line splits (LaidNode
// sd: a group's parts in the layout, a customer's payment by its own kind); a line it
// did not split prints one figure across its month's two columns, as his workbook
// merges them. A running subtotal that splits gets its two figures added up on a quiet
// line under it (his "Net operation surplus"). Nothing is computed here but placement.
// ----------------------------------------------------------------------------

import type { StatementColumn, StatementLine } from './statementColumns';

export type SplitPart = 'S' | 'D';
export const SETTLEMENT_LABEL = 'Settlement';
export const DEPOSIT_LABEL = 'Deposit';
/** The line under a split running subtotal: its two figures added up. */
export const SPLIT_SUM_LABEL = 'Settlement + Deposit';

/** A month's Settlement or Deposit column. */
export const splitKey = (month: string, part: SplitPart): string => `${month}:${part}`;

/** Total as it is; each month as Settlement then Deposit under the month's name (the
    month's own small line — "to 09/11/2026 *" on the month still running — on the heading),
    Settlement marked petrol and Deposit gold (owner 2026-11-10: 做好看一点). */
export function splitColumns(months: StatementColumn[]): StatementColumn[] {
  return months.flatMap((c): StatementColumn[] => {
    if (c.kind !== 'period') return [c];
    const group = { key: c.key, label: c.label, ...(c.sub ? { sub: c.sub } : {}) };
    return (['S', 'D'] as const).map((part) => ({
      key: splitKey(c.key, part), label: part === 'S' ? SETTLEMENT_LABEL : DEPOSIT_LABEL, kind: 'period', from: c.from, to: c.to, pct: false, group,
      mark: part === 'S' ? 'petrol' : 'gold',
    }));
  });
}

/** The By month lines (merged by id, a month's cell carrying the server's split) laid on
    the split columns: Total whole; a month the server split fills both of its columns (a
    nil share no figure); a month it left whole prints one figure across both; a month
    without the line has one empty cell across — or an empty cell in each column when the
    line splits in another month. The table leaves a month's empty cells blank (owner
    2026-11-10: the dashes made it busy); Total keeps its dash. */
export function splitLines(merged: StatementLine[], months: StatementColumn[]): StatementLine[] {
  const periods = months.filter((c) => c.kind === 'period');
  const wholes = months.filter((c) => c.kind !== 'period');
  const place = (l: StatementLine, pctInTotal: boolean): StatementLine => {
    const cells: StatementLine['cells'] = {};
    const spans: Partial<Record<string, number>> = {};
    for (const c of wholes) {
      const cell = l.cells[c.key];
      if (cell) cells[c.key] = { amountSen: cell.amountSen, pct: pctInTotal ? cell.pct : null };
    }
    const splits = periods.some((m) => l.cells[m.key]?.sd);
    for (const m of periods) {
      const cell = l.cells[m.key];
      const settle = splitKey(m.key, 'S');
      if (cell?.sd) {
        /* A nil share has no figure: the cell stays blank, as his workbook leaves it. */
        if (cell.sd.settlementSen !== 0) cells[settle] = { amountSen: cell.sd.settlementSen, pct: null };
        if (cell.sd.depositSen !== 0) cells[splitKey(m.key, 'D')] = { amountSen: cell.sd.depositSen, pct: null };
        continue;
      }
      if (cell) cells[settle] = { amountSen: cell.amountSen, pct: null };
      if (cell || !splits) spans[settle] = 2;
    }
    const out: StatementLine = { ...l, cells };
    delete out.spans;
    return Object.keys(spans).length > 0 ? { ...out, spans } : out;
  };
  const out: StatementLine[] = [];
  for (const l of merged) {
    if (l.kind === 'block') { out.push({ ...l, cells: {} }); continue; }
    out.push(place(l, true));
    /* His "Net operation surplus": the subtotal split, then its two figures added up. */
    if (l.kind === 'net' && periods.some((m) => l.cells[m.key]?.sd)) {
      const whole = Object.fromEntries(Object.entries(l.cells).map(([k, c]) => [k, c && { amountSen: c.amountSen, pct: null }]));
      out.push(place({ id: `${l.id}:sum`, label: SPLIT_SUM_LABEL, kind: 'memo', depth: l.depth + 1, cells: whole }, false));
    }
  }
  return out;
}
