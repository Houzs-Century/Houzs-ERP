import { useState, type ReactNode } from 'react';
import { fmtSen } from '@2990s/shared';
import {
  useMfgProductCostHistory,
  useMfgProductSupplierPriceHistory,
  useMfgProductPriceChanges,
} from '../../vendor/scm/lib/mfg-products-queries';

/* History — the three-tab block on the SKU drawer (approved mockup):
     · Cost (anchor)  — the derived product cost over time + which supplier anchored it.
     · Selling        — the scheduled selling-price timeline (reuses /price-changes).
     · Supplier price — every supplier's cost change, with a raised/lowered arrow.
   Cost / supplier money is finance-gated server-side (null -> "hidden"). Rows arrive
   newest-first from the backend. Own file so Products.tsx stays under its ceiling. */

type Tab = 'cost' | 'selling' | 'supplier';

const H3: React.CSSProperties = {
  fontSize: 'var(--fs-12)', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.06em', color: '#767b6e', marginBottom: 'var(--space-2)',
};
const muted: React.CSSProperties = { color: '#767b6e', fontSize: 'var(--fs-13)' };
const dateStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', color: '#767b6e' };

function tabButton(active: boolean): React.CSSProperties {
  return {
    fontSize: 'var(--fs-12)', fontWeight: 600, cursor: 'pointer',
    borderRadius: 'var(--radius-sm)', padding: '4px 10px',
    border: `1px solid ${active ? '#16695f' : '#c2c6bd'}`,
    background: active ? '#16695f' : '#fff',
    color: active ? '#fff' : '#3a3f36',
  };
}

function Row({ date, main, meta }: { date: string; main: ReactNode; meta?: ReactNode }) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid #e3e6e0' }}>
      <div style={dateStyle}>{date}</div>
      <div style={{ fontSize: 'var(--fs-13)', color: '#2b2f28', marginTop: 1 }}>{main}</div>
      {meta != null && <div style={{ fontSize: 'var(--fs-12)', color: '#767b6e', marginTop: 1 }}>{meta}</div>}
    </div>
  );
}

function DirChip({ direction }: { direction: 'up' | 'down' | null }) {
  if (direction === 'up') {
    return <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', fontWeight: 700, color: 'var(--c-error, #b71c1c)' }}>↑ raised</span>;
  }
  if (direction === 'down') {
    return <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', fontWeight: 700, color: 'var(--c-success, #2f5d4f)' }}>↓ lowered</span>;
  }
  return null;
}

const money = (sen: number | null): string => (sen == null ? 'hidden' : fmtSen(sen));

export const SkuHistoryTabs = ({ productId }: { productId: string }) => {
  const [tab, setTab] = useState<Tab>('cost');
  const cost = useMfgProductCostHistory(tab === 'cost' ? productId : null);
  const supplier = useMfgProductSupplierPriceHistory(tab === 'supplier' ? productId : null);
  const selling = useMfgProductPriceChanges(tab === 'selling' ? productId : null);

  const empty = (text: string) => <p style={muted}>{text}</p>;

  return (
    <section style={{ marginBottom: 'var(--space-5)' }}>
      <h3 style={H3}>History</h3>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <button type="button" style={tabButton(tab === 'cost')} onClick={() => setTab('cost')} aria-pressed={tab === 'cost'}>Cost (anchor)</button>
        <button type="button" style={tabButton(tab === 'selling')} onClick={() => setTab('selling')} aria-pressed={tab === 'selling'}>Selling</button>
        <button type="button" style={tabButton(tab === 'supplier')} onClick={() => setTab('supplier')} aria-pressed={tab === 'supplier'}>Supplier price</button>
      </div>

      {tab === 'cost' && (
        cost.isLoading ? empty('Loading cost history…')
          : (cost.data?.history.length ?? 0) === 0 ? empty('No cost changes recorded yet.')
            : <div>{cost.data!.history.map((r) => (
                <Row
                  key={r.id}
                  date={r.effectiveFrom}
                  main={<>Anchored cost <b style={{ fontFamily: 'var(--font-mono)' }}>{money(r.basePriceSen)}</b></>}
                  meta={r.sourceSupplierName ? `From ${r.sourceSupplierName}${r.notes ? ` · ${r.notes}` : ''}` : (r.notes || undefined)}
                />
              ))}</div>
      )}

      {tab === 'selling' && (
        selling.isLoading ? empty('Loading selling history…')
          : (selling.data?.history.length ?? 0) === 0 ? empty('No scheduled selling prices yet.')
            : <div>{selling.data!.history.map((r) => (
                <Row
                  key={r.id}
                  date={r.effective_from}
                  main={<>Selling <b style={{ fontFamily: 'var(--font-mono)' }}>{fmtSen(r.sell_price_sen)}</b></>}
                  meta={[r.created_by || null, r.notes || null].filter(Boolean).join(' · ') || undefined}
                />
              ))}</div>
      )}

      {tab === 'supplier' && (
        supplier.isLoading ? empty('Loading supplier price history…')
          : (supplier.data?.history.length ?? 0) === 0 ? empty('No supplier price changes recorded yet.')
            : <div>{supplier.data!.history.map((r) => (
                <Row
                  key={r.id}
                  date={r.effectiveFrom}
                  main={<>
                    {r.supplierName ?? r.supplierCode ?? 'Supplier'}{' '}
                    <b style={{ fontFamily: 'var(--font-mono)' }}>{money(r.unitPriceSen ?? r.comparableSen)}</b>
                    <DirChip direction={r.direction} />
                  </>}
                  meta={[r.isMainSupplier ? 'main supplier' : null, r.notes || null].filter(Boolean).join(' · ') || undefined}
                />
              ))}</div>
      )}
    </section>
  );
};
