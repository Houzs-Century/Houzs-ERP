import { type CSSProperties, type ReactNode } from 'react';
import { MapPin, AlertTriangle } from 'lucide-react';
import { fmtSen } from '@2990s/shared';
import type { ProductCostAnchor } from '../../vendor/scm/lib/mfg-products-queries';

const fmtRmSen = (sen: number): string => fmtSen(sen);

/* Product Maintenance Cost — the anchor display (auto-derive stage 2b). Shows the
   SKU's derived cost, WHICH supplier it is anchored to, and the state:
     · ok       — anchored to <supplier>, "highest full set (N of M)".
     · conflict — amber "took highest" (suppliers differ).
     · empty    — red "Missing price — fix in Binding" (opens the supplier).
     · service  — "not supplier-derived".
   The cost figure is finance-gated server-side (costSen null when hidden). Editing
   the cost is not done here (owner ruling: cost derives from the supplier side);
   the CTA jumps to the supplier so the price can be fixed at its source. Lives in
   its own file so Products.tsx (at its size ceiling) does not grow. */
export const CostAnchorCard = ({
  anchor, onOpenSupplier, fallbackSupplierId,
}: {
  anchor: ProductCostAnchor;
  onOpenSupplier: (supplierId: string | null) => void;
  fallbackSupplierId: string | null;
}) => {
  const label = (
    <h3 style={{ fontSize: 'var(--fs-12)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#767b6e', marginBottom: 'var(--space-2)' }}>
      Product Maintenance Cost
    </h3>
  );
  const cardStyle: CSSProperties = {
    background: '#fff', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-3) var(--space-4)',
  };
  const pill = (fg: string, bg: string, text: string) => (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', fontWeight: 600,
      color: fg, background: bg, border: `1px solid ${fg}`, borderRadius: 'var(--radius-pill)', padding: '3px 10px',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }} />
      {text}
    </span>
  );
  const anchorBadge = (name: string | null) => (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-12)', fontWeight: 600,
      color: 'var(--c-burnt, #0c3f39)', background: 'var(--teal-soft, #e2efec)',
      border: '1px solid #16695f', borderRadius: 'var(--radius-sm)', padding: '2px 8px',
    }}>
      <MapPin size={12} strokeWidth={2} />{name ?? 'supplier'}
    </span>
  );
  const figure = (text: string, muted: boolean) => (
    <div>
      <div style={{ fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#767b6e' }}>
        Product Maintenance cost
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-24, 22px)', fontWeight: 600, color: muted ? 'var(--c-error, #b71c1c)' : undefined, fontVariantNumeric: 'tabular-nums' }}>
        {text}
      </div>
    </div>
  );
  const cta = (text: string, supplierId: string | null) => (
    <button
      type="button"
      onClick={() => onOpenSupplier(supplierId)}
      style={{
        fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--c-burnt, #0c3f39)',
        background: 'transparent', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-sm)',
        padding: '5px 11px', cursor: 'pointer',
      }}
    >
      {text}
    </button>
  );
  const top = (fig: ReactNode, state: ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
      {fig}{state}
    </div>
  );
  const line = (children: ReactNode) => (
    <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px dashed #d6d9d2', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', fontSize: 'var(--fs-13)', color: '#5d6357' }}>
      {children}
    </div>
  );
  const setLabel = anchor.totalCount > 1
    ? `highest full set (${anchor.costedCount} of ${anchor.totalCount})`
    : 'only supplier';

  if (anchor.state === 'service') {
    return (
      <section style={{ marginBottom: 'var(--space-5)' }}>
        {label}
        <div style={cardStyle}>
          {top(figure('—', false), pill('#5d6357', 'var(--bg-subtle, #eceeea)', 'Service item'))}
          {line(<span style={{ color: '#767b6e', fontSize: 'var(--fs-12)' }}>
            Service items are not priced from suppliers — cost is labour / freight, set separately.
          </span>)}
        </div>
      </section>
    );
  }
  if (anchor.state === 'empty') {
    const supplierId = fallbackSupplierId;
    const why = anchor.totalCount > 0
      ? 'A supplier is bound but its unit price is blank. Fix it in Binding — it opens the supplier so you fill the price; the cost then derives automatically.'
      : 'No supplier is bound yet. Add a supplier binding so the cost can derive.';
    return (
      <section style={{ marginBottom: 'var(--space-5)' }}>
        {label}
        <div style={cardStyle}>
          {top(figure('Empty', true), pill('var(--c-error, #b71c1c)', 'var(--c-error-bg, rgba(211,47,47,0.08))', 'Missing price · binding gap'))}
          {line(<>
            <AlertTriangle size={13} strokeWidth={2} style={{ color: 'var(--c-error, #b71c1c)' }} />
            <span style={{ color: '#767b6e', fontSize: 'var(--fs-12)' }}>{why}</span>
            {supplierId != null && cta('Fix in Binding', supplierId)}
          </>)}
        </div>
      </section>
    );
  }
  // ok | conflict
  const conflict = anchor.state === 'conflict';
  const figText = anchor.costSen != null ? fmtRmSen(anchor.costSen) : '—';
  return (
    <section style={{ marginBottom: 'var(--space-5)' }}>
      {label}
      <div style={cardStyle}>
        {top(
          figure(figText, false),
          conflict
            ? pill('var(--c-warn, #b76b00)', 'var(--c-warn-bg, rgba(255,193,7,0.16))', 'Suppliers differ · took highest')
            : pill('var(--c-success, #2f5d4f)', 'var(--c-success-bg, rgba(47,93,79,0.08))', 'Anchored'),
        )}
        {line(<>
          <span>Anchored to {anchorBadge(anchor.anchorSupplierName)}</span>
          <span style={{ color: '#767b6e', fontSize: 'var(--fs-12)' }}>{setLabel}</span>
          {conflict && cta('Review / fix', anchor.anchorSupplierId)}
        </>)}
      </div>
    </section>
  );
};
