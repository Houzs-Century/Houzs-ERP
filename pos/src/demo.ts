/* Demo mode: the POS with a sample catalog and sample cashiers, no ERP setup
 * and no device token, so the owner can walk the sell screen before a
 * terminal exists. Everything is forced into Test mode: receipts print
 * *** TEST ***, numbering T00-T00001, no stock, nothing ever syncs, and
 * the sync engine and heartbeat stay off. Prepare device on the Device
 * setup screen (gear on the login screen, supervisor PIN 1234) replaces
 * the demo with a real terminal. */
import { posSettingsDefaults } from "@shared/pos-settings";
import { hashPin } from "./pin";
import type { BundleCashier, BundleItem, DeviceState, PosBundle } from "./types";

export const DEMO_PIN = "1234";

const ITEMS: Omit<BundleItem, "id" | "product_id">[] = [
  { code: "AK-PILLOW-S", name: "Akemi Pillow Soft", receipt_name: "Akemi Pillow Soft", uom: "PCS", price_sen: 5990, list_price_sen: 7990, barcodes: ["2000000000019"], discount: { type: "PCT", value: 10 }, foc_allowed: false, max_manual_disc_pct: 20, stock_qty: 40 },
  { code: "AK-PILLOW-F", name: "Akemi Pillow Firm", receipt_name: "Akemi Pillow Firm", uom: "PCS", price_sen: 6990, list_price_sen: 8990, barcodes: ["2000000000026"], discount: null, foc_allowed: false, max_manual_disc_pct: 20, stock_qty: 25 },
  { code: "BS-QUEEN-WH", name: "Bedsheet Set Queen White", receipt_name: "Bedsheet Queen White", uom: "SET", price_sen: 15900, list_price_sen: 19900, barcodes: ["2000000000033"], discount: { type: "RM", value: 20 }, foc_allowed: false, max_manual_disc_pct: 15, stock_qty: 12 },
  { code: "BS-KING-GR", name: "Bedsheet Set King Grey", receipt_name: "Bedsheet King Grey", uom: "SET", price_sen: 18900, list_price_sen: 23900, barcodes: ["2000000000040"], discount: null, foc_allowed: false, max_manual_disc_pct: 15, stock_qty: 8 },
  { code: "TW-BATH-BL", name: "Bath Towel Blue", receipt_name: "Bath Towel Blue", uom: "PCS", price_sen: 2990, list_price_sen: 3990, barcodes: ["2000000000057"], discount: null, foc_allowed: true, max_manual_disc_pct: 30, stock_qty: 60 },
  { code: "GF-MUG", name: "Gift Mug", receipt_name: "Gift Mug", uom: "PCS", price_sen: 1500, list_price_sen: 1500, barcodes: ["2000000000064"], discount: null, foc_allowed: true, max_manual_disc_pct: 100, stock_qty: 100 },
  { code: "MT-QUEEN", name: "Mattress Queen 10in", receipt_name: "Mattress Queen 10in", uom: "PCS", price_sen: 129900, list_price_sen: 189900, barcodes: ["2000000000071"], discount: { type: "PCT", value: 5 }, foc_allowed: false, max_manual_disc_pct: 10, stock_qty: 5 },
  { code: "CB-DUVET", name: "Comforter Duvet Queen", receipt_name: "Comforter Queen", uom: "PCS", price_sen: 9900, list_price_sen: 12900, barcodes: ["2000000000088"], discount: null, foc_allowed: false, max_manual_disc_pct: 20, stock_qty: 15 },
];

const CASHIERS: Omit<BundleCashier, "pin_hash">[] = [
  { id: -1, code: "DEMO1", name: "Aina (demo)", role: "SUPERVISOR", max_discount_pct: 30 },
  { id: -2, code: "DEMO2", name: "Farah (demo)", role: "PARTTIME", max_discount_pct: 10 },
];

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10);

export async function demoBundle(): Promise<PosBundle> {
  const pin_hash = await hashPin(DEMO_PIN);
  const now = new Date().toISOString();
  return {
    terminal: { id: -1, code: "T00", device_name: "Demo", receipt_counter: 0 },
    event: { project_id: -1, code: "DEMO", name: "Demo fair (sample data)", start_date: day(-1), end_date: day(7), venue: "Nowhere", receipt_header: "DEMO FAIR", sst_default: false, catalog_version: 1, stock_source_warehouse_id: null },
    company: { id: 0, name: "HOUZS CENTURY SDN BHD", registration_no: "DEMO", address: "", phone: "" },
    items: ITEMS.map((it, i) => ({ id: -(i + 1), product_id: `demo-${i + 1}`, ...it })),
    cashiers: CASHIERS.map((c) => ({ ...c, pin_hash })),
    settings: posSettingsDefaults(),
    prepared_at: now,
  };
}

export async function demoState(prev: DeviceState | null): Promise<DeviceState> {
  const bundle = await demoBundle();
  return { token: "", bundle, prepared_at: bundle.prepared_at, last_sync_at: null, last_login: prev?.last_login ?? null, test_mode: true, device_name: "Demo", demo: true };
}

export const isDemo = (s: DeviceState | null | undefined): boolean => s?.demo === true;
