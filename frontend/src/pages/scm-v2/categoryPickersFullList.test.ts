/* HC-0258: screens typed their own 5-category lists, so every new product
   category (Sofa Accessory, Bedlines, Dining, Diffuser, Carpet) went missing from
   them one screen at a time. The one list is MFG_PRODUCT_CATEGORIES
   (vendor/shared/product-categories.ts); the backend refuses any other value.
   This fails on any new array literal that types 4+ category codes by hand. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const CODE = /['"](SOFA|BEDFRAME|MATTRESS|ACCESSORY|SERVICE)['"]/gi;

/* Lists that are NOT the product-category list, each with why. */
const ALLOWED: Record<string, string> = {
  // The one list itself.
  'vendor/shared/product-categories.ts#MFG_PRODUCT_CATEGORIES': 'the source',
  // Supplier type pool fallback (maintained in Products Maintenance), not a product category.
  'vendor/scm/lib/supplier-categories.ts#DEFAULT_SUPPLIER_CATEGORIES': 'supplier type',
  // SO list filter: the server's normCategory buckets, not product categories.
  'vendor/shared/so-list-filter-model.ts#SO_CATEGORY_CHOICES': 'SO list buckets',
  // Supplier type (its own column, includes MIXED), not a product category.
  'pages/scm-v2/SupplierDetail.tsx#SUPPLIER_CATEGORIES': 'supplier type',
  // SO branding buckets (fold every other category into OTHERS on purpose).
  'vendor/shared/so-branding-label.ts#normBuckets': 'branding buckets',
  // MRP's four fixed tabs + Others (owner ruling 2026-09-10, mrp-views.ts).
  'pages/scm-v2/mrp-views.ts#BASE': 'MRP tabs',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function handTypedLists(): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(SRC, file).replace(/\\/g, '/');
    // An array literal with no nested array, up to ~600 chars, named by what precedes it.
    for (const m of src.matchAll(/(\w+)\s*(?::[^=\n]*)?=?\s*:?\s*\[([^[\]]{0,600})\]/g)) {
      const codes = new Set([...m[2].matchAll(CODE)].map((x) => x[1].toUpperCase()));
      if (codes.size < 4) continue;
      const key = `${rel}#${m[1]}`;
      if (!(key in ALLOWED)) hits.push(key);
    }
  }
  return hits;
}

describe('product category lists', () => {
  it('are all built from MFG_PRODUCT_CATEGORIES, never typed by hand', () => {
    expect(handTypedLists()).toEqual([]);
  });
});
