// The AI Connector's server-drawn PDFs (src/services/mcp-pdf.ts): a real Sales Order
// and Purchase Order rendered on the Worker path by the browser's own generator,
// with the real Noto Sans SC subsets from frontend/public/fonts. Light project:
// it reads those font files from disk, which workerd cannot.
//
// The text is checked through the PDF's own ToUnicode maps (with the CJK font
// embedded every string is drawn as glyph ids), so "contains 陈大文" means a
// reader that copies text out of the file gets 陈大文 back.
//
// MCP_PDF_OUT=<dir> writes the two PDFs there, for looking at them.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { grnPdf, PdfReadError, purchaseOrderPdf, salesInvoicePdf, salesOrderPdf, type PdfReader } from "../src/services/mcp-pdf";
import { imageSize, pdfImageFromBytes } from "../src/lib/pdf-image";
import { BRANDING, FABRICS, PAYMENTS, PO, PO_ID, SO, TINY_JPEG } from "./mcpServerPdf.fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const FONTS = resolve(here, "../../frontend/public");

type Fail = { status: number; message: string };

/** A reader that answers from fixtures, the way routes/mcp.ts answers from the ERP. */
function fixtureReader(over: { json?: Record<string, unknown | Fail>; branding?: typeof BRANDING } = {}): PdfReader & { reads: string[] } {
  const reads: string[] = [];
  const table: Record<string, unknown> = {
    "/api/branding": over.branding ?? BRANDING,
    "/api/scm/mfg-sales-orders/HC-SO-099001": SO,
    "/api/scm/mfg-sales-orders/HC-SO-099001/payments": PAYMENTS,
    "/api/scm/fabric-tracking": FABRICS,
    "/api/scm/mfg-products/categories": { categories: [{ code: "SOFA", name: "Sofa", isActive: true }, { code: "MATTRESS", name: "Mattress", isActive: true }] },
    [`/api/scm/mfg-purchase-orders/${PO_ID}`]: PO,
    "/api/scm/inventory/warehouses?includeInactive=true": { warehouses: [{ id: "wh-1", code: "WH-KL", location: "Lot 5, Jalan Gudang, 47100 Puchong" }] },
    "/api/scm/suppliers/sup-1": { supplier: { id: "sup-1", code: "S-CN01", name: "佛山市家具有限公司", fax: "+86 757 1234 0000", payment_terms: "NET 30" }, bindings: [] },
    ...over.json,
  };
  return {
    reads,
    async json<T>(path: string): Promise<T> {
      reads.push(path);
      if (!(path in table)) throw new PdfReadError(404, `no fixture for ${path}`, "missing");
      const v = table[path] as { status?: number; message?: string };
      if (v && typeof v.status === "number" && typeof v.message === "string") throw new PdfReadError(v.status, v.message, "fixture");
      return structuredClone(v) as T;
    },
    async bytes(path: string) {
      reads.push(path);
      if (path.includes("/photos/") && !path.includes(".thumb")) return { status: 200, contentType: "image/jpeg", companyCode: null, body: TINY_JPEG.slice() };
      return { status: 404, contentType: "application/json", companyCode: null, body: new Uint8Array() };
    },
    async asset(path: string) {
      return new Uint8Array(readFileSync(resolve(FONTS, `.${path}`)));
    },
  };
}

/* ── reading the text back out of the PDF ─────────────────────────────────── */

const inflated = (pdf: Uint8Array): string =>
  Buffer.from(pdf)
    .toString("latin1")
    .replace(/stream\n([\s\S]*?)\nendstream/g, (whole, body: string) => {
      try {
        return `stream\n${inflateSync(Buffer.from(body, "latin1")).toString("latin1")}\nendstream`;
      } catch {
        return whole;
      }
    });

