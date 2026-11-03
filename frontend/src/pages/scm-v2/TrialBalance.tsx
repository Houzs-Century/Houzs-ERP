// ----------------------------------------------------------------------------
// TrialBalance — Σ Dr / Σ Cr per account and the report's own self-check: the
// difference is 0.00 or the ledger is broken (brief §3.7). In the owner's
// Claude Design (batch 6, step 5): As at a day (the shared range's end, read
// c1: GET /accounting/balances?asOf), the three tiles, the accounts by section
// on the statement table (the owner's AccountCell: code over name), each
// section totalled, the grand total last. A row opens its lines in a drawer —
// the General ledger's own read of that account, from the first of the as-at
// month to the day — with "Open in General ledger ›".
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useAccountBalances, type AccountBalance } from '../../vendor/scm/lib/accounting-queries';
import { counterLabel, fmtLedger, fmtSide, useLedger, type LedgerLine } from '../../vendor/scm/lib/ledger-queries';
import { ledgerHref, linesVisible } from '../../vendor/scm/lib/report-layout';
import { statementColumnsTable, type ReportSheet } from '../../vendor/scm/lib/report-sheet';
import { fmtDate, fmtSenPlain } from '../../vendor/shared/format';
import { isIsoDay, monthStart } from '../../lib/dateRangePresets';
import { DataTable, type Column } from '../../components/DataTable';
import { ResizableDrawer } from '../../components/ResizableDrawer';
import { DateField } from '../../vendor/scm/components/DateField';
import { useReportTree } from './ReportLayoutTree';
import { useReportRange } from './reports/useReportRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportTiles, ReportTool, ReportToolbar, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { StatementSkeleton, StatementTable } from './reports/StatementTable';
import type { StatementColumn, StatementLine } from './reports/statementColumns';
import s from './reports/Statement.module.css';

/** The sections in statement order, each with the name its block prints. */
const SECTIONS: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'ASSET', label: 'Assets' },
  { type: 'LIABILITY', label: 'Liabilities' },
  { type: 'EQUITY', label: 'Equity' },
  { type: 'INCOME', label: 'Income' },
  { type: 'EXPENSE', label: 'Expenses' },
];

const COLUMNS = (asAt: string): StatementColumn[] => [
  { key: 'dr', label: 'Debit', kind: 'period', from: monthStart(asAt), to: asAt, pct: false },
  { key: 'cr', label: 'Credit', kind: 'period', from: monthStart(asAt), to: asAt, pct: false },
  { key: 'bal', label: 'Balance', kind: 'total', from: monthStart(asAt), to: asAt, pct: false },
];

const cell = (sen: number) => ({ amountSen: sen, pct: null });

/** The Trial balance as statement lines: a block per section with its accounts
 *  (the ones with nothing posted only when asked) and its total, then the grand
 *  total — its Balance cell the difference, which must be 0.00. The sums are
 *  worked here, once; the tiles read the same totals. */
export function trialBalanceLines(rows: readonly AccountBalance[], withZero: boolean) {
  const out: StatementLine[] = [];
  let dr = 0;
  let cr = 0;
  const known = new Set(SECTIONS.map((x) => x.type));
  const sections = [...SECTIONS, ...[...new Set(rows.map((r) => r.account_type))].filter((t) => !known.has(t)).map((t) => ({ type: t, label: t }))];
  for (const sec of sections) {
    const accounts = rows
      .filter((r) => r.account_type === sec.type)
      .sort((a, b) => a.account_code.localeCompare(b.account_code));
    if (accounts.length === 0) continue;
    let sdr = 0;
    let scr = 0;
    let sbal = 0;
    const shown = accounts.filter((a) => withZero || a.total_debit_sen !== 0 || a.total_credit_sen !== 0);
    for (const a of accounts) { sdr += a.total_debit_sen; scr += a.total_credit_sen; sbal += a.balance_sen; }
    dr += sdr;
    cr += scr;
    if (shown.length === 0) continue;
    out.push({ id: `blk:${sec.type}`, label: sec.label, kind: 'block', depth: 0, cells: {} });
    for (const a of shown) {
      out.push({
        id: `acc:${a.account_code}`, label: `${a.account_code} · ${a.account_name}`, code: a.account_code, kind: 'row', depth: 1,
        cells: { dr: cell(a.total_debit_sen), cr: cell(a.total_credit_sen), bal: cell(a.balance_sen) },
      });
    }
    out.push({ id: `tot:${sec.type}`, label: `Total ${sec.label.toLowerCase()}`, kind: 'total', depth: 0, cells: { dr: cell(sdr), cr: cell(scr), bal: cell(sbal) } });
  }
  out.push({ id: 'net:total', label: 'Total', kind: 'net', depth: 0, cells: { dr: cell(dr), cr: cell(cr), bal: cell(dr - cr) } });
  return { lines: out, totals: { dr, cr, diff: dr - cr } };
}

