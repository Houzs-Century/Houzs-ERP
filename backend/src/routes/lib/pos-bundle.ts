// ----------------------------------------------------------------------------
// pos-bundle.ts — the pure half of the device bundle (GET /pos-device/prepare,
// layout P15): which POS items an event's terminal gets, at what price, with
// which barcodes, and the device token rule. Tested without a database.
// ----------------------------------------------------------------------------

export type BundleItemSource = {
  id: number;
  product_id: string;
  item_code: string;
  name: string;
  uom: string;
  price_sen: number;
  preset_discount_type: string | null;
  preset_discount_value: number | null;
  foc_allowed: boolean;
  max_manual_disc_pct: number | null;
  receipt_name: string | null;
  active: boolean;
};

export type BundleItem = {
  id: number;
  product_id: string;
  code: string;
  /** The live SKU name when known, else the tagging-time snapshot. */
  name: string;
  receipt_name: string;
  uom: string;
  price_sen: number;
  list_price_sen: number;
  barcodes: string[];
  discount: { type: "PCT" | "RM"; value: number } | null;
  foc_allowed: boolean;
  max_manual_disc_pct: number | null;
  stock_qty: number;
};

export type BundleScope = {
  catalog_scope: "ALL" | "PICK";
  pick_item_ids: readonly number[];
  price_overrides: ReadonlyMap<number, number>;
};

export type SkuSide = { code: string; name: string; barcode: string | null; stock_qty: number };

/** Active items in scope, event price applied, every barcode of the item
 *  (factory, generated, extra), sorted by code. Inactive items never ship. */
export function buildBundleItems(
  items: readonly BundleItemSource[],
  scope: BundleScope,
  skuByProduct: ReadonlyMap<string, SkuSide>,
  generatedByProduct: ReadonlyMap<string, string>,
  extraByItem: ReadonlyMap<number, readonly string[]>,
): BundleItem[] {
  const pick = new Set(scope.pick_item_ids);
  const out: BundleItem[] = [];
  for (const i of items) {
    if (!i.active) continue;
    if (scope.catalog_scope === "PICK" && !pick.has(i.id)) continue;
    const sku = skuByProduct.get(i.product_id);
    const barcodes: string[] = [];
    const add = (b: string | null | undefined) => { if (b && !barcodes.includes(b)) barcodes.push(b); };
    add(sku?.barcode);
    add(generatedByProduct.get(i.product_id));
    for (const b of extraByItem.get(i.id) ?? []) add(b);
    const override = scope.price_overrides.get(i.id);
    out.push({
      id: i.id,
      product_id: i.product_id,
      code: sku?.code ?? i.item_code,
      name: sku?.name ?? i.name,
      receipt_name: (i.receipt_name ?? sku?.name ?? i.name).slice(0, 24),
      uom: i.uom,
      price_sen: override ?? i.price_sen,
      list_price_sen: i.price_sen,
      barcodes,
      discount: i.preset_discount_type === "PCT" || i.preset_discount_type === "RM" ? { type: i.preset_discount_type, value: Number(i.preset_discount_value ?? 0) } : null,
      foc_allowed: i.foc_allowed,
      max_manual_disc_pct: i.max_manual_disc_pct,
      stock_qty: sku?.stock_qty ?? 0,
    });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

/** A device token: 32 random bytes as hex, shown to the device once. */
export function mintDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the ERP stores: the SHA-256 of the token, hex. */
export async function deviceTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const isDeviceToken = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
