// ----------------------------------------------------------------------------
// UnmatchedPayments — every customer payment not matched yet, card and
// transfer on ONE list (owner 2026-09-30: 我现在可以看到的是 card payment 哪些
// 还没 match 罢了，如果 online transfer 那些呢？我有没有一个表是显示全部还没
// match 的 → 做). Each row says where the payment is stuck and links the screen
// that unsticks it: Merchant Recon for a card, Bank Recon for a transfer.
// The rules live on the server (acc/unmatched-payments).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/Layout';
import { DataTable, type Column } from '../../components/DataTable';
import { DateField } from '../../vendor/scm/components/DateField';
import { fmtDate } from '../../vendor/shared/format';
import { btn, danger, fmt, softText } from './settlement-ui';
import styles from './Suppliers.module.css';
import { useUnmatchedPayments, type UnmatchedPayment, type UnmatchedState } from './unmatched-payments-queries';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const daysBefore = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Where it is stuck, in words, and the screen that unsticks it — one home for both. */
export const STUCK: Record<UnmatchedState, { text: (r: UnmatchedPayment) => string; to: string; screen: string }> = {
  CARD_NOT_REPORTED: { text: () => 'Not on a merchant report yet', to: '/scm/merchant-recon', screen: 'Merchant Recon' },
  CARD_TO_CONFIRM: { text: () => 'On a merchant report — waiting for you to confirm', to: '/scm/merchant-recon', screen: 'Merchant Recon' },
  CARD_NO_MERCHANT: { text: (r) => `${r.channel ?? 'Its bank'} is not set up as a merchant`, to: '/scm/settlement-setup', screen: 'Merchant setup' },
  TRANSFER_NOT_BOOKED: { text: () => 'Not in the books — see Self-check', to: '/scm/accounting?tab=check', screen: 'Self-check' },
  TRANSFER_NOT_MATCHED: { text: () => 'Not matched to the bank statement yet', to: '/scm/bank-recon', screen: 'Bank Recon' },
  TRANSFER_NO_STATEMENT: {
    text: (r) => (r.statementUpTo
      ? `Bank statement for this day not uploaded yet (uploaded to ${fmtDate(r.statementUpTo)})`
      : 'No bank statement uploaded yet'),
    to: '/scm/bank-recon',
    screen: 'Bank Recon',
  },
};

/** "Card · GHL", "Card · 未标", "Transfer · TNG". */
export const methodText = (r: UnmatchedPayment): string =>
  (r.kind === 'card' ? `Card · ${r.channel ?? '未标'}` : `Transfer${r.channel ? ` · ${r.channel}` : ''}`);

type Kind = 'all' | 'card' | 'transfer';

const COLUMNS: Column<UnmatchedPayment>[] = [
  { key: 'paidOn', label: 'Paid on', render: (r) => fmtDate(r.paidOn), getValue: (r) => r.paidOn, exportFormat: 'date' },
  {
    key: 'document', label: 'Document',
    /* An order opens its own page; an invoice's number is shown as it is. */
    render: (r) => (r.source === 'SOPAY'
      ? <Link to={`/scm/sales-orders/${encodeURIComponent(r.docNo)}`}>{r.docNo}</Link>
      : r.docNo),
    getValue: (r) => r.docNo,
  },
  { key: 'customer', label: 'Customer', render: (r) => r.customerName ?? '—', getValue: (r) => r.customerName ?? '' },
  { key: 'salesperson', label: 'Salesperson', render: (r) => r.salespersonName ?? '—', getValue: (r) => r.salespersonName ?? '' },
  { key: 'method', label: 'Method', render: (r) => <span className={styles.codeChip}>{methodText(r)}</span>, getValue: (r) => methodText(r) },
  {
    key: 'amount', label: 'Amount', align: 'right', render: (r) => fmt(r.amountSen),
    getValue: (r) => r.amountSen, exportValue: (r) => r.amountSen / 100, exportFormat: 'money',
  },
  { key: 'reference', label: 'Reference', render: (r) => r.reference ?? '—', getValue: (r) => r.reference ?? '' },
  {
    key: 'days', label: 'Days', align: 'right',
    render: (r) => <span style={{ color: r.ageDays > 14 ? danger : undefined, fontWeight: r.ageDays > 14 ? 700 : undefined }}>{r.ageDays}</span>,
    getValue: (r) => r.ageDays, exportFormat: 'number',
  },
  { key: 'stuck', label: 'Where it is stuck', render: (r) => STUCK[r.state].text(r), getValue: (r) => STUCK[r.state].text(r) },
  {
    key: 'go', label: '',
    render: (r) => <Link to={STUCK[r.state].to}>{STUCK[r.state].screen}</Link>,
  },
];

export const UnmatchedPayments = () => {
  const today = myt();
  const [from, setFrom] = useState(daysBefore(today, 180));
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<Kind>('all');
  const backwards = from > to;
  const q = useUnmatchedPayments(from, to, !backwards);
  const all = useMemo(() => q.data?.rows ?? [], [q.data]);

  const count = useMemo(() => {
    const of = (k: 'card' | 'transfer') => all.filter((r) => r.kind === k);
    const sum = (rs: UnmatchedPayment[]) => rs.reduce((s, r) => s + r.amountSen, 0);
    return {
      all: { n: all.length, sen: sum(all) },
      card: { n: of('card').length, sen: sum(of('card')) },
      transfer: { n: of('transfer').length, sen: sum(of('transfer')) },
    };
  }, [all]);
  const shown = useMemo(() => (kind === 'all' ? all : all.filter((r) => r.kind === kind)), [all, kind]);

  const chip = (k: Kind, label: string) => (
    <button type="button" style={btn(kind === k)} onClick={() => setKind(k)} aria-pressed={kind === k}>
      {`${label} (${count[k].n})`}
    </button>
  );

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · bank & cards" title="Payments not matched yet" />
      <div style={softText}>
        Every card and transfer payment on a sales order or invoice that is not matched yet. A card payment is
        matched when the merchant report line claiming it is confirmed (Merchant Recon); a transfer when a bank
        statement line is matched to it (Bank Recon). Not listed: cash (there is nothing to match it against),
        payments carried over from AutoCount, and cancelled orders.
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        {chip('all', 'All')}
        {chip('card', 'Card')}
        {chip('transfer', 'Transfer')}
        <span style={{ flex: 1 }} />
        <span style={softText}>Paid from</span>
        <DateField value={from} onChange={(v) => { if (v) setFrom(v); }} aria-label="Paid from" />
        <span style={softText}>to</span>
        <DateField value={to} onChange={(v) => { if (v) setTo(v); }} aria-label="Paid to" />
      </div>
      {q.data && !backwards && (
        <div style={softText}>
          {`${count[kind].n} payment${count[kind].n === 1 ? '' : 's'} not matched, ${fmt(count[kind].sen)} in total.`}
          {kind === 'all' && ` Card ${count.card.n} (${fmt(count.card.sen)}) · Transfer ${count.transfer.n} (${fmt(count.transfer.sen)}).`}
        </div>
      )}
      <DataTable<UnmatchedPayment>
        tableId="unmatched-payments"
        exportName="payments-not-matched"
        exportXlsx
        columns={COLUMNS}
        rows={backwards ? [] : q.data ? shown : null}
        loading={!backwards && q.isLoading}
        error={backwards ? 'The From date is after the To date.' : q.isError ? 'The list did not load.' : null}
        emptyLabel="Every card and transfer payment in these dates is matched."
        getRowKey={(r) => `${r.source}:${r.paymentId}`}
      />
    </div>
  );
};
