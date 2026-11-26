
import { monthEnd } from '../../lib/dateRangePresets';
import type { DeptBasis } from '../../vendor/scm/lib/department-queries';
import type { GridColumn } from './reports/FinanceGrid';
import { monthName } from './reports/statementColumns';

export type Mode = 'single' | 'months';
export const MODES: ReadonlyArray<{ value: Mode; label: string }> = [{ value: 'single', label: 'Whole range' }, { value: 'months', label: 'By month' }];

/** A tile's money: whole ringgit, a negative in brackets. */
export const whole = (sen: number | null): string => {
  if (sen == null) return '—';
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-US');
  return sen < 0 ? `(${text})` : text;
};
export const pctText = (part: number, base: number) => (base !== 0 ? `${((part / base) * 100).toFixed(1)}%` : '—');
export const short = (m: string) => monthName(`${m}-01`);
export const rateText = (bp: number) => (bp / 100).toFixed(2).replace(/\.?0+$/, '');
/** A column's months as words, and as the dates its lines are read between. */
export const spanText = (months: readonly string[]) => (months.length === 1 ? short(months[0]!) : `${short(months[0]!)} – ${short(months[months.length - 1]!)}`);
export const datesOf = (months: readonly string[]) => ({ from: `${months[0]}-01`, to: monthEnd(`${months[months.length - 1]}-01`) });

/** What the sales are, in words: the orders (Performance) or the invoices (Actual). */
export const BASIS_WORDS: Record<DeptBasis, { name: string; sales: string }> = {
  performance: { name: 'Performance', sales: 'sales orders by SO date' },
  actual: { name: 'Actual', sales: 'sales invoices, as booked' },
};

/** Whole range = a Total; By month = a Total, then one column per month. */
export function monthColumns(months: readonly string[], mode: Mode, showPct: boolean): GridColumn[] {
  const total: GridColumn = { key: 'T', label: 'Total', sub: spanText(months), kind: 'money', width: showPct ? 172 : 130, total: true, edge: mode === 'months' };
  return mode === 'single' ? [total] : [total, ...months.map((m) => ({ key: m, label: short(m), kind: 'money' as const, width: showPct ? 172 : 120 }))];
}
/** A column's months: the Total's every month, a month's its own. */
export const scopeOf = (months: readonly string[]) => (key: string): string[] => (key === 'T' ? [...months] : [key]);
