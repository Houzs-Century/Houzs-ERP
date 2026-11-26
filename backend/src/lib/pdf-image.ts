
import { sniffImageMime, type PdfPhotoImage } from "./shared-pdf";

/** Pixel size from a PNG IHDR or a JPEG SOFn marker; null when unreadable. */
export function imageSize(bytes: Uint8Array, mime: "image/jpeg" | "image/png"): { w: number; h: number } | null {
  if (mime === "image/png") {
    if (bytes.length < 24) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const w = dv.getUint32(16);
    const h = dv.getUint32(20);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (bytes[i + 5] << 8) | bytes[i + 6];
      const w = (bytes[i + 7] << 8) | bytes[i + 8];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** base64 without a spread of a megabyte of arguments (chunked, like pdf-common's font reader). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** JPEG / PNG bytes as an embeddable image; null for any other format or unreadable bytes. */
export function pdfImageFromBytes(bytes: Uint8Array): PdfPhotoImage | null {
  const mime = sniffImageMime(bytes);
  if (mime !== "image/jpeg" && mime !== "image/png") return null;
  const size = imageSize(bytes, mime);
  if (!size) return null;
  return { dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`, format: mime === "image/png" ? "PNG" : "JPEG", w: size.w, h: size.h };
}
