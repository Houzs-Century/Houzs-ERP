/* CancelledWithMoneyCard — Finance's list: every cancelled order still holding
   money, with what is left on it (owner 2026-09-15; docs/bugs/0931). Money
   on a cancelled order has two exits — refund or convert — and until one is
   taken the customer's money sits with nobody chasing it. On the Self-check
   tab, where the other "money the books are not done with" cards live. Each
   row opens the order, whose money panel carries the two buttons. */
import { useCancelledWithMoney } from '../../vendor/scm/lib/so-money-queries';
import { fmtSen } from '../../vendor/shared/format';
import styles from './Suppliers.module.css';

export const CancelledWithMoneyCard = () => {
  const q = useCancelledWithMoney(null);
  const rows = q.data?.orders ?? [];
  const good = 'var(--c-secondary-a, #2F5D4F)';
  const warn = 'var(--c-burnt, #B8331F)';
  const tone = q.isError ? 'var(--c-ink)' : rows.length === 0 ? good : warn;
  return (
    <section data-testid="cancelled-with-money" style={{ padding: 'var(--space-3) var(--space-4)', border: `1px solid ${tone}`, borderRadius: 'var(--radius-md)', background: 'var(--c-cream)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <strong>Cancelled orders still holding money</strong>
        <span style={{ fontSize: 'var(--fs-13)', color: tone, fontWeight: 700 }}>
          {q.isError ? 'not checked — the read failed' : q.isLoading ? 'checking…' : rows.length === 0 ? 'none' : `${rows.length} · ${fmtSen(q.data?.totalRemainingSen ?? 0)}`}
        </span>
      </div>
      <div className={styles.subtitle} style={{ marginTop: 2 }}>
        Money paid on an order that was later cancelled, not yet refunded or moved to a new order. Open the order: its money panel has Refund and Convert side by side.
      </div>
      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)', marginTop: 8 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Order</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Customer</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Paid</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.docNo}>
                <td style={{ padding: '4px 8px' }}><a href={`/scm/sales-orders/${encodeURIComponent(r.docNo)}`} className={styles.codeChip}>{r.docNo}</a></td>
                <td style={{ padding: '4px 8px' }}>{r.customer ?? '—'}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtSen(r.bookedSen)}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtSen(r.remainingSen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};
