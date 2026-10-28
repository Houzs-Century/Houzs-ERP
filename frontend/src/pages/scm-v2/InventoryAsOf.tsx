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

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fmtSen, fmtQty } from '@2990s/shared';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { DateField } from '../../vendor/scm/components/DateField';
import { StatCard } from '../../components/StatCard';
import { DataTable, type Column } from '../../components/DataTable';
import styles from './Inventory.module.css';
import { mfgCategoryLabel } from '../../vendor/shared/product-categories';

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
      <DateField id="inv-asof" value={asOf} onChange={onChange} aria-label="As of date" />
      {asOf && (
        <button type="button" className={styles.chip} onClick={() => onChange('')}>Back to live</button>
      )}
    </div>
    {asOf ? <AsOfView asOf={asOf} category={category} search={search} /> : children}
  </>
);

const AS_OF_COLUMNS: Column<AsOfRow>[] = [
  { key: 'item', label: 'Item', render: (r) => r.item_code, getValue: (r) => r.item_code },
  { key: 'description', label: 'Description', render: (r) => r.product_name ?? '—', getValue: (r) => r.product_name ?? '' },
  { key: 'category', label: 'Category', render: (r) => mfgCategoryLabel(r.category) || '—', getValue: (r) => mfgCategoryLabel(r.category) || '' },
  { key: 'qty', label: 'Qty', align: 'right', render: (r) => fmtQty(r.qty), getValue: (r) => r.qty, exportFormat: 'number' },
  {
    key: 'value', label: 'Value', align: 'right', render: (r) => fmtSen(r.value_sen),
    getValue: (r) => r.value_sen, exportValue: (r) => r.value_sen / 100, exportFormat: 'money',
  },
];

const AsOfView = ({ asOf, category, search }: { asOf: string; category: string; search: string }) => {
  const q = useQuery({
    queryKey: ['inventory-valuation', asOf],
    queryFn: () => authedFetch<{ asOf: string; totalQty: number; totalValueSen: number; rows: AsOfRow[] }>(
      `/inventory/valuation?asOf=${encodeURIComponent(asOf)}`,
    ),
    staleTime: 60_000,
  });
  /* The rows the table shows after its own funnels: the cards and chips sum
     THOSE, so every figure on screen adds up to the list under it. */
  const [shown, setShown] = useState<AsOfRow[] | null>(null);
  if (q.isLoading) return <div style={soft}>Replaying {asOf}…</div>;
  if (q.isError || !q.data) return <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>The {asOf} snapshot did not load. Pick the date again to retry.</div>;

  const needle = search.trim().toLowerCase();
  const rows = q.data.rows
    .filter((r) => category === 'all' || r.category === category)
    .filter((r) => !needle || r.item_code.toLowerCase().includes(needle) || String(r.product_name ?? '').toLowerCase().includes(needle));
  const onScreen = shown ?? rows;
  const subtotals = categorySubtotals(onScreen);
  const shownQty = onScreen.reduce((s, r) => s + r.qty, 0);
  const shownValue = onScreen.reduce((s, r) => s + r.value_sen, 0);

  return (
    <>
      <div className={STAT_GRID}>
        <StatCard label={`Qty as of ${asOf}`} value={fmtQty(shownQty)} />
        <StatCard label={`Value as of ${asOf}`} value={fmtSen(shownValue)} />
        <StatCard label="Products" value={String(onScreen.length)} />
      </div>
      <div style={{ margin: 'var(--space-2) 0', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {subtotals.map((s) => (
          <span key={s.category} className={styles.chip} data-active={category === s.category}>
            {mfgCategoryLabel(s.category)}: {fmtQty(s.qty)} · {fmtSen(s.valueSen)}
          </span>
        ))}
      </div>
      <DataTable<AsOfRow>
        tableId="inventory-as-of"
        exportName={`inventory-as-of-${asOf}`}
        exportXlsx
        columns={AS_OF_COLUMNS}
        rows={rows}
        emptyLabel={`Nothing held on ${asOf} under this filter.`}
        getRowKey={(r) => r.item_code}
        onFilteredRowsChange={setShown}
      />
    </>
  );
};
