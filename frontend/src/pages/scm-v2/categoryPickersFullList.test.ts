/* HC-0258: screens typed their own 5-category lists, so every new product
   category (Sofa Accessory, Bedlines, Dining, Diffuser, Carpet) went missing from
   them one screen at a time. The one list is the database: scm.acc_item_groups,
   read by the backend (loadProductCategories) and by every screen
   (useProductCategories). Nothing in code lists the categories. This fails on
   any array literal, frontend or backend, that types 4+ category codes. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const BACKEND_SRC = join(__dirname, '..', '..', '..', '..', 'backend', 'src');
const CODE = /['"](SOFA|BEDFRAME|MATTRESS|ACCESSORY|SERVICE)['"]/gi;

const ALLOWED: Record<string, string> = {
  'vendor/scm/lib/supplier-categories.ts#DEFAULT_SUPPLIER_CATEGORIES': 'supplier type',
  'vendor/shared/so-list-filter-model.ts#SO_CATEGORY_CHOICES': 'SO list buckets',
  'pages/scm-v2/SupplierDetail.tsx#SUPPLIER_CATEGORIES': 'supplier type',
  'vendor/shared/so-branding-label.ts#normBuckets': 'branding buckets',
  'backend/scm/shared/so-branding-label.ts#normBuckets': 'branding buckets',
  // MRP's four fixed tabs + Others (owner ruling 2026-09-10, mrp-views.ts).
  'pages/scm-v2/mrp-views.ts#BASE': 'MRP tabs',
  'backend/scm/shared/so-list-filter-model.ts#SO_CATEGORY_CHOICES': 'SO list buckets',
  'backend/acc/performance-pnl.ts#PERFORMANCE_GROUPS': 'P&L groups',
  'backend/scm/lib/procurement-overview.ts#PROCUREMENT_CATEGORIES': 'procurement sheet groups',
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
  for (const file of [...walk(SRC), ...walk(BACKEND_SRC)]) {
    const src = readFileSync(file, 'utf8');
    const rel = (file.startsWith(BACKEND_SRC) ? `backend/${relative(BACKEND_SRC, file)}` : relative(SRC, file)).replace(/\\/g, '/');
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
  it('are all read from the registry, never typed by hand', () => {
    expect(handTypedLists()).toEqual([]);
  }, 60_000);
});
