/* Houzs POS settings (layouts E4 / E5): the three groups the POS Admin menu
 * edits, their defaults, and the one normaliser that turns whatever is stored
 * into a fully-typed document — so the ERP form, the API and the booth app
 * all read the same shape with the same defaults.
 *
 * ONE home. backend/src/scm/shared/pos-settings.ts is the original and
 * frontend/src/vendor/shared/pos-settings.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */
import { POS_PAYMENT_METHODS, type PosPaymentMethod } from "./pos-vocabulary";

export type PosPaperWidth = 58 | 80;

export type SstReceiptSettings = {
  sst_rate: number;
  sst_default_on: boolean;
  show_sst_when_zero: boolean;
  price_includes_sst: boolean;
  sst_reg_no: string;
  receipt_title: string;
  /** Three header lines; `{event name}` is replaced on the device. */
  header_lines: string[];
  footer: string;
  paper_width: PosPaperWidth;
  copies: number;
  rounding_on_cash: boolean;
  print_receipt_barcode: boolean;
  show_salesman: boolean;
  show_cashier: boolean;
};

export type PrinterScannerSettings = {
  connection: "BLUETOOTH" | "USB" | "ANY";
  default_paper: PosPaperWidth;
  on_printer_unavailable: "ASK" | "SKIP";
  scanner_enter_suffix: boolean;
  beep: boolean;
  same_barcode_adds_qty: boolean;
  tested_models: string[];
};

export type GeneralSettings = {
  payment_methods: Record<PosPaymentMethod, boolean>;
  idle_logout_minutes: number;
  price_override: "SUPERVISOR" | "OFF";
  void_rule: "SUPERVISOR_ANY_TIME" | "SUPERVISOR_SAME_DAY";
  receipt_no_format: string;
  alert_pending_days: number;
  alert_event_end_days: number;
  alert_email: string;
  heartbeat_minutes: number;
  daily_summary_email: boolean;
  customer_field: "OPTIONAL" | "HIDDEN";
  /** scm.warehouses.id of the main POS stock location; null = not set. */
  pos_store_warehouse_id: string | null;
  return_window: "EVENT" | "SAME_DAY";
  /** Project brands whose fairs the Events tab lists for the booth, beside
   *  every Cash & Carry project (projects.brand, exact text). */
  booth_brands: string[];
};

export type PosSettingsGroup = "sst_receipt" | "printer_scanner" | "general";
export type PosSettings = {
  sst_receipt: SstReceiptSettings;
  printer_scanner: PrinterScannerSettings;
  general: GeneralSettings;
};

/** Cash is OFF by default: fairs are cashless (spec section 0). */
const defaultPaymentMethods = (): Record<PosPaymentMethod, boolean> =>
  Object.fromEntries(POS_PAYMENT_METHODS.map((m) => [m, m !== "CASH"])) as Record<PosPaymentMethod, boolean>;

export function posSettingsDefaults(): PosSettings {
  return {
    sst_receipt: {
      sst_rate: 8,
      sst_default_on: false,
      show_sst_when_zero: true,
      price_includes_sst: false,
      sst_reg_no: "",
      receipt_title: "SALES INVOICE",
      header_lines: ["{event name}", "", ""],
      footer: "Thank you for your purchase. Goods sold are not returnable.",
      paper_width: 58,
      copies: 1,
      rounding_on_cash: true,
      print_receipt_barcode: true,
      show_salesman: true,
      show_cashier: true,
    },
    printer_scanner: {
      connection: "ANY",
      default_paper: 58,
      on_printer_unavailable: "ASK",
      scanner_enter_suffix: true,
      beep: true,
      same_barcode_adds_qty: true,
      tested_models: [],
    },
    general: {
      payment_methods: defaultPaymentMethods(),
      idle_logout_minutes: 15,
      price_override: "SUPERVISOR",
      void_rule: "SUPERVISOR_ANY_TIME",
      receipt_no_format: "{TERM}-{000000}",
      alert_pending_days: 3,
      alert_event_end_days: 3,
      alert_email: "hello@houzscentury.com",
      heartbeat_minutes: 5,
      daily_summary_email: false,
      customer_field: "OPTIONAL",
      pos_store_warehouse_id: null,
      return_window: "EVENT",
      booth_brands: ["AKEMI Cash & Carry", "AKEMI FRAGRANCE"],
    },
  };
}

export const POS_SETTINGS_GROUPS: PosSettingsGroup[] = ["sst_receipt", "printer_scanner", "general"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Defaults overlaid with the stored keys of the SAME type; an unknown key, a
 *  wrong-typed value or a corrupt document falls back to the default, so a
 *  device never reads an undefined setting. */
export function normalizePosSettingsGroup<G extends PosSettingsGroup>(group: G, raw: unknown): PosSettings[G] {
  const out = { ...posSettingsDefaults()[group] } as Record<string, unknown>;
  if (!isObj(raw)) return out as PosSettings[G];
  for (const [k, def] of Object.entries(out)) {
    const v = raw[k];
    if (v === undefined) continue;
    if (def === null) {
      if (v === null || typeof v === "string") out[k] = v;
    } else if (Array.isArray(def)) {
      if (Array.isArray(v)) out[k] = v.map((x) => String(x));
    } else if (isObj(def)) {
      if (isObj(v)) out[k] = { ...def, ...Object.fromEntries(Object.entries(v).filter(([kk, vv]) => kk in def && typeof vv === typeof def[kk])) };
    } else if (typeof v === typeof def) {
      out[k] = v;
    }
  }
  if (group === "sst_receipt" || group === "printer_scanner") {
    const key = group === "sst_receipt" ? "paper_width" : "default_paper";
    if (out[key] !== 58 && out[key] !== 80) out[key] = 58;
  }
  return out as PosSettings[G];
}

export function normalizePosSettings(raw: Partial<Record<PosSettingsGroup, unknown>>): PosSettings {
  return {
    sst_receipt: normalizePosSettingsGroup("sst_receipt", raw.sst_receipt),
    printer_scanner: normalizePosSettingsGroup("printer_scanner", raw.printer_scanner),
    general: normalizePosSettingsGroup("general", raw.general),
  };
}

/** The receipt header as the device prints it: the three lines with the
 *  event name filled in and blank lines dropped. */
export function receiptHeaderLines(s: Pick<SstReceiptSettings, "header_lines">, eventName: string): string[] {
  return s.header_lines.map((l) => l.replace(/\{event name\}/gi, eventName).trim()).filter((l) => l.length > 0);
}
