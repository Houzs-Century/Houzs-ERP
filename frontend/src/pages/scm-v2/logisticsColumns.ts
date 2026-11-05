// ----------------------------------------------------------------------------
// logisticsColumns — the columns every Logistics cost view shares (owner
// 2026-11-05): Single month = the four regions across the top and Total; By
// month = a Total column first, then one per month — or, with "Split each month
// by region", each month's four regions and its total. A column names the months
// and regions it adds up (scopeOf); a figure with no region (3PL lines on no DO
// yet, the in-house cost of a month with no trip) counts in Total columns only.
// And the sheet Excel / PDF draw from the rows as shown.
// ----------------------------------------------------------------------------

import type { GridColumn, GridRow } from './reports/FinanceGrid';
import { cellText } from './reports/FinanceGrid';
import type { LogisticsMonth, PnlRegion } from '../../vendor/scm/lib/logistics-queries';
import { PCT_COLUMN, type ReportSheet, type SheetColumn, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { monthName } from './reports/statementColumns';

export const REGIONS: ReadonlyArray<{ code: PnlRegion; name: string }> = [
  { code: 'PG', name: 'Penang' }, { code: 'KL', name: 'KL' }, { code: 'EM', name: 'SBH & SWK' }, { code: 'SG', name: 'SGD' },
];
export const ALL_REGIONS: PnlRegion[] = REGIONS.map((r) => r.code);
export const regionName = (code: PnlRegion): string => REGIONS.find((r) => r.code === code)!.name;

export type Mode = 'single' | 'months';
export type Scope = { months: string[]; regions: PnlRegion[] };

const short = (m: string) => monthName(`${m}-01`);

/** The columns for a mode, with the scope each one adds up. */
export function logisticsColumns(months: readonly string[], mode: Mode, split: boolean, width: number): { columns: GridColumn[]; scopes: Map<string, Scope> } {
  const scopes = new Map<string, Scope>();
  const columns: GridColumn[] = [];
  const add = (c: GridColumn, scope: Scope) => { columns.push(c); scopes.set(c.key, scope); };
  const all = [...months];
  const span = all.length === 1 ? short(all[0]!) : `${short(all[0]!)} – ${short(all[all.length - 1]!)}`;
  if (mode === 'single') {
    for (const r of REGIONS) add({ key: r.code, label: r.name, kind: 'money', width }, { months: all, regions: [r.code] });
    add({ key: 'T', label: 'Total', sub: span, kind: 'money', width, total: true }, { months: all, regions: ALL_REGIONS });
    return { columns, scopes };
  }
  add({ key: 'T:all', label: 'Total', sub: `${all.length} month${all.length === 1 ? '' : 's'}`, kind: 'money', width, total: true, edge: true }, { months: all, regions: ALL_REGIONS });
  for (const m of all) {
    if (!split) { add({ key: m, label: short(m), kind: 'money', width }, { months: [m], regions: ALL_REGIONS }); continue; }
    for (const r of REGIONS) add({ key: `${m}:${r.code}`, label: r.name, group: short(m), kind: 'money', width }, { months: [m], regions: [r.code] });
    add({ key: `${m}:T`, label: 'Total', group: short(m), kind: 'money', width, total: true, edge: true }, { months: [m], regions: ALL_REGIONS });
  }
  return { columns, scopes };
}

export const isWhole = (s: Scope): boolean => s.regions.length === ALL_REGIONS.length;

/** One figure per column: f(month, region) added over the column's scope. */
export function cellsBy(scopes: ReadonlyMap<string, Scope>, byMonth: ReadonlyMap<string, LogisticsMonth>, f: (m: LogisticsMonth, r: PnlRegion) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, sc] of scopes) {
    let v = 0;
    for (const m of sc.months) { const mm = byMonth.get(m); if (mm) for (const r of sc.regions) v += f(mm, r); }
    out[key] = v;
  }
  return out;
}

/** A figure that has no region: in Total columns only, null elsewhere. */
export function totalsOnly(scopes: ReadonlyMap<string, Scope>, byMonth: ReadonlyMap<string, LogisticsMonth>, f: (m: LogisticsMonth) => number): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [key, sc] of scopes) out[key] = isWhole(sc) ? sc.months.reduce((s, m) => s + (byMonth.get(m) ? f(byMonth.get(m)!) : 0), 0) : null;
  return out;
}

/** Each figure as a % of a base row, column by column. */
export function pctOf(cells: Record<string, unknown>, base: Record<string, number | null | undefined>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of Object.keys(cells)) {
    const v = cells[k]; const b = base[k];
    out[k] = typeof v === 'number' && b ? Math.round((v / b) * 1000) / 10 : null;
  }
  return out;
}

/** Excel / PDF: the rows as the screen lays them out, every group open, its total below. */
export function gridSheet(input: {
  title: string; subtitle: string; period: string; nameLabel: string;
  columns: GridColumn[]; rows: GridRow[]; showPct: boolean;
}): ReportSheet {
  const cols: SheetColumn[] = [];
  const keys: Array<{ key: string; pct: boolean; kind: GridColumn['kind'] }> = [];
  for (const c of input.columns) {
    const label = c.group ? `${c.group} ${c.label}` : c.label;
    cols.push({ label, kind: c.kind === 'money' ? 'amount' : 'text', edge: c.edge });
    keys.push({ key: c.key, pct: false, kind: c.kind });
    if (input.showPct && c.kind === 'money') { cols.push({ ...PCT_COLUMN('%'), beside: true }); keys.push({ key: c.key, pct: true, kind: c.kind }); }
  }
  const out: SheetRow[] = [];
  const walk = (rows: GridRow[], depth: number) => {
    for (const r of rows) {
      const cells = (row: GridRow) => keys.map(({ key, pct, kind }) => {
        if (pct) return row.pct?.[key] ?? null;
        const v = row.cells[key];
        if (v != null && typeof v === 'object') return v.text ?? null;
        if (v == null) return null;
        return kind === 'money' && !row.int && !row.isPct ? v : cellText(v, kind, row);
      });
      if (r.kids) {
        out.push({ kind: depth === 0 ? 'block' : 'category', depth, label: r.label, cells: [] });
        walk(r.kids, depth + 1);
        out.push({ kind: 'total', depth, label: r.totalLabel ?? `Total ${r.label}`, cells: cells(r) });
      } else {
        const kind = r.kind === 'final' ? 'net' : r.kind === 'strong' || r.kind === 'sub' ? 'total' : r.kind === 'ratio' || r.kind === 'check' || r.kind === 'warn' ? 'memo' : r.kind === 'block' ? 'block' : 'row';
        out.push({ kind, depth, label: r.cap && !r.capBelow ? `${r.label} · ${r.cap}` : r.cap ? `${r.label} (${r.cap})` : r.label, cells: cells(r) });
      }
    }
  };
  walk(input.rows, 0);
  return {
    title: input.title, subtitle: input.subtitle, meta: [{ label: 'Months', value: input.period }],
    tables: [{ columns: cols, rows: out }],
  };
}
