// ----------------------------------------------------------------------------
// ReceiptsPayments — the Receipts & Payments tab (owner 2026-09-06/07: 我希望
// 做一个 receipt & Payment 版式 … 做). AutoCount's shape: a column per cash/bank
// account plus Total, RECEIPTS above PAYMENTS, opening and closing per column;
// rows in the owner's own accounts (a supplier payment read through what it
// settled, rule A), or by debtor/creditor on the toggle. Pick the period,
// tick the accounts, click a figure to see the entries behind it, Print.
// The rows sit on the report's LAYOUT (docs/bugs/0912 — the big groups the
// owner asked for on 2026-09-07, showroom 费用 / operation 费用 …): one tree
// over the chart, laid out for receipts and again for payments, a category
// summing its rows per column, % of the side's total on every line, L1..Ln
// buttons, the Layout button for whoever may read the statements.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAuth } from '../../auth/AuthContext';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import { rpReportPath, useRpReport, type RpReport } from '../../vendor/scm/lib/rp-report-queries';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { rpLines, type MonthColumn } from '../../vendor/scm/lib/report-monthly';
import { ByMonthButton, MonthlyReport } from './MonthlyReport';
import { fmtRp, generateRpPdf } from '../../vendor/scm/lib/rp-report-pdf';
import { fmtPct, laidDepth, leafKeys, pctOf, type LaidNode } from '../../vendor/scm/lib/report-layout';
import { DateField } from '../../vendor/scm/components/DateField';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { LaidRows, LevelButtons, type Level } from './ReportLayoutTree';
import { ReportLayoutEditor } from './ReportLayoutEditor';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
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
  /* null = every money account; a Set = the ticked ones. */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const codes = useMemo(() => (picked ? money.map((a) => a.account_code).filter((c) => picked.has(c)) : []), [picked, money]);
  const q = useRpReport(from, to, codes, byParty);
  /* A figure clicked: the rows under it (one, or a whole category's), the column or the total. */
  const [drill, setDrill] = useState<{ side: 'R' | 'P'; id: string; label: string; rowKeys: string[]; column: string | null } | null>(null);
  const [level, setLevel] = useState<Level>('all');
  const [editing, setEditing] = useState(false);
  const [monthly, setMonthly] = useState(false);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  /* By month: the Total column of the ticked accounts, one request per
     column to the same endpoint (the ticks and the party toggle apply). */
  const fetchColumn = (col: MonthColumn) => authedFetch<RpReport>(rpReportPath(col.from, col.to, codes, byParty));

  const toggleAccount = (code: string) => setPicked((prev) => {
    const next = new Set(prev ?? money.map((a) => a.account_code));
    if (next.has(code)) next.delete(code); else next.add(code);
    return next.size === money.length ? null : next;
  });

  const r = q.data;
  const entries = useMemo(() => {
    if (!r || !drill) return [];
    return r.entries.filter((e) => e.side === drill.side && drill.rowKeys.includes(e.rowKey) && (drill.column == null || e.column === drill.column));
  }, [r, drill]);
  const pick = (side: 'R' | 'P') => (node: LaidNode, column: string | null) =>
    setDrill({ side, id: node.id, label: node.label, rowKeys: leafKeys(node), column });
  const treeDepth = r ? Math.max(laidDepth(r.layout.receipts), laidDepth(r.layout.payments)) : 0;
  const columnCodes = r ? r.columns.map((c) => c.code) : [];

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>From</span><DateField value={from} onChange={setFrom} aria-label="Receipts & Payments from" />
        <span style={soft}>To</span><DateField value={to} onChange={setTo} aria-label="Receipts & Payments to" />
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
        <Button variant="ghost" size="sm" onClick={() => { if (r) void generateRpPdf(r); }} disabled={!r || monthly}>
          <Printer size={16} strokeWidth={1.75} /> Print
        </Button>
      </div>
      {editing && <ReportLayoutEditor report="rp" onClose={() => setEditing(false)} />}
      {monthly && <MonthlyReport<RpReport> report="receipts-payments" title="Receipts & Payments (total of the ticked accounts)" withCumulative fetchColumn={fetchColumn} linesOf={rpLines} fmt={fmtRp} pctTitle="% of the side's total" keyParts={[codes.join(','), byParty ? 'party' : 'accounts']} />}
      {money.length > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          {money.map((a) => (
            <label key={a.account_code} style={{ fontSize: 'var(--fs-12)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={picked == null || picked.has(a.account_code)} onChange={() => toggleAccount(a.account_code)} aria-label={`Column ${a.account_code}`} />
              {a.account_code} · {a.account_name}
            </label>
          ))}
        </div>
      )}

      {!monthly && q.isLoading && <div style={soft}>Working the period out…</div>}
      {!monthly && q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The report did not load — adjust the dates to retry.</div>}
      {!monthly && r && r.columns.length === 0 && <div style={soft}>No money account is ticked — tick at least one bank or cash account.</div>}
      {!monthly && r && r.columns.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }} />
                {r.columns.map((c) => <th key={c.code} style={{ ...th, textAlign: 'right' }} title={c.name}>{c.code}<br /><span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{c.name}</span></th>)}
                <th style={{ ...th, textAlign: 'right' }}>Total</th>
                <th style={{ ...th, textAlign: 'right' }} title="% of total receipts, or of total payments">%</th>
              </tr>
            </thead>
            <tbody>
              <BalanceLine label="Opening balance" columns={r.columns} per={r.opening} total={r.totals.openingTotalSen} />
              <SectionLine label="RECEIPTS" span={r.columns.length + 3} />
              <LaidRows nodes={r.layout.receipts} level={level} columns={columnCodes} fmt={fmtRp} onPick={pick('R')} activeId={drill?.side === 'R' ? drill.id : null} />
              {r.receipts.length === 0 && <EmptyLine text="No money came in on these accounts in the period." span={r.columns.length + 3} />}
              <BalanceLine label="Total receipts" columns={r.columns} per={r.totals.receipts} total={r.totals.receiptsTotalSen} pct={fmtPct(pctOf(r.totals.receiptsTotalSen, r.totals.receiptsTotalSen || null))} />
              <SectionLine label="PAYMENTS" span={r.columns.length + 3} />
              <LaidRows nodes={r.layout.payments} level={level} columns={columnCodes} fmt={fmtRp} onPick={pick('P')} activeId={drill?.side === 'P' ? drill.id : null} />
              {r.payments.length === 0 && <EmptyLine text="No money went out of these accounts in the period." span={r.columns.length + 3} />}
              <BalanceLine label="Total payments" columns={r.columns} per={r.totals.payments} total={r.totals.paymentsTotalSen} pct={fmtPct(pctOf(r.totals.paymentsTotalSen, r.totals.paymentsTotalSen || null))} />
              <BalanceLine label="Closing balance" columns={r.columns} per={r.totals.closing} total={r.totals.closingTotalSen} strong />
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
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)', marginTop: 'var(--space-2)' }}>
            <thead>
              <tr><th style={{ ...th, textAlign: 'left' }}>Date</th><th style={{ ...th, textAlign: 'left' }}>Journal</th><th style={{ ...th, textAlign: 'left' }}>Document</th><th style={{ ...th, textAlign: 'left' }}>Party</th><th style={{ ...th, textAlign: 'left' }}>Account</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.jeNo}-${e.column}-${i}`} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)' }}>
                  <td style={{ padding: '4px 10px', whiteSpace: 'nowrap' }}>{fmtDateOrDash(e.entryDate)}</td>
                  <td style={{ padding: '4px 10px', fontFamily: 'var(--font-mono)' }}>{e.jeNo}</td>
                  <td style={{ padding: '4px 10px' }}>{SOURCE_WORD[String(e.sourceType ?? '').replace(/_REVERSAL$/, '')] ?? e.sourceType ?? '—'}{e.sourceDocNo ? ` ${e.sourceDocNo}` : ''}</td>
                  <td style={{ padding: '4px 10px' }}>{e.party ?? '—'}</td>
                  <td style={{ padding: '4px 10px', fontFamily: 'var(--font-mono)' }}>{e.column}</td>
                  <td style={{ padding: '4px 10px', ...num }}>{fmtRp(e.sen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const SectionLine = ({ label, span }: { label: string; span: number }) => (
  <tr><td colSpan={span} style={{ padding: '10px 10px 4px', fontWeight: 700 }}>{label}</td></tr>
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
