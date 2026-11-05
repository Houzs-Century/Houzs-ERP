// ----------------------------------------------------------------------------
// pos-admin-rules.ts — the pure rules behind the POS Admin menu: what a
// cashier PIN is, how a cashier / terminal code is minted, what an event's
// status word is, and how one Excel import row becomes a POS item patch.
// Tested without a database.
// ----------------------------------------------------------------------------
import { MFG_PRODUCT_CATEGORIES, isMfgProductCategory, type MfgProductCategory } from "../../scm/shared/product-categories";

export const CASHIER_ROLES = ["PARTTIME", "SUPERVISOR"] as const;
export type CashierRole = (typeof CASHIER_ROLES)[number];
export const isCashierRole = (v: unknown): v is CashierRole => typeof v === "string" && (CASHIER_ROLES as readonly string[]).includes(v);

/** 4 to 6 digits (spec section 2). */
export const isPosCashierPin = (v: unknown): v is string => typeof v === "string" && /^\d{4,6}$/.test(v);

/** The next free code with a prefix: T01, T02 … (two digits, then three). */
export function nextCode(prefix: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((s) => s.toUpperCase()));
  for (let n = 1; n < 1000; n++) {
    const code = `${prefix}${String(n).padStart(2, "0")}`;
    if (!taken.has(code)) return code;
  }
  return `${prefix}${Date.now().toString(36).toUpperCase()}`;
}

export type PosEventStatus = "COMING" | "ON GOING" | "DONE";

/** Where the fair is in time, whatever its POS link: ON GOING while today is
 *  inside the dates, DONE after, COMING before. No dates = ON GOING. */
export function posEventStatus(p: { start_date: string | null; end_date: string | null }, today: string): PosEventStatus {
  const start = p.start_date ? p.start_date.slice(0, 10) : null;
  const end = p.end_date ? p.end_date.slice(0, 10) : start;
  if (end && today > end) return "DONE";
  if (start && today < start) return "COMING";
  return "ON GOING";
}

export type ImportRowInput = Record<string, unknown>;

export type ImportRowFields = {
  uom?: string; price_sen?: number; cost_sen?: number | null; preset_discount_type?: "PCT" | "RM" | null;
  preset_discount_value?: number | null; foc_allowed?: boolean; max_manual_disc_pct?: number | null; receipt_name?: string | null; active?: boolean;
};

export type ParsedImportRow =
  | { ok: true; item_code: string; barcode: string | null; fields: ImportRowFields }
  | { ok: false; item_code: string | null; reason: string };

const cell = (r: ImportRowInput, ...keys: string[]): string => {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
};

const yes = (s: string): boolean => /^(y|yes|true|1|on)$/i.test(s);
const rm = (s: string): number | null => {
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return s === "" || !Number.isFinite(n) ? null : n;
};

/** Columns (case-insensitive, spaces/underscores ignored): Item Code,
 *  Barcode, UOM, Price, Cost, Discount Type (% or RM), Discount Value, FOC,
 *  Max Manual Disc, Receipt Name, Active. Prices are RM; stored in sen. */
export function parseImportRow(raw: ImportRowInput): ParsedImportRow {
  const r: ImportRowInput = {};
  for (const [k, v] of Object.entries(raw)) r[k.toLowerCase().replace(/[\s_()%]+/g, "")] = v;
  const item_code = cell(r, "itemcode", "code", "sku");
  if (!item_code) return { ok: false, item_code: null, reason: "item code missing" };
  const fields: ImportRowFields = {};
  const uom = cell(r, "uom", "unit");
  if (uom) fields.uom = uom.toUpperCase();
  const price = rm(cell(r, "price", "sellingprice", "pricerm"));
  if (price != null) {
    if (price < 0) return { ok: false, item_code, reason: "price below zero" };
    fields.price_sen = Math.round(price * 100);
  }
  const cost = cell(r, "cost", "costrm");
  if (cost) fields.cost_sen = Math.round((rm(cost) ?? 0) * 100);
  const dtRaw = cell(r, "discounttype", "disctype", "presetdiscounttype").toUpperCase();
  const dv = rm(cell(r, "discountvalue", "discvalue", "presetdiscount", "discount"));
  if (dtRaw || dv != null) {
    const dt = dtRaw === "%" || dtRaw === "PCT" || dtRaw === "PERCENT" ? "PCT" : dtRaw === "RM" || dtRaw === "AMOUNT" ? "RM" : dv != null && !dtRaw ? "RM" : null;
    if (!dt) return { ok: false, item_code, reason: `discount type "${dtRaw}" is not % or RM` };
    if (dv == null || dv < 0) return { ok: false, item_code, reason: "discount value missing" };
    if (dt === "PCT" && dv > 100) return { ok: false, item_code, reason: "discount above 100%" };
    fields.preset_discount_type = dt;
    fields.preset_discount_value = dv;
  }
  const foc = cell(r, "foc", "focallowed");
  if (foc) fields.foc_allowed = yes(foc);
  const maxDisc = cell(r, "maxmanualdisc", "maxmanualdiscount", "maxdisc");
  if (maxDisc) fields.max_manual_disc_pct = Math.min(100, Math.max(0, rm(maxDisc) ?? 0));
  const receipt = cell(r, "receiptname", "shortname");
  if (receipt) fields.receipt_name = receipt.slice(0, 24);
  const active = cell(r, "active");
  if (active) fields.active = yes(active);
  const barcode = cell(r, "barcode", "ean");
  return { ok: true, item_code, barcode: barcode && /^[0-9A-Za-z-]{4,32}$/.test(barcode) ? barcode : null, fields };
}

/* ── POS Items > Add by category ─────────────────────────────────────────── */

/** One ACTIVE inventory product as the add-by-category count sees it:
 *  `pos_active` is null when it is not a POS item yet. */
export type CategoryProductRow = { category: string | null; sell_price_sen: number | string | null; pos_active: boolean | null };
/** Per category: products not yet in the POS with a selling price (`to_add`),
 *  POS items on / off, and products with no selling price (never added). */
export type CategoryCount = { category: string; to_add: number; active: number; off: number; no_price: number };

export const hasSellingPrice = (r: { sell_price_sen: number | string | null }): boolean => Number(r.sell_price_sen ?? 0) > 0;

/** Counts per category in enum order; a product without a category lands
 *  under "" at the end, so nothing is hidden from the picker. */
export function countByCategory(rows: readonly CategoryProductRow[]): CategoryCount[] {
  const by = new Map<string, CategoryCount>();
  for (const r of rows) {
    const key = r.category ?? "";
    const c = by.get(key) ?? { category: key, to_add: 0, active: 0, off: 0, no_price: 0 };
    if (r.pos_active === true) c.active += 1;
    else if (r.pos_active === false) c.off += 1;
    else if (hasSellingPrice(r)) c.to_add += 1;
    else c.no_price += 1;
    by.set(key, c);
  }
  const order = (k: string): number => { const i = (MFG_PRODUCT_CATEGORIES as readonly string[]).indexOf(k); return i < 0 ? MFG_PRODUCT_CATEGORIES.length + (k === "" ? 1 : 0) : i; };
  return [...by.values()].sort((a, b) => order(a.category) - order(b.category) || a.category.localeCompare(b.category));
}

/** The categories a request names, each a real `mfg_product_category`; [] when none. */
export const pickedCategories = (v: unknown): MfgProductCategory[] =>
  Array.isArray(v) ? [...new Set(v.filter(isMfgProductCategory))] : [];
