// ----------------------------------------------------------------------------
// ReceiptsPayments — the Cash Flow tab (owner 2026-09-06/07: 我希望做一个
// receipt & Payment 版式 … 做; named Cash Flow on 2026-09-18 — 我认为 cash flow
// 其实就等于我的 R&P), in the owner's Claude Design (batch 6, step 4).
// AutoCount's shape: RECEIPTS above PAYMENTS, opening and closing per column.
// The Total column covers EVERY bank and cash account and is what shows by
// default (owner 2026-09-18: default 看 total); the Accounts picker adds an
// account's own column beside it, on paper as on the screen. Rows in the
// owner's own accounts (a supplier payment read through what it settled, rule
// A), or by debtor / creditor. Columns: Total, or By month (one read of the
// same endpoint per month, Total leftmost). A figure opens the entries behind
// it right under its row; Excel, PDF and Print carry the table AS SHOWN — the
// columns, the lines at the level chosen (owner 2026-09-19: 我这页显示什么就要
// export 什么).
// The rows sit on the report's LAYOUT (docs/bugs/0912; the Cash Flow tree since
// 2026-09-18): every top category is In or Out and prints as a section with
// its own subtotal name, a running subtotal is a bold line, the unassigned
// groups sit last, then Cash surplus / (deficit), Balance b/f and Balance c/f,
// each split into the banks and the card money not yet in the bank (the Card
// column: a swipe is Cash In on its own day, owner 2026-11-05).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, X } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import { AUTOCOUNT_LINE_ID, AUTOCOUNT_LINE_LABEL, balanceParts, CARD_COLUMN, rpReportPath, useRpReport, withAutoCountLine, type RpEntry, type RpReport } from '../../vendor/scm/lib/rp-report-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { mergeColumns, rpLines } from '../../vendor/scm/lib/report-monthly';
import { cashFlowSheet, fmtRp } from '../../vendor/scm/lib/rp-report-pdf';
import { flattenLaid, leafKeys, linesVisible, pctOf, type LaidNode } from '../../vendor/scm/lib/report-layout';
import { statementColumnsTable, type ReportSheet } from '../../vendor/scm/lib/report-sheet';
import { fmtDate, fmtDateOrDash } from '../../vendor/shared/format';
import { useReportTree, type Level } from './ReportLayoutTree';
import { ReportLayoutEditor } from './ReportLayoutEditor';
import { FinanceDateRange } from './reports/FinanceDateRange';
import { useReportRange } from './reports/useReportRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
} from './reports/reportParts';
import { StatementSkeleton, StatementTable } from './reports/StatementTable';
import { MONTH_COUNTS, columnsSpan, monthColumns, monthName, type StatementColumn, type StatementLine } from './reports/statementColumns';
import {
  REPORT_CHART_COLORS, ReportBarChart, chartMonths, thousands, useChartMonths, useChartPeriods,
  type ChartBarSeries, type ChartMonth,
} from './reports/ReportBarChart';
import type { ChartWindow } from './reports/chartWindow';
import type { DashboardPeriod } from '../../vendor/scm/lib/dashboard-queries';
import st from './reports/Statement.module.css';
import s from './ReceiptsPayments.module.css';

type CashView = 'total' | 'month';
const VIEWS: ReadonlyArray<{ value: CashView; label: string }> = [
  { value: 'total', label: 'Total' },
  { value: 'month', label: 'By month' },
];
const ROWS: ReadonlyArray<{ value: 'accounts' | 'party'; label: string }> = [
  { value: 'accounts', label: 'By account' },
  { value: 'party', label: 'By debtor / creditor' },
];
const MONTH_OPTIONS = MONTH_COUNTS.map((n) => ({ value: n, label: String(n) }));

/** Which entries a node's figure opens: an In line the receipts, an Out line
    the payments, a Net line both — a category whatever its lines carry. */
