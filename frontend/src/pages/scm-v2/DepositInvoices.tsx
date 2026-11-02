// ----------------------------------------------------------------------------
// DepositInvoices — /scm/deposit-invoices (owner 2026-09-12; docs/bugs/0828).
// One invoice per customer payment received before the order's final invoice
// — born by itself off the payment when the company's switch is on, booked
// Dr the customer / Cr DEPOSIT PAY BY CUSTOMER (收钱就认 sales). This page is
// Finance's window: the switch and its start day, the payments the start day
// left behind (and the button that issues them), the list, one invoice with
// its payment, cancel with a reason, post again. The server decides; this
// page shows its reasons.
//
// A row opens THE INVOICE (owner 2026-10-06: 点一行就直接打开这张单) — since the
// redesign (owner's Claude Design, batch 5 §8) as a page of its own,
// /scm/ar-invoices/deposit/:id, in its own tab: the facts, the steps (Post to
// ledger, Cancel with a reason) and the page exactly as it prints.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Button } from '@2990s/design-system';
import { PageHeader } from '../../components/Layout';
import { DateField } from '../../vendor/scm/components/DateField';
import {
  useDepositInvoices, useDepositInvoiceSettings, useSaveDepositInvoiceSettings,
  useIssueMissingDepositInvoices, useInvoiceDeliveredOrders, fetchDepositInvoiceSheets,
  type DepositInvoice, type DepositInvoiceStatus,
} from '../../vendor/scm/lib/deposit-invoice-queries';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { moneyInDocHref } from './money-in/moneyInDocs';
import { DataTable, type Column } from '../../components/DataTable';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import { PAYMENT_METHOD_CODES, PAYMENT_METHOD_DEFAULT_LABELS } from '../../vendor/scm/lib/payment-methods';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 0, overflowX: 'auto' };
const danger = 'var(--c-festive-b, #B8331F)';
const good = 'var(--c-secondary-a, #2F5D4F)';
const input: React.CSSProperties = { padding: '5px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, minWidth: 180 };

const StatusPill = ({ status }: { status: DepositInvoiceStatus }) => (
  <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', color: status === 'ISSUED' ? good : danger }}>
    {status}
  </span>
);

/* Document numbers in tabular figures — never monospace (the redesign). */
const figures: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const methodLabel = (m: string | null): string => {
  const code = PAYMENT_METHOD_CODES.find((c) => c === m);
  return code ? PAYMENT_METHOD_DEFAULT_LABELS[code] : m ? humaniseStatusKey(m) : '—';
};
const DEPOSIT_COLUMNS: Column<DepositInvoice>[] = [
  /* The number opens the invoice's page, in its own tab. */
  {
    key: 'number', label: 'Number', getValue: (d) => d.di_number,
    render: (d) => <span className={cancelledDocNoClass(d.status)}><FinanceDocLink to={moneyInDocHref('depositInvoice', d.id)}>{d.di_number}</FinanceDocLink></span>,
  },
  { key: 'date', label: 'Date', render: (d) => fmtDateOrDash(d.invoice_date), getValue: (d) => d.invoice_date, exportFormat: 'date' },
  { key: 'customer', label: 'Customer', render: (d) => d.party_name ?? d.party_code ?? '—', getValue: (d) => d.party_name ?? d.party_code ?? '' },
  { key: 'order', label: 'Order', render: (d) => <span style={figures}>{d.so_doc_no}</span>, getValue: (d) => d.so_doc_no },
  { key: 'method', label: 'Method', render: (d) => methodLabel(d.method), getValue: (d) => d.method ?? '' },
  {
    key: 'amount', label: 'Amount', align: 'right', render: (d) => fmtSen(d.amount_sen),
    getValue: (d) => d.amount_sen, exportValue: (d) => d.amount_sen / 100, exportFormat: 'money',
  },
  { key: 'status', label: 'Status', render: (d) => <StatusPill status={d.status} />, getValue: (d) => d.status },
  { key: 'journal', label: 'Journal', render: (d) => <span style={figures}>{d.je_no ?? '—'}</span>, getValue: (d) => d.je_no ?? '' },
  {
    key: 'closedBy', label: 'Closed by',
    render: (d) => (
      <span style={figures}>
        {d.credit_note_number ?? (d.credit_note_id ? 'CN' : '—')}
        {(d.refunded_sen ?? 0) > 0 && <div style={soft}>refunded {fmtSen(d.refunded_sen ?? 0)}</div>}
      </span>
    ),
    getValue: (d) => d.credit_note_number ?? (d.credit_note_id ? 'CN' : ''),
  },
];

export const DepositInvoices = () => {
  const [status, setStatus] = useState<DepositInvoiceStatus | 'ALL'>('ALL');
  const [so, setSo] = useState('');
  const openInTab = useOpenDocInTab();
  const listQ = useDepositInvoices(status, so.trim());
  const rows = listQ.data?.rows ?? [];
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const toggle = (id: string) => setTicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /* The ticked invoices as ONE document in LIST order, a page each (owner
     2026-09-12: 要批量打印; docs/bugs/0834) — each sheet with its order's
     address and figures, the A4 layout's (owner 2026-10-06). */
  const printTicked = async (action: PdfAction) => {
    const targets = rows.filter((d) => ticked.has(d.id));
    if (targets.length === 0 || printing) return;
    setPrinting(true); setPrintError(null);
    try {
      const sheets = await fetchDepositInvoiceSheets(targets.map((d) => d.id));
      const { generateDepositInvoicesPdf } = await import('../../vendor/scm/lib/deposit-invoice-pdf');
      await generateDepositInvoicesPdf(sheets, { action });
    } catch (e) { setPrintError(errText(e)); } finally { setPrinting(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · Money in" title="Deposit invoices" />

      <SwitchCard />

      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value as DepositInvoiceStatus | 'ALL')} aria-label="Invoice status" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}>
          <option value="ALL">Any status</option>
          <option value="ISSUED">Issued</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <input value={so} onChange={(e) => setSo(e.target.value)} placeholder="sales order, e.g. 2990-SO-2609-001" aria-label="Sales order" style={input} />
      </div>

      {ticked.size > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }} aria-label="Ticked invoices">
          <span>{ticked.size} ticked</span>
          <Button size="sm" onClick={() => void printTicked('print')} disabled={printing}>{printing ? 'Preparing…' : `Print ${ticked.size}`}</Button>
          <Button variant="ghost" size="sm" onClick={() => void printTicked('save')} disabled={printing}>Save PDF</Button>
          <Button variant="ghost" size="sm" onClick={() => setTicked(new Set())} disabled={printing}>Clear</Button>
          {printError && <span style={{ color: danger }}>{printError}</span>}
        </div>
      )}
      <DataTable<DepositInvoice>
        tableId="deposit-invoices"
        exportName="deposit-invoices"
        exportXlsx
        columns={DEPOSIT_COLUMNS}
        rows={listQ.data ? rows : null}
        loading={listQ.isLoading}
        error={listQ.isError ? `The list did not load — ${errText(listQ.error)}` : null}
        emptyLabel="No deposit invoice matches this filter."
        getRowKey={(d) => d.id}
        getRowClassName={(d) => cancelledRowClass(d.status)}
        onRowClick={(d) => openInTab(moneyInDocHref('depositInvoice', d.id))}
        selection={{
          selectedIds: ticked,
          onToggle: toggle,
          onToggleAll: (keys, all) => setTicked(all ? new Set() : new Set(keys)),
          rowLabel: (d) => `Tick ${d.di_number}`,
        }}
      />

    </div>
  );
};

