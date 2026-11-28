/* The product categories live in the database, not in code: scm.acc_item_groups
   (code, name, is_active) is the one list (HC-0258). Accounting -> Item groups
   -> create adds a category with no release: scm.acc_register_item_group adds
   the mfg_product_category enum value and the registry row in one step. The
   backend reads it with loadProductCategories (scm/lib/product-category-registry.ts),
   the screens with useProductCategories, both from the same rows.

   Every function here takes the list it was given, so nothing in code can name
   a category set again. FABRIC_ACCESSORY reads "Sofa Accessory" because that is
   its registry name; the code keeps no 'sofa' in it on purpose, because readers
   test a line group with includes('sofa').

   Mirrored byte-for-byte at frontend/src/vendor/shared/product-categories.ts. */
export type MfgProductCategory = string;

export interface ProductCategory {
  code: string;
  name: string;
  isActive: boolean;
}

/** The categories a picker offers: the registry's active rows. */
export function activeProductCategories(list: readonly ProductCategory[]): ProductCategory[] {
  return list.filter((r) => r.isActive);
}

/** Is it a registry code (active or not: a switched-off category still names its old rows)? */
export function isMfgProductCategory(list: readonly ProductCategory[], c: string | null | undefined): boolean {
  const code = String(c ?? '');
  return list.some((r) => r.code === code);
}

export function isSingleSkuCategory(c: string | null | undefined): boolean {
  const up = String(c ?? '').trim().toUpperCase();
  return up !== '' && up !== 'SOFA' && up !== 'BEDFRAME' && up !== 'MATTRESS';
}

/** A category's registry name; a code not in the list reads in Title Case ("NEW_GROUP" -> "New Group"). */
export function mfgCategoryLabel(list: readonly ProductCategory[], c: string | null | undefined): string {
  const raw = String(c ?? '');
  const row = list.find((r) => r.code === raw.toUpperCase());
  if (row) return row.name;
  if (!/^[A-Z][A-Z0-9_]*$/.test(raw)) return raw;
  return raw.toLowerCase().split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function parseMfgCategory(list: readonly ProductCategory[], input: string | null | undefined): MfgProductCategory | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const code = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (isMfgProductCategory(list, code)) return code;
  const asName = raw.toUpperCase().replace(/[\s_]+/g, ' ');
  return list.find((r) => r.name.toUpperCase().replace(/[\s_]+/g, ' ') === asName)?.code ?? null;
}
