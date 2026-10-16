/* The thermal receipt (layout P10 right / E4), AutoCount style, as text
 * lines at 32 columns (58 mm) or 48 (80 mm): company, SSM, event header
 * lines, title, DESC / QTY / PRICE / AMOUNT with the code + description on
 * one line and qty x price = amount on the next, the discount under the
 * item, Sub Total, SST x% (0.00 when unticked and the setting says so),
 * Rounding Adj, FINAL TOTAL, payment lines, Change, Receipt# / Terminal /
 * Date / Salesman / Cashier, footer. COPY on a reprint, VOID on a void bill,
 * *** TEST *** in test mode, RETURN on a return receipt. The barcode is a
 * separate ESC/POS command (escpos.ts) and a text fallback here. */
import { posMethodLabel } from "@shared/pos-vocabulary";
import { receiptHeaderLines, type SstReceiptSettings } from "@shared/pos-settings";
import { fmtMyt } from "./loginRules";
import type { SaleRecord } from "./sale";

export const receiptColumns = (paperWidth: 58 | 80): number => (paperWidth === 80 ? 48 : 32);

const money = (sen: number): string => (sen < 0 ? `-${(-sen / 100).toFixed(2)}` : (sen / 100).toFixed(2));

export const center = (s: string, w: number): string => {
  const t = s.slice(0, w);
  return " ".repeat(Math.max(0, Math.floor((w - t.length) / 2))) + t;
};
export const lr = (l: string, r: string, w: number): string => {
  const right = r.slice(0, w);
  const left = l.slice(0, Math.max(0, w - right.length - 1));
  return left + " ".repeat(Math.max(1, w - left.length - right.length)) + right;
};

export type ReceiptContext = {
  company: { name: string; registration_no: string; address: string; phone: string };
  event_name: string;
  settings: SstReceiptSettings;
  kind: "ORIGINAL" | "COPY";
};

export type ReceiptLine = { text: string; bold?: boolean; center?: boolean; big?: boolean };

