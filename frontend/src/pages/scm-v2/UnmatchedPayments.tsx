// ----------------------------------------------------------------------------
// UnmatchedPayments — everything not matched yet, three lists under one date
// range (owner 2026-09-30: 我有没有一个表是显示全部还没 match 的 → 做; 2026-11-10:
// 关于那个unmatch payment 我要优化 … 一个就是有卡机报告但没有对应的收款记录，一个就是
// 现有的记录收钱了，但没有对应的卡机报告或收款记录，如果银行那边的收款有，也没有对应
// 的transaction 也可以显示 / 要支持可以export 全部 / 也要支持pdf → 做):
//   Merchant report lines — on a merchant report, no sale reconciled;
//   Bank money in         — in the bank, no entry in the books matched;
//   Payments              — money recorded on an order or invoice, not matched.
// (that order: owner 2026-11-11, Merchant Report Line -> Bank Money In -> Payment).
// Each list exports what it shows, to Excel or PDF, under the title the owner
// gave it (export 出来时注明是 …). Export all writes the three in one file, each
// as its table shows it — its chip, its column filters, its columns (owner
// 2026-11-11: 我filter 了三个card 的东西，但是export 了还是全部) — and says the
// filter above it; nothing narrowed, every row. So the three tables stay mounted,
// the hidden ones too, and tell the page their columns, rows and filters. Every
// row links the screen that unsticks it. Words and columns: unmatchedLists.tsx;
// the rules are the server's.
//
// A fourth list, apart from the three: Previous records — payments the owner
// ticked and marked as the previous system's (owner 2026-11-11: 我检查确定后，就
// 直接说这个是之前record), with Undo. Not part of Export all, nor of the order.
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, FileText } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PageHeader } from '../../components/Layout';
import { DataTable, type Column } from '../../components/DataTable';
import {
  buildLineExportMatrix, exportableColumns, tablePdfViewOf, writeLineExportBook, type TablePdfView,
} from '../../components/dataTableLineExport';
import { DateField } from '../../vendor/scm/components/DateField';
import type { UnmatchedPdfPart } from '../../vendor/scm/lib/unmatched-payments-pdf';
import { fmtDate } from '../../vendor/shared/format';
import { danger, fmt, softText } from './settlement-ui';
import top from './MerchantReports.module.css';
import { useSettlementBatchDetails, useSettlementBatches } from './settlement-queries';
import { usePreviousPayments, useUnmatchedBankLines, useUnmatchedPayments, type UnmatchedBankLine } from './unmatched-payments-queries';
import { MarkPreviousButton, PressNote, PreviousRecordsList, usePaymentTicks, type PressResult } from './previousRecords';
import {
  BANK_COLUMNS, BANK_KINDS, LISTS, PAYMENT_COLUMNS, PAYMENT_STAGES, REPORT_COLUMNS, REPORT_STATUSES, reportLinesOf, withSameMoney,
  type ListKey, type PaymentRow, type ReportLineRow,
} from './unmatchedLists';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const daysBefore = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const asList = (v: string | null): ListKey => LISTS.find((l) => l.key === v)?.key ?? 'payments';
const listOf = (k: ListKey) => LISTS.find((l) => l.key === k)!;
const titleOf = (k: ListKey): string => listOf(k).label;
/** Each list's column names, to say a column filter in words. */
const COLUMN_LABELS: Record<ListKey, ReadonlyMap<string, string>> = {
  reports: new Map(REPORT_COLUMNS.map((c) => [c.key, c.label])),
  payments: new Map(PAYMENT_COLUMNS.map((c) => [c.key, c.label])),
  bank: new Map(BANK_COLUMNS.map((c) => [c.key, c.label])),
};

