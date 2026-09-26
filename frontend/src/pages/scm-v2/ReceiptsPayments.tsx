// ----------------------------------------------------------------------------
// ReceiptsPayments — the Cash Flow tab (owner 2026-09-06/07: 我希望做一个
// receipt & Payment 版式 … 做; named Cash Flow on 2026-09-18 — 我认为 cash flow
// 其实就等于我的 R&P). AutoCount's shape: RECEIPTS above PAYMENTS, opening and
// closing per column. The Total column covers EVERY bank and cash account and
// is what shows by default (owner 2026-09-18: default 看 total); a tick adds
// that account's own column beside it, on paper as on the screen;
// rows in the owner's own accounts (a supplier payment read through what it
// settled, rule A), or by debtor/creditor on the toggle. Pick the period,
// tick the accounts, click a figure to see the entries behind it; Excel and
// PDF carry the table AS SHOWN — the ticked columns, the lines at the level
// chosen (owner 2026-09-19: 我这页显示什么就要 export 什么).
// The rows sit on the report's LAYOUT (docs/bugs/0912 — the big groups the
// owner asked for on 2026-09-07, showroom 费用 / operation 费用 …) — since
// 2026-09-18 the Cash Flow tree: every top category is In or Out and prints
// as a section with its own subtotal name, a running subtotal is a bold
// line, the unassigned groups sit last, then Cash Surplus / (Deficit),
// Balance b/f and Balance c/f. A category sums its rows per column, every
// line carries % of its side's total; L1..Ln buttons, the Layout button for
// whoever may read the statements.
// ----------------------------------------------------------------------------

import { Fragment, useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAuth } from '../../auth/AuthContext';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import { rpReportPath, useRpReport, type RpEntry, type RpReport } from '../../vendor/scm/lib/rp-report-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { rpLines, type MonthColumn } from '../../vendor/scm/lib/report-monthly';
import { ByMonthButton, MonthlyReport } from './MonthlyReport';
import { downloadRpXlsx, fmtRp, generateRpPdf } from '../../vendor/scm/lib/rp-report-pdf';
import { fmtPct, laidDepth, leafKeys, type LaidNode } from '../../vendor/scm/lib/report-layout';
import { DateField } from '../../vendor/scm/components/DateField';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { LaidRows, LevelButtons, useReportTree, type Level } from './ReportLayoutTree';
import { ReportLayoutEditor } from './ReportLayoutEditor';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
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

const SOURCE_WORD: Partial<Record<string, string>> = {
  PV: 'Payment voucher', SOPAY: 'Customer payment', SIPAY: 'Customer payment', RCT: 'Receipt', ODR: 'Other debtor receipt',
  SETTLE: 'Settlement', SETTLEBANK: 'Settlement', MANUAL: 'Journal', CASHUP: 'Cash-up',
};