export const TrialBalanceTab = () => {
  const r = useReportRange();
  const asAt = isIsoDay(r.to) ? r.to : r.today;
  const q = useAccountBalances(asAt);
  const [withZero, setWithZero] = useState(false);
  const [opened, setOpened] = useState<{ code: string; name: string } | null>(null);
  const tree = useReportTree('all');
  const rows = useMemo(() => q.data?.balances ?? [], [q.data]);
  const { lines, totals } = useMemo(() => trialBalanceLines(rows, withZero), [rows, withZero]);
  const columns = COLUMNS(asAt);
  const shown = linesVisible(lines, 'all', tree.open);

  /* A self-check folded over a list that is empty BECAUSE THE READ FAILED
     computes dr === cr === 0, which reads as "the books balance" — in the green
     frame, as a finding. It is not a finding about the ledger, it is the
     absence of one. `isLoading` alone cannot tell them apart: it is FALSE after
     a failed fetch, which is exactly when `rows` is emptiest. So the tiles show
     the unknown marker and the failure is stated. */
  const unknown = q.isError || (!q.isSuccess && rows.length === 0);
  const NOT_KNOWN = '—';
  const tiles: ReportTile[] = [
    { key: 'dr', label: 'Σ Debit', value: unknown ? NOT_KNOWN : fmtSenPlain(totals.dr), sub: `As at ${fmtDate(asAt)}` },
    { key: 'cr', label: 'Σ Credit', value: unknown ? NOT_KNOWN : fmtSenPlain(totals.cr), sub: `As at ${fmtDate(asAt)}` },
    {
      key: 'diff', label: 'Difference (must be 0.00)',
      value: unknown ? `${NOT_KNOWN} — not checked` : `${fmtSenPlain(totals.diff)}${totals.diff === 0 ? ' — books balance' : ' — BOOKS DO NOT BALANCE'}`,
      sub: 'Σ Debit less Σ Credit',
      tone: unknown ? 'plain' : totals.diff === 0 ? 'good' : 'late',
    },
  ];
  useReportSubtitle(`As at ${fmtDate(asAt)} · debits and credits of every account the books count`);

  const sheet = (): ReportSheet | null => (q.isSuccess ? {
    title: 'Trial Balance',
    subtitle: `As at ${fmtDate(asAt)} · ${withZero ? 'every account' : 'accounts with something posted'}`,
    meta: [{ label: 'As at', value: fmtDate(asAt) }],
    tables: [statementColumnsTable(columns.map((c) => ({ key: c.key, label: c.label, pct: false, edge: c.kind === 'total' })), shown)],
  } : null);

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={`trial-balance-${asAt}`} />
      </ReportHeaderActions>
      <ReportToolbar>
        <ReportTool label="As at">
          <DateField value={asAt} onChange={r.setAsAt} aria-label="Trial balance as at" />
        </ReportTool>
        <ReportSwitch on={withZero} onChange={setWithZero}>Accounts with nothing posted</ReportSwitch>
      </ReportToolbar>
      {q.isError && (
        <ReportMessage tone="error">
          The account balances could not be loaded, so this report is not a statement about the books.{' '}
          {q.error instanceof Error ? q.error.message : 'Please try again.'}
        </ReportMessage>
      )}
      <ReportTiles label="Trial balance figures" tiles={tiles} pending={q.isLoading} />
      {q.isLoading && <StatementSkeleton label="Adding the ledger up" />}
      {q.isSuccess && (
        <StatementTable
          widthsKey="tb"
          head="Account"
          columns={columns}
          lines={lines}
          shown={shown}
          level="all"
          tree={tree}
          showPct={false}
          finalId="net:total"
          accountCell
          onOpenRow={(l) => { if (l.code) setOpened({ code: l.code, name: l.label.slice(l.code.length + 3) }); }}
          note="Double-click an account, or press its name, for its lines this month to the day."
          drillKey={asAt}
          ariaLabel="Trial balance"
        />
      )}
      {opened && <TbLinesDrawer code={opened.code} name={opened.name} asAt={asAt} onClose={() => setOpened(null)} />}
    </>
  );
};

