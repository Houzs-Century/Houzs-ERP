/* Change a model's or a model-less SKU's category between Accessory and Sofa
   Accessory from the edit screens (owner 2026-09-14: 「我不能自己更换category吗？」).
   The rule lives in shared/category-swap.ts; the server enforces it too and
   moves a model's SKUs with it. Renders nothing for any other category. */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../lib/authed-fetch';
import { SWAPPABLE_CATEGORIES } from '../../shared/category-swap';
import { mfgCategoryLabel } from '../lib/mfg-products-queries';

export function CategorySwapSelect({ kind, id, category }: {
  kind: 'model' | 'sku';
  id: string;
  category: string;
}) {
  const qc = useQueryClient();
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
  if (!SWAPPABLE_CATEGORIES.includes(current)) return null;
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase', color: '#767b6e' }}>Category</span>
      <select
        aria-label="Category"
        value={current}
        disabled={save.isPending}
        onChange={(e) => save.mutate(e.target.value)}
      >
        {SWAPPABLE_CATEGORIES.map((c) => <option key={c} value={c}>{mfgCategoryLabel(c)}</option>)}
      </select>
      {error && <span role="alert" style={{ color: 'var(--color-err, #b3261e)', fontSize: 'var(--fs-12)' }}>{error}</span>}
    </label>
  );
}
