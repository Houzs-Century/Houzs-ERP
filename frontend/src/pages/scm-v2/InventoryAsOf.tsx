// ----------------------------------------------------------------------------
// InventoryAsOf — the 选日期 photograph (GL redesign item 5), in its OWN file
// because Inventory.tsx sits one line under its size ceiling.
//
// AsOfSection wraps the live product view: with no date it renders the date
// bar plus its children (the live planning list untouched); with a date it
// swaps the children for that day's photograph — per product, qty and value
// replayed on the BUSINESS date by GET /inventory/valuation (the same engine
// the month-end close reads, so the two can never disagree), with category
// subtotal chips and totals that are sums of exactly what is on screen.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { fmtSen, fmtQty } from '@2990s/shared';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { StatCard } from '../../components/StatCard';
import styles from './Inventory.module.css';

const STAT_GRID = 'grid grid-cols-2 md:grid-cols-4 gap-3';
const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };

type AsOfRow = { item_code: string; product_name: string | null; category: string | null; qty: number; value_sen: number };

/** Rows → per-category subtotal lines, largest value first. Exported for its
    test: the subtotals must always sum back to the grand total. */
export const categorySubtotals = (rows: AsOfRow[]): Array<{ category: string; qty: number; valueSen: number }> => {
  const at = new Map<string, { qty: number; valueSen: number }>();
  for (const r of rows) {
    const key = r.category ?? '(no category)';
    const cur = at.get(key) ?? { qty: 0, valueSen: 0 };
    cur.qty += r.qty;
    cur.valueSen += r.value_sen;
    at.set(key, cur);
  }
  return [...at.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.valueSen - a.valueSen);
};

export const AsOfSection = ({
  asOf, onChange, category, search, children,
}: {
  asOf: string;
  onChange: (v: string) => void;
  category: string;
  search: string;
  children: React.ReactNode;
}) => (
  <>
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
      <label htmlFor="inv-asof" style={soft}>As of date</label>
      <input id="inv-asof" type="date" value={asOf} onChange={(e) => onChange(e.target.value)}
        style={{ padding: '4px 8px', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 'var(--radius-sm, 6px)', fontSize: 'var(--fs-13)', background: 'white' }} />
      {asOf && (
        <button type="button" className={styles.chip} onClick={() => onChange('')}>Back to live</button>
      )}
    </div>
    {asOf ? <AsOfView asOf={asOf} category={category} search={search} /> : children}
  </>
);

const AsOfView = ({ asOf, category, search }: { asOf: string; category: string; search: string }) => {
  const q = useQuery({
    queryKey: ['inventory-valuation', asOf],
    queryFn: () => authedFetch<{ asOf: string; totalQty: number; totalValueSen: number; rows: AsOfRow[] }>(
      `/inventory/valuation?asOf=${encodeURIComponent(asOf)}`,
    ),
    staleTime: 60_000,
  });
  if (q.isLoading) return <div style={soft}>Replaying {asOf}…</div>;
  if (q.isError || !q.data) return <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The {asOf} snapshot did not load. Pick the date again to retry.</div>;

  const needle = search.trim().toLowerCase();
  const rows = q.data.rows
    .filter((r) => category === 'all' || r.category === category)
    .filter((r) => !needle || r.item_code.toLowerCase().includes(needle) || String(r.product_name ?? '').toLowerCase().includes(needle));
  const subtotals = categorySubtotals(rows);
  const shownQty = rows.reduce((s, r) => s + r.qty, 0);
  const shownValue = rows.reduce((s, r) => s + r.value_sen, 0);

  return (
    <>
      <div className={STAT_GRID}>
        <StatCard label={`Qty as of ${asOf}`} value={fmtQty(shownQty)} />
        <StatCard label={`Value as of ${asOf}`} value={fmtSen(shownValue)} />
        <StatCard label="Products" value={String(rows.length)} />
      </div>
      <div style={{ margin: 'var(--space-2) 0', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {subtotals.map((s) => (
          <span key={s.category} className={styles.chip} data-active={category === s.category}>
            {s.category}: {fmtQty(s.qty)} · {fmtSen(s.valueSen)}
          </span>
        ))}
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--c-line, rgba(34,31,32,0.12))', borderRadius: 'var(--radius-md)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Item</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Description</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Category</th>
              <th style={{ textAlign: 'right', padding: '8px 10px' }}>Qty</th>
              <th style={{ textAlign: 'right', padding: '8px 10px' }}>Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item_code} style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.item_code}</td>
                <td style={{ padding: '6px 10px' }}>{r.product_name ?? '—'}</td>
                <td style={{ padding: '6px 10px' }}>{r.category ?? '—'}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtQty(r.qty)}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtSen(r.value_sen)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '10px', ...soft }}>Nothing held on {asOf} under this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
};
