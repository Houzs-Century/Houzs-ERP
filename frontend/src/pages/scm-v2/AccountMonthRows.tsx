// AccountMonthRows — an account's lines opened under its row on the monthly
// view, each line in the month it belongs to (owner 2026-09-18: 点开可以让那笔
// 费用挂在那个月份的下面): the date, the description and the reference in the
// name column, the amount under its month (and under 累计), a dash elsewhere;
// a month figure clicked opens that month's lines alone. Read from the
// General Ledger's own endpoint, like AccountLinesRow on the single-period
// screen, so the two never disagree; the foot links to the full ledger.
// Owner 2026-09-19 (划过去时会这样 / 我要在 amount 下面): the rows wear a solid
// shade of their own, so the frozen name cell hides what scrolls under it;
// a long description is cut at the column's width, the whole text in its
// tooltip; and a figure sits under the row's AMOUNT, not under its % — each
// cell keeps the % slot's width empty while the amounts print with a %
// beside them.

import { Link } from 'react-router-dom';
import { fmtDate } from '../../vendor/shared/format';
import { ledgerHref } from '../../vendor/scm/lib/report-layout';
import { useLedger } from '../../vendor/scm/lib/ledger-queries';
import type { MonthColumn } from '../../vendor/scm/lib/report-monthly';
import styles from './MonthlyReport.module.css';

/** The room a % takes beside an amount — on the account rows, and kept empty on their lines. */
export const pctSlotStyle: React.CSSProperties = { display: 'inline-block', minWidth: 46, marginLeft: 6 };

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--text-soft, #8a8578)' };
const name: React.CSSProperties = { padding: '2px 10px 2px 34px', fontSize: 'var(--fs-12)' };
const num: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap', padding: '2px 10px', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--fs-12)' };
const cumEdge: React.CSSProperties = { borderRight: '2px solid var(--c-ink, #221f20)' };
const rowClass = `${styles.row} ${styles.lines}`;

type Props = {
  code: string;
  columns: MonthColumn[];
  /** The whole range the columns cover — one read, whichever month is open. */
  from: string;
  to: string;
  /** A month key (YYYY-MM) to show alone, or null for every line of the range. */
  month: string | null;
  /** The figure the row prints for the range — the lines are signed to sum to it. */
  rowSen: number;
  fmt: (sen: number) => string;
  /** Whether the amounts print with a % beside them — the lines keep that slot empty, so a figure sits under the amount. */
  pctSlot: boolean;
};

/** Whether a line dated `date` belongs under a column. */
const inColumn = (c: MonthColumn, date: string): boolean => (c.cumulative ? date >= c.from && date <= c.to : date.slice(0, 7) === c.key);

export const AccountMonthRows = ({ code, columns, from, to, month, rowSen, fmt, pctSlot }: Props) => {
  const q = useLedger({ from, to, accounts: [code] });
  const block = q.data?.blocks.find((b) => b.code === code) ?? null;
  const all = block?.lines ?? [];
  const lines = month ? all.filter((l) => l.date.slice(0, 7) === month) : all;
  /* Debit less credit, turned to read the way the row does: an expense's
     debits print positive, a receipt account's credits print positive. */
  const net = all.reduce((s, l) => s + (l.debitSen - l.creditSen), 0);
  const sign = net !== 0 && rowSen !== 0 && Math.sign(net) !== Math.sign(rowSen) ? -1 : 1;
  const amountOf = (l: { debitSen: number; creditSen: number }): number => sign * (l.debitSen - l.creditSen);
  const slot = pctSlot ? <span data-pct style={pctSlotStyle} /> : null;
  const span = 1 + columns.length;
  if (q.isLoading) return <tr data-lines-of={code} className={rowClass}><td colSpan={span} className={styles.name} style={{ ...name, ...soft }}>Reading the lines…</td></tr>;
  if (q.isError) return <tr data-lines-of={code} className={rowClass}><td colSpan={span} className={styles.name} style={{ ...name, fontSize: 'var(--fs-12)', color: 'var(--c-danger, #a33)' }}>The lines did not load.</td></tr>;
  if (lines.length === 0) {
    return (
      <tr data-lines-of={code} className={rowClass}>
        <td colSpan={span} className={styles.name} style={{ ...name, ...soft }}>
          {month ? `No line on ${code} in ${month.slice(5, 7)}/${month.slice(0, 4)}.` : `No line on ${code} between ${fmtDate(from)} and ${fmtDate(to)}.`}
        </td>
      </tr>
    );
  }
  return (
    <>
      {lines.map((l) => {
        const text = `${fmtDate(l.date)} · ${l.description ?? l.doc ?? '—'}`;
        return (
          <tr key={l.lineId} className={rowClass} data-line-of={code} data-month={l.date.slice(0, 7)}>
            <td className={`${styles.name} ${styles.clip}`} style={name} title={l.doc ? `${text} · ${l.doc}` : text}>
              {text}
              {l.doc && <span style={{ ...soft, marginLeft: 8 }}>{l.doc}</span>}
            </td>
            {columns.map((c) => (
              <td key={c.key} style={{ ...num, ...(c.cumulative ? cumEdge : {}) }}>
                {inColumn(c, l.date) ? fmt(amountOf(l)) : <span style={soft}>-</span>}{slot}
              </td>
            ))}
          </tr>
        );
      })}
      <tr data-lines-foot={code} className={rowClass}>
        <td className={styles.name} style={{ ...name, fontWeight: 600 }}>
          共 {lines.length} 笔{month ? ` · ${month.slice(5, 7)}/${month.slice(0, 4)}` : ''}
          <Link to={ledgerHref([code], from, to)} style={{ marginLeft: 12, fontWeight: 400, color: 'var(--c-orange)' }}>在 GL 打开</Link>
        </td>
        {columns.map((c) => {
          const here = lines.filter((l) => inColumn(c, l.date));
          return (
            <td key={c.key} style={{ ...num, fontWeight: 600, ...(c.cumulative ? cumEdge : {}) }}>
              {here.length > 0 ? fmt(here.reduce((s, l) => s + amountOf(l), 0)) : <span style={soft}>-</span>}{slot}
            </td>
          );
        })}
      </tr>
    </>
  );
};