const sidesOf = (n: LaidNode): Array<'R' | 'P'> => {
  const flows = new Set<string>();
  const walk = (x: LaidNode): void => { if (x.children.length === 0) flows.add(x.flow ?? 'net'); else x.children.forEach(walk); };
  walk(n);
  const out: Array<'R' | 'P'> = [];
  if (flows.has('in') || flows.has('net')) out.push('R');
  if (flows.has('out') || flows.has('net')) out.push('P');
  return out;
};

/** Every node of the tree by its id — what a line's figure opens is read off its node. */
const nodesById = (r: RpReport | undefined): Map<string, LaidNode> => {
  const out = new Map<string, LaidNode>();
  for (const top of r?.layout.tree ?? []) for (const { node } of flattenLaid(top.children)) out.set(node.id, node);
  return out;
};

const SOURCE_WORD: Partial<Record<string, string>> = {
  PV: 'Payment voucher', SOPAY: 'Customer payment', SIPAY: 'Customer payment', RCT: 'Receipt', ODR: 'Other debtor receipt',
  SETTLE: 'Settlement', SETTLEBANK: 'Settlement', MANUAL: 'Journal', CASHUP: 'Cash-up', AUTOCOUNT: 'AutoCount',
};

type DrillEntry = RpEntry & { idx: number };
const docText = (e: RpEntry): string =>
  `${SOURCE_WORD[String(e.sourceType ?? '').replace(/_REVERSAL$/, '')] ?? e.sourceType ?? '—'}${e.sourceDocNo ? ` ${e.sourceDocNo}` : ''}`;
const DRILL_COLUMNS: Column<DrillEntry>[] = [
  { key: 'date', label: 'Date', render: (e) => fmtDateOrDash(e.entryDate), getValue: (e) => e.entryDate, exportFormat: 'date' },
  { key: 'journal', label: 'Journal', render: (e) => e.jeNo, getValue: (e) => e.jeNo },
  { key: 'document', label: 'Document', render: docText, getValue: docText },
  { key: 'party', label: 'Party', render: (e) => e.party ?? '—', getValue: (e) => e.party ?? '' },
  { key: 'account', label: 'Account', render: (e) => e.column, getValue: (e) => e.column },
  {
    key: 'amount', label: 'Amount', align: 'right', render: (e) => fmtRp(e.sen),
    getValue: (e) => e.sen, exportValue: (e) => e.sen / 100, exportFormat: 'money',
  },
];

/* ── The lines ────────────────────────────────────────────────────────────── */

const EMPTY_IN = 'No money came in on these accounts in the period.';
const EMPTY_OUT = 'No money went out of these accounts in the period.';

/** The Total view's lines: a column per account picked, then Total with its
 *  % of the side's total; the surplus as % of the receipts; the card memo
 *  lines in the Total column only. */
