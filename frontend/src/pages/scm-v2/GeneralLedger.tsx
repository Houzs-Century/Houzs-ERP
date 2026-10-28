// ----------------------------------------------------------------------------
// GeneralLedger — the General Ledger the AutoCount way (owner 2026-09-14, from
// his AutoCount screenshot: 点开看明细其实就是看 general ledger … gl 显示的资料也要
// 优化; docs/bugs/0924). One block per account: its code over its name, a
// BALANCE B/F row, every line of the period with a running balance, the
// block's totals; the grand totals at the foot. The columns are his: Date ·
// Entry · Journal · Other side · Ref. 1 · Ref. 2 · Description · Debit ·
// Credit · Balance.
//
// The filters live in the URL (/scm/accounting?tab=gl&accounts=…&from=…&to=…)
// so a figure on the P&L or the balance sheet opens this page on its account
// and period, and a ledger can be handed on as a link. A reversed entry and
// its contra are left out until "Show reversed entries" is ticked, and then
// they are listed and marked but move nothing (docs/bugs/0923).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@2990s/design-system';
import { Download, Printer } from 'lucide-react';
import { DateField } from '../../vendor/scm/components/DateField';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import {
  counterLabel, downloadLedgerCsv, fmtLedger, fmtSide, journalLabel, useLedger,
  type LedgerBlock, type LedgerLine, type LedgerParams,
} from '../../vendor/scm/lib/ledger-queries';
import { fmtDate } from '../../vendor/shared/format';
import { AccountCell } from './JournalEntryCards';
import styles from './Suppliers.module.css';

const card: React.CSSProperties = {
  padding: 0,
  background: 'var(--c-cream)',
  border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
  borderRadius: 'var(--radius-md)',
  overflowX: 'auto',
};
const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const th: React.CSSProperties = { padding: '6px 8px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: React.CSSProperties = { padding: '4px 8px', verticalAlign: 'top', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' };
const num: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The ledger's filters as the URL carries them — one reader for the page and for a test. */
export const ledgerParamsFromSearch = (params: URLSearchParams): LedgerParams => {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  return {
    from: DATE.test(from) ? from : monthStart(),
    to: DATE.test(to) ? to : myt(),
    accounts: (params.get('accounts') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    fromAccount: params.get('fromAccount') ?? '',
    toAccount: params.get('toAccount') ?? '',
    showReversed: ['1', 'true'].includes(params.get('showReversed') ?? ''),
  };
};

const REVERSAL_WORD = { reversed: 'reversed', contra: 'contra', '': '' } as const;

const LineRow = ({ l }: { l: LedgerLine }) => (
  <tr data-reversal={l.reversal || undefined} style={l.reversal ? { color: 'var(--text-soft, #8a8578)' } : undefined}>
    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(l.date)}</td>
    <td style={td}><span className={styles.codeChip}>{l.jeNo}</span></td>
    <td style={td}>{journalLabel(l.journal)}</td>
    <td style={td} title={counterLabel(l.counter)}>
      {l.counter ? <><AccountCell code={l.counter.code} name={l.counter.name} />{l.counter.more > 0 && <span style={soft}> +{l.counter.more}</span>}</> : '—'}
    </td>
    <td style={td}>{l.doc ?? '—'}</td>
    <td style={td}>{l.doc2 ?? '—'}</td>
    <td style={td}>
      {l.description ?? '—'}
      {l.reversal && <span className={styles.codeChip} style={{ marginLeft: 6 }}>{REVERSAL_WORD[l.reversal]}</span>}
    </td>
    <td style={num}>{fmtSide(l.debitSen)}</td>
    <td style={num}>{fmtSide(l.creditSen)}</td>
    <td style={num}>{fmtLedger(l.balanceSen)}</td>
  </tr>
);

const Block = ({ b }: { b: LedgerBlock }) => (
  <tbody data-account={b.code}>
    <tr>
      <td colSpan={10} style={{ padding: '12px 8px 4px', fontWeight: 700, background: 'var(--c-cream-2, rgba(34,31,32,0.03))' }}>
        <AccountCell code={b.code} name={b.name} />
      </td>
    </tr>
    <tr>
      <td colSpan={7} style={{ ...td, fontStyle: 'italic', ...soft }}>BALANCE B/F</td>
      <td style={num} /><td style={num} />
      <td style={{ ...num, fontStyle: 'italic' }}>{fmtLedger(b.openingSen)}</td>
    </tr>
    {b.lines.map((l) => <LineRow key={l.lineId} l={l} />)}
    <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
      <td colSpan={7} style={{ ...td, fontWeight: 600 }}>TOTAL</td>
      <td style={{ ...num, fontWeight: 700 }}>{fmtLedger(b.debitSen)}</td>
      <td style={{ ...num, fontWeight: 700 }}>{fmtLedger(b.creditSen)}</td>
      <td style={{ ...num, fontWeight: 700 }}>{fmtLedger(b.closingSen)}</td>
    </tr>
  </tbody>
);

