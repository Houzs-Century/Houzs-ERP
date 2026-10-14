/* The live receipt preview on SST & Receipt (layout E4): a sample bill laid
 * out the AutoCount way on 58 or 80 mm paper, from the settings as typed.
 * Pure: settings in, text lines out. The booth app's real ESC/POS layout
 * (step 5) follows the same column rule, 32 columns at 58 mm, 48 at 80 mm. */
import { receiptHeaderLines, type SstReceiptSettings } from "../../vendor/shared/pos-settings";

export const receiptColumns = (paperWidth: 58 | 80): number => (paperWidth === 80 ? 48 : 32);

const center = (s: string, w: number): string => {
  const t = s.slice(0, w);
  const pad = Math.max(0, Math.floor((w - t.length) / 2));
  return " ".repeat(pad) + t;
};
const lr = (l: string, r: string, w: number): string => {
  const right = r.slice(0, w);
  const left = l.slice(0, Math.max(0, w - right.length - 1));
  return left + " ".repeat(Math.max(1, w - left.length - right.length)) + right;
};
const money = (sen: number): string => (sen / 100).toFixed(2);

export type SampleBill = {
  company: string;
  ssm: string;
  event: string;
  receipt_no: string;
  terminal: string;
  salesman: string;
  cashier: string;
  date: string;
  lines: { code: string; description: string; qty: number; price_sen: number; discount_sen: number; foc: boolean }[];
  paid_by: { method: string; amount_sen: number }[];
};

export const SAMPLE_BILL: SampleBill = {
  company: "HOUZS CENTURY SDN BHD",
  ssm: "SSM 123456-X",
  event: "AEON Tebrau Cash & Carry",
  receipt_no: "T02-000279",
  terminal: "T02",
  salesman: "Farah",
  cashier: "Aina",
  date: "14/10/2026 03:15 PM",
  lines: [
    { code: "PL-01", description: "Akemi Pillow Soft", qty: 2, price_sen: 5990, discount_sen: 1198, foc: false },
    { code: "BS-QN", description: "Bedsheet Set Queen", qty: 1, price_sen: 15900, discount_sen: 0, foc: false },
    { code: "GF-01", description: "Gift Mug", qty: 1, price_sen: 1500, discount_sen: 0, foc: true },
  ],
  paid_by: [{ method: "QR / DuitNow", amount_sen: 0 }],
};

export function receiptPreviewLines(s: SstReceiptSettings, bill: SampleBill, sstTicked: boolean): string[] {
  const w = receiptColumns(s.paper_width);
  const out: string[] = [];
  out.push(center(bill.company, w));
  out.push(center(bill.ssm, w));
  for (const h of receiptHeaderLines(s, bill.event)) out.push(center(h, w));
  if (sstTicked && s.sst_reg_no) out.push(center(`SST No: ${s.sst_reg_no}`, w));
  out.push(center(s.receipt_title || "SALES INVOICE", w));
  out.push("-".repeat(w));
  out.push(lr("DESC", "QTY  PRICE  AMOUNT", w));
  out.push("-".repeat(w));
  let subtotal = 0;
  let discount = 0;
  for (const l of bill.lines) {
    const gross = l.qty * l.price_sen;
    const amount = l.foc ? 0 : gross - l.discount_sen;
    subtotal += l.foc ? 0 : gross;
    discount += l.foc ? 0 : l.discount_sen;
    out.push(`${l.code} ${l.description}`.slice(0, w));
    out.push(lr("", `${l.qty} x ${money(l.price_sen)}  ${money(amount)}`, w));
    if (l.foc) out.push(lr("  FOC", `-${money(gross)}`, w));
    else if (l.discount_sen > 0) out.push(lr("  Discount", `-${money(l.discount_sen)}`, w));
  }
  out.push("-".repeat(w));
  const net = subtotal - discount;
  const sstSen = sstTicked ? Math.round((net * s.sst_rate) / 100) : 0;
  out.push(lr("Sub Total", money(subtotal), w));
  if (discount > 0) out.push(lr("Total Discount", `-${money(discount)}`, w));
  if (sstTicked || s.show_sst_when_zero) out.push(lr(`SST ${s.sst_rate}%`, money(sstSen), w));
  const total = net + sstSen;
  const rounding = s.rounding_on_cash && bill.paid_by.some((p) => p.method === "Cash") ? Math.round(total / 5) * 5 - total : 0;
  if (rounding !== 0) out.push(lr("Rounding Adj", money(rounding), w));
  out.push(lr("FINAL TOTAL", money(total + rounding), w));
  for (const p of bill.paid_by) out.push(lr(p.method, money(p.amount_sen || total + rounding), w));
  out.push("-".repeat(w));
  out.push(`Receipt# ${bill.receipt_no}  Terminal ${bill.terminal}`.slice(0, w));
  out.push(`Date ${bill.date}`);
  if (s.show_salesman) out.push(`Salesman ${bill.salesman}`);
  if (s.show_cashier) out.push(`Cashier ${bill.cashier}`);
  if (s.footer) for (const f of s.footer.split("\n")) out.push(center(f, w));
  if (s.print_receipt_barcode) out.push(center(`|| ${bill.receipt_no} ||`, w));
  return out;
}