/** Every string drawn on the pages, decoded through the fonts' ToUnicode maps (glyph id → character). */
function pdfText(pdf: Uint8Array): string {
  const raw = inflated(pdf);
  const map = new Map<string, string>();
  for (const block of raw.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(m[1].toLowerCase().padStart(4, "0"), String.fromCodePoint(parseInt(m[2], 16)));
    }
  }
  const out: string[] = [];
  for (const m of raw.matchAll(/<([0-9a-fA-F]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    if (m[1]) {
      let s = "";
      for (let i = 0; i < m[1].length; i += 4) s += map.get(m[1].slice(i, i + 4).toLowerCase()) ?? "?";
      out.push(s);
    } else out.push(m[2]);
  }
  return out.join("\n");
}

const writeOut = (name: string, pdf: { bytes: Uint8Array; pages: number; ms: number }) => {
  const dir = process.env.MCP_PDF_OUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), pdf.bytes);
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify({ pages: pdf.pages, bytes: pdf.bytes.byteLength, ms: pdf.ms }));
};

describe("server Sales Order PDF", () => {
  it("is the real document: Chinese fields readable, totals and payments printed, cancelled line left out", async () => {
    const pdf = await salesOrderPdf(fixtureReader(), "HC-SO-099001");
    writeOut("so.pdf", pdf);
    expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pdf.filename).toBe("HC-SO-099001-陈大文 Tan Dai Wen.pdf");
    expect(pdf.pages).toBeGreaterThanOrEqual(2);
    const raw = inflated(pdf.bytes);
    expect(raw).toContain("/BaseFont /NotoSansSC"); // the CJK subset is embedded, not helvetica mojibake
    const text = pdfText(pdf.bytes);
    expect(text).toContain("SALES ORDER");
    expect(text).toContain("HC-SO-099001");
    expect(text).toContain("陈大文");
    expect(text).toContain("请在星期六送货");
    expect(text).toContain("Example Living Sdn Bhd"); // the document company's letterhead
    expect(text).toContain("PAYMENTS RECEIVED");
    expect(text).toContain("MDL-039");
    expect(text).not.toContain("MDL-040"); // the cancelled line
    expect(text).toContain("ITEM PHOTOS");
    expect(raw).toMatch(/\/Subtype \/Image/); // the line photo is in the file
  });

  it("makes no document when the person cannot read the order", async () => {
    const r = fixtureReader({ json: { "/api/scm/mfg-sales-orders/HC-SO-099001": { status: 403, message: "Not available to your role" } } });
    await expect(salesOrderPdf(r, "HC-SO-099001")).rejects.toMatchObject({ status: 403 });
  });

  it("makes no document when the payments cannot be read (a blank ledger would tell the customer they owe everything)", async () => {
    const r = fixtureReader({ json: { "/api/scm/mfg-sales-orders/HC-SO-099001/payments": { status: 403, message: "Not available to your role" } } });
    await expect(salesOrderPdf(r, "HC-SO-099001")).rejects.toMatchObject({ status: 403 });
  });

  it("keeps two concurrent renders on their own company's letterhead", async () => {
    const other = { ...BRANDING, branding: { ...BRANDING.branding, companyName: "Second Company Bhd" }, companyCode: "OTHER" };
    const [a, b] = await Promise.all([salesOrderPdf(fixtureReader(), "HC-SO-099001"), salesOrderPdf(fixtureReader({ branding: other }), "HC-SO-099001")]);
    expect(pdfText(a.bytes)).toContain("Example Living Sdn Bhd");
    expect(pdfText(a.bytes)).not.toContain("Second Company Bhd");
    expect(pdfText(b.bytes)).toContain("Second Company Bhd");
    expect(pdfText(b.bytes)).not.toContain("Example Living Sdn Bhd");
  });
});

describe("server Purchase Order PDF", () => {
  it("prints the supplier's Chinese name, the ship-to warehouse and the revision number", async () => {
    const reader = fixtureReader();
    const pdf = await purchaseOrderPdf(reader, PO_ID);
    writeOut("po.pdf", pdf);
    expect(pdf.filename).toBe("HC-PO-2611-001_R1-佛山市家具有限公司.pdf");
    const text = pdfText(pdf.bytes);
    expect(text).toContain("PURCHASE ORDER");
    expect(text).toContain("HC-PO-2611-001_R1");
    expect(text).toContain("佛山市家具有限公司");
    expect(text).toContain("包装要加固");
    expect(text).toContain("WH-KL");
    expect(text).toContain("SUP-1");
    expect(reader.reads).toContain("/api/scm/suppliers/sup-1");
  });
});

