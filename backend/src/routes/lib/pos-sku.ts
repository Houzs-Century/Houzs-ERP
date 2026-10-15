// ----------------------------------------------------------------------------
// pos-sku.ts — the furniture SKU master as the Houzs POS reads it (raw SQL
// over scm.mfg_products + scm.inventory_balances; the SKU master is not in the
// Drizzle schema). Shared by the POS Admin routes and the device bundle.
// ----------------------------------------------------------------------------
import { sql } from "drizzle-orm";
import type { getDb } from "../../db/client";

type Db = ReturnType<typeof getDb>;

export type SkuFact = {
  product_id: string;
  code: string;
  name: string;
  category: string | null;
  barcode: string | null;
  sell_price_sen: number | null;
  cost_price_sen: number | null;
  /** On hand across the company's warehouses, or at ONE warehouse when asked. */
  stock_qty: number;
};

const stockExpr = (warehouseId: string | null) =>
  warehouseId
    ? sql`COALESCE((SELECT SUM(b.qty) FROM scm.inventory_balances b WHERE b.item_code = p.code AND b.company_id = p.company_id AND b.warehouse_id::text = ${warehouseId}), 0)::float8`
    : sql`COALESCE((SELECT SUM(b.qty) FROM scm.inventory_balances b WHERE b.item_code = p.code AND b.company_id = p.company_id), 0)::float8`;

export async function skuFactsByIds(db: Db, companyId: number, productIds: string[], warehouseId: string | null = null): Promise<Map<string, SkuFact>> {
  const out = new Map<string, SkuFact>();
  if (productIds.length === 0) return out;
  const rows = await db.execute<SkuFact>(sql`
    SELECT p.id AS product_id, p.code, p.name, p.category::text AS category, p.barcode,
           COALESCE(p.sell_price_sen, p.price1_sen, p.base_price_sen) AS sell_price_sen,
           p.cost_price_sen,
           ${stockExpr(warehouseId)} AS stock_qty
      FROM scm.mfg_products p
     WHERE p.company_id = ${companyId} AND p.id IN ${productIds}`);
  for (const r of rows) out.set(r.product_id, { ...r, stock_qty: Number(r.stock_qty) });
  return out;
}

export async function skuSearch(db: Db, companyId: number, q: string, limit: number): Promise<SkuFact[]> {
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = await db.execute<SkuFact>(sql`
    SELECT p.id AS product_id, p.code, p.name, p.category::text AS category, p.barcode,
           COALESCE(p.sell_price_sen, p.price1_sen, p.base_price_sen) AS sell_price_sen,
           p.cost_price_sen,
           ${stockExpr(null)} AS stock_qty
      FROM scm.mfg_products p
     WHERE p.company_id = ${companyId} AND p.status = 'ACTIVE'
       AND (p.code ILIKE ${like} OR p.name ILIKE ${like} OR p.barcode = ${q})
     ORDER BY p.code
     LIMIT ${limit}`);
  return rows.map((r) => ({ ...r, stock_qty: Number(r.stock_qty) }));
}

export async function skuByCodes(db: Db, companyId: number, codes: string[]): Promise<Map<string, SkuFact>> {
  const out = new Map<string, SkuFact>();
  if (codes.length === 0) return out;
  const rows = await db.execute<SkuFact>(sql`
    SELECT p.id AS product_id, p.code, p.name, p.category::text AS category, p.barcode,
           COALESCE(p.sell_price_sen, p.price1_sen, p.base_price_sen) AS sell_price_sen, p.cost_price_sen, 0::float8 AS stock_qty
      FROM scm.mfg_products p
     WHERE p.company_id = ${companyId} AND upper(p.code) IN ${codes.map((x) => x.toUpperCase())}`);
  for (const r of rows) out.set(r.code.toUpperCase(), r);
  return out;
}
