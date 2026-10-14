/* The cart (layouts P2 to P6, P11), pure: lines, discounts, FOC, totals.
 * Money is integer sen; a line's amount is rounded to the sen once, so the
 * receipt, the ERP and the report cannot disagree by a sen. */
import type { BundleItem } from "./types";

export type Discount = { source: "AUTO" | "MANUAL"; type: "PCT" | "RM"; value: number };

export type CartLine = {
  line_no: number;
  item_id: number;
  product_id: string;
  code: string;
  description: string;
  receipt_name: string;
  uom: string;
  qty: number;
  unit_price_sen: number;
  /** Set when a supervisor overrode the price (P4). */
  original_price_sen: number | null;
  override_by: string | null;
  override_reason: string | null;
  discount: Discount | null;
  is_foc: boolean;
  foc_allowed: boolean;
  max_manual_disc_pct: number | null;
  stock_qty: number;
};

export type Cart = {
  lines: CartLine[];
  bill_discount: { type: "PCT" | "RM"; value: number } | null;
  salesman: { id: number; name: string } | null;
  customer: { name: string; phone: string } | null;
  sst_applied: boolean;
};

export const emptyCart = (sstDefault: boolean, salesman: Cart["salesman"] = null): Cart => ({ lines: [], bill_discount: null, salesman, customer: null, sst_applied: sstDefault });

const round = (n: number): number => Math.round(n);

/** A line's discount in sen, on its gross (qty x price). FOC takes everything. */
export function lineDiscountSen(l: Pick<CartLine, "qty" | "unit_price_sen" | "discount" | "is_foc">): number {
  const gross = l.qty * l.unit_price_sen;
  if (l.is_foc) return gross;
  if (!l.discount) return 0;
  const d = l.discount.type === "PCT" ? round((gross * l.discount.value) / 100) : round(l.discount.value * 100) * l.qty;
  return Math.min(gross, Math.max(0, d));
}

export const lineAmountSen = (l: Pick<CartLine, "qty" | "unit_price_sen" | "discount" | "is_foc">): number => l.qty * l.unit_price_sen - lineDiscountSen(l);

/** The Disc column's word: AUTO -10%, -RM15, FOC, --. */
export function discLabel(l: Pick<CartLine, "discount" | "is_foc">): string {
  if (l.is_foc) return "FOC";
  if (!l.discount) return "--";
  return l.discount.type === "PCT" ? `-${l.discount.value}%` : `-RM${l.discount.value}`;
}

function lineFrom(item: BundleItem, lineNo: number): CartLine {
  return {
    line_no: lineNo, item_id: item.id, product_id: item.product_id, code: item.code, description: item.name, receipt_name: item.receipt_name, uom: item.uom,
    qty: 1, unit_price_sen: item.price_sen, original_price_sen: null, override_by: null, override_reason: null,
    discount: item.discount ? { source: "AUTO", type: item.discount.type, value: item.discount.value } : null,
    is_foc: false, foc_allowed: item.foc_allowed, max_manual_disc_pct: item.max_manual_disc_pct, stock_qty: item.stock_qty,
  };
}

const renumber = (lines: CartLine[]): CartLine[] => lines.map((l, i) => ({ ...l, line_no: i + 1 }));

/** Scan / pick: +1 on the same item's plain line when the setting says so,
 *  else a new line. A line with an override, manual discount or FOC is never
 *  merged into. Returns the line touched. */
export function addItem(cart: Cart, item: BundleItem, sameBarcodeAddsQty: boolean): { cart: Cart; line_no: number } {
  if (sameBarcodeAddsQty) {
    const idx = cart.lines.findIndex((l) => l.item_id === item.id && l.original_price_sen == null && !l.is_foc && l.discount?.source !== "MANUAL");
    if (idx >= 0) {
      const lines = cart.lines.map((l, i) => (i === idx ? { ...l, qty: l.qty + 1 } : l));
      return { cart: { ...cart, lines }, line_no: lines[idx]!.line_no };
    }
  }
  const line = lineFrom(item, cart.lines.length + 1);
  return { cart: { ...cart, lines: [...cart.lines, line] }, line_no: line.line_no };
}

/** Qty 0 removes the line (P4). */
export function setQty(cart: Cart, lineNo: number, qty: number): Cart {
  const q = Math.max(0, Math.floor(qty));
  if (q === 0) return removeLine(cart, lineNo);
  return { ...cart, lines: cart.lines.map((l) => (l.line_no === lineNo ? { ...l, qty: q } : l)) };
}

export function removeLine(cart: Cart, lineNo: number): Cart {
  return { ...cart, lines: renumber(cart.lines.filter((l) => l.line_no !== lineNo)) };
}

export function overridePrice(cart: Cart, lineNo: number, newPriceSen: number, by: string, reason: string): Cart {
  const p = Math.max(0, round(newPriceSen));
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.line_no === lineNo ? { ...l, original_price_sen: l.original_price_sen ?? l.unit_price_sen, unit_price_sen: p, override_by: by, override_reason: reason } : l)),
  };
}

export function setLineDiscount(cart: Cart, lineNo: number, discount: Discount | null): Cart {
  return { ...cart, lines: cart.lines.map((l) => (l.line_no === lineNo ? { ...l, discount, is_foc: discount ? false : l.is_foc } : l)) };
}