export function cashFlowLines(r: RpReport, codes: readonly string[]): StatementLine[] {
  const cells = (per: Record<string, number> | undefined, total: number, pct: number | null) => ({
    ...Object.fromEntries(codes.map((c) => [c, { amountSen: per?.[c] ?? 0, pct: null }])),
    total: { amountSen: total, pct },
  });
  const t = r.totals;
  const out: StatementLine[] = [];
  for (const n of r.layout.tree) {
    if (n.kind === 'subtotal') { out.push({ id: n.id, label: n.label, kind: 'net', depth: 0, cells: cells(n.cells, n.amountSen, null) }); continue; }
    out.push({ id: `blk:${n.id}`, label: n.label, kind: 'block', depth: 0, cells: {} });
    for (const { node, depth } of flattenLaid(n.children)) {
      out.push({
        id: node.id, label: node.label, depth,
        kind: node.kind === 'account' ? 'row' : node.kind === 'unassigned' ? 'unassigned' : 'category',
        ...(node.code ? { code: node.code } : {}),
        ...(node.totalLabel ? { totalLabel: node.totalLabel } : {}),
        cells: cells(node.cells, node.amountSen, node.pct),
      });
    }
    if (n.children.length === 0) out.push({ id: `empty:${n.id}`, label: n.flow === 'out' ? EMPTY_OUT : EMPTY_IN, kind: 'memo', depth: 1, cells: {} });
    out.push({ id: `tot:${n.id}`, label: n.totalLabel ?? `Total ${n.label}`, kind: 'total', depth: 0, cells: cells(n.cells, n.amountSen, n.pct) });
  }
  const surplusPer = Object.fromEntries(r.columns.map((c) => [c.code, (t.receipts[c.code] ?? 0) - (t.payments[c.code] ?? 0)]));
  const surplus = t.receiptsTotalSen - t.paymentsTotalSen;
  out.push({ id: 'net:surplus', label: 'Cash surplus / (deficit)', kind: 'net', depth: 0, cells: cells(surplusPer, surplus, pctOf(surplus, t.receiptsTotalSen)) });
  /* Each balance in two parts, the banks and the card money not yet in the bank (owner 2026-11-05). */
  const parts = (id: string, per: Record<string, number>, total: number): StatementLine[] =>
    balanceParts(r, id, per, total).map((p) => ({ id: p.id, label: p.label, kind: 'row', depth: 1, cells: cells(p.per, p.sen, null) }));
  out.push({ id: 'bal:opening', label: 'Balance b/f', kind: 'total', depth: 0, cells: cells(r.opening, t.openingTotalSen, null) });
  out.push(...parts('bal:opening', r.opening, t.openingTotalSen));
  out.push({ id: 'bal:closing', label: 'Balance c/f', kind: 'net', depth: 0, cells: cells(t.closing, t.closingTotalSen, null) });
  out.push(...parts('bal:closing', t.closing, t.closingTotalSen));
  /* Customers' money AutoCount recorded after the books started (owner 2026-11-08): grey, in the Total column only, in no total. */
  return withAutoCountLine(r, out, (depth, sen): StatementLine =>
    ({ id: AUTOCOUNT_LINE_ID, label: AUTOCOUNT_LINE_LABEL, kind: 'memo', depth, drill: true, cells: { total: { amountSen: sen, pct: null } } }));
}

/** By month: each column the report for its month (rpLines: every line's % of
 *  its side, the surplus's of the receipts), merged by line id. */
export function cashFlowMonthLines(columns: StatementColumn[], byKey: Partial<Record<string, RpReport>>): StatementLine[] {
  return mergeColumns(columns.filter((c) => byKey[c.key]).map((c) => ({ key: c.key, lines: rpLines(byKey[c.key]!) })));
}

/* ── The page ─────────────────────────────────────────────────────────────── */