const SI = {
  salesInvoice: {
    invoice_number: "HC-INV-2611-001", status: "SENT", so_doc_no: "HC-SO-099001", debtor_code: "C-1", debtor_name: "陈大文 Tan Dai Wen",
    invoice_date: "2026-11-20", due_date: "2026-12-20", currency: "MYR", subtotal_sen: 250000, discount_sen: 0, tax_sen: 0, total_sen: 250000, paid_sen: 50000,
    notes: "请在星期六送货", address1: "12 Jalan Contoh", city: "Puchong", state: "Selangor", postcode: "47100", phone: "0123456789",
  },
  items: [{ item_code: "MDL-039", description: "Sofa 3 seater", qty: 1, unit_price_sen: 250000, line_total_sen: 250000 }],
};
const GRN = {
  grn: {
    grn_number: "HC-GRN-2611-001", status: "POSTED", received_at: "2026-11-21", delivery_note_ref: "DN-88", notes: null, posted_at: "2026-11-21",
    supplier_id: "sup-1", warehouse_name: "KL Warehouse", supplier: { code: "S-CN01", name: "佛山市家具有限公司" }, purchase_order: { id: "po-1", po_number: "HC-PO-2611-001" },
  },
  items: [{ item_code: "MDL-039", material_name: "Sofa frame", qty_received: 2, qty_accepted: 2, qty_rejected: 0, rejection_reason: null, unit_price_sen: 80000, supplier_sku: "FS-39" }],
};

describe("server Sales Invoice and GRN PDFs (round 4)", () => {
  it("draws the sales invoice with the ERP page's own layout, payments and Chinese text", async () => {
    const reader = fixtureReader({ json: { "/api/scm/sales-invoices/inv-1": SI } });
    const pdf = await salesInvoicePdf(reader, "inv-1");
    writeOut("si.pdf", pdf);
    expect(pdf.filename).toBe("HC-INV-2611-001-陈大文 Tan Dai Wen.pdf");
    const text = pdfText(pdf.bytes);
    expect(text).toContain("SALES INVOICE");
    expect(text).toContain("HC-INV-2611-001");
    expect(text).toContain("陈大文");
    expect(text).toContain("Payments received");
    expect(text).toContain("Example Living Sdn Bhd");
  });

  it("draws the GRN with the supplier's Chinese name and the receiving warehouse", async () => {
    const reader = fixtureReader({ json: { "/api/scm/grns/grn-1": GRN } });
    const pdf = await grnPdf(reader, "grn-1");
    writeOut("grn.pdf", pdf);
    expect(pdf.filename).toBe("HC-GRN-2611-001-佛山市家具有限公司.pdf");
    const text = pdfText(pdf.bytes);
    expect(text).toContain("GOODS RECEIPT NOTE");
    expect(text).toContain("佛山市家具有限公司");
    expect(text).toContain("KL Warehouse");
    expect(text).toContain("FS-39");
  });

  it("makes no document when the person cannot read the invoice or the GRN", async () => {
    const r = fixtureReader({ json: { "/api/scm/sales-invoices/inv-1": { status: 403, message: "Not available to your role" }, "/api/scm/grns/grn-1": { status: 403, message: "Not available to your role" } } });
    await expect(salesInvoicePdf(r, "inv-1")).rejects.toMatchObject({ status: 403 });
    await expect(grnPdf(r, "grn-1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("pdf-image", () => {
  it("embeds JPEG / PNG as they are and refuses what jsPDF cannot take", () => {
    expect(imageSize(TINY_JPEG.slice(), "image/jpeg")).toEqual({ w: 16, h: 12 });
    expect(pdfImageFromBytes(TINY_JPEG.slice())?.format).toBe("JPEG");
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);
    expect(pdfImageFromBytes(webp)).toBeNull();
    expect(pdfImageFromBytes(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