export function toggleFoc(cart: Cart, lineNo: number): Cart {
  return { ...cart, lines: cart.lines.map((l) => (l.line_no === lineNo && l.foc_allowed ? { ...l, is_foc: !l.is_foc } : l)) };
}

export const setBillDiscount = (cart: Cart, d: Cart["bill_discount"]): Cart => ({ ...cart, bill_discount: d });

/** A manual discount above the cashier's cap (or the item's own cap) needs a
 *  supervisor PIN (P5). An RM discount is compared as a % of the line gross. */
export function manualDiscountNeedsSupervisor(
  discount: { type: "PCT" | "RM"; value: number },
  grossSen: number,
  cashierMaxPct: number,
  itemMaxPct: number | null,
): boolean {
  const pct = discount.type === "PCT" ? discount.value : grossSen > 0 ? (discount.value * 100 * 100) / grossSen : 100;
  const cap = itemMaxPct == null ? cashierMaxPct : Math.min(cashierMaxPct, itemMaxPct);
  return pct > cap + 1e-9;
}

export type Totals = {
  subtotal_sen: number;
  item_discount_sen: number;
  bill_discount_sen: number;
  net_sen: number;
  sst_rate: number;
  sst_sen: number;
  rounding_sen: number;
  total_sen: number;
  units: number;
};

/** Sub Total is the gross of every non-FOC line; item discounts then bill
 *  discount; SST on the net when ticked; rounding to 5 sen only when asked
 *  (a cash payment, P7). */
export function cartTotals(cart: Cart, sstRate: number, roundToFiveSen: boolean): Totals {
  let subtotal = 0;
  let itemDisc = 0;
  let units = 0;
  for (const l of cart.lines) {
    units += l.qty;
    if (l.is_foc) continue;
    subtotal += l.qty * l.unit_price_sen;
    itemDisc += lineDiscountSen(l);
  }
  const afterItems = subtotal - itemDisc;
  let billDisc = 0;
  if (cart.bill_discount) {
    billDisc = cart.bill_discount.type === "PCT" ? round((afterItems * cart.bill_discount.value) / 100) : round(cart.bill_discount.value * 100);
    billDisc = Math.min(afterItems, Math.max(0, billDisc));
  }
  const net = afterItems - billDisc;
  const sst = cart.sst_applied ? round((net * sstRate) / 100) : 0;
  const beforeRounding = net + sst;
  const rounding = roundToFiveSen ? round(beforeRounding / 5) * 5 - beforeRounding : 0;
  return { subtotal_sen: subtotal, item_discount_sen: itemDisc, bill_discount_sen: billDisc, net_sen: net, sst_rate: cart.sst_applied ? sstRate : 0, sst_sen: sst, rounding_sen: rounding, total_sen: beforeRounding + rounding, units };
}

/* ── catalog lookup (P2 / P3) ──────────────────────────────────────────── */

export function findByBarcode(items: readonly BundleItem[], code: string): BundleItem | null {
  const c = code.trim();
  if (!c) return null;
  return items.find((i) => i.barcodes.includes(c)) ?? items.find((i) => i.code.toUpperCase() === c.toUpperCase()) ?? null;
}

/** One box searches barcode, code and name; at least two characters. */
export function searchItems(items: readonly BundleItem[], q: string, limit = 50): BundleItem[] {
  const t = q.trim().toLowerCase();
  if (t.length < 2) return [];
  const starts: BundleItem[] = [];
  const contains: BundleItem[] = [];
  for (const i of items) {
    const code = i.code.toLowerCase();
    const name = i.name.toLowerCase();
    if (code.startsWith(t) || i.barcodes.some((b) => b.startsWith(t))) starts.push(i);
    else if (code.includes(t) || name.includes(t) || i.barcodes.some((b) => b.includes(t))) contains.push(i);
    if (starts.length + contains.length >= limit * 2) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

/* ── receipt numbering (step 5 uses it; the header shows the next one) ──── */

/** {TERM}-{000000}: the terminal code and the zero-padded running number. */
export function formatReceiptNo(format: string, terminal: string, n: number, test: boolean): string {
  const padded = (m: string) => String(n).padStart(m.length, "0");
  const out = format.replace(/\{TERM\}/g, terminal).replace(/\{(0+)\}/g, (_, zeros: string) => (test ? `T${String(n).padStart(Math.max(1, zeros.length - 1), "0")}` : padded(zeros)));
  return out;
}

/* ── hold / recall (P11) ──────────────────────────────────────────────── */

export type HeldBill = { hold_no: string; created_at: string; cart: Cart; cashier: string };

export const nextHoldNo = (existing: readonly HeldBill[]): string => {
  const max = existing.reduce((m, h) => Math.max(m, Number(h.hold_no.replace(/\D/g, "")) || 0), 0);
  return `HOLD-${String(max + 1).padStart(2, "0")}`;
};

/** Held bills die at the event's end (the end date's last second, Malaysia time). */
export function holdExpired(h: HeldBill, eventEndDate: string | null, nowMs: number): boolean {
  if (!eventEndDate) return false;
  const end = Date.parse(`${eventEndDate.slice(0, 10)}T23:59:59+08:00`);
  return Number.isFinite(end) && nowMs > end;
}
