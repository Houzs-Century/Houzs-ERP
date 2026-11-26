// The server-drawn SO / PO PDFs inside workerd itself, not Node: jsPDF, the
// autotable plugin, Intl number formatting and the shared layout all have to
// work in the runtime production uses. The fixtures carry no Chinese, so no font
// file is needed (workerd has no filesystem); the Chinese path is covered in
// mcpServerPdf.test.ts. Also the export link that serves the stored file.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import mcpRoutes from "../src/routes/mcp";
import { purchaseOrderPdf, salesOrderPdf, type PdfReader } from "../src/services/mcp-pdf";
import { pdfDisposition } from "../src/services/mcp-actions";
import { BRANDING, FABRICS, PAYMENTS, PO, PO_ID, SO } from "./mcpServerPdf.fixtures";

const latin = <T>(v: T): T =>
  JSON.parse(JSON.stringify(v).replace(/[\u0080-￿]+/g, "x")) as T;

function reader(): PdfReader {
  const table: Record<string, unknown> = latin({
    "/api/branding": BRANDING,
    "/api/scm/mfg-sales-orders/HC-SO-099001": { ...SO, items: SO.items.map((l) => ({ ...l, photo_urls: null })) },
    "/api/scm/mfg-sales-orders/HC-SO-099001/payments": PAYMENTS,
    "/api/scm/fabric-tracking": FABRICS,
    [`/api/scm/mfg-purchase-orders/${PO_ID}`]: PO,
    "/api/scm/inventory/warehouses?includeInactive=true": { warehouses: [{ id: "wh-1", code: "WH-KL", location: "Puchong" }] },
    "/api/scm/suppliers/sup-1": { supplier: { id: "sup-1", payment_terms: "NET 30" }, bindings: [] },
  });
  return {
    async json<T>(path: string): Promise<T> {
      if (!(path in table)) throw new Error(`no fixture for ${path}`);
      return structuredClone(table[path]) as T;
    },
    async bytes() {
      return { status: 404, contentType: "application/json", companyCode: null, body: new Uint8Array() };
    },
    async asset(path: string): Promise<Uint8Array> {
      throw new Error(`no font expected for a Latin document: ${path}`);
    },
  };
}

const content = (pdf: Uint8Array): string => new TextDecoder("latin1").decode(pdf);

describe("server PDFs in workerd", () => {
  it("draws the Sales Order", async () => {
    const pdf = await salesOrderPdf(reader(), "HC-SO-099001");
    expect(content(pdf.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(pdf.pages).toBeGreaterThanOrEqual(2);
    expect(pdf.filename).toMatch(/^HC-SO-099001-/);
  });

  it("draws the Purchase Order", async () => {
    const pdf = await purchaseOrderPdf(reader(), PO_ID);
    expect(content(pdf.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(pdf.pages).toBe(1);
    expect(pdf.filename).toMatch(/^HC-PO-2611-001_R1-/);
  });
});

describe("GET /api/mcp/export/:key", () => {
  const key = "k".repeat(43);
  const bucket = (env as unknown as { POD_BUCKET: R2Bucket }).POD_BUCKET;
  const get = (k: string) => mcpRoutes.request(`/export/${k}`, {}, env);

  it("serves a stored PDF as a download under its own name", async () => {
    const pdf = await salesOrderPdf(reader(), "HC-SO-099001");
    await bucket.put(`mcp-exports/${key}.pdf`, pdf.bytes, {
      httpMetadata: { contentType: "application/pdf", contentDisposition: pdfDisposition(pdf.filename) },
      customMetadata: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    const res = await get(key);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(pdf.filename)}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(pdf.bytes.byteLength);
  });

  it("refuses an expired link and drops the file", async () => {
    const old = "e".repeat(43);
    await bucket.put(`mcp-exports/${old}.pdf`, new Uint8Array([37, 80, 68, 70]), { customMetadata: { expiresAt: new Date(Date.now() - 1).toISOString() } });
    expect((await get(old)).status).toBe(410);
    expect(await bucket.head(`mcp-exports/${old}.pdf`)).toBeNull();
  });

  it("still serves the HTML printouts, sandboxed", async () => {
    const html = "h".repeat(43);
    await bucket.put(`mcp-exports/${html}.html`, "<p>case</p>", { customMetadata: { expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const res = await get(html);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});
