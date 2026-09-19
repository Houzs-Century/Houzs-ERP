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
// Finance reports share this rule through fmtSenPlain — 1,234.56, no RM, as the
// Cash Flow reads (owner 2026-09-19: P&L 的 RM 前缀拿掉，和 cash flow 一样).
//
// LAYOUT (owner 2026-09-14, docs/bugs/0911: 我想要有 level，父子 account 分层 …
// 我要能自己调动排版 … P&L 那边不是每个 expense 都有 percentage): the P&L draws each
// block on the report's layout — the server lays the period's figures on the
// owner's tree of categories (one tree, shared by every company, ticked per
// company) — with a subtotal on every category, % of sales on every row, and
// L1..Ln buttons to open the tree to a depth. The Layout button opens the
// editor (ReportLayoutEditor) for whoever may read the statements. The
// Balance Sheet draws the same way on its own tree (docs/bugs/0912), every
// line's % of TOTAL ASSETS, both sides (owner: balance sheet 也需要).
//
// BY MONTH (docs/bugs/0916, owner: 能看每个月的): the By month button swaps
// the single period for MonthlyReport — the same endpoint asked once per
// column, 累计 leftmost then newest → oldest, a % toggle; the balance sheet's
// columns are month-end balances and it has no cumulative column.
//
// EXPORTS (owner 2026-09-19: 我这页显示什么就要 export 什么 … finance 这里的 report
// 都是要这样): Excel and PDF carry the statement AS SHOWN — the lines at the
// level chosen, the same shades — through the shared report sheet.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtDate, fmtSenPlain } from '../../vendor/shared/format';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { DateField } from '../../vendor/scm/components/DateField';
import { useAuth } from '../../auth/AuthContext';
import { fmtPct, laidDepth, leafCodes, ledgerHref, linesVisible, pctOf, type LaidNode } from '../../vendor/scm/lib/report-layout';
import { LaidBlock, LaidTotalRow, LevelButtons, useReportTree, type Level } from './ReportLayoutTree';
import { ReportLayoutEditor } from './ReportLayoutEditor';
import { ByMonthButton, MonthlyReport } from './MonthlyReport';
import { balanceSheetLines, pnlLines, type MonthColumn } from '../../vendor/scm/lib/report-monthly';
import { statementTable, type ReportSheet } from '../../vendor/scm/lib/report-sheet';
import { downloadReportXlsx } from '../../vendor/scm/lib/report-sheet-xlsx';
import { generateReportPdf } from '../../vendor/scm/lib/report-sheet-pdf';

/** The Excel and PDF buttons a statement wears while one period is shown. */
const ExportButtons = ({ sheet, fileBase }: { sheet: () => ReportSheet | null; fileBase: string }) => (
  <>
    <span style={{ flex: 1 }} />
    <Button variant="ghost" size="sm" onClick={() => { const s = sheet(); if (s) void downloadReportXlsx(s, `${fileBase}.xlsx`); }}>
      <Download size={16} strokeWidth={1.75} /> Excel
    </Button>
    <Button variant="ghost" size="sm" onClick={() => { const s = sheet(); if (s) void generateReportPdf(s, { fileName: `${fileBase}.pdf` }); }}>
      <Printer size={16} strokeWidth={1.75} /> PDF
    </Button>
  </>
);

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

/** 点开看明细其实就是看 general ledger (owner 2026-09-14): a figure opens the
    General Ledger on the node's accounts for the period (docs/bugs/0924). */
const useOpenLedger = (from: () => string, to: () => string) => {
  const navigate = useNavigate();
  return (node: LaidNode) => {
    const codes = leafCodes(node);
    if (codes.length > 0) navigate(ledgerHref(codes, from(), to()));
  };
};

/* ── P&L ──────────────────────────────────────────────────────────────────── */
type PnlLayout = {
  stored: boolean;
  /** Sales of the period — what every % is of; null when nothing sold. */
  baseSen: number | null;
  tradingIncome: LaidNode[]; costOfSales: LaidNode[]; otherIncome: LaidNode[]; expenses: LaidNode[]; taxation: LaidNode[];
};
type PnlResponse = {
  tradingIncome: Line[]; costOfSales: Line[]; otherIncome: Line[]; expenses: Line[];
  /** TAXATION section rows — a profit-before-tax line appears when any posted. */
  taxation?: Line[];
  /** The same figures on the report's layout. */
  layout: PnlLayout;
  totals: {
    tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number; expensesSen: number;
    profitBeforeTaxSen?: number; taxationSen?: number; netProfitSen: number;
  };
};
const fetchPnl = (from: string, to: string) => authedFetch<PnlResponse>(`/accounting/reports/pnl?from=${from}&to=${to}`);
const fetchPnlColumn = (col: MonthColumn) => fetchPnl(col.from, col.to);

