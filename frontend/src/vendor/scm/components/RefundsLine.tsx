/* RefundsLine — the SO side of a Customer Refund (payment-voucher.md §14,
   owner 2026-09-07: 主要是要有办法链接相关的订单资料). Under the payments
   table of a saved Sales Order: every refund voucher raised on it, with its
   number linking to the voucher, and the total refunded. Renders NOTHING
   when there is none — the line is a fact, not a feature to notice. Errors
   read as nothing too: the payments above are the money truth, a failed
   side-read must not stain them. */
import { useRefundSource } from '../lib/payment-voucher-queries';

const fmtRm = (sen: number): string =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function RefundsLine({ docNo }: { docNo: string }) {
  const q = useRefundSource('SO', docNo);
  const refunds = q.data?.source.refunds ?? [];
  if (q.isError || refunds.length === 0) return null;
  const totalSen = refunds.reduce((s, r) => s + r.totalSen, 0);
  const posted = refunds.filter((r) => r.status === 'POSTED');
  return (
    <div data-testid="refunds-line" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', padding: '6px 0' }}>
      <span style={{ fontWeight: 700 }}>Refunded {fmtRm(totalSen)}</span>
      {posted.length !== refunds.length && <span>({refunds.length - posted.length} not yet approved)</span>}
      {refunds.map((r) => (
        <a key={r.id} href={`/scm/payment-vouchers/${r.id}`} style={{ color: 'var(--c-orange)', fontFamily: 'var(--font-mono)' }}
          title={`${r.status} · ${r.voucherDate}`}>
          {r.pvNumber} · {fmtRm(r.totalSen)}{r.status === 'POSTED' ? '' : ` (${r.status.toLowerCase()})`}
        </a>
      ))}
    </div>
  );
}
