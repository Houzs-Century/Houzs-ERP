import type { Env } from "../types";
import { AutoCountClient } from "./autocount";
import { writeLog } from "./logger";
import { orderSupplierCode } from "./assrOrderPos";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";

/**
 * Local cache layer over AutoCount /StockItem/getSingle.
 *
 * Why cache: the item → creditor link (`MainSupplier`) is read every
 * time a service case is opened, listed, or grouped. Hitting AutoCount
 * for every row is slow and flaky. We pull once, store in `stock_items`,
 * and rely on the refresh endpoint (or the nightly cron if we add one)
 * to keep it fresh.
 *
 * `resolveCreditorForCase` writes `creditor_code` onto a case from its
 * PO / SO supplier (HC-0130); it no longer reads `main_supplier`.
 */

export interface StockItemRow {
  item_code: string;
  main_supplier: string | null;
  description: string | null;
  desc2: string | null;
  item_group: string | null;
  is_active: number;
  cost: number | null;
  price: number | null;
  last_modified: string | null;
  fetched_at: string;
  raw: string | null;
}

const INSERT_SQL = `INSERT INTO stock_items (
  item_code, auto_key, doc_key, description, desc2,
  item_group, item_type, item_brand, item_class, item_category,
  base_uom, sales_uom, purchase_uom,
  main_supplier, is_active, is_sales_item, is_purchase_item,
  lead_time, cost, price, tax_code, purchase_tax_code,
  barcode2, cost_code, last_modified, raw, fetched_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
ON CONFLICT(item_code) DO UPDATE SET
  auto_key = excluded.auto_key,
  doc_key = excluded.doc_key,
  description = excluded.description,
  desc2 = excluded.desc2,
  item_group = excluded.item_group,
  item_type = excluded.item_type,
  item_brand = excluded.item_brand,
  item_class = excluded.item_class,
  item_category = excluded.item_category,
  base_uom = excluded.base_uom,
  sales_uom = excluded.sales_uom,
  purchase_uom = excluded.purchase_uom,
  main_supplier = excluded.main_supplier,
  is_active = excluded.is_active,
  is_sales_item = excluded.is_sales_item,
  is_purchase_item = excluded.is_purchase_item,
  lead_time = excluded.lead_time,
  cost = excluded.cost,
  price = excluded.price,
  tax_code = excluded.tax_code,
  purchase_tax_code = excluded.purchase_tax_code,
  barcode2 = excluded.barcode2,
  cost_code = excluded.cost_code,
  last_modified = excluded.last_modified,
  raw = excluded.raw,
  fetched_at = datetime('now'),
  updated_at = datetime('now')`;

function bool01(v: unknown): number {
  return v === true || v === 1 || String(v).toUpperCase() === "T" || String(v).toLowerCase() === "true"
    ? 1
    : 0;
}

async function upsertStockItem(env: Env, o: Record<string, any>): Promise<void> {
  await env.DB.prepare(INSERT_SQL)
    .bind(
      o.ItemCode,
      o.AutoKey ?? null,
      o.DocKey ?? null,
      o.Description ?? null,
      o.Desc2 ?? null,
      o.ItemGroup ?? null,
      o.ItemType ?? null,
      o.ItemBrand ?? null,
      o.ItemClass ?? null,
      o.ItemCategory ?? null,
      o.BaseUOM ?? null,
      o.SalesUOM ?? null,
      o.PurchaseUOM ?? null,
      o.MainSupplier ?? null,
      bool01(o.IsActive),
      bool01(o.IsSalesItem),
      bool01(o.IsPurchaseItem),
      typeof o.LeadTimeDay === "number" ? o.LeadTimeDay : (typeof o.LeadTime === "number" ? o.LeadTime : null),
      typeof o.Cost === "number" ? o.Cost : null,
      typeof o.Price === "number" ? o.Price : null,
      o.TaxCode ?? null,
      o.PurchaseTaxCode ?? null,
      o.UDF_Barcode2 ?? null,
      o.UDF_CostCode ?? null,
      o.LastModified ?? null,
      JSON.stringify(o)
    )
    .run();
}

/**
 * Read-through cache. Returns the cached row when it exists and is
 * younger than maxAgeHours; otherwise calls AutoCount, upserts, and
 * returns the fresh row. Returns null if AutoCount doesn't know the
 * item — caller treats that as "creditor unknown".
 */
export async function getStockItemCached(
  env: Env,
  itemCode: string,
  opts: { maxAgeHours?: number } = {}
): Promise<StockItemRow | null> {
  if (!itemCode) return null;
  const maxAgeHours = opts.maxAgeHours ?? 24;

  const cached = await env.DB.prepare(
    `SELECT * FROM stock_items
      WHERE item_code = ?
        AND fetched_at > to_char(timezone('UTC', now()) - (?::text || ' hours')::interval, 'YYYY-MM-DD HH24:MI:SS')
      LIMIT 1`
  )
    .bind(itemCode, maxAgeHours)
    .first<StockItemRow>();
  if (cached) return cached;

  // Miss or stale — pull fresh. Failures bubble; caller may swallow.
  const client = new AutoCountClient(env);
  const fresh = await client.getStockItem(itemCode);
  if (!fresh) return null;
  await upsertStockItem(env, fresh);

  return (await env.DB.prepare(
    `SELECT * FROM stock_items WHERE item_code = ? LIMIT 1`
  )
    .bind(itemCode)
    .first<StockItemRow>()) ?? null;
}

