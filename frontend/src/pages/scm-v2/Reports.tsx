// ----------------------------------------------------------------------------
// Reports — the standard P&L and Balance Sheet (GL redesign item 6).
// Standard layout first, numbers over beauty: the owner iterates the 样板 with
// us later (his call), so both tabs stay plain sections + rows + bold totals.
// One source: /accounting/reports/* over v_gl_entries — these can never argue
// with the Journal / GL / TB tabs beside them.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fmtSen } from '../../vendor/shared/format';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { DateField } from '../../vendor/scm/components/DateField';

const card: React.CSSProperties = {
  padding: 'var(--space-4)',
  background: 'var(--c-cream)',
  border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
  borderRadius: 'var(--radius-md)',
  maxWidth: 760,
};
const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };

type Line = { code: string; name: string; amountSen: number };

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;

const Section = ({ title, rows, totalLabel, totalSen, negate }: {
  title: string; rows: Line[]; totalLabel: string; totalSen: number;
  /** Render the rows as deductions (cost/expense sections). */
  negate?: boolean;
}) => (
  <>
    <tr><td colSpan={2} style={{ padding: '10px 10px 4px', fontWeight: 700 }}>{title}</td></tr>
    {rows.map((l) => (
      <tr key={l.code}>
        <td style={{ padding: '2px 10px 2px 24px' }}>{l.code} — {l.name}</td>
        <td style={{ padding: '2px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>{negate ? `(${fmtSen(l.amountSen)})` : fmtSen(l.amountSen)}</td>
      </tr>
    ))}
    {rows.length === 0 && <tr><td colSpan={2} style={{ padding: '2px 10px 2px 24px', ...soft }}>—</td></tr>}
    <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
      <td style={{ padding: '4px 10px', fontWeight: 600 }}>{totalLabel}</td>
      <td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtSen(totalSen)}</td>
    </tr>
  </>
);

/* ── P&L ──────────────────────────────────────────────────────────────────── */
export const PnLTab = () => {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(myt());
  const q = useQuery({
    queryKey: ['report-pnl', from, to],
    queryFn: () => authedFetch<{
      tradingIncome: Line[]; costOfSales: Line[]; otherIncome: Line[]; expenses: Line[];
      totals: { tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number; expensesSen: number; netProfitSen: number };
    }>(`/accounting/reports/pnl?from=${from}&to=${to}`),
    enabled: Boolean(from && to),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>From</span><DateField value={from} onChange={setFrom} aria-label="P&L from" />
        <span style={soft}>To</span><DateField value={to} onChange={setTo} aria-label="P&L to" />
      </div>
      {q.isLoading && <div style={soft}>Working the period out…</div>}
      {q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The statement did not load — adjust the dates to retry.</div>}
      {q.data && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <tbody>
              <Section title="Trading income" rows={q.data.tradingIncome} totalLabel="Total income" totalSen={q.data.totals.tradingIncomeSen} />
              <Section title="Cost of sales (purchases + opening − closing)" rows={q.data.costOfSales} negate totalLabel="Total cost of sales" totalSen={q.data.totals.costOfSalesSen} />
              <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
                <td style={{ padding: '6px 10px', fontWeight: 700 }}>GROSS PROFIT</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>{fmtSen(q.data.totals.grossProfitSen)}</td>
              </tr>
              <Section title="Other income" rows={q.data.otherIncome} totalLabel="Total other income" totalSen={q.data.totals.otherIncomeSen} />
              <Section title="Expenses" rows={q.data.expenses} negate totalLabel="Total expenses" totalSen={q.data.totals.expensesSen} />
              <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
                <td style={{ padding: '8px 10px', fontWeight: 700 }}>NET PROFIT</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{fmtSen(q.data.totals.netProfitSen)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/* ── Balance sheet ────────────────────────────────────────────────────────── */
export const BalanceSheetTab = () => {
  const [asOf, setAsOf] = useState(myt());
  const q = useQuery({
    queryKey: ['report-bs', asOf],
    queryFn: () => authedFetch<{
      assets: Line[]; liabilities: Line[]; equity: Line[];
      totals: { assetsSen: number; liabilitiesSen: number; equitySen: number; earningsSen: number; checkSen: number };
    }>(`/accounting/reports/balance-sheet?asOf=${asOf}`),
    enabled: Boolean(asOf),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <span style={soft}>As of</span><DateField value={asOf} onChange={setAsOf} aria-label="Balance sheet as of" />
      </div>
      {q.isLoading && <div style={soft}>Adding the ledger up…</div>}
      {q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The statement did not load — pick the date again to retry.</div>}
      {q.data && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <tbody>
              <Section title="Assets" rows={q.data.assets} totalLabel="Total assets" totalSen={q.data.totals.assetsSen} />
              <Section title="Liabilities" rows={q.data.liabilities} totalLabel="Total liabilities" totalSen={q.data.totals.liabilitiesSen} />
              <Section title="Equity" rows={q.data.equity} totalLabel="Total equity" totalSen={q.data.totals.equitySen} />
              <tr>
                <td style={{ padding: '4px 10px' }}>Current period earnings</td>
                <td style={{ padding: '4px 10px', textAlign: 'right' }}>{fmtSen(q.data.totals.earningsSen)}</td>
              </tr>
              <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
                <td style={{ padding: '8px 10px', fontWeight: 700 }}>
                  {q.data.totals.checkSen === 0 ? 'BALANCED' : 'OUT OF BALANCE'}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: q.data.totals.checkSen === 0 ? 'var(--c-good, #2f5d4f)' : 'var(--c-danger, #a33)' }}>
                  {q.data.totals.checkSen === 0 ? fmtSen(q.data.totals.assetsSen) : fmtSen(q.data.totals.checkSen)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