export const ReceiptsPaymentsTab = () => {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(myt());
  const [byParty, setByParty] = useState(false);
  const accountsQ = useAccounts();
  const money = useMemo(() => (accountsQ.data?.accounts ?? []).filter((a) => a.acc_money === true && a.is_active), [accountsQ.data]);
  /* The accounts whose OWN column shows beside Total — none by default. The
     report itself always covers every money account. */
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const q = useRpReport(from, to, [], byParty);
  /* A figure clicked: the rows under it (one, or a whole category's), the column or the total. */
  const [drill, setDrill] = useState<{ sides: Array<'R' | 'P'>; id: string; label: string; rowKeys: string[]; column: string | null } | null>(null);
  const [level, setLevel] = useState<Level>('all');
  const tree = useReportTree(level);
  const [editing, setEditing] = useState(false);
  const [monthly, setMonthly] = useState(false);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  /* By month: the Total column, one request per column to the same endpoint
     (the party toggle applies). */
  const fetchColumn = (col: MonthColumn) => authedFetch<RpReport>(rpReportPath(col.from, col.to, [], byParty));

  const toggleColumn = (code: string) => setShown((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const r = q.data;
  const entries = useMemo(() => {
    if (!r || !drill) return [];
    return r.entries.filter((e) => drill.sides.includes(e.side) && drill.rowKeys.includes(e.rowKey) && (drill.column == null || e.column === drill.column));
  }, [r, drill]);
  const drillRows = useMemo<DrillEntry[]>(() => entries.map((e, idx) => ({ ...e, idx })), [entries]);
  const pick = (node: LaidNode, column: string | null) =>
    setDrill({ sides: sidesOf(node), id: node.id, label: node.label, rowKeys: leafKeys(node), column });
  /* The levels count inside a side: L1 is the first layer under RECEIPTS / PAYMENTS. */
  const treeDepth = r ? Math.max(0, ...r.layout.tree.map((n) => laidDepth(n.children))) : 0;
  const surplusPer: Record<string, number> = r ? Object.fromEntries(r.columns.map((c) => [c.code, (r.totals.receipts[c.code] ?? 0) - (r.totals.payments[c.code] ?? 0)])) : {};
  const columns = r ? r.columns.filter((c) => shown.has(c.code)) : [];
  const columnCodes = columns.map((c) => c.code);

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>From</span><DateField value={from} onChange={setFrom} aria-label="Cash Flow from" />
        <span style={soft}>To</span><DateField value={to} onChange={setTo} aria-label="Cash Flow to" />
        <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={byParty} onChange={(e) => setByParty(e.target.checked)} aria-label="Show debtor and creditor names" />
          by debtor / creditor
        </label>
        <LevelButtons depth={treeDepth} level={level} onLevel={setLevel} />
        <ByMonthButton on={monthly} onToggle={() => setMonthly((v) => !v)} />
        {canArrange && (
          <Button variant="ghost" size="sm" onClick={() => setEditing((e) => !e)} aria-pressed={editing}>Layout</Button>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={() => { if (r) void downloadRpXlsx(r, { columns: columnCodes, level, open: tree.open }); }} disabled={!r || monthly}>
          <Download size={16} strokeWidth={1.75} /> Excel
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { if (r) void generateRpPdf(r, { columns: columnCodes, level, open: tree.open }); }} disabled={!r || monthly}>
          <Printer size={16} strokeWidth={1.75} /> PDF
        </Button>
      </div>
      {editing && <ReportLayoutEditor report="rp" onClose={() => setEditing(false)} />}
      {monthly && <MonthlyReport<RpReport> report="receipts-payments" title="Cash Flow (every bank and cash account)" withCumulative fetchColumn={fetchColumn} linesOf={rpLines} fmt={fmtRp} pctTitle="% of the side's total" keyParts={[byParty ? 'party' : 'accounts']} />}
      {money.length > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={soft}>Total covers every account · tick one to see its own column:</span>
          {money.map((a) => (
            <label key={a.account_code} style={{ fontSize: 'var(--fs-12)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={shown.has(a.account_code)} onChange={() => toggleColumn(a.account_code)} aria-label={`Column ${a.account_code}`} />
              {a.account_code} · {a.account_name}
            </label>
          ))}
        </div>
      )}

      {!monthly && q.isLoading && <div style={soft}>Working the period out…</div>}
      {!monthly && q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The report did not load — adjust the dates to retry.</div>}
      {!monthly && r && r.columns.length === 0 && <div style={soft}>This company has no active bank or cash account.</div>}
      {!monthly && r && r.columns.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }} />
                {columns.map((c) => <th key={c.code} style={{ ...th, textAlign: 'right' }} title={c.name}>{c.code}<br /><span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{c.name}</span></th>)}
                <th style={{ ...th, textAlign: 'right' }}>Total</th>
                <th style={{ ...th, textAlign: 'right' }} title="% of total receipts, or of total payments">%</th>
              </tr>
            </thead>
            <tbody>
              {r.layout.tree.map((n) => (n.kind === 'subtotal'
                ? <BalanceLine key={n.id} label={n.label} columns={columns} per={n.cells ?? {}} total={n.amountSen} strong />
                : (
                  <Fragment key={n.id}>
                    <SectionLine label={n.label} span={columns.length + 3} muted={n.kind === 'unassigned'} />
                    <LaidRows nodes={n.children} level={level} columns={columnCodes} fmt={fmtRp} onPick={pick} activeId={drill?.id ?? null} tree={tree} drill={{ from, to }} />
                    {n.children.length === 0 && <EmptyLine text={n.flow === 'out' ? 'No money went out of these accounts in the period.' : 'No money came in on these accounts in the period.'} span={columns.length + 3} />}
                    <BalanceLine label={n.totalLabel ?? `Total ${n.label}`} columns={columns} per={n.cells ?? {}} total={n.amountSen} pct={fmtPct(n.pct)} />
                  </Fragment>
                )))}
              <BalanceLine label="Cash Surplus / (Deficit)" columns={columns} per={surplusPer} total={r.totals.receiptsTotalSen - r.totals.paymentsTotalSen} strong />
              <BalanceLine label="Balance b/f" columns={columns} per={r.opening} total={r.totals.openingTotalSen} />
              <BalanceLine label="Balance c/f" columns={columns} per={r.totals.closing} total={r.totals.closingTotalSen} strong />
            </tbody>
          </table>
        </div>
      )}

      {r && drill && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <b style={{ fontSize: 'var(--fs-13)' }}>
              {drill.label}
              {drill.column ? ` · ${drill.column}` : ''} — {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
            </b>
            <Button variant="ghost" size="sm" onClick={() => setDrill(null)}>Close</Button>
          </div>
          <DataTable<DrillEntry>
            tableId="rp-drill-entries"
            exportName="receipts-payments-entries"
            exportXlsx
            columns={DRILL_COLUMNS}
            rows={drillRows}
            emptyLabel="No entry behind this figure."
            getRowKey={(e) => e.idx}
          />
        </div>
      )}
    </div>
  );
};