export const ReceiptsPaymentsTab = () => {
  const r = useReportRange();
  const [view, setView] = useState<CashView>('total');
  const [byParty, setByParty] = useState(false);
  const [months, setMonths] = useState<number>(6);
  const [level, setLevel] = useState<Level>('all');
  const [showPct, setShowPct] = useState(true);
  const [editing, setEditing] = useState(false);
  /* The accounts whose OWN column shows beside Total — none by default. The
     report itself always covers every money account. */
  const [ticked, setTicked] = useState<string[]>([]);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  const tree = useReportTree(level);
  const chartWin = useChartMonths(r.from, r.to, r.usable);
  const accountsQ = useAccounts();
  const money = useMemo(() => (accountsQ.data?.accounts ?? []).filter((a) => a.acc_money === true && a.is_active), [accountsQ.data]);

  /* Total: one read, as today. By month: the same endpoint once per column. */
  const q = useRpReport(r.usable && view === 'total' ? r.from : '', r.usable && view === 'total' ? r.to : '', [], byParty);
  const columns = useMemo(() => (r.usable && view === 'month' ? monthColumns(r.to, months, r.today, true) : []), [r.usable, view, r.to, months, r.today]);
  const monthReads = useQueries({
    queries: columns.map((c) => ({
      queryKey: ['report-rp', c.from, c.to, '', byParty],
      queryFn: () => authedFetch<RpReport>(rpReportPath(c.from, c.to, [], byParty)),
      staleTime: 30_000,
    })),
  });
  const byKey: Partial<Record<string, RpReport>> = {};
  columns.forEach((c, i) => { const d = monthReads[i]?.data; if (d) byKey[c.key] = d; });

  const report = q.data;
  const codes = useMemo(() => (report ? report.columns.map((c) => c.code).filter((c) => ticked.includes(c)) : []), [report, ticked]);
  const totalColumns: StatementColumn[] = useMemo(() => [
    ...codes.map((code): StatementColumn => ({ key: code, label: code, sub: report?.columns.find((c) => c.code === code)?.name ?? '', kind: 'period', from: r.from, to: r.to, pct: false })),
    { key: 'total', label: 'Total', sub: 'Every bank and cash account', kind: 'total', from: r.from, to: r.to, pct: true },
  ], [codes, report, r.from, r.to]);
  const shownColumns = view === 'total' ? totalColumns : columns;
  const lines = view === 'total' ? (report ? cashFlowLines(report, codes) : []) : cashFlowMonthLines(columns, byKey);
  const shown = linesVisible(lines, level, tree.open);
  const depth = lines.reduce((d, l) => Math.max(d, l.depth), 0);
  const loading = view === 'total' ? q.isLoading : monthReads.some((x) => x.isLoading);
  const failed = view === 'total' ? (q.isError ? 1 : 0) : monthReads.filter((x) => x.isError).length;
  const head = view === 'total' ? report : byKey.total;
  const span = columnsSpan(shownColumns);
  const rowsWord = byParty ? 'by debtor / creditor' : "by the owner's accounts";
  const periodText = view === 'month' ? `${monthName(span.from)} – ${monthName(span.to)} · ${months} months` : `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  const layoutWord = head ? (head.layout.stored ? ' · on the saved layout' : " · on the chart's own tree") : '';
  useReportSubtitle(r.usable ? `${periodText} · every bank and cash account · ${rowsWord} · % of the side's total${layoutWord}` : 'Pick dates.');

  /* The entries behind a figure: the rows under it (one, or a whole category's), the column or the total. */
  const entriesFor = (l: StatementLine, col: StatementColumn | null): { entries: DrillEntry[]; label: string } => {
    /* Total: the one read, an account's column filtering by account. By month:
       the column's own read — the name opens the Total column's, the whole span. */
    const src = view === 'total' ? report : byKey[col?.key ?? 'total'];
    if (l.id === AUTOCOUNT_LINE_ID) return { entries: (src?.autoCount?.entries ?? []).map((e, idx) => ({ ...e, idx })), label: col?.label ?? 'Total' };
    const node = nodesById(src).get(l.id);
    const label = col?.label ?? 'Total';
    if (!src || !node) return { entries: [], label };
    const sides = sidesOf(node);
    const keys = leafKeys(node);
    const account = view === 'total' && col?.kind === 'period' ? col.key : null;
    const entries = src.entries
      .filter((e) => sides.includes(e.side) && keys.includes(e.rowKey) && (account == null || e.column === account))
      .map((e, idx) => ({ ...e, idx }));
    return { entries, label };
  };

  const sheet = (): ReportSheet | null => {
    if (view === 'total') return report ? cashFlowSheet(report, { columns: codes, level, open: tree.open, pct: showPct }) : null;
    if (columns.some((c) => !byKey[c.key])) return null;
    return {
      title: 'Cash Flow',
      subtitle: `By month · ${periodText} · every bank and cash account · ${rowsWord} · ${showPct ? "% of the side's total beside" : 'amounts'}`,
      meta: [{ label: 'Months', value: `${monthName(span.from)} – ${monthName(span.to)}` }, { label: 'Rows', value: rowsWord }],
      tables: [statementColumnsTable(columns.map((c) => ({ key: c.key, label: c.label, pct: showPct, edge: c.kind === 'total' })), shown)],
      fmt: fmtRp,
    };
  };
  const fileBase = view === 'month' ? `cash-flow-monthly-${span.from.slice(0, 7)}-${span.to.slice(0, 7)}` : `cash-flow-${r.from}-to-${r.to}`;

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={fileBase} onLayout={canArrange ? () => setEditing((v) => !v) : undefined} layoutOn={editing} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange />
        <ReportTool label="Columns"><Segmented options={VIEWS} value={view} onChange={setView} label="Columns" /></ReportTool>
        {view === 'total' && money.length > 0 && (
          <ReportTool label="Accounts">
            <AccountsPicker accounts={[...money.map((a) => ({ code: a.account_code, name: a.account_name })), ...(report?.columns.filter((c) => c.code === CARD_COLUMN) ?? [])]} ticked={ticked} onTicked={setTicked} />
          </ReportTool>
        )}
        {view === 'month' && (
          <ReportTool label="Months"><Segmented options={MONTH_OPTIONS} value={months} onChange={setMonths} label="Months" /></ReportTool>
        )}
        <ReportTool label="Rows">
          <Segmented options={ROWS} value={byParty ? 'party' : 'accounts'} onChange={(v) => setByParty(v === 'party')} label="Show debtor and creditor names" />
        </ReportTool>
        {depth >= 2 && (
          <ReportTool label="Levels">
            <Segmented
              options={[...Array.from({ length: depth }, (_, i) => ({ value: (i + 1) as Level, label: `L${i + 1}` })), { value: 'all' as Level, label: 'All' }]}
              value={level}
              onChange={setLevel}
              label="Levels"
            />
          </ReportTool>
        )}
        <ReportSwitch on={showPct} onChange={setShowPct}>% beside</ReportSwitch>
      </ReportToolbar>
      {editing && <ReportLayoutEditor report="rp" onClose={() => setEditing(false)} />}
      {chartWin && <CashFlowChart win={chartWin} />}
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {r.usable && failed > 0 && (
        <ReportMessage tone="error">
          {view === 'total' ? 'The report did not load — adjust the dates to retry.' : `${failed} column(s) did not load — adjust the dates to retry.`}
        </ReportMessage>
      )}
      {r.usable && loading && <StatementSkeleton label="Working the period out" />}
      {r.usable && view === 'total' && report && report.columns.length === 0 && (
        <ReportMessage>This company has no active bank or cash account.</ReportMessage>
      )}
      {r.usable && !loading && lines.length > 0 && (view === 'month' || (report && report.columns.length > 0)) && (
        <StatementTable
          widthsKey={view === 'total' ? 'cf-total' : 'cf-month'}
          head="Account"
          columns={shownColumns}
          lines={lines}
          shown={shown}
          level={level}
          tree={tree}
          showPct={showPct}
          fmt={fmtRp}
          finalId="bal:closing"
          strongIds={STRONG}
          drillRows="figures"
          renderLines={(l, col, close, colSpan) => {
            const { entries, label } = entriesFor(l, col);
            return <EntriesRow key={`e:${l.id}`} title={l.label} sub={label} entries={entries} colSpan={colSpan} onClose={close} />;
          }}
          note="% beside each receipt is of the receipts, beside each payment of the payments; the surplus’s is of the receipts. Click a figure for the entries behind it."
          drillKey={`${view}|${r.from}|${r.to}|${byParty}|${months}|${codes.join(',')}`}
          ariaLabel="Cash flow"
        />
      )}
    </>
  );
};

