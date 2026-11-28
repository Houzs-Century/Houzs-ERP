import type { MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';

export const costMarker = (state?: MfgProductRow['costAnchorState']) => {
  const dot = (bg: string, title: string) => (
    <span title={title} style={{ marginLeft: 5, width: 7, height: 7, borderRadius: '50%', background: bg, display: 'inline-block', verticalAlign: 'middle' }} />
  );
  if (state === 'ok') return dot('var(--c-success, #2f5d4f)', 'Cost derived from supplier');
  if (state === 'conflict') return dot('var(--c-warn, #b76b00)', 'Suppliers differ — took the highest');
  if (state === 'empty') {
    return (
      <span title="No supplier cost — fix in Binding" style={{ marginLeft: 5, fontSize: '10px', fontWeight: 700, color: 'var(--c-error, var(--hz-dk-err, #b71c1c))', border: '1px solid var(--c-error, #b71c1c)', borderRadius: 4, padding: '0 4px', verticalAlign: 'middle' }}>Gap</span>
    );
  }
  return null;
};
