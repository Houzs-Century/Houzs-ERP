// ----------------------------------------------------------------------------
// Payment listing — the vouchers to pay, a line each, with the bank each pays
// into (owner 2026-11-08: 「每天要过账的listing，就算pv号码，名字，description,
// purpose，包含bank account number 这些」, 「我能自己filter 吗？」; 2026-11-09: the
// Description IS the purpose — what the bills say is paid for, never the bill no.).
//
// It opens on what is not posted yet (Prepared and Checked) dated up to today;
// the reader picks the days, the stages, the payee and the account it is paid
// from. Excel from the table's Export (and its header's right-click, with PDF,
// both of the columns showing); Print prints the listing's own columns.
// Server: GET /payment-vouchers/listing (payment-vouchers-listing.ts).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataTable, type Column } from '../../components/DataTable';
import { tablePdfViewOf, type TablePdfView } from '../../components/dataTableLineExport';
import { PageHeader } from '../../components/Layout';
import { DateField } from '../../vendor/scm/components/DateField';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { usePaymentListing, type PaymentListingRow, type PaymentListingStage } from '../../vendor/scm/lib/payment-voucher-queries';
import { fmtDate, fmtMoneySen, fmtSenPlain } from '../../vendor/shared/format';
import { FinanceDocLink, financeDocHref } from './finance/FinanceDocLink';
import { Tag } from './MoneyOutErpParts';
import styles from './SalesOrderDetail.module.css';
import css from './MoneyOutErp.module.css';

type Tone = 'late' | 'warn' | 'info' | 'calm';
/* The four layers' words (docs/modules/document-status-vocabulary.md): a posted voucher reads Approved. */
export const LISTING_STAGES: Array<{ key: PaymentListingStage; word: string; tone: Tone }> = [
  { key: 'DRAFT', word: 'Draft', tone: 'calm' },
  { key: 'PREPARED', word: 'Prepared', tone: 'warn' },
  { key: 'CHECKED', word: 'Checked', tone: 'info' },
  { key: 'POSTED', word: 'Approved', tone: 'calm' },
  { key: 'CANCELLED', word: 'Cancelled', tone: 'late' },
];
const DEFAULT_STAGES: PaymentListingStage[] = ['PREPARED', 'CHECKED'];
const stageWord = (s: PaymentListingStage): string => LISTING_STAGES.find((x) => x.key === s)?.word ?? s;

const isForeign = (r: PaymentListingRow): boolean => (r.currency ?? 'MYR').toUpperCase() !== 'MYR';
/** What leaves the bank in ringgit: a voucher in another currency at its own rate. */
export const ringgitSenOf = (r: PaymentListingRow): number =>
  Math.round(Number(r.total_sen ?? 0) * (isForeign(r) ? Number(r.exchange_rate) || 1 : 1));
const payeeOf = (r: PaymentListingRow): string => r.payee_name || r.supplier?.name || '';

/** The sentence on top of the printed listing: the days, the stages and the filters it was cut to. */
export function listingSubtitle(f: { from: string; to: string; stages: PaymentListingStage[]; payee: string; payFrom: string }): string {
  const words = f.stages.map(stageWord);
  return [
    `Vouchers dated ${f.from ? `${fmtDate(f.from)} to ${fmtDate(f.to)}` : `up to ${fmtDate(f.to)}`}, at ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] ?? 'no stage'}.`,
    f.payee.trim() ? `Payee: ${f.payee.trim()}.` : '',
    f.payFrom ? `Pay from: ${f.payFrom}.` : '',
    'All amounts in RM; a voucher in another currency shows its own amount under the ringgit.',
  ].filter(Boolean).join(' ');
}