/** What each list is, said once above it. */
const ABOUT: Record<ListKey, string> = {
  reports: 'Lines on a merchant report that are not reconciled to their sale yet, read as Merchant Recon reads them. '
    + '“No sale in the ERP” is card money nobody keyed a sale for — key it, or find it on the report.',
  payments: 'Every card and transfer payment on a sales order or invoice that is not matched yet. A card payment — or a DuitNow QR '
    + 'sale keyed as a transfer — is matched once the merchant report line claiming it is confirmed; what may still be open after '
    + 'that is on the other two lists. Any other transfer is matched once a bank statement line is matched to it. Where the same '
    + 'money waits on another list, the row says so. Not listed: cash (there is nothing to match it against), payments carried over '
    + 'from AutoCount, and cancelled orders.',
  bank: 'Money in on an uploaded bank statement that no entry in the books is matched to yet: a card payout waiting for its report, '
    + 'DuitNow QR money, and transfers — each with the entries of the same amount it could be.',
};
const PREVIOUS_ABOUT = 'Payment records you checked and marked as the previous system’s. They show up on no list here, in Merchant Recon '
  + 'or in the Cash Flow, and no merchant or bank line is offered them; nothing was posted. Tick one and press Undo to put it back.';

type Chip = { key: string; label: string; n: number; sen: number };
const total = <T,>(rows: readonly T[], sen: (r: T) => number): number => rows.reduce((s, r) => s + sen(r), 0);
/** "All" first, then each chip with something in it. */
const chipsOf = <T,>(rows: readonly T[], sen: (r: T) => number, defs: ReadonlyArray<{ key: string; label: string }>, keyOf: (r: T) => string): Chip[] => [
  { key: 'all', label: 'All', n: rows.length, sen: total(rows, sen) },
  ...defs.map((d) => {
    const mine = rows.filter((r) => keyOf(r) === d.key);
    return { key: d.key, label: d.label, n: mine.length, sen: total(mine, sen) };
  }).filter((c) => c.n > 0),
];
const pick = <T,>(rows: T[] | null, chip: string, keyOf: (r: T) => string): T[] | null =>
  (rows == null ? null : chip === 'all' ? rows : rows.filter((r) => keyOf(r) === chip));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The columns a table has showing, or — before it has said — its own default view. */
const shownOr = <T,>(shown: Column<T>[] | null, all: Column<T>[]): Column<T>[] => shown ?? all.filter((c) => !c.defaultHidden);

type Shown = { reports: Column<ReportLineRow>[] | null; payments: Column<PaymentRow>[] | null; bank: Column<UnmatchedBankLine>[] | null };
type Seen = { reports: ReportLineRow[] | null; payments: PaymentRow[] | null; bank: UnmatchedBankLine[] | null };