/* The per-company switch and its start day, with the backlog the start day
   leaves behind. Saved as a pair: switching on needs a day. */
const SwitchCard = () => {
  const q = useDepositInvoiceSettings();
  const save = useSaveDepositInvoiceSettings();
  const issue = useIssueMissingDepositInvoices();
  const invoiceDelivered = useInvoiceDeliveredOrders();
  const [draft, setDraft] = useState<{ enabled: boolean; fromDate: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const saved = q.data?.settings;
  const missing = q.data?.missingCount ?? 0;
  const delivered = q.data?.deliveredUninvoicedCount ?? 0;
  const v = draft ?? { enabled: saved?.enabled ?? false, fromDate: saved?.fromDate ?? '' };
  const busy = save.isPending || issue.isPending || invoiceDelivered.isPending;

  return (
    <section style={{ ...card, padding: 'var(--space-3)', overflowX: 'visible' }} aria-label="Deposit invoice switch">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
        <span>
          <strong>Auto-issue for this company:</strong>{' '}
          {q.isLoading ? 'loading…' : q.isError ? <span style={{ color: danger }}>not read — {errText(q.error)}</span>
            : saved?.enabled ? <span style={{ color: good }}>On — payments dated from {fmtDateOrDash(saved.fromDate)}</span> : 'Off'}
        </span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={v.enabled} onChange={(e) => setDraft({ ...v, enabled: e.target.checked })} aria-label="Issue a deposit invoice for every customer payment" />
          issue a deposit invoice for every customer payment
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={soft}>from</span>
          <DateField value={v.fromDate} onChange={(d) => setDraft({ ...v, fromDate: d })} aria-label="Deposit invoices start from" />
        </label>
        <Button size="sm" disabled={draft == null || busy}
          onClick={() => save.mutate({ enabled: v.enabled, fromDate: v.fromDate.trim() || null }, {
            onSuccess: (r) => { setDraft(null); setNote(r.settings.enabled ? `Saved — on for payments dated from ${fmtDateOrDash(r.settings.fromDate)}.` : 'Saved — off.'); },
            onError: (e) => setNote(errText(e)),
          })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {saved?.enabled && missing > 0 && (
        <div style={{ marginTop: 'var(--space-2)', display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
          <span>{missing} {missing === 1 ? 'payment' : 'payments'} dated from {fmtDateOrDash(saved.fromDate)} still without a deposit invoice.</span>
          <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => issue.mutate(undefined, { onError: (e) => setNote(errText(e)) })}>
            {issue.isPending ? 'Issuing…' : 'Issue them now'}
          </Button>
        </div>
      )}
      {issue.isSuccess && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-13)', color: good }}>
          Issued {issue.data.issued.length}{issue.data.issued.length > 0 ? `: ${issue.data.issued.join(', ')}` : ''}
          {issue.data.skipped.length > 0 ? ` · ${issue.data.skipped.length} skipped (${issue.data.skipped.map((s) => s.why).join(', ')})` : ''}.
        </div>
      )}
      {saved?.enabled && delivered > 0 && (
        <div style={{ marginTop: 'var(--space-2)', display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
          <span>{delivered} delivered {delivered === 1 ? 'order' : 'orders'} still without a final invoice. Each is invoiced on the day its goods left; the deposit invoices on it are then closed by a credit note each.</span>
          <Button variant="ghost" size="sm" disabled={busy || missing > 0}
            title={missing > 0 ? 'Issue the deposit invoices first.' : undefined}
            onClick={() => invoiceDelivered.mutate(undefined, { onError: (e) => setNote(errText(e)) })}>
            {invoiceDelivered.isPending ? 'Invoicing…' : 'Invoice them now'}
          </Button>
          {missing > 0 && <span style={soft}>Issue the deposit invoices first.</span>}
        </div>
      )}
      {invoiceDelivered.isSuccess && (
        <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-13)', color: good }}>
          Invoiced {invoiceDelivered.data.invoiced.length}{invoiceDelivered.data.invoiced.length > 0 ? `: ${invoiceDelivered.data.invoiced.join(', ')}` : ''}
          {invoiceDelivered.data.skipped.length > 0 ? ` · ${invoiceDelivered.data.skipped.length} skipped (${invoiceDelivered.data.skipped.map((s) => `${s.docNo}: ${s.why}`).join(', ')})` : ''}.
        </div>
      )}
      {note && <div style={{ ...soft, marginTop: 'var(--space-2)' }}>{note}</div>}
    </section>
  );
};
