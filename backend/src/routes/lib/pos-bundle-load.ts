// ----------------------------------------------------------------------------
// pos-bundle-load.ts — read the device bundle for one terminal: its event, the
// items in scope (event price, barcodes, stock at the event's stock source),
// the cashiers assigned (hashed PINs, verified offline), the settings and
// the company block for the receipt. Used by Prepare device (POS Admin) and
// by the device's own refresh (GET /api/pos-device/prepare).
// ----------------------------------------------------------------------------
import { and, eq, inArray, sql } from "drizzle-orm";
import type { getDb } from "../../db/client";
import {
  pos_cashiers,
  pos_event_cashiers,
  pos_event_items,
  pos_event_links,
  pos_event_prices,
  pos_generated_barcodes,
  pos_item_barcodes,
  pos_items,
  pos_settings,
  pos_terminals,
} from "../../db/schema";
import { normalizePosSettings, type PosSettings, type PosSettingsGroup } from "../../scm/shared/pos-settings";
import { buildBundleItems, type BundleItem } from "./pos-bundle";
import { skuFactsByIds } from "./pos-sku";

type Db = ReturnType<typeof getDb>;

export type BundleCashier = { id: number; code: string; name: string; role: "PARTTIME" | "SUPERVISOR"; pin_hash: string; max_discount_pct: number };

export type PosBundle = {
  terminal: { id: number; code: string; device_name: string | null; receipt_counter: number };
  event: { project_id: number; code: string | null; name: string; start_date: string | null; end_date: string | null; venue: string | null; receipt_header: string | null; sst_default: boolean; catalog_version: number; stock_source_warehouse_id: string | null };
  company: { id: number; name: string; registration_no: string; address: string; phone: string };
  items: BundleItem[];
  cashiers: BundleCashier[];
  settings: PosSettings;
  prepared_at: string;
};

export type BundleCompany = PosBundle["company"];

/** null when the terminal is not this company's, is inactive, or has no event. */
export async function loadPosBundle(db: Db, companyId: number, terminalId: number, company: BundleCompany): Promise<PosBundle | null> {
  const terminals = await db.select().from(pos_terminals).where(and(eq(pos_terminals.id, terminalId), eq(pos_terminals.company_id, companyId), eq(pos_terminals.active, true))).limit(1);
  if (terminals.length === 0) return null;
  const terminal = terminals[0];
  if (terminal.project_id == null) return null;
  const links = await db.select().from(pos_event_links).where(and(eq(pos_event_links.company_id, companyId), eq(pos_event_links.project_id, terminal.project_id))).limit(1);
  if (links.length === 0) return null;
  const link = links[0];
  const projRows = await db.execute<{ id: number; code: string | null; name: string; start_date: string | null; end_date: string | null; venue: string | null }>(sql`
    SELECT id, code, name, start_date, end_date, venue FROM projects WHERE id = ${terminal.project_id} AND company_id = ${companyId}`);
  if (projRows.length === 0) return null;
  const proj = projRows[0];

  const [items, picks, prices, cashierLinks, settingsRows] = await Promise.all([
    db.select().from(pos_items).where(and(eq(pos_items.company_id, companyId), eq(pos_items.active, true))),
    db.select().from(pos_event_items).where(eq(pos_event_items.link_id, link.id)),
    db.select().from(pos_event_prices).where(eq(pos_event_prices.link_id, link.id)),
    db.select({ cashier_id: pos_event_cashiers.cashier_id }).from(pos_event_cashiers).where(eq(pos_event_cashiers.link_id, link.id)),
    db.select().from(pos_settings).where(eq(pos_settings.company_id, companyId)),
  ]);
  const settingsRaw: Partial<Record<PosSettingsGroup, unknown>> = {};
  for (const r of settingsRows) settingsRaw[r.group as PosSettingsGroup] = r.value;
  const settings = normalizePosSettings(settingsRaw);
  const stockSource = link.stock_source_warehouse_id ?? settings.general.pos_store_warehouse_id;

  const productIds = items.map((i) => i.product_id);
  const itemIds = items.map((i) => i.id);
  const [facts, generated, extra, cashiers] = await Promise.all([
    skuFactsByIds(db, companyId, productIds, stockSource),
    productIds.length ? db.select().from(pos_generated_barcodes).where(and(eq(pos_generated_barcodes.company_id, companyId), inArray(pos_generated_barcodes.product_id, productIds))) : [],
    itemIds.length ? db.select().from(pos_item_barcodes).where(inArray(pos_item_barcodes.pos_item_id, itemIds)) : [],
    cashierLinks.length
      ? db.select().from(pos_cashiers).where(and(eq(pos_cashiers.company_id, companyId), eq(pos_cashiers.active, true), inArray(pos_cashiers.id, cashierLinks.map((c) => c.cashier_id))))
      : db.select().from(pos_cashiers).where(and(eq(pos_cashiers.company_id, companyId), eq(pos_cashiers.active, true))),
  ]);
  const extraByItem = new Map<number, string[]>();
  for (const b of extra) extraByItem.set(b.pos_item_id, [...(extraByItem.get(b.pos_item_id) ?? []), b.barcode]);
  const bundleItems = buildBundleItems(
    items.map((i) => ({ ...i, preset_discount_value: i.preset_discount_value == null ? null : Number(i.preset_discount_value), max_manual_disc_pct: i.max_manual_disc_pct == null ? null : Number(i.max_manual_disc_pct) })),
    { catalog_scope: link.catalog_scope === "PICK" ? "PICK" : "ALL", pick_item_ids: picks.map((p) => p.pos_item_id), price_overrides: new Map(prices.map((p) => [p.pos_item_id, p.price_sen])) },
    new Map(Array.from(facts, ([id, f]) => [id, { code: f.code, name: f.name, barcode: f.barcode, stock_qty: f.stock_qty }])),
    new Map(generated.map((g) => [g.product_id, g.barcode])),
    extraByItem,
  );
  return {
    terminal: { id: terminal.id, code: terminal.code, device_name: terminal.device_name, receipt_counter: terminal.receipt_counter },
    event: {
      project_id: Number(proj.id), code: proj.code, name: proj.name, start_date: proj.start_date, end_date: proj.end_date, venue: proj.venue,
      receipt_header: link.receipt_header, sst_default: link.sst_default, catalog_version: link.catalog_version, stock_source_warehouse_id: stockSource,
    },
    company,
    items: bundleItems,
    cashiers: cashiers.sort((a, b) => a.code.localeCompare(b.code)).map((c) => ({ id: c.id, code: c.code, name: c.name, role: c.role === "SUPERVISOR" ? "SUPERVISOR" : "PARTTIME", pin_hash: c.pin_hash, max_discount_pct: Number(c.max_discount_pct) })),
    settings,
    prepared_at: new Date().toISOString(),
  };
}
