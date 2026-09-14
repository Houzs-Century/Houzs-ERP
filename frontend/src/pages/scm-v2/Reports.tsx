// ----------------------------------------------------------------------------
// Reports — the standard P&L and Balance Sheet (GL redesign item 6).
// Standard layout first, numbers over beauty: the owner iterates the 样板 with
// us later (his call), so both tabs stay plain sections + rows + bold totals.
// One source: /accounting/reports/* over v_gl_entries — these can never argue
// with the Journal / GL / TB tabs beside them.
//
// SIGNS (owner 2026-09-14, docs/bugs/0910: expense 可以不用（）吗？因为本身就是费用
// 除非他当月是 ct 大过 debit 才（）): every figure is the positive amount it is —
// an expense is a cost, not a negative — and only a line whose credits beat
// its debits in the period (a reversal, a closing-stock credit) prints in
// parentheses; a loss is a negative net and reads the same way. The four
// Finance reports share this rule through fmtSenParen / fmtPerf.
//
// LAYOUT (owner 2026-09-14, docs/bugs/0911: 我想要有 level，父子 account 分层 …
// 我要能自己调动排版 … P&L 那边不是每个 expense 都有 percentage): the P&L draws each
// block on the report's layout — the server lays the period's figures on the
// owner's tree of categories (one tree, shared by every company, ticked per
// company) — with a subtotal on every category, % of sales on every row, and
// L1..Ln buttons to open the tree to a depth. The Layout button opens the
// editor (ReportLayoutEditor) for whoever may read the statements.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@2990s/design-system';
import { fmtSenParen } from '../../vendor/shared/format';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { DateField } from '../../vendor/scm/components/DateField';
import { useAuth } from '../../auth/AuthContext';
import { laidDepth, type LaidNode } from '../../vendor/scm/lib/report-layout';
import { LaidBlock, LaidTotalRow, LevelButtons, type Level } from './ReportLayoutTree';
import { ReportLayoutEditor } from './ReportLayoutEditor';

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