const STRONG = new Set(['net:surplus']);

/** The entries behind a figure, under its row: the six columns of today's list, its own Export. */
function EntriesRow({ title, sub, entries, colSpan, onClose }: { title: string; sub: string; entries: DrillEntry[]; colSpan: number; onClose: () => void }) {
  return (
    <tr className={st.linesRow}>
      <td colSpan={colSpan}>
        <div className={st.lines} role="region" aria-label={`Entries of ${title}`}>
          <div className={st.linesHead}>
            <BookOpen size={14} strokeWidth={1.75} aria-hidden className={st.linesIcon} />
            <span className={st.linesTitle}>
              <span className={st.linesName}>{title}</span>
              <span className={st.linesSub}> · {sub} · {entries.length === 1 ? '1 entry' : `${entries.length} entries`}</span>
            </span>
            <button type="button" className={st.linesClose} title="Close the lines" aria-label="Close the lines" onClick={onClose}>
              <X size={12} strokeWidth={2} aria-hidden />
            </button>
          </div>
          <DataTable<DrillEntry>
            tableId="rp-drill-entries"
            exportName="receipts-payments-entries"
            exportXlsx
            columns={DRILL_COLUMNS}
            rows={entries}
            emptyLabel="No entry behind this figure."
            getRowKey={(e) => e.idx}
          />
        </div>
      </td>
    </tr>
  );
}

