// ----------------------------------------------------------------------------
// merchantReconExport: "Merchant reports still to reconcile" as a file (owner
// 2026-11-06: 我要能 export). How one report line reads, which the screen uses too,
// so the Excel, the PDF and the screen cannot say three different things.
// ----------------------------------------------------------------------------

import type { LineExportMatrix } from '../../components/dataTableLineExport';
import type { PrintedLine, PrintedReport } from '../../vendor/scm/lib/merchant-recon-pdf';
import type { SettlementBatch, SettlementRow } from './settlement-queries';
import { payableOf } from './settlement-ui';

/** Whichever side is showing, the ORDER columns read from one shape, so a claimed
    payment and a suggested one line up under the same headings. */
export const ordersOf = (r: SettlementRow) => (
  r.linked.length > 0
    ? r.linked.map((l) => ({
      key: l.payment_id,
      docNo: l.doc_no ?? l.payment_id,
      /* No document number: the payment id is shown, and it opens nothing. */
      source: l.doc_no ? l.payment_source : null,
      customer: l.customer_name ?? null,
      sales: l.salesperson ?? null,
      sheet: l.account_sheet ?? null,
      paidOn: l.paid_on ?? null,
      code: l.approval_code ?? null,
      amountSen: l.amount_sen,
    }))
    : (r.suggested ?? []).map((p) => ({
      key: p.id,
      docNo: p.docNo,
      source: p.source,
      customer: p.customerName ?? null,
      sales: p.salesperson ?? null,
      sheet: p.accountSheet ?? null,
      paidOn: p.paidOn,
      code: p.approvalCode ?? null,
      amountSen: p.amountSen,
    }))
);

export type LineStatus = 'done' | 'matched' | 'guess' | 'none' | 'choose';

/** Linked = it claimed a payment. Suggested = the system's answer, pre-ticked but
    not taken. Neither = a human's job. */
export const lineStatus = (r: SettlementRow): LineStatus => {
  if (r.confirmed_at) return 'done';
  if (r.linked.length > 0) return 'matched';
  if ((r.suggested ?? []).length > 0) return 'guess';
  return r.bucket === 'UNMATCHED' ? 'none' : 'choose';
};

export const LINE_STATUS_WORDS: Record<LineStatus, string> = {
  done: 'done',
  matched: 'matched by reference',
  guess: 'the system’s guess — check it',
  none: 'no sale in the ERP',
  choose: 'you choose',
};

/** A line still to do: one already decided is not work. */
export const isOpenLine = (r: SettlementRow): boolean => !r.confirmed_at && r.bucket !== 'IGNORED';

const printedLine = (r: SettlementRow): PrintedLine => {
  const status = lineStatus(r);
  const orders = ordersOf(r);
  return {
    date: r.txn_date,
    lineNo: r.line_no,
    ref: r.ref,
    grossSen: Number(r.gross_sen),
    feeSen: Number(r.fee_sen),
    netSen: Number(r.net_sen),
    document: orders.length === 0 && r.candidates.length > 0 ? `${r.candidates.length} possible` : null,
    orders: orders.map((o) => ({
      docNo: o.docNo, customer: o.customer, sales: o.sales, sheet: o.sheet, paidOn: o.paidOn, code: o.code,
      amountSen: Number(o.amountSen),
    })),
    status: LINE_STATUS_WORDS[status],
    tone: status === 'matched' ? 'good' : status === 'none' ? 'bad' : null,
  };
};

/** The reports the list is showing, in its order, each at what it really pays,
    with only its open lines. `details[i]` is what `batches[i]` read. */
export const openReportsOf = (
  batches: readonly SettlementBatch[],
  details: ReadonlyArray<{ rows: SettlementRow[] }>,
): PrintedReport[] => batches.flatMap((b, i) => {
  const lines = (details[i]?.rows ?? []).filter(isOpenLine).map(printedLine);
  return lines.length === 0 ? [] : [{ merchant: b.acquirer_code, file: b.file_name, netSen: payableOf(b), lines }];
});

const ringgit = (sen: number | null): number | null => (sen == null ? null : sen / 100);

/** One flat heading row, so the file filters and sums. A line paying several orders
    takes a row each with its own money on the first, so Gross, Fee and Net still add up. */
export const reportLinesMatrix = (reports: readonly PrintedReport[]): LineExportMatrix => ({
  header: ['Merchant', 'Report', 'Date', 'Line', 'Reference', 'Gross', 'Fee', 'Net', 'Document', 'Customer', 'Sales', 'Account sheet', 'Paid on', 'Approval', 'Amount', 'Status'],
  formats: ['text', 'text', 'date', 'number', 'text', 'money', 'money', 'money', 'text', 'text', 'text', 'text', 'date', 'text', 'money', 'text'],
  body: reports.flatMap((report) => report.lines.flatMap((l) => {
    const head = [report.merchant, report.file, l.date, l.lineNo, l.ref];
    const money = [ringgit(l.grossSen), ringgit(l.feeSen), ringgit(l.netSen)];
    if (l.orders.length === 0) {
      return [[...head, ...money, l.document, null, null, null, null, null, null, l.status]];
    }
    return l.orders.map((o, i) => [
      ...head, ...(i === 0 ? money : [null, null, null]),
      o.docNo, o.customer, o.sales, o.sheet, o.paidOn, o.code, ringgit(o.amountSen), l.status,
    ]);
  })),
});