export function receiptLines(sale: SaleRecord, ctx: ReceiptContext): ReceiptLine[] {
  const s = ctx.settings;
  const w = receiptColumns(s.paper_width);
  const out: ReceiptLine[] = [];
  const push = (text: string, o: Omit<ReceiptLine, "text"> = {}) => out.push({ text, ...o });
  if (sale.is_test) push(center("*** TEST ***", w), { bold: true, center: true });
  if (sale.status === "VOID") push(center("*** VOID ***", w), { bold: true, center: true, big: true });
  if (ctx.kind === "COPY") push(center("COPY", w), { bold: true, center: true });
  push(center(ctx.company.name, w), { bold: true, center: true });
  if (ctx.company.registration_no) push(center(ctx.company.registration_no, w), { center: true });
  if (ctx.company.address) for (const part of wrap(ctx.company.address, w)) push(center(part, w), { center: true });
  if (ctx.company.phone) push(center(`Tel ${ctx.company.phone}`, w), { center: true });
  for (const h of receiptHeaderLines(s, ctx.event_name)) push(center(h, w), { center: true });
  if (sale.sst_applied && s.sst_reg_no) push(center(`SST No: ${s.sst_reg_no}`, w), { center: true });
  push(center(sale.type === "RETURN" ? "RETURN / EXCHANGE" : s.receipt_title || "SALES INVOICE", w), { bold: true, center: true });
  if (sale.type === "RETURN" && sale.ref_receipt_no) push(center(`Ref ${sale.ref_receipt_no}`, w), { center: true });
  push("-".repeat(w));
  push(lr("DESC", "QTY   PRICE   AMOUNT", w));
  push("-".repeat(w));
  for (const l of sale.lines) {
    for (const part of wrap(`${l.code} ${l.description}`, w)) push(part);
    push(lr("", `${l.qty} x ${money(l.unit_price_sen)} = ${money(l.qty * l.unit_price_sen)}`, w));
    if (l.is_foc) push(lr("  FOC", `-${money(l.qty * l.unit_price_sen)}`, w));
    else if (l.discount_amount_sen !== 0) {
      const word = l.discount_type === "PCT" ? `${l.discount_value}%` : l.discount_type === "RM" ? `RM${l.discount_value}` : "";
      push(lr(`  Discount ${word}`.trimEnd(), money(-l.discount_amount_sen), w));
    }
    if (l.original_price_sen != null) push(lr(`  Price override (was ${money(l.original_price_sen)})`, "", w));
  }
  push("-".repeat(w));
  push(lr("Sub Total", money(sale.subtotal_sen), w));
  if (sale.item_discount_sen !== 0 || sale.bill_discount_sen !== 0) push(lr("Total Discount", money(-(sale.item_discount_sen + sale.bill_discount_sen)), w));
  if (sale.sst_applied || s.show_sst_when_zero) push(lr(`SST ${sale.sst_applied ? sale.sst_rate : s.sst_rate}%`, money(sale.sst_amount_sen), w));
  if (sale.rounding_sen !== 0) push(lr("Rounding Adj", money(sale.rounding_sen), w));
  push(lr(sale.type === "RETURN" ? (sale.total_sen < 0 ? "REFUND" : "CUSTOMER PAYS") : "FINAL TOTAL", money(Math.abs(sale.total_sen)), w), { bold: true, big: true });
  for (const p of sale.payments) {
    push(lr(posMethodLabel(p.method), money(Math.abs(p.amount_sen)), w));
    if (p.reference) push(lr(`  Ref ${p.reference}`, "", w));
    if (p.method === "CASH" && p.tendered_sen != null) {
      push(lr("Cash Tendered", money(p.tendered_sen), w));
      push(lr("Change", money(p.change_sen ?? 0), w), { bold: true });
    }
  }
  push("-".repeat(w));
  push(lr(`Receipt# ${sale.receipt_no}`, `Terminal ${sale.terminal_code}`, w));
  push(`Date ${fmtMyt(sale.sold_at)}`);
  if (s.show_salesman) push(`Salesman ${sale.salesman_name ?? "Booth"}`);
  if (s.show_cashier) push(`Cashier ${sale.cashier_name}`);
  if (sale.status === "VOID") push(`VOID ${sale.voided_at ? fmtMyt(sale.voided_at) : ""} ${sale.void_by ?? ""} ${sale.void_reason ?? ""}`.trim());
  if (sale.customer_name || sale.customer_phone) push(`Customer ${[sale.customer_name, sale.customer_phone].filter(Boolean).join(" ")}`.slice(0, w));
  if (s.footer) for (const f of s.footer.split("\n")) for (const part of wrap(f, w)) push(center(part, w), { center: true });
  return out;
}

/** Word-wrap to the paper width; a single long token is cut. */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > w) {
      if (line) { out.push(line); line = ""; }
      for (let i = 0; i < word.length; i += w) out.push(word.slice(i, i + w));
      continue;
    }
    if ((line + " " + word).trim().length > w) { out.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

export const receiptText = (sale: SaleRecord, ctx: ReceiptContext): string => receiptLines(sale, ctx).map((l) => l.text).join("\n");

/** The same receipt as a printable HTML page (e-receipt / Save as PDF). */
export function receiptHtml(sale: SaleRecord, ctx: ReceiptContext): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const lines = receiptLines(sale, ctx).map((l) => `<div class="${[l.bold ? "b" : "", l.big ? "big" : ""].join(" ").trim()}">${esc(l.text) || "&nbsp;"}</div>`).join("");
  const widthMm = ctx.settings.paper_width === 80 ? 72 : 48;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sale.receipt_no)}</title><style>
@page { size: ${widthMm + 8}mm auto; margin: 4mm; } body { margin: 0; font-family: "Courier New", monospace; font-size: 10.5pt; }
.r { width: ${widthMm}mm; white-space: pre; line-height: 1.25; } .b { font-weight: 700; } .big { font-size: 12.5pt; } .bc { margin-top: 6px; text-align: center; }
</style></head><body><div class="r">${lines}</div>${ctx.settings.print_receipt_barcode ? `<div class="bc">${esc(sale.receipt_no)}</div>` : ""}</body></html>`;
}
