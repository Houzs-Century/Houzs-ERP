/* Payment corrections — the Finance report of every payment action made on
   the correction right (owner 2026-09-10, docs/bugs/0785; widened 2026-09-14,
   docs/bugs/0888: 只要是有关 collection payment 的，我或有权限的用户做的动作都要
   记录写 reason).

   A filtered read of the SO audit log, one row per action: who, when, which
   order, what was done — a payment recorded, changed, removed, or its proof
   attached — who FIRST recorded that payment and on which day (owner: 我就是要
   看原本是谁记录这一笔的), the reason typed at the time, and the JE numbers. A
   row from before the rule — a holder's own action, made when nothing asked
   why — is listed and marked (规则之前). A same-day fix by a role without the
   key is not here on purpose (owner: 靠权限改的来决定); the SO's own audit
   history still shows those.

   In the owner's Claude Design (batch 6 step 13, §5.9): the report shell — a
   Month (the last twelve) and Done by, no date range — the three tiles, the
   Finance-Table `payment-corrections`, Excel from what is on screen, and PDF /
   Print through the report's own document builder (`correctionsDocument`,
   kept: it prints the way the bank reconciliation does). */

import { useMemo, useState } from 'react';
import { fmtDate, fmtDateOrDash, fmtSen } from '../../vendor/shared/format';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import type { ReportSheet, SheetColumn } from '../../vendor/scm/lib/report-sheet';
import { usePaymentCorrections, type PaymentCorrectionRow } from './accounting-phase1-queries';
import { DataTable, type Column } from '../../components/DataTable';
/* The page already reads the document's own sentences from this module, so
   its builder costs nothing more imported here. */
import { emptyText, generatePaymentCorrectionsPdf, ledgerText, whatChanged } from '../../vendor/scm/lib/payment-corrections-pdf';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { Tag, type Tone } from './finance/SetupParts';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, ReportTool, ReportToolbar, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import css from './reports/Corrections.module.css';

/** The last twelve months, this one first, as YYYY-MM. */
export const recentMonths = (today: Date = new Date(), count = 12): string[] => {
  const out: string[] = [];
  let y = today.getFullYear();
  let m = today.getMonth() + 1;
  for (let i = 0; i < count; i += 1) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
};

/** "October 2026" — a month as the select and the grey line name it. */
const monthLong = (ym: string): string =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const fmt = (sen: number | null | undefined) => fmtSen(sen);
const signed = (sen: number) => (sen < 0 ? `−${fmt(-sen)}` : sen > 0 ? `+${fmt(sen)}` : fmt(0));

/* The tag each kind wears (the design's tones): money that came in info, an
   edit calm, money that went late, a proof calm. */
const KIND: Record<PaymentCorrectionRow['kind'], { text: string; tone: Tone; dot?: boolean }> = {
  added: { text: 'Added', tone: 'info' },
  edited: { text: 'Edited', tone: 'calm' },
  deleted: { text: 'Deleted', tone: 'late', dot: true },
  proof: { text: 'Proof', tone: 'calm' },
};

const reasonOf = (r: PaymentCorrectionRow): string => r.reason || (r.beforeRule ? 'Before the rule' : '');
const recordedOf = (r: PaymentCorrectionRow): string =>
  (r.recordedBy || r.recordedOn ? `${r.recordedBy ?? '—'}${r.recordedOn ? ` · ${fmtDateOrDash(r.recordedOn)}` : ''}` : '');

/** The table as the screen shows it, for Excel. */
export function correctionsSheet(month: string, rows: readonly PaymentCorrectionRow[], who: string, subtitle: string): ReportSheet {
  const text = (label: string): SheetColumn => ({ label, kind: 'text' });
  return {
    title: 'Payment corrections',
    subtitle,
    meta: [{ label: 'Month', value: monthLong(month) }, { label: 'Done by', value: who || 'Everyone' }],
    tables: [{
      columns: [text('Done by'), text('Sales order'), text('Customer'), text('What'), text('Change'), text('First recorded by'), text('Reason'), text('Ledger')],
      rows: rows.map((r) => ({
        kind: 'row' as const, depth: 0, label: fmtDate(r.at),
        cells: [r.by, r.docNo, r.customer ?? '', KIND[r.kind].text, whatChanged(r), recordedOf(r), reasonOf(r), ledgerText(r)],
      })),
    }],
  };
}