/**
 * Resolves the creditor for a single case by looking up its item_code
 * in the stock_items cache (fetching if needed) and writing the
 * resulting `main_supplier` into `assr_cases.creditor_code`. Logs an
 * activity row on change so the case's audit trail shows it.
 *
 * Called from `createAssrCase` (fire-and-forget — a failed resolve
 * must not block case creation) and from `patchAssrCase` when the
 * item_code changes.
 *
 * Manual picks win: a case with creditor_source='manual' is left alone.
 * HC-0130: PO supplier ('po'), else the SO item's bound supplier ('so'),
 * else blank. "Resolve now" passes force=true to hand the link back to
 * the auto path.
 */
export async function resolveCreditorForCase(
  env: Env,
  caseId: number,
  itemCode: string | null | undefined,
  opts: { force?: boolean } = {}
): Promise<{ code: string | null; soMissing: boolean }> {
  if (!itemCode) return { code: null, soMissing: false };

  const existing = await env.DB.prepare(
    `SELECT * FROM assr_cases WHERE id = ? LIMIT 1` // company_id is absent from the D1 test schema
  )
    .bind(caseId)
    .first<{ creditor_code: string | null; creditor_source: string | null; doc_no: string | null; company_id?: number | string | null }>();
  if (!existing) return { code: null, soMissing: false }; // case was deleted
  if (existing.creditor_source === "manual" && !opts.force) {
    return { code: existing.creditor_code, soMissing: false };
  }

  // HC-0130 (Farra's rule): the item's PO supplier, else the SO item's bound
  // supplier, else blank for Service Team. AutoCount's MainSupplier is not used.
  // An SO that is not in the ERP (old AutoCount-only orders) keeps whatever the
  // case has: there is nothing to resolve from, so blanking it would lose data.
  const fromOrder = isSupabaseConfigured(env)
    ? await orderSupplierCode(getSupabaseService(env), existing.doc_no, itemCode, Number(existing.company_id))
    : null;
  if (fromOrder === "so-missing") return { code: existing.creditor_code, soMissing: true };
  const creditorCode: string | null = fromOrder?.code ?? null;
  const source: string | null = fromOrder?.source ?? null;

  const same = (existing.creditor_code ?? null) === (creditorCode ?? null);
  // Same value AND same owner (po/so/blank) → nothing to do. When force
  // re-resolves a manual row to the same code, still fall through so
  // ownership flips back to po/so.
  if (same && existing.creditor_source === source) return { code: creditorCode, soMissing: false };

  await env.DB.prepare(
    `UPDATE assr_cases SET creditor_code = ?, creditor_source = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(creditorCode, source, caseId)
    .run();

  if (!same) {
    // Activity trail — mirrors other auto-resolved transitions.
    await env.DB.prepare(
      `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id, category)
       VALUES (?, 'creditor_resolved', ?, ?, ?, NULL, 'supplier')`
    )
      .bind(
        caseId,
        existing.creditor_code ?? null,
        creditorCode,
        source === "po" ? `Auto-resolved from the PO of item ${itemCode}`
          : source === "so" ? `Auto-resolved from the SO supplier of item ${itemCode}`
          : `No PO or SO supplier found for item ${itemCode}`
      )
      .run()
      .catch((e: any) => {
        // A failed trail row must not undo the link; log it so it is seen.
        console.warn(`[resolveCreditorForCase] case=${caseId} activity insert failed:`, e?.message || e);
      });
  }

  return { code: creditorCode, soMissing: false };
}

export interface RefreshResult {
  fetched: number;
  upserted: number;
  cases_updated: number;
  message: string;
}

/**
 * Bulk refresh: pull stock_items for every distinct item_code
 * referenced by non-archived cases (optionally constrained to a
 * caller-provided list). Cases are not touched (HC-0130).
 */
export async function runStockItemsRefresh(
  env: Env,
  opts: { itemCodes?: string[] } = {}
): Promise<RefreshResult> {
  const rid = crypto.randomUUID();
  const startedAt = new Date();
  const client = new AutoCountClient(env, rid);

  try {
    let itemCodes: string[];
    if (opts.itemCodes && opts.itemCodes.length > 0) {
      itemCodes = opts.itemCodes.filter(Boolean);
    } else {
      const rows = await env.DB.prepare(
        `SELECT DISTINCT item_code FROM assr_cases
          WHERE item_code IS NOT NULL AND item_code != ''
            AND archived_at IS NULL`
      ).all<{ item_code: string }>();
      itemCodes = (rows.results ?? []).map((r) => r.item_code);
    }

    let fetched = 0;
    let upserted = 0;
    for (const code of itemCodes) {
      try {
        const item = await client.getStockItem(code);
        fetched++;
        if (item) {
          await upsertStockItem(env, item);
          upserted++;
        }
      } catch (e: any) {
        console.warn(`[stockItemsRefresh][${rid}] ${code} failed:`, e?.message || e);
      }
    }

    // HC-0130 (Farra's rule): a case's supplier comes from its PO / SO, never
    // from AutoCount MainSupplier, so the refresh no longer writes to cases.
    const casesUpdated = 0;

    const message = `Refreshed ${fetched}/${itemCodes.length} items (${upserted} upserted); updated ${casesUpdated} cases.`;
    await writeLog(env, {
      requestId: rid,
      type: "STOCK_ITEMS_REFRESH",
      startedAt,
      status: "SYNCED",
      message,
    });
    return { fetched, upserted, cases_updated: casesUpdated, message };
  } catch (err: any) {
    const message = err?.message || String(err);
    await writeLog(env, {
      requestId: rid,
      type: "STOCK_ITEMS_REFRESH",
      startedAt,
      status: "FAILED",
      message,
    });
    throw err;
  }
}
