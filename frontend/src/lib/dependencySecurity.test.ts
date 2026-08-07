import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_BRANDING,
  clearBrandingLogoCache,
  setBrandingCache,
} from "./branding";

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, "HOUZS");
  clearBrandingLogoCache();
  vi.unstubAllGlobals();
});

describe("security-upgraded document dependencies", () => {
  test("jsPDF and AutoTable still generate a non-empty document", async () => {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const doc = new jsPDF();
    doc.text("Houzs ERP", 14, 14);
    autoTable(doc, {
      head: [["Document", "Status"]],
      body: [["SO-TEST", "Draft"]],
    });

    const bytes = doc.output("arraybuffer");
    expect(bytes.byteLength).toBeGreaterThan(500);
  });

  test("SheetJS 0.20.x writes and reads the export/import contract", async () => {
    const XLSX = await import("./xlsx-runtime");
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Code", "Quantity"],
      ["SKU-TEST", 3],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Items");
    const bytes = XLSX.writeXLSX(workbook, { type: "array" });
    const parsed = XLSX.read(bytes, { type: "array" });

    expect(parsed.SheetNames).toEqual(["Items"]);
    expect(XLSX.utils.sheet_to_json(parsed.Sheets["Items"]!, { header: 1 }))
      .toEqual([["Code", "Quantity"], ["SKU-TEST", 3]]);
  });

  test("the production facade still reads legacy BIFF8 .xls workbooks", async () => {
    // Generate a real OLE/BIFF8 workbook in memory. Keeping the producer here is
    // reviewable and avoids committing an opaque binary fixture; production
    // remains limited to the four exports in xlsx-runtime.
    const fullSheetJs = await import("xlsx");
    const sheet = fullSheetJs.utils.aoa_to_sheet([
      ["Code", "Quantity"],
      ["LEGACY-SKU", 7],
    ]);
    const workbook = fullSheetJs.utils.book_new();
    fullSheetJs.utils.book_append_sheet(workbook, sheet, "Legacy");
    const legacyBytes = new Uint8Array(fullSheetJs.write(workbook, {
      bookType: "xls",
      type: "array",
    }) as ArrayBuffer);

    // BIFF8 .xls is wrapped in an OLE Compound File, whose fixed signature
    // proves this is exercising the legacy binary parser rather than XLSX.
    expect(Array.from(legacyBytes.slice(0, 8))).toEqual([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);

    const XLSX = await import("./xlsx-runtime");
    const parsed = XLSX.read(legacyBytes, { type: "array" });
    expect(XLSX.utils.sheet_to_json(parsed.Sheets["Legacy"]!, { header: 1 }))
      .toEqual([["Code", "Quantity"], ["LEGACY-SKU", 7]]);
  });

  test("a real HOUZS delivery PDF renders live branding and embeds its CJK font", async () => {
    const requestedFonts: string[] = [];
    let fontFetchFailure: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const url = new URL(rawUrl, window.location.href).pathname;
      if (!url.startsWith("/fonts/")) {
        throw new Error(`Unexpected fetch in PDF smoke test: ${rawUrl}`);
      }
      requestedFonts.push(url);
      try {
        const bytes = await readFile(resolve("public", url.slice(1)));
        const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return {
          ok: true,
          arrayBuffer: async () => body,
        } as Response;
      } catch (error) {
        fontFetchFailure = error;
        throw error;
      }
    }));

    const testBranding = {
      ...DEFAULT_BRANDING,
      companyName: "HOUZS 测试公司",
      address: "中文地址, Selangor",
      postcode: "43300",
      logoR2Key: "",
    };
    setBrandingCache(testBranding, "HOUZS");

    const [{ jsPDF }, { default: autoTable }, { renderDeliveryOrderInto }] =
      await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
        import("../vendor/scm/lib/delivery-order-pdf"),
      ]);
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const drawnText: unknown[] = [];
    const originalText = doc.text.bind(doc);
    vi.spyOn(doc, "text").mockImplementation(((...args: Parameters<typeof doc.text>) => {
      drawnText.push(args[0]);
      return originalText(...args);
    }) as typeof doc.text);

    try {
      await renderDeliveryOrderInto(
        doc,
        autoTable,
        {
          do_number: "DO-CJK-001",
          status: "draft",
          do_date: "2026-07-21",
          so_doc_no: "SO-CJK-001",
          debtor_code: "CJK-001",
          debtor_name: "中文客户",
          expected_delivery_at: null,
          dispatched_at: null,
          signed_at: null,
          delivered_at: null,
          driver_name: null,
          vehicle: null,
          address1: "测试路 1 号",
          address2: null,
          city: "Seri Kembangan",
          state: "Selangor",
          postcode: "43300",
          phone: null,
          notes: "中文备注",
          m3_total_milli: 1250,
        },
        [{
          item_code: "SKU-CJK",
          description: "测试沙发",
          qty: 1,
          m3_milli: 1250,
          unit_price_centi: 10000,
          source_pos: ["PO-001"],
          racks: ["RACK-A1"],
        }],
      );
    } catch (error) {
      throw new Error(
        `Headless HOUZS PDF render failed after ${requestedFonts.join(", ")}: ${String(fontFetchFailure ?? error)}`,
        { cause: error },
      );
    }

    const flattenedText = drawnText.flatMap((value) =>
      Array.isArray(value) ? value.map(String) : [String(value)]
    );
    expect(flattenedText).toContain(testBranding.companyName);
    // The Theme C DO (2026-08-07) labels the name inside the Deliver To panel
    // ("Customer :  中文客户"), so it reaches the page within a line rather than
    // as one. What this guards is that it reaches the page at all, through the
    // CJK font — not how it is labelled.
    expect(flattenedText.some((line) => line.includes("中文客户"))).toBe(true);
    expect(requestedFonts.sort()).toEqual([
      "/fonts/noto-sans-sc-hanzi-400.ttf",
      "/fonts/noto-sans-sc-hanzi-700.ttf",
    ]);
    expect(doc.getFont().fontName).toBe("NotoSansSC");

    const bytes = new Uint8Array(doc.output("arraybuffer"));
    const pdfAscii = new TextDecoder("latin1").decode(bytes);
    expect(bytes.byteLength).toBeGreaterThan(100_000);
    expect(pdfAscii.startsWith("%PDF-")).toBe(true);
    expect(pdfAscii).toContain("NotoSansSC");
  }, 20_000);
});