const DRILL_COLUMNS: Column<LedgerLine>[] = [
  { key: 'date', label: 'Date', width: '96px', getValue: (l) => l.date, render: (l) => fmtDate(l.date) },
  { key: 'entry', label: 'Entry', getValue: (l) => l.jeNo, render: (l) => l.jeNo },
  { key: 'description', label: 'Description', getValue: (l) => l.description ?? '', render: (l) => l.description ?? '—' },
  { key: 'other', label: 'Other side', getValue: (l) => counterLabel(l.counter), render: (l) => counterLabel(l.counter) || '—' },
  { key: 'ref1', label: 'Ref. 1', getValue: (l) => l.doc ?? '', render: (l) => l.doc ?? '—' },
  { key: 'ref2', label: 'Ref. 2', getValue: (l) => l.doc2 ?? '', render: (l) => l.doc2 ?? '—', defaultHidden: true },
  { key: 'debit', label: 'Debit', align: 'right', getValue: (l) => l.debitSen / 100, render: (l) => fmtSide(l.debitSen), total: (rows) => fmtLedger(rows.reduce((t, l) => t + l.debitSen, 0)) },
  { key: 'credit', label: 'Credit', align: 'right', getValue: (l) => l.creditSen / 100, render: (l) => fmtSide(l.creditSen), total: (rows) => fmtLedger(rows.reduce((t, l) => t + l.creditSen, 0)) },
  { key: 'balance', label: 'Balance', align: 'right', getValue: (l) => l.balanceSen / 100, render: (l) => fmtLedger(l.balanceSen) },
];

/** An account's lines from the first of the as-at month to the day, in a drawer
 *  — the General ledger's own read, so the two never disagree. */
function TbLinesDrawer({ code, name, asAt, onClose }: { code: string; name: string; asAt: string; onClose: () => void }) {
  const from = monthStart(asAt);
  const q = useLedger({ from, to: asAt, accounts: [code] });
  const location = useLocation();
  const block = q.data?.blocks.find((b) => b.code === code) ?? null;
  const back = { to: `${location.pathname}${location.search}`, label: 'Trial balance' };
  return (
    <ResizableDrawer
      onClose={onClose}
      title={`${code} ${name}`}
      subtitle={`${fmtDate(from)} – ${fmtDate(asAt)}${block ? ` · balance b/f ${fmtLedger(block.openingSen)}` : ''}`}
      ariaLabel={`Lines of ${code} ${name}`}
      storageKey="panel-tb-lines.v1"
      headerActions={(
        <Link to={`${ledgerHref([code], from, asAt)}&in=reports`} state={{ back }} className={s.linesGl}>
          Open in General ledger<ChevronRight size={13} strokeWidth={2} aria-hidden />
        </Link>
      )}
    >
      {q.isLoading && <p className={s.linesState}>Reading the lines…</p>}
      {q.isError && <p className={s.linesError}>The lines did not load.</p>}
      {q.data && (
        <DataTable<LedgerLine>
          tableId="rep-drill"
          columns={DRILL_COLUMNS}
          rows={block?.lines ?? []}
          emptyLabel={`No line on ${code} between ${fmtDate(from)} and ${fmtDate(asAt)}.`}
          getRowKey={(l) => l.lineId}
          exportName={`trial-balance-${code}-lines`}
          exportXlsx
        />
      )}
    </ResizableDrawer>
  );
}