export const UnmatchedPayments = () => {
  const today = myt();
  const [from, setFrom] = useState(daysBefore(today, 180));
  const [to, setTo] = useState(today);
  const backwards = from > to;
  const [params, setParams] = useSearchParams();
  const list = asList(params.get('list'));
  /* The fourth list: the payments marked as the previous system's. */
  const showPrevious = params.get('list') === 'previous';
  const choose = (k: ListKey | 'previous') => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set('list', k);
    return next;
  }, { replace: true });
  const previousQ = usePreviousPayments();
  const [markResult, setMarkResult] = useState<PressResult | null>(null);
  const [chip, setChip] = useState<Record<ListKey, string>>({ reports: 'all', payments: 'all', bank: 'all' });

  /* The merchant report lines: each open report read as Merchant Recon reads it. */
  const batchesQ = useSettlementBatches();
  const openBatches = useMemo(() => (batchesQ.data?.batches ?? []).filter((b) => (b.open_count ?? 0) > 0
    && String(b.period_to ?? '9999-12-31').slice(0, 10) >= from
    && String(b.period_from ?? '0000-01-01').slice(0, 10) <= to), [batchesQ.data, from, to]);
  const detailQ = useSettlementBatchDetails(openBatches.map((b) => b.id));
  const reportsFailed = batchesQ.isError || detailQ.failed;
  const reports = useMemo(() => (backwards || reportsFailed || batchesQ.isLoading || detailQ.loading ? null
    : reportLinesOf(openBatches, detailQ.details, from, to, today)),
  [backwards, reportsFailed, batchesQ.isLoading, detailQ.loading, detailQ.details, openBatches, from, to, today]);
  const payQ = useUnmatchedPayments(from, to, !backwards);
  const bankQ = useUnmatchedBankLines(from, to, !backwards);
  const bank = backwards ? null : bankQ.data?.rows ?? null;
  /* Each payment with the same money on another list, where one waits (owner 2026-11-10: 会不会duplicate). */
  const payRows = backwards ? null : payQ.data?.rows ?? null;
  const payments = useMemo(() => (payRows ? withSameMoney(payRows, reports ?? [], bank ?? []) : null), [payRows, reports, bank]);

  /* What each table shows — its columns, and its rows after its own funnels —
     for Export all and the PDF button. Refs: told on every render, read on a press. */
  const shown = useRef<Shown>({ reports: null, payments: null, bank: null });
  const seen = useRef<Seen>({ reports: null, payments: null, bank: null });
  const shownReports = useCallback((c: Column<ReportLineRow>[]) => { shown.current.reports = c; }, []);
  const shownPayments = useCallback((c: Column<PaymentRow>[]) => { shown.current.payments = c; }, []);
  const shownBank = useCallback((c: Column<UnmatchedBankLine>[]) => { shown.current.bank = c; }, []);
  const seenReports = useCallback((r: ReportLineRow[]) => { seen.current.reports = r; }, []);
  const seenPayments = useCallback((r: PaymentRow[]) => { seen.current.payments = r; }, []);
  const seenBank = useCallback((r: UnmatchedBankLine[]) => { seen.current.bank = r; }, []);
  /* Each table's column filters, so its export can say them. */
  const funnels = useRef<Record<ListKey, Record<string, string[]>>>({ reports: {}, payments: {}, bank: {} });
  const funnelReports = useCallback((f: Record<string, string[]>) => { funnels.current.reports = f; }, []);
  const funnelPayments = useCallback((f: Record<string, string[]>) => { funnels.current.payments = f; }, []);
  const funnelBank = useCallback((f: Record<string, string[]>) => { funnels.current.bank = f; }, []);

  const chips: Record<ListKey, Chip[]> = {
    reports: chipsOf(reports ?? [], (r) => r.grossSen, REPORT_STATUSES, (r) => r.status),
    payments: chipsOf(payments ?? [], (r) => r.amountSen, PAYMENT_STAGES, (r) => r.state),
    bank: chipsOf(bank ?? [], (r) => r.amountSen, BANK_KINDS, (r) => r.what),
  };
  const on = (k: ListKey): string => (chips[k].some((c) => c.key === chip[k]) ? chip[k] : 'all');
  const rowsOn = {
    reports: pick(reports, on('reports'), (r) => r.status),
    payments: pick(payments, on('payments'), (r) => r.state),
    bank: pick(bank, on('bank'), (r) => r.what),
  };
  const oldest: Record<ListKey, number> = {
    reports: Math.max(0, ...(reports ?? []).map((r) => r.ageDays)),
    payments: Math.max(0, ...(payments ?? []).map((r) => r.ageDays)),
    bank: Math.max(0, ...(bank ?? []).map((r) => r.ageDays)),
  };
  const loaded: Record<ListKey, boolean> = { reports: reports != null, payments: payments != null, bank: bank != null };
  /* Ticks on Payments, for "Previous record". */
  const payTicks = usePaymentTicks((rowsOn.payments ?? []).map((r) => `${r.source}:${r.paymentId}`));

  const range = `Dated ${fmtDate(from)} to ${fmtDate(to)}`;
  const chipLabel = (k: ListKey): string | null => {
    const c = chips[k].find((x) => x.key === on(k));
    return c && c.key !== 'all' ? c.label : null;
  };
  const [exportError, setExportError] = useState<string | null>(null);
  const failed = (e: unknown) => setExportError(`The file could not be made — ${e instanceof Error ? e.message : 'something went wrong.'}`);

  /** What narrows a list on the screen — its chip, its column filters — in words, for
      its export (owner 2026-11-11: 我filter 了三个card 的东西，但是export 了还是全部). */
  const narrowing = (k: ListKey, shownN: number): string => {
    const columnWords = Object.entries(funnels.current[k]).filter(([, v]) => v.length > 0)
      .map(([key, v]) => `${COLUMN_LABELS[k].get(key) ?? key}: ${v.slice(0, 3).join(', ')}${v.length > 3 ? ` +${v.length - 3}` : ''}`);
    const words = [chipLabel(k), ...columnWords].filter((w): w is string => w != null);
    const chipN = rowsOn[k]?.length ?? 0;
    if (columnWords.length === 0 && shownN < chipN) words.push(`table filter: ${shownN} of ${chipN} rows`);
    return words.length === 0 ? 'No filter — every row' : `Filter: ${words.join(' · ')}`;
  };
  /** Above a list's Excel table: what the list is, then the dates and what narrowed it. */
  const headingOf = (k: ListKey, shownN: number): string[] => [listOf(k).exportTitle, `${range} · ${narrowing(k, shownN)}`];
  const partOf = <T,>(k: ListKey, view: TablePdfView<T>): UnmatchedPdfPart =>
    ({ title: listOf(k).exportTitle, label: listOf(k).sheet, note: narrowing(k, view.rows.length), view });

  /** One list on paper: what its table shows, under its export title. */
  const printList = async <T,>(k: ListKey, view: TablePdfView<T>) => {
    setExportError(null);
    try {
      const { generateUnmatchedPdf } = await import('../../vendor/scm/lib/unmatched-payments-pdf');
      await generateUnmatchedPdf([partOf(k, view)], { subtitle: range });
    } catch (e) { failed(e); }
  };

  /** The three lists in one file, in the owner's order, each as its table shows it — its
      chip, its column filters, its columns — under its export title (owner 2026-11-11).
      Nothing narrowed: every row. */
  const exportAll = async (how: 'excel' | 'pdf') => {
    if (!reports || !payments || !bank) return;
    setExportError(null);
    const r = shownOr(shown.current.reports, REPORT_COLUMNS);
    const p = shownOr(shown.current.payments, PAYMENT_COLUMNS);
    const b = shownOr(shown.current.bank, BANK_COLUMNS);
    /* What each table shows now; before it has said, its chip's rows. */
    const rows = {
      reports: seen.current.reports ?? rowsOn.reports ?? [],
      payments: seen.current.payments ?? rowsOn.payments ?? [],
      bank: seen.current.bank ?? rowsOn.bank ?? [],
    };
    try {
      if (how === 'excel') {
        const sheet = <T,>(k: ListKey, list: readonly T[], cols: Column<T>[]) =>
          ({ name: listOf(k).sheet, heading: headingOf(k, list.length), matrix: buildLineExportMatrix(list, () => [], exportableColumns(cols)) });
        await writeLineExportBook([sheet('reports', rows.reports, r), sheet('bank', rows.bank, b), sheet('payments', rows.payments, p)],
          `payments-not-matched-${today}.xlsx`);
        return;
      }
      const { generateUnmatchedPdf } = await import('../../vendor/scm/lib/unmatched-payments-pdf');
      await generateUnmatchedPdf([
        partOf('reports', tablePdfViewOf(rows.reports, r)),
        partOf('bank', tablePdfViewOf(rows.bank, b)),
        partOf('payments', tablePdfViewOf(rows.payments, p)),
      ], { subtitle: range });
    } catch (e) { failed(e); }
  };
  const allReady = loaded.reports && loaded.payments && loaded.bank;

  const summary: Record<ListKey, string> = {
    reports: (() => {
      const c = chips.reports.find((x) => x.key === on('reports'))!;
      return `${plural(c.n, 'line')} not reconciled, ${fmt(c.sen)} gross.`;
    })(),
    payments: (() => {
      const c = chips.payments.find((x) => x.key === on('payments'))!;
      const of = (k: 'card' | 'transfer') => (payments ?? []).filter((x) => x.kind === k);
      const card = of('card');
      const transfer = of('transfer');
      return `${plural(c.n, 'payment')} not matched, ${fmt(c.sen)} in total.${on('payments') === 'all'
        ? ` Card ${card.length} (${fmt(total(card, (x) => x.amountSen))}) · Transfer ${transfer.length} (${fmt(total(transfer, (x) => x.amountSen))}).`
        : ''}`;
    })(),
    bank: (() => {
      const c = chips.bank.find((x) => x.key === on('bank'))!;
      return `${plural(c.n, 'bank line')} with no entry matched, ${fmt(c.sen)} in total.`;
    })(),
  };

  const pdfButton = (onPress: () => void, disabled: boolean) => (
    <Button variant="ghost" size="sm" disabled={disabled} onClick={onPress}>
      <FileText {...ICON} /> PDF
    </Button>
  );
  const errorOf = (k: ListKey): string | null => {
    if (backwards) return 'The From date is after the To date.';
    if (k === 'reports') return reportsFailed ? 'The merchant reports did not load.' : null;
    if (k === 'payments') return payQ.isError ? 'The list did not load.' : null;
    return bankQ.isError ? 'The bank lines did not load.' : null;
  };

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · bank & cards" title="Payments not matched yet" />
      <div className={top.top}>
        <div className={top.headRow}>
          <span style={softText}>Dated from</span>
          <DateField value={from} onChange={(v) => { if (v) setFrom(v); }} aria-label="Dated from" />
          <span style={softText}>to</span>
          <DateField value={to} onChange={(v) => { if (v) setTo(v); }} aria-label="Dated to" />
          <span className={top.grow} />
          <Button variant="secondary" size="sm" disabled={!allReady} onClick={() => void exportAll('excel')}
            title="The three lists in these dates, a sheet each — each as it is filtered, with the columns it shows">
            <Download {...ICON} /> Export all · Excel
          </Button>
          <Button variant="secondary" size="sm" disabled={!allReady} onClick={() => void exportAll('pdf')}
            title="The three lists in these dates, a part each — each as it is filtered, with the columns it shows">
            <FileText {...ICON} /> Export all · PDF
          </Button>
        </div>
        {exportError && <div role="alert" style={{ color: danger, fontSize: 'var(--fs-12)' }}>{exportError}</div>}

        <div className={top.cards} role="tablist" aria-label="Lists">
          {LISTS.map((l) => {
            const all = chips[l.key][0]!;
            return (
              <button key={l.key} type="button" role="tab" aria-selected={!showPrevious && list === l.key}
                className={`${top.card} ${!showPrevious && list === l.key ? top.cardOn : ''}`} onClick={() => choose(l.key)}>
                <div className={top.cardHead}><span className={top.cardName}>{l.label}</span></div>
                <div className={`${top.count} ${loaded[l.key] && all.n === 0 ? top.countZero : ''}`}>
                  {loaded[l.key] ? all.n : '…'}
                </div>
                <div className={top.countLabel}>{loaded[l.key] ? `${fmt(all.sen)} · ${l.sub}` : l.sub}</div>
                {loaded[l.key] && all.n > 0 && (
                  <div className={top.status}>
                    <span className={oldest[l.key] > 14 ? top.toneLate : top.toneCalm}>oldest {plural(oldest[l.key], 'day')}</span>
                  </div>
                )}
              </button>
            );
          })}
          <button type="button" role="tab" aria-selected={showPrevious}
            className={`${top.card} ${showPrevious ? top.cardOn : ''}`} onClick={() => choose('previous')}>
            <div className={top.cardHead}><span className={top.cardName}>Previous records</span></div>
            <div className={`${top.count} ${previousQ.data?.rows.length === 0 ? top.countZero : ''}`}>
              {previousQ.data ? previousQ.data.rows.length : '…'}
            </div>
            <div className={top.countLabel}>the previous system’s, marked by you · shown nowhere</div>
          </button>
        </div>

        {showPrevious && <div style={softText}>{PREVIOUS_ABOUT}</div>}
        {!showPrevious && <div style={softText}>{ABOUT[list]}</div>}
        {!showPrevious && loaded[list] && (
          <div className={top.headRow} role="group" aria-label={`${titleOf(list)} filter`}>
            {chips[list].map((c) => (
              <button key={c.key} type="button" aria-pressed={on(list) === c.key}
                className={`${top.chip} ${on(list) === c.key ? top.chipOn : ''}`}
                onClick={() => setChip((prev) => ({ ...prev, [list]: c.key }))}>
                {`${c.label} (${c.n})`}
              </button>
            ))}
          </div>
        )}
        {!showPrevious && loaded[list] && <div style={softText} aria-live="polite">{summary[list]}</div>}
        {!showPrevious && list === 'payments' && <PressNote result={markResult} />}
      </div>

      {showPrevious && <PreviousRecordsList />}

      <div hidden={showPrevious || list !== 'reports'}>
        <DataTable<ReportLineRow>
          tableId="unmatched-report-lines"
          exportName={listOf('reports').file}
          exportXlsx
          exportSheet={(rows) => ({ name: listOf('reports').sheet, heading: headingOf('reports', rows.length) })}
          onExportPdf={(view) => void printList('reports', view)}
          toolbarExtra={pdfButton(() => void printList('reports', tablePdfViewOf(seen.current.reports ?? rowsOn.reports ?? [], shownOr(shown.current.reports, REPORT_COLUMNS))), !loaded.reports)}
          onShownColumnsChange={shownReports}
          onFilteredRowsChange={seenReports}
          onColFiltersChange={funnelReports}
          columns={REPORT_COLUMNS}
          rows={rowsOn.reports}
          loading={!backwards && !reportsFailed && reports == null}
          error={errorOf('reports')}
          emptyLabel="Every merchant report line in these dates is reconciled."
          getRowKey={(r) => r.key}
        />
      </div>
      <div hidden={showPrevious || list !== 'bank'}>
        <DataTable<UnmatchedBankLine>
          tableId="unmatched-bank-lines"
          exportName={listOf('bank').file}
          exportXlsx
          exportSheet={(rows) => ({ name: listOf('bank').sheet, heading: headingOf('bank', rows.length) })}
          onExportPdf={(view) => void printList('bank', view)}
          toolbarExtra={pdfButton(() => void printList('bank', tablePdfViewOf(seen.current.bank ?? rowsOn.bank ?? [], shownOr(shown.current.bank, BANK_COLUMNS))), !loaded.bank)}
          onShownColumnsChange={shownBank}
          onFilteredRowsChange={seenBank}
          onColFiltersChange={funnelBank}
          columns={BANK_COLUMNS}
          rows={rowsOn.bank}
          loading={!backwards && bankQ.isLoading}
          error={errorOf('bank')}
          emptyLabel="Every bank line in these dates is matched."
          getRowKey={(r) => r.lineId}
        />
      </div>
      <div hidden={showPrevious || list !== 'payments'}>
        <DataTable<PaymentRow>
          tableId="unmatched-payments"
          exportName={listOf('payments').file}
          exportXlsx
          exportSheet={(rows) => ({ name: listOf('payments').sheet, heading: headingOf('payments', rows.length) })}
          onExportPdf={(view) => void printList('payments', view)}
          selection={{ ...payTicks.selection, rowLabel: (r) => `Tick ${r.docNo}` }}
          toolbarExtra={(
            <>
              {pdfButton(() => void printList('payments', tablePdfViewOf(seen.current.payments ?? rowsOn.payments ?? [], shownOr(shown.current.payments, PAYMENT_COLUMNS))), !loaded.payments)}
              <MarkPreviousButton refs={payTicks.refs} onDone={payTicks.clear} onResult={setMarkResult} />
            </>
          )}
          onShownColumnsChange={shownPayments}
          onFilteredRowsChange={seenPayments}
          onColFiltersChange={funnelPayments}
          columns={PAYMENT_COLUMNS}
          rows={rowsOn.payments}
          loading={!backwards && payQ.isLoading}
          error={errorOf('payments')}
          emptyLabel="Every card and transfer payment in these dates is matched."
          getRowKey={(r) => `${r.source}:${r.paymentId}`}
        />
      </div>
    </div>
  );
};