const Section = ({ title, rows, totalLabel, totalSen }: {
  title: string; rows: Line[]; totalLabel: string; totalSen: number;
}) => (
  <>
    <tr><td colSpan={2} style={{ padding: '10px 10px 4px', fontWeight: 700 }}>{title}</td></tr>
    {rows.map((l) => (
      <tr key={l.code}>
        <td style={{ padding: '2px 10px 2px 24px' }}>{l.code} — {l.name}</td>
        <td style={{ padding: '2px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtSenParen(l.amountSen)}</td>
      </tr>
    ))}
    {rows.length === 0 && <tr><td colSpan={2} style={{ padding: '2px 10px 2px 24px', ...soft }}>—</td></tr>}
    <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
      <td style={{ padding: '4px 10px', fontWeight: 600 }}>{totalLabel}</td>
      <td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtSenParen(totalSen)}</td>
    </tr>
  </>
);

/* ── P&L ──────────────────────────────────────────────────────────────────── */
type PnlLayout = {
  stored: boolean;
  /** Sales of the period — what every % is of; null when nothing sold. */
  baseSen: number | null;
  tradingIncome: LaidNode[]; costOfSales: LaidNode[]; otherIncome: LaidNode[]; expenses: LaidNode[]; taxation: LaidNode[];
};

export const PnLTab = () => {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(myt());
  const [level, setLevel] = useState<Level>('all');
  const [editing, setEditing] = useState(false);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  const q = useQuery({
    queryKey: ['report-pnl', from, to],
    queryFn: () => authedFetch<{
      tradingIncome: Line[]; costOfSales: Line[]; otherIncome: Line[]; expenses: Line[];
      /** TAXATION section rows — a profit-before-tax line appears when any posted. */
      taxation?: Line[];
      /** The same figures on the report's layout. */
      layout: PnlLayout;
      totals: {
        tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number; expensesSen: number;
        profitBeforeTaxSen?: number; taxationSen?: number; netProfitSen: number;
      };
    }>(`/accounting/reports/pnl?from=${from}&to=${to}`),
    enabled: Boolean(from && to),
    staleTime: 30_000,
  });

  const lay = q.data?.layout;
  const depth = lay ? Math.max(laidDepth(lay.tradingIncome), laidDepth(lay.costOfSales), laidDepth(lay.otherIncome), laidDepth(lay.expenses), laidDepth(lay.taxation)) : 0;
  const base = lay ? lay.baseSen : null;

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>From</span><DateField value={from} onChange={setFrom} aria-label="P&L from" />
        <span style={soft}>To</span><DateField value={to} onChange={setTo} aria-label="P&L to" />
        <LevelButtons depth={depth} level={level} onLevel={setLevel} />
        {canArrange && (
          <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)} aria-pressed={editing}>Layout</Button>
        )}
      </div>
      {editing && <ReportLayoutEditor report="pnl" onClose={() => setEditing(false)} />}
      {q.isLoading && <div style={soft}>Working the period out…</div>}
      {q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The statement did not load — adjust the dates to retry.</div>}
      {q.data && lay && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
                <th style={{ padding: '6px 10px', textAlign: 'left', ...soft }}>{lay.stored ? 'On the saved layout' : 'On the chart\'s own tree'}</th>
                <th style={{ padding: '6px 10px', textAlign: 'right', ...soft }}>Amount</th>
                <th style={{ padding: '6px 10px', textAlign: 'right', ...soft }}>% of sales</th>
              </tr>
            </thead>
            <tbody>
              <LaidBlock title="Trading income" nodes={lay.tradingIncome} level={level} totalLabel="Total income" totalSen={q.data.totals.tradingIncomeSen} baseSen={base} />
              <LaidBlock title="Cost of sales (purchases + opening − closing)" nodes={lay.costOfSales} level={level} totalLabel="Total cost of sales" totalSen={q.data.totals.costOfSalesSen} baseSen={base} />
              <LaidTotalRow label="GROSS PROFIT" amountSen={q.data.totals.grossProfitSen} baseSen={base} />
              <LaidBlock title="Other income" nodes={lay.otherIncome} level={level} totalLabel="Total other income" totalSen={q.data.totals.otherIncomeSen} baseSen={base} />
              <LaidBlock title="Expenses" nodes={lay.expenses} level={level} totalLabel="Total expenses" totalSen={q.data.totals.expensesSen} baseSen={base} />
              {/* The TAXATION section (AutoCount's own line) only when
                  something posted there — the layout stays as the owner
                  left it otherwise (版式先这样). */}
              {(q.data.taxation?.length ?? 0) > 0 && (
                <>
                  <LaidTotalRow label="PROFIT BEFORE TAX" amountSen={q.data.totals.profitBeforeTaxSen ?? q.data.totals.netProfitSen} baseSen={base} />
                  <LaidBlock title="Taxation" nodes={lay.taxation} level={level} totalLabel="Total taxation" totalSen={q.data.totals.taxationSen ?? 0} baseSen={base} />
                </>
              )}
              <LaidTotalRow label="NET PROFIT" amountSen={q.data.totals.netProfitSen} baseSen={base} strong />
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
                <td style={{ padding: '4px 10px', textAlign: 'right' }}>{fmtSenParen(q.data.totals.earningsSen)}</td>
              </tr>
              <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
                <td style={{ padding: '8px 10px', fontWeight: 700 }}>
                  {q.data.totals.checkSen === 0 ? 'BALANCED' : 'OUT OF BALANCE'}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: q.data.totals.checkSen === 0 ? 'var(--c-good, #2f5d4f)' : 'var(--c-danger, #a33)' }}>
                  {q.data.totals.checkSen === 0 ? fmtSenParen(q.data.totals.assetsSen) : fmtSenParen(q.data.totals.checkSen)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
