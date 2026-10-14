// ----------------------------------------------------------------------------
// pos-sales-list.ts — the pure half of GET /api/project-pos-sales/:projectId:
// how synced POS bills, their lines and their payments become the grouped
// receipt list the project page (E9) shows, and the totals in its header.
//
// Pure so it can be tested without a database. Money is integer sen. Test
// sales (is_test) never reach here: the device never syncs them, and the
// import path drops them, so the query does not filter them again.
// ----------------------------------------------------------------------------

export type PosSaleHeader = {
  id: number;
  uuid: string;
  receipt_no: string;
  type: string;
  ref_sale_uuid: string | null;
  terminal_code: string;
  cashier_id: number | null;
  cashier_name: string | null;
  salesman_id: number | null;
  salesman_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  sold_at: string;
  subtotal_sen: number;
  item_discount_sen: number;
  bill_discount_sen: number;
  sst_applied: boolean;
  sst_rate: string | number;
  sst_amount_sen: number;
  rounding_sen: number;
  total_sen: number;
  status: string;
  void_reason: string | null;
  void_by: string | null;
  voided_at: string | null;
  source: string;
  synced_at: string;
};

export type PosSaleLineRow = {
  sale_id: number;
  line_no: number;
  item_code: string;
  description: string;
  uom: string;
  qty: string | number;
  unit_price_sen: number;
  original_price_sen: number | null;
  override_by: string | null;
  override_reason: string | null;
  discount_source: string | null;
  discount_type: string | null;
  discount_value: string | number | null;
  discount_amount_sen: number;
  is_foc: boolean;
  amount_sen: number;
};

export type PosPaymentRow = {
  sale_id: number;
  method: string;
  amount_sen: number;
  reference: string | null;
};

/** One line as the page prints it: "1 UNIT", "-10%", "-RM15", "FOC" or "--". */
export type PosReceiptLine = {
  line_no: number;
  item_code: string;
  description: string;
  qty: number;
  uom: string;
  unit_price_sen: number;
  original_price_sen: number | null;
  override_reason: string | null;
  disc_label: string;
  discount_amount_sen: number;
  is_foc: boolean;
  amount_sen: number;
};

export type PosReceipt = {
  id: number;
  uuid: string;
  receipt_no: string;
  type: "SALE" | "RETURN";
  ref_sale_uuid: string | null;
  terminal_code: string;
  cashier_id: number | null;
  cashier_name: string | null;
  salesman_id: number | null;
  salesman_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  sold_at: string;
  subtotal_sen: number;
  item_discount_sen: number;
  bill_discount_sen: number;
  sst_applied: boolean;
  sst_rate: number;
  sst_amount_sen: number;
  rounding_sen: number;
  total_sen: number;
  status: "PAID" | "VOID";
  void_reason: string | null;
  void_by: string | null;
  voided_at: string | null;
  source: string;
  synced_at: string;
  /** Distinct methods on the bill, for the list's filter and its Paid-by cell. */
  methods: string[];
  lines: PosReceiptLine[];
  payments: { method: string; amount_sen: number; reference: string | null }[];
};

