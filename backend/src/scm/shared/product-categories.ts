/* The product categories and the ONE name a person sees for each.

   MFG_PRODUCT_CATEGORIES is the `mfg_product_category` PG enum in declaration
   order; the routes validate against it and the HR item-KPI picker reads it, so
   a screen can never offer a category the column cannot hold. Keep it in step
   with the enum if it ever gains a member.

   The labels live beside the list so every screen (SKU Master tabs, the Modular
   chips / select / grid, the category picker) says the same word. FABRIC_ACCESSORY
   reads "Sofa Accessory" (owner 2026-09-14); the code keeps no 'sofa' in it on
   purpose, because readers test a line group with includes('sofa').

   Mirrored byte-for-byte at frontend/src/vendor/shared/product-categories.ts. */
export const MFG_PRODUCT_CATEGORIES = ['SOFA', 'BEDFRAME', 'ACCESSORY', 'FABRIC_ACCESSORY', 'MATTRESS', 'BEDLINES', 'DINING', 'DIFFUSER', 'CARPET', 'SERVICE'] as const;

export type MfgProductCategory = (typeof MFG_PRODUCT_CATEGORIES)[number];

export const MFG_CATEGORY_LABELS: Readonly<Record<MfgProductCategory, string>> = {
  SOFA: 'Sofa',
  BEDFRAME: 'Bedframe',
  ACCESSORY: 'Accessory',
  FABRIC_ACCESSORY: 'Sofa Accessory',
  MATTRESS: 'Mattress',
  BEDLINES: 'Bedlines',
  DINING: 'Dining',
  DIFFUSER: 'Diffuser',
  CARPET: 'Carpet',
  SERVICE: 'Service',
};

export function isMfgProductCategory(c: string | null | undefined): c is MfgProductCategory {
  return (MFG_PRODUCT_CATEGORIES as readonly string[]).includes(String(c ?? ''));
}

/** A category's label; an unknown value is shown as it is stored. */
export function mfgCategoryLabel(c: string | null | undefined): string {
  const up = String(c ?? '').toUpperCase();
  return isMfgProductCategory(up) ? MFG_CATEGORY_LABELS[up] : String(c ?? '');
}

/* Read a category the way a person types it into a sheet: the stored code in
   any case ("fabric_accessory", "Sofa accessory" -> FABRIC_ACCESSORY) or its
   label. null for a blank cell or a value that is not a category, so an import
   can tell "left blank" from "typed something unrecognisable" instead of
   silently ignoring both. */
export function parseMfgCategory(input: string | null | undefined): MfgProductCategory | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const code = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (isMfgProductCategory(code)) return code;
  const asLabel = raw.toUpperCase().replace(/[\s_]+/g, ' ');
  return MFG_PRODUCT_CATEGORIES.find((c) => MFG_CATEGORY_LABELS[c].toUpperCase() === asLabel) ?? null;
}