export const PaymentCorrectionsTab = () => {
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState(months[0]!);
  const [who, setWho] = useState<string>('');
  const q = usePaymentCorrections(month);
  const notify = useNotify();

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const people = useMemo(() => [...new Set(rows.map((r) => r.by))].sort(), [rows]);
  const shown = who ? rows.filter((r) => r.by === who) : rows;
  const summary = q.data?.summary;

  const subtitle = `${monthLong(month)} · every payment action taken with the payment-correction right, with the reason given and who first recorded the payment`;
  useReportSubtitle(subtitle);

  const pdf = async (action: 'preview' | 'print') => {
    if (!q.data) return;
    try {
      await generatePaymentCorrectionsPdf({ month: q.data.month, rows: shown, summary: q.data.summary }, { action });
    } catch (e) {
      void notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const tiles: ReportTile[] = [
    {
      key: 'actions', label: 'Payment actions', value: summary ? String(summary.corrections) : '',
      sub: summary ? `${summary.edited} edited · ${summary.added} added · ${summary.deleted} deleted${summary.proof > 0 ? ` · ${summary.proof} proof` : ''}` : '',
    },
    { key: 'by', label: 'Done by', value: summary ? who || 'Everyone' : '', sub: summary ? `${people.length} ${people.length === 1 ? 'person' : 'people'}` : '' },
    {
      key: 'net', label: 'Money received, net effect', value: summary ? signed(summary.netMovedSen) : '',
      sub: 'Added, removed and edited amounts together', tone: summary && summary.netMovedSen < 0 ? 'late' : 'plain',
    },
  ];

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (q.data ? correctionsSheet(month, shown, who, subtitle) : null)} fileBase={`payment-corrections-${month}`} onPdf={pdf} />
      </ReportHeaderActions>
      <ReportToolbar>
        <ReportTool label="Month">
          <select className={css.select} value={month} onChange={(e) => { setMonth(e.target.value); setWho(''); }} aria-label="Month">
            {months.map((m) => <option key={m} value={m}>{monthLong(m)}</option>)}
          </select>
        </ReportTool>
        <ReportTool label="Done by">
          <select className={css.select} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Done by">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </ReportTool>
      </ReportToolbar>

      {q.isError && (
        <ReportMessage tone="error">The report could not be read: {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>
      )}
      {!q.isError && <ReportTiles label="Payment corrections figures" tiles={tiles} pending={!summary} />}

      {q.data && rows.length === 0 && (
        <ReportMessage>
          {emptyText(month)}{' '}
          Actions by roles without the right are on each order's audit history, not here.
        </ReportMessage>
      )}

      {(q.isLoading || rows.length > 0) && (
        <DataTable<PaymentCorrectionRow>
          tableId="payment-corrections"
          exportName={`payment-corrections-${month}`}
          exportXlsx
          columns={CORRECTION_COLUMNS}
          rows={q.isLoading ? null : shown}
          loading={q.isLoading}
          emptyLabel={`No payment action by ${who || 'anyone'} in ${monthLong(month)}.`}
          getRowKey={(r) => r.id}
        />
      )}
    </>
  );
};

const CORRECTION_COLUMNS: Column<PaymentCorrectionRow>[] = [
  { key: 'done', label: 'Done', getValue: (r) => r.at, exportValue: (r) => r.at.slice(0, 10), exportFormat: 'date', render: (r) => fmtDateOrDash(r.at) },
  { key: 'doneBy', label: 'Done by', render: (r) => r.by, getValue: (r) => r.by },
  {
    key: 'order', label: 'Sales order', getValue: (r) => r.docNo,
    render: (r) => <FinanceDocLink to={`/scm/sales-orders/${encodeURIComponent(r.docNo)}`}>{r.docNo}</FinanceDocLink>,
  },
  { key: 'customer', label: 'Customer', getValue: (r) => r.customer ?? '', render: (r) => r.customer ?? '—' },
  {
    key: 'what', label: 'What', getValue: (r) => KIND[r.kind].text,
    render: (r) => <Tag tone={KIND[r.kind].tone} dot={KIND[r.kind].dot}>{KIND[r.kind].text}</Tag>,
  },
  { key: 'change', label: 'Change', getValue: (r) => whatChanged(r), render: (r) => whatChanged(r) },
  {
    key: 'recorded', label: 'First recorded by', getValue: (r) => r.recordedBy ?? '',
    render: (r) => (r.recordedBy || r.recordedOn
      ? <><span>{r.recordedBy ?? '—'}</span>{r.recordedOn && <span className={css.sub}> · {fmtDateOrDash(r.recordedOn)}</span>}</>
      : '—'),
  },
  {
    key: 'reason', label: 'Reason', getValue: (r) => reasonOf(r),
    render: (r) => (r.reason
      ? r.reason
      : r.beforeRule
        ? <span className={css.sub} title="Made before every payment action on the right asked for a reason (2026-09-14)">Before the rule</span>
        : '—'),
  },
  { key: 'ledger', label: 'Ledger', getValue: (r) => ledgerText(r), render: (r) => ledgerText(r) },
];
