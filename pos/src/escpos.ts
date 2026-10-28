/* ESC/POS bytes for a 58 / 80 mm thermal printer: text lines, bold, size,
 * alignment, a Code 128 barcode of the receipt number (GS k), feed and cut.
 * Pure: lines in, Uint8Array out. */
import type { ReceiptLine } from "./receipt";

const ESC = 0x1b;
const GS = 0x1d;

export function escposBytes(lines: readonly ReceiptLine[], opts: { barcode: string | null; copies: number; cut: boolean }): Uint8Array {
  const out: number[] = [];
  const enc = new TextEncoder();
  const text = (s: string) => { for (const b of enc.encode(s.replace(/[^\x20-\x7e]/g, "?"))) out.push(b); };
  for (let copy = 0; copy < Math.max(1, opts.copies); copy++) {
    out.push(ESC, 0x40); // init
    out.push(ESC, 0x74, 0x00); // codepage 437
    for (const l of lines) {
      out.push(ESC, 0x61, l.center ? 0x01 : 0x00);
      out.push(ESC, 0x45, l.bold ? 0x01 : 0x00);
      out.push(GS, 0x21, l.big ? 0x11 : 0x00);
      text(l.center ? l.text.trim() : l.text);
      out.push(0x0a);
    }
    out.push(ESC, 0x45, 0x00, GS, 0x21, 0x00);
    if (opts.barcode) {
      out.push(ESC, 0x61, 0x01);
      out.push(GS, 0x68, 0x40); // height 64 dots
      out.push(GS, 0x77, 0x02); // module width 2
      out.push(GS, 0x48, 0x02); // HRI below
      out.push(GS, 0x66, 0x00);
      const code = opts.barcode.replace(/[^\x20-\x7e]/g, "");
      out.push(GS, 0x6b, 0x49, code.length + 2, 0x7b, 0x42); // Code128, set B
      text(code);
    }
    out.push(0x0a, 0x0a, 0x0a);
    if (opts.cut) out.push(GS, 0x56, 0x42, 0x00); // partial cut with feed
  }
  return Uint8Array.from(out);
}