export type PosSalesTotals = {
  /** Receipts in the list (every type and status). */
  count: number;
  paid_count: number;
  void_count: number;
  return_count: number;
  /** PAID sales minus PAID returns — what the booth actually took. */
  net_sen: number;
  /** PAID sales only (gross of returns). */
  sales_sen: number;
  return_sen: number;
  void_sen: number;
  discount_sen: number;
  sst_sen: number;
  /** Net received per payment method, PAID bills only; refunds are negative. */
  by_method: Record<string, number>;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The Disc column's text — the wire carries a type + value, the page a word. */
export function discLabel(l: Pick<PosSaleLineRow, "is_foc" | "discount_type" | "discount_value" | "discount_amount_sen">): string {
  if (l.is_foc) return "FOC";
  if (l.discount_type === "PCT" && l.discount_value != null) return `-${num(l.discount_value)}%`;
  if (l.discount_type === "RM" && l.discount_value != null) return `-RM${num(l.discount_value)}`;
  if (num(l.discount_amount_sen) > 0) return `-RM${(num(l.discount_amount_sen) / 100).toFixed(2)}`;
  return "--";
}

/** Group the three reads into receipts, newest first (sold_at, then receipt no). */
export function groupPosReceipts(
  headers: readonly PosSaleHeader[],
  lines: readonly PosSaleLineRow[],
  payments: readonly PosPaymentRow[],
): PosReceipt[] {
  const linesBySale = new Map<number, PosReceiptLine[]>();
  for (const l of lines) {
    const arr = linesBySale.get(l.sale_id) ?? [];
    arr.push({
      line_no: l.line_no,
      item_code: l.item_code,
      description: l.description,
      qty: num(l.qty),
      uom: l.uom,
      unit_price_sen: num(l.unit_price_sen),
      original_price_sen: l.original_price_sen == null ? null : num(l.original_price_sen),
      override_reason: l.override_reason,
      disc_label: discLabel(l),
      discount_amount_sen: num(l.discount_amount_sen),
      is_foc: l.is_foc === true,
      amount_sen: num(l.amount_sen),
    });
    linesBySale.set(l.sale_id, arr);
  }
  const paysBySale = new Map<number, PosReceipt["payments"]>();
  for (const p of payments) {
    const arr = paysBySale.get(p.sale_id) ?? [];
    arr.push({ method: p.method, amount_sen: num(p.amount_sen), reference: p.reference });
    paysBySale.set(p.sale_id, arr);
  }
  const out: PosReceipt[] = headers.map((h) => {
    const pays = paysBySale.get(h.id) ?? [];
    const methods = Array.from(new Set(pays.map((p) => p.method)));
    return {
      id: h.id,
      uuid: h.uuid,
      receipt_no: h.receipt_no,
      type: h.type === "RETURN" ? "RETURN" : "SALE",
      ref_sale_uuid: h.ref_sale_uuid,
      terminal_code: h.terminal_code,
      cashier_id: h.cashier_id,
      cashier_name: h.cashier_name,
      salesman_id: h.salesman_id,
      salesman_name: h.salesman_name,
      customer_name: h.customer_name,
      customer_phone: h.customer_phone,
      sold_at: h.sold_at,
      subtotal_sen: num(h.subtotal_sen),
      item_discount_sen: num(h.item_discount_sen),
      bill_discount_sen: num(h.bill_discount_sen),
      sst_applied: h.sst_applied === true,
      sst_rate: num(h.sst_rate),
      sst_amount_sen: num(h.sst_amount_sen),
      rounding_sen: num(h.rounding_sen),
      total_sen: num(h.total_sen),
      status: h.status === "VOID" ? "VOID" : "PAID",
      void_reason: h.void_reason,
      void_by: h.void_by,
      voided_at: h.voided_at,
      source: h.source,
      synced_at: h.synced_at,
      methods,
      lines: (linesBySale.get(h.id) ?? []).sort((a, b) => a.line_no - b.line_no),
      payments: pays,
    };
  });
  out.sort((a, b) => (a.sold_at < b.sold_at ? 1 : a.sold_at > b.sold_at ? -1 : b.receipt_no.localeCompare(a.receipt_no)));
  return out;
}

/** The header tiles. A RETURN's total is stored POSITIVE (what was refunded)
 *  and subtracted here; a VOID bill counts in void_* only. */
export function posSalesTotals(receipts: readonly PosReceipt[]): PosSalesTotals {
  const t: PosSalesTotals = {
    count: 0, paid_count: 0, void_count: 0, return_count: 0,
    net_sen: 0, sales_sen: 0, return_sen: 0, void_sen: 0, discount_sen: 0, sst_sen: 0,
    by_method: {},
  };
  for (const r of receipts) {
    t.count += 1;
    if (r.status === "VOID") {
      t.void_count += 1;
      t.void_sen += r.total_sen;
      continue;
    }
    if (r.type === "RETURN") {
      t.return_count += 1;
      t.return_sen += r.total_sen;
      t.net_sen -= r.total_sen;
    } else {
      t.paid_count += 1;
      t.sales_sen += r.total_sen;
      t.net_sen += r.total_sen;
      t.discount_sen += r.item_discount_sen + r.bill_discount_sen;
      t.sst_sen += r.sst_amount_sen;
    }
    for (const p of r.payments) {
      /* A refund is stored negative on the payment row already; a RETURN's
         "customer pays" difference is positive. Sum as stored. */
      t.by_method[p.method] = (t.by_method[p.method] ?? 0) + p.amount_sen;
    }
  }
  return t;
}

export type PosSalesFilter = {
  /** YYYY-MM-DD in the app's timezone, matched against sold_at's local date. */
  date: string | null;
  terminal: string | null;
  cashier_id: number | null;
  method: string | null;
  status: "PAID" | "VOID" | "RETURN" | null;
};

/** The date a bill belongs to, in Malaysia time (UTC+8, no DST). */
export function posLocalDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function filterPosReceipts(receipts: readonly PosReceipt[], f: PosSalesFilter): PosReceipt[] {
  return receipts.filter((r) => {
    if (f.date && posLocalDate(r.sold_at) !== f.date) return false;
    if (f.terminal && r.terminal_code !== f.terminal) return false;
    if (f.cashier_id != null && r.cashier_id !== f.cashier_id) return false;
    if (f.method && !r.methods.includes(f.method)) return false;
    if (f.status === "VOID" && r.status !== "VOID") return false;
    if (f.status === "RETURN" && (r.type !== "RETURN" || r.status === "VOID")) return false;
    if (f.status === "PAID" && (r.status !== "PAID" || r.type !== "SALE")) return false;
    return true;
  });
}

/** Parse the list's query string into a filter; anything malformed is "no filter". */
export function parsePosSalesFilter(q: Record<string, string | undefined>): PosSalesFilter {
  const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : null;
  const terminal = q.terminal && q.terminal.trim() ? q.terminal.trim() : null;
  const cashierNum = Number(q.cashier);
  const cashier_id = q.cashier && Number.isInteger(cashierNum) && cashierNum > 0 ? cashierNum : null;
  const method = q.method && ["QR", "CREDIT", "DEBIT", "EWALLET", "CASH"].includes(q.method) ? q.method : null;
  const status = q.status === "PAID" || q.status === "VOID" || q.status === "RETURN" ? q.status : null;
  return { date, terminal, cashier_id, method, status };
}
