/* Read the product categories from scm.acc_item_groups, the one list
   (shared/product-categories.ts says why). The registry is global: it has no
   company_id, like the enum it mirrors. THROWS on a read error, so a write is
   refused instead of being checked against an empty list. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProductCategory } from '../shared/product-categories';

type Row = { code: string | null; name: string | null; is_active: boolean | null };

export function toProductCategories(rows: readonly Row[]): ProductCategory[] {
  return rows
    .filter((r) => String(r.code ?? '').trim() !== '')
    .map((r) => {
      const code = String(r.code).trim().toUpperCase();
      return { code, name: String(r.name ?? '').trim() || code, isActive: r.is_active !== false };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProductCategories(supabase: SupabaseClient): Promise<ProductCategory[]> {
  const { data, error } = await supabase.from('acc_item_groups').select('code, name, is_active');
  if (error) throw new Error(`product_categories_load_failed: ${error.message ?? 'unknown'}`);
  return toProductCategories((data ?? []) as Row[]);
}
