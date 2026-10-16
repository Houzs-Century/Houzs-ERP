/* Barcode labels (layout E1b): the same label (name, code, price, barcode,
 * number) three ways — an A4 sheet of 40 x 30 mm labels for the browser's
 * print dialog, a TSPL job for a TSC-style label printer, a ZPL job for a
 * Zebra. Pure: strings in, strings out. */
import { ean13Svg, isValidEan13 } from "../../vendor/shared/ean13";

export type LabelSpec = {
  name: string;
  code: string;
  /** RM text, already formatted, or null to leave the price off. */
  price: string | null;
  barcode: string;
  qty: number;
};

/** One label per unit of qty, in the order given. */
export function expandLabels(specs: readonly LabelSpec[]): LabelSpec[] {
  const out: LabelSpec[] = [];
  for (const s of specs) for (let i = 0; i < Math.max(0, Math.min(500, Math.floor(s.qty))); i++) out.push({ ...s, qty: 1 });
  return out;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A4 portrait, 5 columns x 9 rows of 40 x 30 mm, 5 mm side margin. */
export function labelSheetHtml(specs: readonly LabelSpec[]): string {
  const labels = expandLabels(specs);
  const cells = labels
    .map((l) => {
      const bars = isValidEan13(l.barcode)
        ? ean13Svg(l.barcode, { module: 1, height: 28, showText: true })
        : `<div class="raw">${esc(l.barcode)}</div>`;
      return `<div class="label"><div class="name">${esc(l.name)}</div><div class="meta"><span>${esc(l.code)}</span>${l.price ? `<span class="price">RM ${esc(l.price)}</span>` : ""}</div><div class="bars">${bars}</div></div>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title><style>
@page { size: A4 portrait; margin: 13mm 5mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
.sheet { display: grid; grid-template-columns: repeat(5, 40mm); grid-auto-rows: 30mm; }
.label { width: 40mm; height: 30mm; padding: 1.5mm 2mm; overflow: hidden; display: flex; flex-direction: column; break-inside: avoid; }
.name { font-size: 8pt; font-weight: 700; line-height: 1.1; max-height: 2.2em; overflow: hidden; }
.meta { display: flex; justify-content: space-between; font-size: 7pt; margin-top: 0.5mm; }
.price { font-weight: 700; }
.bars { margin-top: auto; }
.bars svg { width: 36mm; height: auto; display: block; }
.raw { font-family: monospace; font-size: 9pt; }
</style></head><body><div class="sheet">${cells}</div></body></html>`;
}

const tsplText = (s: string): string => s.replace(/"/g, "'");

/** TSPL (TSC and compatible): one PRINT per label with its qty. */
export function labelsTspl(specs: readonly LabelSpec[]): string {
  return specs
    .filter((s) => s.qty > 0)
    .map((s) => {
      const kind = isValidEan13(s.barcode) ? "EAN13" : "128";
      return [
        "SIZE 40 mm,30 mm",
        "GAP 2 mm,0",
        "DIRECTION 1",
        "CLS",
        `TEXT 16,12,"2",0,1,1,"${tsplText(s.name.slice(0, 28))}"`,
        `TEXT 16,44,"1",0,1,1,"${tsplText(s.code)}${s.price ? `  RM ${s.price}` : ""}"`,
        `BARCODE 24,76,"${kind}",72,1,0,2,2,"${s.barcode}"`,
        `PRINT 1,${Math.min(500, Math.floor(s.qty))}`,
      ].join("\n");
    })
    .join("\n") + "\n";
}

/** ZPL (Zebra): 203 dpi, 40 x 30 mm = 320 x 240 dots. */
export function labelsZpl(specs: readonly LabelSpec[]): string {
  return specs
    .filter((s) => s.qty > 0)
    .map((s) => {
      const bar = isValidEan13(s.barcode) ? `^BEN,70,Y,N^FD${s.barcode.slice(0, 12)}^FS` : `^BCN,70,Y,N,N^FD${s.barcode}^FS`;
      return [
        "^XA",
        "^PW320",
        "^LL240",
        `^FO16,12^A0N,22,22^FB288,2,0,L^FD${s.name.slice(0, 40)}^FS`,
        `^FO16,60^A0N,18,18^FD${s.code}${s.price ? `  RM ${s.price}` : ""}^FS`,
        `^FO40,96${bar}`,
        `^PQ${Math.min(500, Math.floor(s.qty))}`,
        "^XZ",
      ].join("\n");
    })
    .join("\n") + "\n";
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function openPrintWindow(html: string): boolean {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
  return true;
}