export const PaymentListing = () => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(() => todayMyt());
  const [stages, setStages] = useState<PaymentListingStage[]>(DEFAULT_STAGES);
  const [payee, setPayee] = useState('');
  const [payFrom, setPayFrom] = useState('');
  const [printError, setPrintError] = useState<string | null>(null);
  const q = usePaymentListing({ from, to, stages });
  const accounts = useAccounts();
  const accountName = useMemo(() => new Map((accounts.data?.accounts ?? []).map((a) => [a.account_code, a.account_name])), [accounts.data]);
  const payFromLabel = (code: string) => `${code}${accountName.get(code) ? ` · ${accountName.get(code)}` : ''}`;

  const all = useMemo(() => q.data?.vouchers ?? [], [q.data]);
  const payFromCodes = useMemo(() => [...new Set(all.map((r) => r.credit_account_code ?? '').filter(Boolean))].sort(), [all]);
  const rows = useMemo(() => {
    const want = payee.trim().toUpperCase();
    return all.filter((r) => (!want || payeeOf(r).toUpperCase().includes(want)) && (!payFrom || r.credit_account_code === payFrom));
  }, [all, payee, payFrom]);
  const totalSen = rows.reduce((s, r) => s + ringgitSenOf(r), 0);
  const byStage = LISTING_STAGES
    .map((s) => ({ ...s, n: rows.filter((r) => r.stage === s.key).length }))
    .filter((s) => s.n > 0);

  const toggleStage = (s: PaymentListingStage) =>
    setStages((was) => (was.includes(s) ? was.filter((x) => x !== s) : LISTING_STAGES.map((x) => x.key).filter((k) => k === s || was.includes(k))));

  const columns = useMemo<Column<PaymentListingRow>[]>(() => [
    {
      key: 'pv_number', label: 'PV No.',
      render: (r) => <FinanceDocLink to={financeDocHref('PV', r.id)}>{r.pv_number}</FinanceDocLink>,
      getValue: (r) => r.pv_number,
    },
    { key: 'voucher_date', label: 'Date', render: (r) => fmtDate(r.voucher_date), getValue: (r) => r.voucher_date ?? '', exportFormat: 'date' },
    { key: 'payee', label: 'Payee', render: (r) => payeeOf(r) || '—', getValue: (r) => payeeOf(r) },
    /* What is paid for, as the bills say it — never the bill number (owner 2026-11-09:
       description 就是 purpose; 只显示单上的费用). The typed Remark rides hidden. */
    { key: 'description', label: 'Description', render: (r) => r.description_text?.trim() || '—', getValue: (r) => r.description_text?.trim() ?? '' },
    { key: 'remark', label: 'Remark', render: (r) => r.notes?.trim() || '—', getValue: (r) => r.notes?.trim() ?? '', defaultHidden: true },
    { key: 'bank', label: 'Bank', render: (r) => r.pay_bank || '—', getValue: (r) => r.pay_bank ?? '' },
    { key: 'accountNo', label: 'Account no.', render: (r) => r.pay_account_no || '—', getValue: (r) => r.pay_account_no ?? '' },
    { key: 'accountName', label: 'Account name', render: (r) => r.pay_account_name || '—', getValue: (r) => r.pay_account_name ?? '', defaultHidden: true },
    {
      key: 'payFrom', label: 'Pay from', defaultHidden: true,
      render: (r) => (r.credit_account_code ? payFromLabel(r.credit_account_code) : '—'),
      getValue: (r) => r.credit_account_code ?? '',
    },
    {
      key: 'amount', label: 'Amount (RM)', align: 'right',
      render: (r) => (
        <span>
          <span className={css.money}>{fmtSenPlain(ringgitSenOf(r))}</span>
          {isForeign(r) && <span className={css.muted} style={{ display: 'block', fontSize: 'var(--fs-11)' }}>{fmtMoneySen(Number(r.total_sen ?? 0), r.currency)}</span>}
        </span>
      ),
      getValue: (r) => ringgitSenOf(r), exportValue: (r) => ringgitSenOf(r) / 100, exportFormat: 'money',
      total: (shown) => fmtSenPlain(shown.reduce((s, r) => s + ringgitSenOf(r), 0)),
    },
    {
      key: 'stage', label: 'Stage',
      render: (r) => <Tag tone={LISTING_STAGES.find((s) => s.key === r.stage)?.tone ?? 'calm'}>{stageWord(r.stage)}</Tag>,
      getValue: (r) => stageWord(r.stage),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- payFromLabel reads the account names the memo depends on
  ], [accountName]);

  const subtitle = listingSubtitle({ from, to, stages, payee, payFrom: payFrom ? payFromLabel(payFrom) : '' });
  const printPdf = async (view: TablePdfView<PaymentListingRow>, action: 'preview' | 'print') => {
    setPrintError(null);
    try {
      const { generatePaymentListingPdf } = await import('../../vendor/scm/lib/payment-listing-pdf');
      await generatePaymentListingPdf(view, { subtitle, action });
    } catch (e) {
      setPrintError(`The listing could not be printed — ${e instanceof Error ? e.message : 'something went wrong.'}`);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · Money out" title="Payment listing" />
      <section className={css.card}>
        <div className={css.cardTop} style={{ flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
          <label className={styles.field} style={{ minWidth: 150 }}>
            <span className={styles.fieldLabel}>From</span>
            <DateField fullWidth value={from} onChange={(iso) => setFrom(iso)} className={styles.fieldInput} aria-label="From" />
          </label>
          <label className={styles.field} style={{ minWidth: 150 }}>
            <span className={styles.fieldLabel}>To</span>
            <DateField fullWidth value={to} onChange={(iso) => setTo(iso || todayMyt())} className={styles.fieldInput} aria-label="To" />
          </label>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Stage</span>
            <div className={css.views} role="group" aria-label="Stage">
              {LISTING_STAGES.map((s) => (
                <button key={s.key} type="button" aria-pressed={stages.includes(s.key)}
                  className={`${css.view} ${stages.includes(s.key) ? css.viewOn : ''}`} onClick={() => toggleStage(s.key)}>
                  {s.word}
                </button>
              ))}
            </div>
          </div>
          <label className={styles.field} style={{ minWidth: 180 }}>
            <span className={styles.fieldLabel}>Payee</span>
            <input type="search" className={styles.fieldInput} value={payee} onChange={(e) => setPayee(e.target.value)}
              placeholder="Any payee" aria-label="Payee" />
          </label>
          <label className={styles.field} style={{ minWidth: 200 }}>
            <span className={styles.fieldLabel}>Pay from</span>
            <select className={styles.fieldInput} value={payFrom} onChange={(e) => setPayFrom(e.target.value)} aria-label="Pay from">
              <option value="">Any account</option>
              {payFromCodes.map((code) => <option key={code} value={code}>{payFromLabel(code)}</option>)}
            </select>
          </label>
        </div>
        <div className={css.cardBody}>
          <p className={css.hint} style={{ margin: '0 0 var(--space-2)' }} aria-live="polite">
            {stages.length === 0
              ? 'Pick at least one stage.'
              : q.data
                ? `${rows.length} voucher${rows.length === 1 ? '' : 's'} · RM ${fmtSenPlain(totalSen)}${byStage.length > 0 ? ` · ${byStage.map((s) => `${s.word} ${s.n}`).join(' · ')}` : ''}`
                : ' '}
          </p>
          {printError && <p role="alert" style={{ color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))', fontSize: 'var(--fs-12)', margin: '0 0 var(--space-2)' }}>{printError}</p>}
          <DataTable<PaymentListingRow>
            tableId="payment-listing"
            exportName="payment-listing"
            exportXlsx
            onExportPdf={(view) => void printPdf(view, 'preview')}
            toolbarExtra={(
              <Button variant="ghost" size="sm" disabled={rows.length === 0}
                onClick={() => void printPdf(tablePdfViewOf(rows, columns.filter((c) => !c.defaultHidden)), 'print')}>
                <Printer size={14} strokeWidth={1.75} /> Print
              </Button>
            )}
            columns={columns}
            rows={stages.length === 0 ? [] : q.data ? rows : null}
            loading={q.isLoading && stages.length > 0}
            error={q.isError ? `The listing could not be loaded — ${q.error instanceof Error ? q.error.message : 'something went wrong.'}` : null}
            emptyLabel={stages.length === 0 ? 'Pick at least one stage.' : all.length > 0 ? 'No voucher for this payee or account — clear the filter.' : 'No voucher at these stages in these days.'}
            getRowKey={(r) => r.id}
          />
        </div>
      </section>
    </div>
  );
};
