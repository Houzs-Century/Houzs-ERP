/* Change a model's or a model-less SKU's category from the edit screens. Every
   category can move to any other one (owner 2026-09-15: 「每一个 category 我都可以
   换去不一样的 category」). The rule lives in shared/category-swap.ts; the server
   enforces it too and moves a model's SKUs with it. Asks first, because the move
   saves at once and orders already written keep their old category. */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../lib/authed-fetch';
import { categorySwapAllowed } from '../../shared/category-swap';
import { MFG_PRODUCT_CATEGORIES, mfgCategoryLabel } from '../../shared/product-categories';
import { useConfirm } from './ConfirmDialog';

export function CategorySwapSelect({ kind, id, category }: {
  kind: 'model' | 'sku';
  id: string;
  category: string;
}) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  // The edit dialogs hold a snapshot of the row, so the saved value is kept here.
  const [current, setCurrent] = useState(category.toUpperCase());
  const save = useMutation({
    mutationFn: (next: string) => authedFetch(`/${kind === 'model' ? 'product-models' : 'mfg-products'}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ category: next }),
    }),
    onSuccess: (_res, next) => {
      setError(null);
      setCurrent(next);
      void qc.invalidateQueries({ queryKey: ['product-models'] });
      void qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'The category was not changed.'),
  });
  const choose = async (next: string) => {
    if (!categorySwapAllowed(current, next)) return;
    const ok = await askConfirm({
      title: `Move to ${mfgCategoryLabel(next)}?`,
      body: `${kind === 'model' ? 'This model and all its SKUs move' : 'This SKU moves'} from ${mfgCategoryLabel(current)} to ${mfgCategoryLabel(next)} now. `
        + 'Orders already written keep the old category; only new orders use the new one.',
      confirmLabel: 'Move',
    });
    if (ok) save.mutate(next);
  };
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase', color: '#767b6e' }}>Category</span>
      <select
        aria-label="Category"
        value={current}
        disabled={save.isPending}
        onChange={(e) => void choose(e.target.value)}
      >
        {!MFG_PRODUCT_CATEGORIES.some((c) => c === current) && <option value={current}>{mfgCategoryLabel(current) || '(none)'}</option>}
        {MFG_PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{mfgCategoryLabel(c)}</option>)}
      </select>
      {error && <span role="alert" style={{ color: 'var(--color-err, #b3261e)', fontSize: 'var(--fs-12)' }}>{error}</span>}
    </label>
  );
}
