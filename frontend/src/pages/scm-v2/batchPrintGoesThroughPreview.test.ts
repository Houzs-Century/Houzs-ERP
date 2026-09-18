/* Every list that merges several documents into one PDF goes through the Print
 * preview first.
 *
 * The owner's rule since 2026-08-06 (components/scm-v2/PrintPreviewModal.tsx):
 * 「全部打印的时候都需要有这个」. It was rolled out list by list, and on
 * 2026-09-14 the owner found the Purchase Order list's "Print all" still going
 * straight to a combined-or-separate prompt and a download (「PO打印没有这个」).
 * The Sales Invoice list had the same gap. Six lists had the preview and two did
 * not: a rule written at N call sites and present at N-2.
 *
 * So the population is found, not listed: any source file outside the PDF
 * generators that calls a generateCombined...Pdf function is a batch print, and
 * each one must open the preview and ask combined-or-separate only on Download.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
};

const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");
const COMBINED_CALL = /\bgenerateCombined\w*Pdf\(/;
/* The generators DEFINE these functions; they are not a place a person prints from. */
const isGenerator = (p: string) => /^vendor\/scm\/lib\/[\w-]+-pdf\.ts$/.test(rel(p));

const batchPrinters = walk(SRC)
  .filter((p) => !isGenerator(p))
  .filter((p) => COMBINED_CALL.test(readFileSync(p, "utf8")))
  .map((p) => ({ file: rel(p), src: readFileSync(p, "utf8") }));

describe("batch print goes through the Print preview", () => {
  it("the scan finds the batch printers, including the two lists that lacked the preview", () => {
    const files = batchPrinters.map((b) => b.file);
    expect(files).toContain("pages/scm-v2/PurchaseOrdersListV2.tsx");
    expect(files).toContain("pages/scm-v2/SalesInvoicesListV2.tsx");
    expect(files).toContain("pages/scm-v2/GoodsReceivedListV2.tsx");
  });

  it.each(batchPrinters.map((b) => [b.file, b.src] as const))(
    "%s opens the preview, and asks combined-or-separate only on Download",
    (_file, src) => {
      expect(src).toContain("usePrintPreview(");
      expect(src).toContain("<PrintPreviewBatchModal");
      if (src.includes("One combined PDF")) expect(src).toContain('action !== "save"');
    },
  );
});
