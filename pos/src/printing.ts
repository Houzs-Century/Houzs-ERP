/* Printing glue: a sale → receipt lines → ESC/POS → the paired printer, and
 * the same receipt as an HTML page for the e-receipt (Save as PDF / share). */
import { escposBytes } from "./escpos";
import { printBytes, printerStatus } from "./printer";
import { receiptHtml, receiptLines, type ReceiptContext } from "./receipt";
import type { SaleRecord } from "./sale";
import type { DeviceState } from "./types";

export function receiptContext(state: DeviceState, kind: ReceiptContext["kind"]): ReceiptContext {
  return { company: state.bundle.company, event_name: state.bundle.event.receipt_header || state.bundle.event.name, settings: state.bundle.settings.sst_receipt, kind };
}

export type PrintResult = { ok: true } | { ok: false; reason: string; noPrinter: boolean };

export async function printSale(sale: SaleRecord, state: DeviceState, kind: ReceiptContext["kind"]): Promise<PrintResult> {
  const s = state.bundle.settings.sst_receipt;
  if (!printerStatus().connected) return { ok: false, reason: "No printer connected", noPrinter: true };
  try {
    const lines = receiptLines(sale, receiptContext(state, kind));
    await printBytes(escposBytes(lines, { barcode: s.print_receipt_barcode ? sale.receipt_no : null, copies: kind === "ORIGINAL" ? s.copies : 1, cut: true }));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Print failed", noPrinter: false };
  }
}

export async function printTestPage(state: DeviceState): Promise<PrintResult> {
  if (!printerStatus().connected) return { ok: false, reason: "No printer connected", noPrinter: true };
  try {
    const w = state.bundle.settings.sst_receipt.paper_width;
    await printBytes(escposBytes([
      { text: state.bundle.company.name, bold: true, center: true },
      { text: "Houzs POS test print", center: true },
      { text: `Terminal ${state.bundle.terminal.code} · ${w} mm`, center: true },
      { text: "-".repeat(w === 80 ? 48 : 32) },
      { text: "0123456789 abcdefghij ABCDEFGHIJ" },
    ], { barcode: "TEST-0001", copies: 1, cut: true }));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Print failed", noPrinter: false };
  }
}

/** The e-receipt: open the receipt as a page the user can share, print or
 *  save as PDF (WhatsApp / email through the browser's share sheet). */
export async function shareReceipt(sale: SaleRecord, state: DeviceState): Promise<boolean> {
  const html = receiptHtml(sale, receiptContext(state, "COPY"));
  const file = new File([html], `${sale.receipt_no}.html`, { type: "text/html" });
  const navAny = navigator as Navigator & { canShare?: (d: { files?: File[] }) => boolean };
  try {
    if (navAny.share && navAny.canShare?.({ files: [file] })) {
      await navAny.share({ files: [file], title: `Receipt ${sale.receipt_no}` });
      return true;
    }
  } catch {
    /* fall through to a window */
  }
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 300);
  return true;
}
