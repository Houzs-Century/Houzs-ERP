/* The Houzs POS bills of one event, as the project page shows them (layout
 * E9) — the wire shape of GET /api/project-pos-sales/:projectId, the labels
 * the list prints, and the rows its Excel export writes.
 *
 * Shared by the desktop section and the mobile panel so the two cannot
 * disagree. Pure; no fetching here. Money is integer sen on the wire. The
 * vocabularies (payment methods, receipt status word, empty totals) have ONE
 * home, vendor/shared/pos-vocabulary.ts, and are re-exported from here.
 */
import {
  emptyPosSalesTotals,
  isPosPaymentMethod,
  isPosReceiptStatus,
  posMethodLabel,
  posReceiptStatusLabel,
  type PosReceiptStatus,
  type PosSalesTotals,
} from "../vendor/shared/pos-vocabulary";

export { posMethodLabel, posReceiptStatusLabel, type PosReceiptStatus, type PosSalesTotals };

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
  methods: string[];
  lines: PosReceiptLine[];
  payments: { method: string; amount_sen: number; reference: string | null }[];
};

export type PosSalesFilter = {
  date: string | null;
  terminal: string | null;
  cashier_id: number | null;
  method: string | null;
  status: PosReceiptStatus | null;
};

export type ProjectPosSalesResponse = {
  project: { id: number; name: string; event_type_slug: string | null } | null;
  /** The project's type carries POS Sales (Cash & Carry). */
  pos_enabled: boolean;
  data: PosReceipt[];
  totals: PosSalesTotals;
  /** Bills before the filter — "no bills yet" against "nothing matches". */
  all_count: number;
  options: { terminals: string[]; cashiers: { id: number; name: string }[]; methods: string[] };
};

export const EMPTY_POS_FILTER: PosSalesFilter = { date: null, terminal: null, cashier_id: null, method: null, status: null };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Every numeric field of the totals coerced; the method map kept when it is one. */
function normalizeTotals(raw: unknown): PosSalesTotals {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = emptyPosSalesTotals();
  for (const k of Object.keys(out) as (keyof PosSalesTotals)[]) {
    if (k === "by_method") continue;
    out[k] = num(t[k]);
  }
  const bm = t.by_method;
  if (bm && typeof bm === "object") {
    for (const [m, v] of Object.entries(bm as Record<string, unknown>)) out.by_method[m] = num(v);
  }
  return out;
}

/** The read as the page may rely on it: a response of another shape becomes
 *  an empty, disabled read rather than a crash of the whole project page. */
export function normalizeProjectPosSales(raw: unknown): ProjectPosSalesResponse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ProjectPosSalesResponse>;
  const o = r.options && typeof r.options === "object" ? r.options : undefined;
  return {
    project: r.project && typeof r.project === "object" ? r.project : null,
    pos_enabled: r.pos_enabled === true,
    data: Array.isArray(r.data) ? r.data : [],
    totals: normalizeTotals(r.totals),
    all_count: num(r.all_count),
    options: {
      terminals: Array.isArray(o?.terminals) ? o.terminals : [],
      cashiers: Array.isArray(o?.cashiers) ? o.cashiers : [],
      methods: Array.isArray(o?.methods) ? o.methods : [],
    },
  };
}

/** The query string the filter becomes; only set, well-formed fields travel. */
export function posSalesFilterQuery(f: PosSalesFilter): string {
  const q = new URLSearchParams();
  if (f.date) q.set("date", f.date);
  if (f.terminal) q.set("terminal", f.terminal);
  if (f.cashier_id != null) q.set("cashier", String(f.cashier_id));
  if (f.method && isPosPaymentMethod(f.method)) q.set("method", f.method);
  if (f.status && isPosReceiptStatus(f.status)) q.set("status", f.status);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The Total Sales button writes the booth's NET takings, in whole RM with
 *  sen, as the project's lump-sum total (project_finance.total_sales). */
export const posNetRm = (t: Pick<PosSalesTotals, "net_sen">): number => Math.round(t.net_sen) / 100;

export const POS_EXPORT_HEADERS = [
  "Receipt No", "Date/Time", "Type", "Status", "Terminal", "Cashier", "Salesman", "Customer",
  "Line", "Item Code", "Description", "Qty", "UOM", "Unit Price (RM)", "Disc", "Line Amount (RM)",
  "Sub Total (RM)", "Discount (RM)", "SST (RM)", "Rounding (RM)", "Bill Total (RM)", "Paid By", "Void Reason",
] as const;

export type PosExportCell = string | number | null;

const rm = (sen: number): number => Math.round(sen) / 100;

/** One row per LINE, the bill's header columns repeated on each so a pivot in
 *  Excel works without merged cells; a bill with no lines still gets one row. */
export function buildPosSalesExportRows(receipts: readonly PosReceipt[]): PosExportCell[][] {
  const rows: PosExportCell[][] = [];
  for (const r of receipts) {
    const paidBy = r.payments.map((p) => `${posMethodLabel(p.method)} ${rm(p.amount_sen).toFixed(2)}`).join("; ");
    const head: PosExportCell[] = [
      r.receipt_no, r.sold_at, r.type, posReceiptStatusLabel(r), r.terminal_code,
      r.cashier_name ?? "", r.salesman_name ?? "Booth", r.customer_name ?? "",
    ];
    const tail: PosExportCell[] = [
      rm(r.subtotal_sen), rm(r.item_discount_sen + r.bill_discount_sen), rm(r.sst_amount_sen), rm(r.rounding_sen), rm(r.total_sen),
      paidBy, r.void_reason ?? "",
    ];
    if (r.lines.length === 0) {
      rows.push([...head, null, "", "", null, "", null, "", null, ...tail]);
      continue;
    }
    for (const l of r.lines) {
      rows.push([
        ...head,
        l.line_no, l.item_code, l.description, l.qty, l.uom, rm(l.unit_price_sen), l.disc_label, rm(l.amount_sen),
        ...tail,
      ]);
    }
  }
  return rows;
}