export const PnLTab = () => {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(myt());
  const [level, setLevel] = useState<Level>('all');
  const [editing, setEditing] = useState(false);
  const [monthly, setMonthly] = useState(false);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  const openLedger = useOpenLedger(() => from, () => to);
  const tree = useReportTree(level);
  const drill = { from, to };
  const q = useQuery({
    queryKey: ['report-pnl', from, to],
    queryFn: () => fetchPnl(from, to),
    enabled: Boolean(from && to) && !monthly,
    staleTime: 30_000,
  });

  const lay = q.data?.layout;
  const depth = lay ? Math.max(laidDepth(lay.tradingIncome), laidDepth(lay.costOfSales), laidDepth(lay.otherIncome), laidDepth(lay.expenses), laidDepth(lay.taxation)) : 0;
  const base = lay ? lay.baseSen : null;
  /* Excel and PDF carry the statement as shown — the lines at this level (owner 2026-09-19). */
  const period = `${fmtDate(from)} – ${fmtDate(to)}`;
  const sheet = (): ReportSheet | null => (q.data && lay ? {
    title: 'P&L',
    subtitle: `${period} · % of sales · ${lay.stored ? 'on the saved layout' : "on the chart's own tree"}${level === 'all' ? '' : ` · level ${level}`}`,
    meta: [{ label: 'Period', value: period }],
    tables: [statementTable(linesVisible(pnlLines(q.data), level, tree.open), '% of sales')],
  } : null);

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {!monthly && (
          <>
            <span style={soft}>From</span><DateField value={from} onChange={setFrom} aria-label="P&L from" />
            <span style={soft}>To</span><DateField value={to} onChange={setTo} aria-label="P&L to" />
            <LevelButtons depth={depth} level={level} onLevel={setLevel} />
          </>
        )}
        <ByMonthButton on={monthly} onToggle={() => setMonthly((v) => !v)} />
        {canArrange && (
          <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)} aria-pressed={editing}>Layout</Button>
        )}
        {!monthly && q.data && <ExportButtons sheet={sheet} fileBase={`pnl-${from}-to-${to}`} />}
      </div>
      {editing && <ReportLayoutEditor report="pnl" onClose={() => setEditing(false)} />}
      {monthly && <MonthlyReport<PnlResponse> report="pnl" title="P&L" withCumulative fetchColumn={fetchPnlColumn} linesOf={pnlLines} fmt={fmtSenPlain} pctTitle="% of sales" />}
      {!monthly && q.isLoading && <div style={soft}>Working the period out…</div>}
      {!monthly && q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The statement did not load — adjust the dates to retry.</div>}
      {!monthly && q.data && lay && (
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
              <LaidBlock title="Trading income" nodes={lay.tradingIncome} level={level} totalLabel="Total income" totalSen={q.data.totals.tradingIncomeSen} baseSen={base} onPick={openLedger} tree={tree} drill={drill} />
              <LaidBlock title="Cost of sales (purchases + opening − closing)" nodes={lay.costOfSales} level={level} totalLabel="Total cost of sales" totalSen={q.data.totals.costOfSalesSen} baseSen={base} onPick={openLedger} tree={tree} drill={drill} />
              <LaidTotalRow label="GROSS PROFIT" amountSen={q.data.totals.grossProfitSen} baseSen={base} />
              <LaidBlock title="Other income" nodes={lay.otherIncome} level={level} totalLabel="Total other income" totalSen={q.data.totals.otherIncomeSen} baseSen={base} onPick={openLedger} tree={tree} drill={drill} />
              <LaidBlock title="Expenses" nodes={lay.expenses} level={level} totalLabel="Total expenses" totalSen={q.data.totals.expensesSen} baseSen={base} onPick={openLedger} tree={tree} drill={drill} />
              {/* The TAXATION section (AutoCount's own line) only when
                  something posted there — the layout stays as the owner
                  left it otherwise (版式先这样). */}
              {(q.data.taxation?.length ?? 0) > 0 && (
                <>
                  <LaidTotalRow label="PROFIT BEFORE TAX" amountSen={q.data.totals.profitBeforeTaxSen ?? q.data.totals.netProfitSen} baseSen={base} />
                  <LaidBlock title="Taxation" nodes={lay.taxation} level={level} totalLabel="Total taxation" totalSen={q.data.totals.taxationSen ?? 0} baseSen={base} onPick={openLedger} tree={tree} drill={drill} />
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
type BsLayout = {
  stored: boolean;
  /** Total assets — what every % is of, both sides; null when there are none. */
  baseSen: number | null;
  assets: LaidNode[]; liabilities: LaidNode[]; equity: LaidNode[];
};
type BsResponse = {
  assets: Line[]; liabilities: Line[]; equity: Line[];
  /** The same figures on the report's layout. */
  layout: BsLayout;
  totals: { assetsSen: number; liabilitiesSen: number; equitySen: number; earningsSen: number; checkSen: number };
};
const fetchBalanceSheet = (asOf: string) => authedFetch<BsResponse>(`/accounting/reports/balance-sheet?asOf=${asOf}`);
/** A month's column is the balance as at that month's END. */
const fetchBsColumn = (col: MonthColumn) => fetchBalanceSheet(col.to);

export const BalanceSheetTab = () => {
  const [asOf, setAsOf] = useState(myt());
  const [level, setLevel] = useState<Level>('all');
  const [editing, setEditing] = useState(false);
  const [monthly, setMonthly] = useState(false);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  const openLedger = useOpenLedger(() => `${asOf.slice(0, 7)}-01`, () => asOf);
  const tree = useReportTree(level);
  const drill = { from: `${asOf.slice(0, 7)}-01`, to: asOf };
  const q = useQuery({
    queryKey: ['report-bs', asOf],
    queryFn: () => fetchBalanceSheet(asOf),
    enabled: Boolean(asOf) && !monthly,
    staleTime: 30_000,
  });

  const lay = q.data?.layout;
  const depth = lay ? Math.max(laidDepth(lay.assets), laidDepth(lay.liabilities), laidDepth(lay.equity)) : 0;
  const base = lay ? lay.baseSen : null;
  /* Excel and PDF carry the statement as shown — the lines at this level (owner 2026-09-19). */
  const sheet = (): ReportSheet | null => (q.data && lay ? {
    title: 'Balance Sheet',
    subtitle: `As at ${fmtDate(asOf)} · % of total assets · ${lay.stored ? 'on the saved layout' : "on the chart's own tree"}${level === 'all' ? '' : ` · level ${level}`}`,
    meta: [{ label: 'As at', value: fmtDate(asOf) }],
    tables: [statementTable(linesVisible(balanceSheetLines(q.data), level, tree.open), '% of total assets')],
  } : null);

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {!monthly && (
          <>
            <span style={soft}>As of</span><DateField value={asOf} onChange={setAsOf} aria-label="Balance sheet as of" />
            <LevelButtons depth={depth} level={level} onLevel={setLevel} />
          </>
        )}
        <ByMonthButton on={monthly} onToggle={() => setMonthly((v) => !v)} />
        {canArrange && (
          <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)} aria-pressed={editing}>Layout</Button>
        )}
        {!monthly && q.data && <ExportButtons sheet={sheet} fileBase={`balance-sheet-${asOf}`} />}
      </div>
      {editing && <ReportLayoutEditor report="balance_sheet" onClose={() => setEditing(false)} />}
      {monthly && <MonthlyReport<BsResponse> report="balance-sheet" title="Balance Sheet (as at month end)" withCumulative={false} fetchColumn={fetchBsColumn} linesOf={balanceSheetLines} fmt={fmtSenPlain} pctTitle="% of total assets" />}
      {!monthly && q.isLoading && <div style={soft}>Adding the ledger up…</div>}
      {!monthly && q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The statement did not load — pick the date again to retry.</div>}
      {!monthly && q.data && lay && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
                <th style={{ padding: '6px 10px', textAlign: 'left', ...soft }}>{lay.stored ? 'On the saved layout' : 'On the chart\'s own tree'}</th>
                <th style={{ padding: '6px 10px', textAlign: 'right', ...soft }}>Amount</th>
                <th style={{ padding: '6px 10px', textAlign: 'right', ...soft }}>% of total assets</th>
              </tr>
            </thead>
            <tbody>
              <LaidBlock title="Assets" nodes={lay.assets} level={level} totalLabel="Total assets" totalSen={q.data.totals.assetsSen} baseSen={base} onPick={openLedger} tree={tree} drill={drill} />
              <LaidBlock title="Liabilities" nodes={lay.liabilities} level={level} totalLabel="Total liabilities" totalSen={q.data.totals.liabilitiesSen} baseSen={base} onPick={openLedger} tree={tree} drill={drill} />
              <LaidBlock title="Equity" nodes={lay.equity} level={level} totalLabel="Total equity" totalSen={q.data.totals.equitySen} baseSen={base} onPick={openLedger} tree={tree} drill={drill} />
              <tr>
                <td style={{ padding: '4px 10px' }}>Current period earnings</td>
                <td style={{ padding: '4px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtSenPlain(q.data.totals.earningsSen)}</td>
                <td style={{ padding: '4px 10px', textAlign: 'right', whiteSpace: 'nowrap', ...soft }}>{fmtPct(pctOf(q.data.totals.earningsSen, base))}</td>
              </tr>
              <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
                <td style={{ padding: '8px 10px', fontWeight: 700 }}>
                  {q.data.totals.checkSen === 0 ? 'BALANCED' : 'OUT OF BALANCE'}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', color: q.data.totals.checkSen === 0 ? 'var(--c-good, #2f5d4f)' : 'var(--c-danger, #a33)' }}>
                  {q.data.totals.checkSen === 0 ? fmtSenPlain(q.data.totals.assetsSen) : fmtSenPlain(q.data.totals.checkSen)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap', ...soft }}>{q.data.totals.checkSen === 0 ? fmtPct(pctOf(q.data.totals.assetsSen, base)) : ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