export const GeneralLedger = () => {
  const [params, setParams] = useSearchParams();
  const p = useMemo(() => ledgerParamsFromSearch(params), [params]);
  const accounts = useAccounts();
  const [adding, setAdding] = useState('');

  /* Every filter change is written to the URL — the page has no state of its own. */
  const update = (patch: Partial<LedgerParams>) => {
    const next = { ...p, ...patch };
    const q = new URLSearchParams(params);
    q.set('tab', 'gl');
    q.set('from', next.from);
    q.set('to', next.to);
    if (next.accounts && next.accounts.length > 0) q.set('accounts', next.accounts.join(',')); else q.delete('accounts');
    if (next.fromAccount) q.set('fromAccount', next.fromAccount); else q.delete('fromAccount');
    if (next.toAccount) q.set('toAccount', next.toAccount); else q.delete('toAccount');
    if (next.showReversed) q.set('showReversed', '1'); else q.delete('showReversed');
    setParams(q, { replace: true });
  };

  const chart = useMemo(() => [...(accounts.data?.accounts ?? [])].sort((a, b) => a.account_code.localeCompare(b.account_code)), [accounts.data]);
  const options = useMemo(() => chart.map((a) => ({ value: a.account_code, label: `${a.account_code} — ${a.account_name}` })), [chart]);
  const nameOf = (code: string) => chart.find((a) => a.account_code === code)?.account_name ?? '';
  const picked = p.accounts ?? [];

  const q = useLedger(p);
  const r = q.data;
  const rangeOk = p.from <= p.to;

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>From</span><DateField value={p.from} onChange={(v) => update({ from: v })} aria-label="Ledger from" />
        <span style={soft}>To</span><DateField value={p.to} onChange={(v) => update({ to: v })} aria-label="Ledger to" />
        <span style={{ minWidth: 300, flex: 1 }}>
          <SearchCombo options={options} value={adding} placeholder="Add an account — type a code or a name…" aria-label="Add an account"
            onChange={(code) => { setAdding(''); if (code && !picked.includes(code)) update({ accounts: [...picked, code], fromAccount: '', toAccount: '' }); }} />
        </span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-13)', cursor: 'pointer' }}>
          <input type="checkbox" checked={Boolean(p.showReversed)} onChange={(e) => update({ showReversed: e.target.checked })} aria-label="Show reversed entries" />
          Show reversed entries
        </label>
        <Button variant="ghost" size="sm" onClick={() => { if (r) downloadLedgerCsv(r); }} disabled={!r}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { if (r) void import('../../vendor/scm/lib/ledger-pdf').then((m) => m.generateLedgerPdf(r)); }} disabled={!r}>
          <Printer size={16} strokeWidth={1.75} /> Print
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {picked.length === 0 && !p.fromAccount && !p.toAccount && <span style={soft}>Every account with a balance or a movement in the period.</span>}
        {picked.map((code) => (
          <span key={code} className={styles.codeChip} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {code} {nameOf(code)}
            <button type="button" aria-label={`Remove ${code}`} onClick={() => update({ accounts: picked.filter((c) => c !== code) })}
              style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
        {picked.length > 0 && <Button variant="ghost" size="sm" onClick={() => update({ accounts: [] })}>All accounts</Button>}
        {picked.length === 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...soft }}>
            or a range
            <span style={{ minWidth: 220 }}><SearchCombo options={options} value={p.fromAccount ?? ''} placeholder="from code" aria-label="From account" onChange={(code) => update({ fromAccount: code })} /></span>
            <span style={{ minWidth: 220 }}><SearchCombo options={options} value={p.toAccount ?? ''} placeholder="to code" aria-label="To account" onChange={(code) => update({ toAccount: code })} /></span>
            {(p.fromAccount || p.toAccount) && <Button variant="ghost" size="sm" onClick={() => update({ fromAccount: '', toAccount: '' })}>Clear</Button>}
          </span>
        )}
        <span style={soft}>
          {p.showReversed ? 'Reversed entries and their contras are listed and marked; they move no balance and no total.' : 'Reversed entries and their contras are left out — they undo each other.'}
        </span>
      </div>

      {!rangeOk && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>From is later than To — adjust the dates.</div>}
      {rangeOk && q.isLoading && <div style={soft}>Working the ledger out…</div>}
      {rangeOk && q.isError && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The ledger did not load — adjust the filters to retry.</div>}
      {r && r.blocks.length === 0 && <div style={soft}>Nothing moved on these accounts in the period, and nothing was brought forward.</div>}
      {r && r.blocks.length > 0 && (
        <div style={card}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Entry</th>
                <th style={th}>Journal</th>
                <th style={th}>Other side</th>
                <th style={th}>Ref. 1</th>
                <th style={th}>Ref. 2</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: 'right' }}>Debit</th>
                <th style={{ ...th, textAlign: 'right' }}>Credit</th>
                <th style={{ ...th, textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            {r.blocks.map((b) => <Block key={b.code} b={b} />)}
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
                <td colSpan={7} style={{ ...td, fontWeight: 700, borderBottom: 0 }}>GRAND TOTAL</td>
                <td style={{ ...num, fontWeight: 700, borderBottom: 0 }}>{fmtLedger(r.totals.debitSen)}</td>
                <td style={{ ...num, fontWeight: 700, borderBottom: 0 }}>{fmtLedger(r.totals.creditSen)}</td>
                <td style={{ ...num, borderBottom: 0 }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
};
