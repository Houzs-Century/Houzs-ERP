/* The device bundle as GET /api/pos-device/prepare (and Prepare device)
 * returns it — the wire shape of backend/src/routes/lib/pos-bundle-load.ts.
 * Everything the booth needs to open and sell with no signal. */
import type { PosSettings } from "@shared/pos-settings";

export type BundleItem = {
  id: number;
  product_id: string;
  code: string;
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

export type BundleCashier = {
  id: number;
  code: string;
  name: string;
  role: "PARTTIME" | "SUPERVISOR";
  pin_hash: string;
  max_discount_pct: number;
};

export type PosBundle = {
  terminal: { id: number; code: string; device_name: string | null; receipt_counter: number };
  event: {
    project_id: number;
    code: string | null;
    name: string;
    start_date: string | null;
    end_date: string | null;
    venue: string | null;
    receipt_header: string | null;
    sst_default: boolean;
    catalog_version: number;
    stock_source_warehouse_id: string | null;
  };
  company: { id: number; name: string; registration_no: string; address: string; phone: string };
  items: BundleItem[];
  cashiers: BundleCashier[];
  settings: PosSettings;
  prepared_at: string;
};

/** What the device keeps about itself, beside the bundle. */
export type DeviceState = {
  token: string;
  bundle: PosBundle;
  prepared_at: string;
  last_sync_at: string | null;
  last_login: { cashier: string; at: string } | null;
  test_mode: boolean;
  device_name: string;
  /** Signed in with an ERP account but no terminal yet (src/manager.ts): in memory only, never saved, never synced. */
  provisional?: boolean;
};

export type Session = { cashier: BundleCashier; started_at: string };