/** "Add an account's column": Total always shows every bank and cash account
 *  together; a tick adds an account's own column beside it. */
function AccountsPicker({ accounts, ticked, onTicked }: {
  accounts: Array<{ code: string; name: string }>;
  ticked: string[];
  onTicked: (codes: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const value = ticked.length === 0
    ? 'Total only'
    : ticked.length === 1
      ? `Total + ${accounts.find((a) => a.code === ticked[0])?.name ?? ticked[0]}`
      : `Total + ${ticked.length} accounts`;
  const toggle = (code: string) => onTicked(ticked.includes(code) ? ticked.filter((c) => c !== code) : [...ticked, code]);
  return (
    <div className={s.picker} ref={ref}>
      <button type="button" className={s.pickerButton} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {value}<ChevronDown size={13} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div className={s.pop} role="dialog" aria-label="Add an account's column">
          <div className={s.popHead}>
            <div className={s.popTitle}>Add an account&apos;s column</div>
            <div className={s.popSub}>Total always shows every bank and cash account together.</div>
          </div>
          <div className={s.popList}>
            {accounts.map((a) => {
              const on = ticked.includes(a.code);
              return (
                <button key={a.code} type="button" role="checkbox" aria-checked={on} aria-label={`Column ${a.code}`} className={s.popRow} onClick={() => toggle(a.code)}>
                  <span className={`${s.tick} ${on ? s.tickOn : ''}`} aria-hidden>{on && <Check size={11} strokeWidth={3} />}</span>
                  <span className={s.popName}>{a.name}</span>
                  <span className={s.popCode}>{a.code}</span>
                </button>
              );
            })}
          </div>
          <div className={s.popFoot}>
            <button type="button" className={s.popLink} onClick={() => onTicked(accounts.map((a) => a.code))}>Tick all</button>
            <button type="button" className={s.popLink} onClick={() => onTicked([])}>Total only</button>
            <span className={s.grow} />
            <button type="button" className={s.popDone} onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── The chart (batch 6 §4.1): money in and out of every bank and cash
   account a month, the surplus or deficit under each, from the Dashboard's
   one read of the Cash Flow builder's figures. ── */
const CASH_SERIES: ChartBarSeries[] = [
  { key: 'in', label: 'Money in', color: REPORT_CHART_COLORS.petrol },
  { key: 'out', label: 'Money out', color: REPORT_CHART_COLORS.gold },
];

/** A month of the Cash flow chart — the builder's figures as they are. */
export function cashChartMonth(p: DashboardPeriod): Omit<ChartMonth, 'month'> | null {
  const c = p.cashFlow;
  if (!c) return null;
  const deficit = c.netSen < 0;
  return {
    values: { in: c.inSen, out: c.outSen },
    bottom: [
      { label: 'Cash surplus / (deficit)', value: fmtRp(c.netSen), loss: deficit },
      { label: 'Balance c/f', value: fmtRp(c.closingSen) },
    ],
    under: { text: thousands(c.netSen), loss: deficit },
  };
}

function CashFlowChart({ win }: { win: ChartWindow }) {
  const periods = useChartPeriods(win);
  return (
    <ReportBarChart
      title="Money in and out"
      series={CASH_SERIES}
      months={chartMonths(win, periods.byMonth, cashChartMonth)}
      win={win}
      loading={periods.isLoading}
      failed={periods.isError}
      note="Under each month: the cash surplus, RM thousand — red is a deficit. Shaded months are in the period; click a month to open it."
    />
  );
}
