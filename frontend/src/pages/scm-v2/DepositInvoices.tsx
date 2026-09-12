// ----------------------------------------------------------------------------
// DepositInvoices — /scm/deposit-invoices (owner 2026-09-12; docs/bugs/0828).
// One invoice per customer payment received before the order's final invoice
// — born by itself off the payment when the company's switch is on, booked
// Dr the customer / Cr DEPOSIT PAY BY CUSTOMER (收钱就认 sales). This page is
// Finance's window: the switch and its start day, the payments the start day
// left behind (and the button that issues them), the list, one invoice with
// its payment, cancel with a reason, post again. The server decides; this
// page shows its reasons.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Button } from '@2990s/design-system';
import { PageHeader } from '../../components/Layout';
import { Modal } from '../../vendor/scm/components/Modal';
import { DateField } from '../../vendor/scm/components/DateField';
import {
  useDepositInvoices, useDepositInvoiceDetail, useDepositInvoiceSettings, useSaveDepositInvoiceSettings,
  useIssueMissingDepositInvoices, useInvoiceDeliveredOrders, useCancelDepositInvoice, usePostDepositInvoice,
  type DepositInvoiceStatus,
} from '../../vendor/scm/lib/deposit-invoice-queries';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 0, overflowX: 'auto' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-13)', borderBottom: '1px solid var(--border-weak, #f0eee8)' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const danger = 'var(--c-festive-b, #B8331F)';
const good = 'var(--c-secondary-a, #2F5D4F)';
const input: React.CSSProperties = { padding: '5px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, minWidth: 180 };

const StatusPill = ({ status }: { status: DepositInvoiceStatus }) => (
  <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', color: status === 'ISSUED' ? good : danger }}>
    {status}
  </span>
);

export const DepositInvoices = () => {
  const [status, setStatus] = useState<DepositInvoiceStatus | 'ALL'>('ALL');
  const [so, setSo] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const listQ = useDepositInvoices(status, so.trim());
  const rows = listQ.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Deposit Invoices"
        description="One invoice per customer payment received before the order's final invoice — issued by itself when the switch is on, booked Dr the customer / Cr Deposit pay by customer. An edited payment cancels its invoice and takes the next number; a deleted one cancels it. At the final invoice each one is closed by a credit note of its own." />

      <SwitchCard />

      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value as DepositInvoiceStatus | 'ALL')} aria-label="Invoice status" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}>
          <option value="ALL">Any status</option>
          <option value="ISSUED">Issued</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <input value={so} onChange={(e) => setSo(e.target.value)} placeholder="sales order, e.g. 2990-SO-2609-001" aria-label="Sales order" style={input} />
      </div>

      {listQ.isLoading && <div style={soft}>Loading…</div>}
      {listQ.isError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>The list did not load — {errText(listQ.error)}</div>}
      {listQ.data && rows.length === 0 && <div style={soft}>No deposit invoice matches this filter.</div>}
      {rows.length > 0 && (
        <div style={card}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Number</th><th style={th}>Date</th><th style={th}>Customer</th><th style={th}>Order</th><th style={th}>Method</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Status</th><th style={th}>Journal</th><th style={th}>Closed by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} onClick={() => setOpenId(d.id)} style={{ cursor: 'pointer' }} data-invoice={d.di_number}>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{d.di_number}</td>
                  <td style={td}>{fmtDateOrDash(d.invoice_date)}</td>
                  <td style={td}>{d.party_name ?? d.party_code ?? '—'}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{d.so_doc_no}</td>
                  <td style={td}>{d.method ?? '—'}</td>
                  <td style={{ ...td, ...num }}>{fmtSen(d.amount_sen)}</td>
                  <td style={td}><StatusPill status={d.status} /></td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{d.je_no ?? '—'}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{d.credit_note_number ?? (d.credit_note_id ? 'CN' : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && <InvoiceDetail id={openId} onClose={() => setOpenId(null)} />}
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

const InvoiceDetail = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const q = useDepositInvoiceDetail(id);
  const cancel = useCancelDepositInvoice();
  const post = usePostDepositInvoice();
  const [reason, setReason] = useState('');
  const inv = q.data?.invoice;
  const pay = q.data?.payment ?? null;
  const busy = cancel.isPending || post.isPending;
  const failed = cancel.isError ? cancel.error : post.isError ? post.error : null;
  return (
    <Modal title={inv ? `Deposit invoice ${inv.di_number}` : 'Deposit invoice'} onClose={onClose} width="min(760px, 100%)" ariaLabel="Deposit invoice"
      actions={inv && inv.status === 'ISSUED' && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          {!inv.je_no && <Button size="sm" onClick={() => post.mutate(inv.id)} disabled={busy}>{post.isPending ? 'Posting…' : 'Post to ledger'}</Button>}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why it is cancelled" aria-label="Cancel reason" style={input} />
          <Button variant="ghost" size="sm" disabled={busy || reason.trim() === ''} onClick={() => cancel.mutate({ id: inv.id, reason: reason.trim() })}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel invoice'}
          </Button>
        </div>
      )}>
      {q.isLoading && <div style={soft}>Loading…</div>}
      {q.isError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{errText(q.error)}</div>}
      {inv && (
        <div className="space-y-3">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <div><div style={soft}>Customer</div>{inv.party_name ?? '—'}{inv.party_code ? <span style={soft}> · {inv.party_code}</span> : null}</div>
            <div><div style={soft}>Sales order</div><span style={{ fontFamily: 'var(--font-mono)' }}>{inv.so_doc_no}</span></div>
            <div><div style={soft}>Date</div>{fmtDateOrDash(inv.invoice_date)}</div>
            <div><div style={soft}>Amount</div><span style={num}>{fmtSen(inv.amount_sen)}</span></div>
            <div>
              <div style={soft}>Payment</div>
              {pay ? `${pay.method ?? '—'}${pay.merchant_provider ? ` · ${pay.merchant_provider}` : ''}${pay.online_type ? ` · ${pay.online_type}` : ''} · ${fmtDateOrDash(pay.paid_at)} · ${fmtSen(pay.amount_sen)}` : 'the payment row is gone'}
            </div>
            <div><div style={soft}>Status</div><StatusPill status={inv.status} />{inv.je_no ? <span style={soft}> · {inv.je_no}</span> : <span style={{ ...soft, color: danger }}> · not posted</span>}</div>
            {inv.credit_note_id && <div><div style={soft}>Closed by credit note</div><span style={{ fontFamily: 'var(--font-mono)' }}>{inv.credit_note_number ?? inv.credit_note_id}</span></div>}
            {inv.status === 'CANCELLED' && (
              <div style={{ gridColumn: '1 / -1' }}><div style={soft}>Cancelled</div>{inv.cancel_reason ?? '—'}{inv.cancelled_by ? <span style={soft}> · {inv.cancelled_by}</span> : null}{inv.cancelled_at ? <span style={soft}> · {fmtDateOrDash(inv.cancelled_at)}</span> : null}</div>
            )}
          </div>
          {post.isSuccess && <div style={{ fontSize: 'var(--fs-13)', color: good }}>Posted as {post.data.jeNo}.</div>}
          {cancel.isSuccess && <div style={{ fontSize: 'var(--fs-13)', color: good }}>Cancelled{cancel.data.contraJeNo ? ` — contra ${cancel.data.contraJeNo}` : ''}.</div>}
          {failed != null && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{errText(failed)}</div>}
        </div>
      )}
    </Modal>
  );
};