type DrillEntry = RpEntry & { idx: number };
const docText = (e: RpEntry): string =>
  `${SOURCE_WORD[String(e.sourceType ?? '').replace(/_REVERSAL$/, '')] ?? e.sourceType ?? '—'}${e.sourceDocNo ? ` ${e.sourceDocNo}` : ''}`;
const DRILL_COLUMNS: Column<DrillEntry>[] = [
  { key: 'date', label: 'Date', render: (e) => fmtDateOrDash(e.entryDate), getValue: (e) => e.entryDate, exportFormat: 'date' },
  { key: 'journal', label: 'Journal', render: (e) => <span style={{ fontFamily: 'var(--font-mono)' }}>{e.jeNo}</span>, getValue: (e) => e.jeNo },
  { key: 'document', label: 'Document', render: docText, getValue: docText },
  { key: 'party', label: 'Party', render: (e) => e.party ?? '—', getValue: (e) => e.party ?? '' },
  { key: 'account', label: 'Account', render: (e) => <span style={{ fontFamily: 'var(--font-mono)' }}>{e.column}</span>, getValue: (e) => e.column },
  {
    key: 'amount', label: 'Amount', align: 'right', render: (e) => fmtRp(e.sen),
    getValue: (e) => e.sen, exportValue: (e) => e.sen / 100, exportFormat: 'money',
  },
];

const SectionLine = ({ label, span, muted }: { label: string; span: number; muted?: boolean }) => (
  <tr><td colSpan={span} style={{ padding: '10px 10px 4px', fontWeight: 700, ...(muted ? { fontStyle: 'italic', ...soft } : {}) }}>{label}</td></tr>
);
const EmptyLine = ({ text, span }: { text: string; span: number }) => (
  <tr><td colSpan={span} style={{ padding: '2px 10px 2px 24px', ...soft }}>{text}</td></tr>
);
const BalanceLine = ({ label, columns, per, total, strong, pct }: { label: string; columns: RpReport['columns']; per: Record<string, number>; total: number; strong?: boolean; pct?: string }) => (
  <tr style={{ borderTop: strong ? '2px solid var(--c-ink, #221f20)' : '1px solid var(--border-weak, #e3e1da)' }}>
    <td style={{ padding: '6px 10px', fontWeight: 700 }}>{label}</td>
    {columns.map((c) => <td key={c.code} style={{ padding: '6px 10px', fontWeight: 600, ...num }}>{fmtRp(per[c.code] ?? 0)}</td>)}
    <td style={{ padding: '6px 10px', fontWeight: 700, ...num }}>{fmtRp(total)}</td>
    <td style={{ padding: '6px 10px', ...num, ...soft }}>{pct ?? ''}</td>
  </tr>
);
