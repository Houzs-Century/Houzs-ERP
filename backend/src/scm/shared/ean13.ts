/* EAN-13 for the Houzs POS barcode labels (layout E1b): an own barcode is the
 * internal prefix 200 + a nine-digit running number + the check digit, so it
 * can never collide with a factory GS1 code (the 200-299 range is reserved
 * for in-store use). The same module renders the bars for a label.
 *
 * ONE home. backend/src/scm/shared/ean13.ts is the original and
 * frontend/src/vendor/shared/ean13.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */

export const EAN13_INTERNAL_PREFIX = "200";

/** The check digit of the first twelve digits (weights 1,3 from the left). */
export function ean13CheckDigit(twelve: string): number {
  if (!/^\d{12}$/.test(twelve)) throw new Error("ean13CheckDigit: twelve digits expected");
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** The nth internal barcode: 200 + n padded to nine digits + check digit. */
export function internalEan13(runningNo: number): string {
  if (!Number.isInteger(runningNo) || runningNo < 1 || runningNo > 999_999_999) {
    throw new Error("internalEan13: running number out of range");
  }
  const twelve = EAN13_INTERNAL_PREFIX + String(runningNo).padStart(9, "0");
  return twelve + String(ean13CheckDigit(twelve));
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

export function isInternalEan13(code: string): boolean {
  return isValidEan13(code) && code.startsWith(EAN13_INTERNAL_PREFIX);
}

/* ── Rendering ─────────────────────────────────────────────────────────────
   Standard EAN-13 encoding: the first digit picks the L/G parity pattern of
   the left six digits; the right six use R. Each digit is seven modules. */
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** The 95-module bar pattern of a valid EAN-13, as a string of 0/1. */
export function ean13Modules(code: string): string {
  if (!isValidEan13(code)) throw new Error("ean13Modules: not a valid EAN-13");
  const parity = PARITY[Number(code[0])];
  let out = "101";
  for (let i = 1; i <= 6; i++) {
    const d = Number(code[i]);
    out += parity[i - 1] === "L" ? L[d] : G[d];
  }
  out += "01010";
  for (let i = 7; i <= 12; i++) out += R[Number(code[i])];
  out += "101";
  return out;
}

/** The bars as SVG rectangles, so a label sheet and a receipt need no library.
 *  `module` is one bar's width in SVG units; guards extend below the digits. */
export function ean13Svg(code: string, opts: { module: number; height: number; showText: boolean }): string {
  const mods = ean13Modules(code);
  const { module, height, showText } = opts;
  const textH = showText ? module * 9 : 0;
  const width = (95 + 11) * module;
  const rects: string[] = [];
  const guardAt = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);
  for (let i = 0; i < mods.length; i++) {
    if (mods[i] !== "1") continue;
    const h = guardAt.has(i) ? height + textH / 2 : height;
    rects.push(`<rect x="${(i + 11) * module}" y="0" width="${module}" height="${h}" />`);
  }
  const text = showText
    ? `<text x="${6 * module}" y="${height + textH * 0.85}" font-size="${textH * 0.9}" font-family="monospace">${code[0]}</text>` +
      `<text x="${(3 + 11 + 21) * module}" y="${height + textH * 0.85}" font-size="${textH * 0.9}" font-family="monospace" text-anchor="middle">${code.slice(1, 7)}</text>` +
      `<text x="${(50 + 11 + 21) * module}" y="${height + textH * 0.85}" font-size="${textH * 0.9}" font-family="monospace" text-anchor="middle">${code.slice(7)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + textH}" width="${width}" height="${height + textH}" shape-rendering="crispEdges">${rects.join("")}${text}</svg>`;
}
