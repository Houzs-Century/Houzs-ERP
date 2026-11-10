/* ----------------------------------------------------------------------------
   stock-bucket-key — the variant_key a stock writer puts on a movement.

   Two decisions the line itself must not make (PR #5609 follow-up):
     1. CATEGORY IS THE SKU'S. The key's identity fields depend on the category,
        and the line's item_group is a client's recollection of it (SoLineCard
        rewrites it on open). The product master answers; the line's group is
        only a fallback when the code is not a product.
     2. A CANONICALLY EQUAL BUCKET WINS. The FIFO trigger
        (fn_inventory_movement_fifo / fn_consume_fifo) matches variant_key as an
        exact string. Existing buckets keep the strings they were written with
        (`...|totalheight=24"`, `legheight=default`); they are re-keyed by the
        separate repair, not here. So a new movement whose key is canonically
        equal to a stocked bucket carries THAT bucket's string
        (shared/variant-key.ts pickStockBucketKey), and its OUT consumes the
        goods that are actually there.

   ONLY FOR A VARIANT-TRACKED COMPANY (binding-mode.ts). Company 1 binds lines
   to their PO and does not pick stock by spec (owner 2026-11-10), so for it
   every helper here returns exactly what the writer computed before this file:
   `computeVariantKey(line.item_group, line.variants)`, no product read, no
   bucket lookup, no own-bucket remap, no resync fold.

   The key itself is unchanged (`computeVariantKey`); only the CHOICE between
   it and an existing canonically equal string is new.

   Fail-soft on both reads: a failed product read falls back to the line's group,
   a failed balance read writes the computed key — the behaviour before this file.
   Neither may stop a document posting. Both reads are company-scoped.
   -------------------------------------------------------------------------- */
import { canonicalVariantKey, computeVariantKey, pickStockBucketKey, type VariantAttrs } from '../shared/variant-key';
import { chunkIn } from './paginate-all';
import { pgrestIn } from './pgrest-in-list';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { variantTrackedCompany } from './binding-mode';

export type StockKeyLine = {
  item_code: string | null;
  item_group: string | null;
  variants: unknown;
  /** The warehouse the movement lands in. Null = no bucket lookup (computed key only). */
  warehouse_id: string | null;
};

export type BucketRow = { warehouse_id: string; item_code: string; variant_key: string | null; qty: number };

/** Pure: the key for one line, given the SKU categories and the existing buckets. */
export function stockBucketKeyFor(
  line: StockKeyLine,
  categoryByCode: ReadonlyMap<string, string>,
  bucketsByWhItem: ReadonlyMap<string, ReadonlyArray<{ variantKey: string | null; qty: number }>>,
): string {
  const code = String(line.item_code ?? '').trim();
  const group = categoryByCode.get(code) ?? line.item_group ?? null;
  const wanted = computeVariantKey(group, (line.variants ?? null) as VariantAttrs | null);
  if (!line.warehouse_id) return wanted;
  return pickStockBucketKey(wanted, bucketsByWhItem.get(`${line.warehouse_id}::${code}`) ?? []);
}

/** Pure: group balance rows by `warehouse::item_code`. */
export function groupBuckets(rows: readonly BucketRow[]): Map<string, Array<{ variantKey: string | null; qty: number }>> {
  const out = new Map<string, Array<{ variantKey: string | null; qty: number }>>();
  for (const r of rows) {
    const k = `${r.warehouse_id}::${r.item_code}`;
    const list = out.get(k) ?? [];
    list.push({ variantKey: r.variant_key ?? '', qty: Number(r.qty) });
    out.set(k, list);
  }
  return out;
}

/** `item_code -> category` (lowercased) from the product master, company-scoped. Fail-soft. */
export async function productCategoryMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  codes: readonly string[],
  companyId: number | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (list.length === 0) return out;
  try {
    const { data, error } = await chunkIn<{ code: string; category: string | null }>(list, (batch, from, to) =>
      scopeToCompanyIdOrOpen(pgrestIn(sb.from('mfg_products').select('code, category'), 'code', batch), companyId)
        .range(from, to));
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[stock-bucket-key] product read failed - lines keep their own group:', error.message);
      return out;
    }
    for (const r of data) {
      const cat = String(r.category ?? '').trim().toLowerCase();
      if (cat) out.set(r.code, cat);
    }
  } catch { /* fail-soft, see header */ }
  return out;
}

