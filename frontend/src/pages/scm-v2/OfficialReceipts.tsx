// ----------------------------------------------------------------------------
// OfficialReceipts — /scm/official-receipts, the OR book (GL redesign item 9b).
// Every customer payment's OFFICIAL RECEIPT document lives here: the drafts
// waiting for their money to be confirmed and the formal run per channel.
// Distinct from /scm/receipts (这个月收了什么钱 money-in list) — that page is
// about the ledger, this one is about the paper. Two buttons per row — Print
// (DRAFT prints with the watermark) and, on a draft, Confirm money — the
// owner's 客户催收据 path: he verified the slip himself, the receipt goes
// formal now (default = the company bank; recon links up later).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import { PageHeader } from '../../components/Layout';
import { generateReceiptPdf, type ReceiptPdfData } from '../../vendor/scm/lib/receipt-pdf';

type ReceiptRow = ReceiptPdfData & {
  id: number;
  payment_source: string;
  payment_id: string;
  channel_account_code: string | null;
  created_at: string;
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const btn = (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
  padding: '4px 10px',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  borderRadius: 'var(--radius-sm, 6px)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});

export const OfficialReceipts = () => {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'' | 'DRAFT' | 'FORMAL'>('');
  const q = useQuery({
    queryKey: ['official-receipts', status],
    queryFn: () => authedFetch<{ receipts: ReceiptRow[] }>(`/accounting/receipts${status ? `?status=${status}` : ''}`),
    staleTime: 15_000,
  });
  const formalise = useMutation({
    mutationFn: (id: number) => authedFetch<{ ok: boolean; orNumber: string }>(`/accounting/receipts/${id}/formalise`, { method: 'POST', body: '{}' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['official-receipts'] }); },
  });

  const rows = q.data?.receipts ?? [];

  return (
    <div className="space-y-3">
      <PageHeader eyebrow="Finance" title="Official Receipts" />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {([['', 'All'], ['DRAFT', 'Draft — money not confirmed'], ['FORMAL', 'Formal']] as const).map(([v, label]) => (
          <button key={v || 'all'} type="button" style={btn(status === v)} onClick={() => setStatus(v)}>{label}</button>
        ))}
        <span style={soft}>现金当场正式;卡款等 merchant recon;转账你核对后按 Confirm money。</span>
      </div>

      {formalise.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>
          {String((formalise.error as { message?: string } | null)?.message ?? 'The receipt was not confirmed.')}
        </div>
      )}

      <div style={{ overflowX: 'auto', border: '1px solid var(--c-line, rgba(34,31,32,0.12))', borderRadius: 'var(--radius-md)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>OR No</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Status</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Paid</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Document</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Customer</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Method</th>
              <th style={{ textAlign: 'right', padding: '8px 10px' }}>Amount</th>
              <th style={{ padding: '8px 10px' }} />
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={8} style={{ padding: 10, ...soft }}>Loading…</td></tr>}
            {!q.isLoading && rows.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 10, ...soft }}>No receipts yet — one is born with every customer payment recorded from now on.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}><b>{r.or_number}</b></td>
                <td style={{ padding: '6px 10px', color: r.status === 'FORMAL' ? 'var(--c-good, #2f5d4f)' : undefined }}>
                  {r.status === 'FORMAL' ? 'Formal' : 'Draft'}
                </td>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{fmtDateOrDash(r.paid_at)}</td>
                <td style={{ padding: '6px 10px' }}>{r.doc_no ?? '—'}</td>
                <td style={{ padding: '6px 10px' }}>{r.customer_name ?? '—'}</td>
                <td style={{ padding: '6px 10px' }}>{r.method ?? '—'}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtSen(r.amount_sen)}</td>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  <button type="button" style={btn()} onClick={() => { void generateReceiptPdf(r, { action: 'print' }); }}>Print</button>{' '}
                  {r.status !== 'FORMAL' && (
                    <button type="button" style={btn(true, formalise.isPending)} disabled={formalise.isPending}
                      onClick={() => formalise.mutate(r.id)}>
                      Confirm money
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
