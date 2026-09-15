/* Import SKUs result: a row that changed the category of a SKU on a model moved
   the model and every SKU of it (owner 2026-09-15), so the owner is told which
   model moved and how many SKUs went with it. */
import { mfgCategoryLabel } from '../../shared/product-categories';
import type { ImportModelMove } from '../lib/mfg-products-queries';

export function ImportModelsMoved({ moves }: { moves: ImportModelMove[] | undefined }) {
  if (!moves || moves.length === 0) return null;
  return (
    <div style={{ marginTop: 'var(--space-2)' }}>
      <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
        {moves.map((m) => (
          <li key={m.modelCode}>
            Model {m.modelCode}{m.modelName ? ` (${m.modelName})` : ''} moved
            {m.from ? ` from ${mfgCategoryLabel(m.from)}` : ''} to {mfgCategoryLabel(m.to)}, with
            its {m.skuCount} SKU{m.skuCount === 1 ? '' : 's'}.
          </li>
        ))}
      </ul>
      <p style={{ margin: 'var(--space-1) 0 0', color: '#767b6e' }}>
        Orders already written keep the old category; only new orders use the new one.
      </p>
    </div>
  );
}