/** Existing buckets for these items in these warehouses, company-scoped. Fail-soft. */
export async function loadBuckets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  codes: readonly string[],
  warehouseIds: readonly string[],
  companyId: number | null,
): Promise<BucketRow[]> {
  const list = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  const whs = [...new Set(warehouseIds.filter(Boolean))];
  if (list.length === 0 || whs.length === 0) return [];
  try {
    const { data, error } = await chunkIn<BucketRow>(list, (batch, from, to) =>
      scopeToCompanyIdOrOpen(
        pgrestIn(pgrestIn(sb.from('inventory_balances').select('warehouse_id, item_code, variant_key, qty'), 'item_code', batch), 'warehouse_id', whs),
        companyId,
      ).range(from, to));
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[stock-bucket-key] balance read failed - writing computed keys:', error.message);
      return [];
    }
    return data;
  } catch {
    return [];
  }
}

/**
 * The whole rule as one call: `const keyOf = await stockBucketKeyResolver(sb, co, lines)`,
 * then `keyOf(line)` for each of those lines (any line with the same code and warehouse works).
 */
export async function stockBucketKeyResolver(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  companyId: number | null,
  lines: readonly StockKeyLine[],
): Promise<(line: StockKeyLine) => string> {
  if (!variantTrackedCompany(companyId)) {
    return (line) => computeVariantKey(line.item_group, (line.variants ?? null) as VariantAttrs | null);
  }
  const codes = lines.map((l) => String(l.item_code ?? ''));
  const whs = lines.map((l) => l.warehouse_id).filter((w): w is string => !!w);
  const [cats, rows] = await Promise.all([
    productCategoryMap(sb, codes, companyId),
    loadBuckets(sb, codes, whs, companyId),
  ]);
  const buckets = groupBuckets(rows);
  return (line) => stockBucketKeyFor(line, cats, buckets);
}

/**
 * A document's OWN earlier movements, by canonical key: `item_code::canonical`
 * -> the stored variant_key string. A reversal (cancel, line delete, a variant
 * edit's take-back) must hit exactly the bucket the document moved, even when
 * that bucket was written under an older spelling of the same spec.
 */
export function ownBucketKeyMap(rows: ReadonlyArray<{ item_code: string; variant_key: string | null }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) out.set(`${r.item_code}::${canonicalVariantKey(r.variant_key)}`, r.variant_key ?? '');
  return out;
}

/** The stored key of the document's own bucket for this line, else the computed key. */
export function ownBucketKey(own: ReadonlyMap<string, string> | null, itemCode: string, computed: string): string {
  return own?.get(`${itemCode}::${canonicalVariantKey(computed)}`) ?? computed;
}

/** Read a document's movements of one type and build `ownBucketKeyMap`. Null when unreadable. */
export async function loadOwnBucketKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  sourceDocType: string,
  sourceDocId: string,
  movementType: 'IN' | 'OUT',
  companyId: number | null,
): Promise<Map<string, string> | null> {
  if (!variantTrackedCompany(companyId)) return null;
  const { data, error } = await scopeToCompanyIdOrOpen(sb.from('inventory_movements')
    .select('item_code, variant_key')
    .eq('source_doc_type', sourceDocType)
    .eq('source_doc_id', sourceDocId)
    .eq('movement_type', movementType), companyId);
  if (error) return null;
  return ownBucketKeyMap((data ?? []) as Array<{ item_code: string; variant_key: string | null }>);
}

/**
 * Resync helper: a target bucket (`warehouse::item::variant::batch`) that is
 * canonically equal to a bucket the document ALREADY moved stock in IS that
 * bucket. Without this, the first edit after a key-format change would take the
 * units back out of the old spelling and book them again under the new one.
 * Mutates and returns `targets`; each moved entry gets the stored variant_key.
 */
export function foldTargetsIntoOwnBuckets<T extends { variant_key: string; qty: number }>(
  targets: Map<string, T>,
  ownKeys: Iterable<string>,
  companyId: number | null,
): Map<string, T> {
  if (!variantTrackedCompany(companyId)) return targets;
  const own = [...ownKeys];
  for (const [tk, t] of [...targets.entries()]) {
    if (own.includes(tk)) continue;
    const [twh = '', tcode = '', tvk = '', tbatch = ''] = tk.split('::');
    const match = own.find((ak) => {
      const [wh = '', code = '', vk = '', batch = ''] = ak.split('::');
      return wh === twh && code === tcode && batch === tbatch && canonicalVariantKey(vk) === canonicalVariantKey(tvk);
    });
    if (!match) continue;
    targets.delete(tk);
    const merged = targets.get(match);
    if (merged) merged.qty += t.qty;
    else targets.set(match, { ...t, variant_key: match.split('::')[2] ?? '' });
  }
  return targets;
}

/**
 * Stock adjustment / stock-take lines carry their key already (explicit, or
 * derived from the attributes by the parser). Each INCREASE is re-pointed in
 * place: a derived key is recomputed from the SKU's category, and either way a
 * canonically equal stocked bucket's string wins. Decreases name the bucket they
 * picked and are left alone.
 */
export async function resolveIncreaseKeys<L extends { item_code: string; item_group: string | null; variants: unknown; variant_key: string; qty: number }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  companyId: number | null,
  warehouseId: string,
  lines: L[],
): Promise<L[]> {
  if (!variantTrackedCompany(companyId)) return lines;
  const ups = lines.filter((l) => l.qty > 0);
  if (ups.length === 0) return lines;
  const codes = ups.map((l) => l.item_code);
  const [cats, rows] = await Promise.all([
    productCategoryMap(sb, codes, companyId),
    loadBuckets(sb, codes, [warehouseId], companyId),
  ]);
  const buckets = groupBuckets(rows);
  for (const l of ups) {
    const derived = l.variant_key === computeVariantKey(l.item_group, (l.variants ?? null) as VariantAttrs | null);
    l.variant_key = derived
      ? stockBucketKeyFor({ item_code: l.item_code, item_group: l.item_group, variants: l.variants, warehouse_id: warehouseId }, cats, buckets)
      : pickStockBucketKey(l.variant_key, buckets.get(`${warehouseId}::${l.item_code}`) ?? []);
  }
  return lines;
}

/** One line's write key (same rule as stockBucketKeyResolver). */
export async function stockBucketKeyOne(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  companyId: number | null,
  line: StockKeyLine,
): Promise<string> {
  return (await stockBucketKeyResolver(sb, companyId, [line]))(line);
}

/** The document's own stored bucket for this line (variant-tracked company), else `computed`. */
export async function ownDocBucketKey(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  doc: { type: string; id: string; movement: 'IN' | 'OUT'; companyId: number | null },
  itemCode: string,
  computed: string,
): Promise<string> {
  return ownBucketKey(await loadOwnBucketKeys(sb, doc.type, doc.id, doc.movement, doc.companyId), itemCode, computed);
}

/** Bucket equality for the company: canonical when variant-tracked, exact string otherwise. */
export function sameBucketFor(companyId: number | null, a: string, b: string): boolean {
  return variantTrackedCompany(companyId) ? canonicalVariantKey(a) === canonicalVariantKey(b) : a === b;
}

/** ownBucketKeyMap for a variant-tracked company; null (no remap) otherwise. */
export function ownBucketKeyMapFor(
  companyId: number | null,
  rows: ReadonlyArray<{ item_code: string; variant_key: string | null }>,
): Map<string, string> | null {
  return variantTrackedCompany(companyId) ? ownBucketKeyMap(rows) : null;
}

/** A stored line row (snake_case) as a StockKeyLine for this warehouse. */
export function stockKeyLine(
  row: { item_code: string; item_group?: string | null; variants?: unknown },
  warehouseId: string | null,
): StockKeyLine {
  return { item_code: row.item_code, item_group: row.item_group ?? null, variants: row.variants ?? null, warehouse_id: warehouseId };
}

/** A stored key in the form buckets are compared in for this company. */
export function bucketIdFor(companyId: number | null, vk: string | null): string {
  return variantTrackedCompany(companyId) ? canonicalVariantKey(vk) : (vk ?? '');
}
