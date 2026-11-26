
import { PDF_THUMB_PX, sniffImageMime, type PdfPhotoImage } from './pdf-item-photos';

/**
 * Decode any browser-displayable image blob and re-encode it as a JPEG data URL
 * for jsPDF. Returns null on ANY failure — undecodable bytes, no canvas in this
 * environment — and never throws; the caller skips the photo.
 *
 * THE WHOLE PHOTO, NOT A CENTRE CROP (owner, 2026-08-28). It used to force a
 * square by cropping to the shorter side, which silently threw away the top and
 * bottom of every portrait photo — and a purchaser's photo is very often
 * portrait BECAUSE it is a tape measure held against a panel. Cropping cut off
 * the two ends of the measurement, which is the one thing the photo was taken to
 * show.
 *
 * The tile stays square; the image is letterboxed inside it on white, so the
 * grid layout is untouched and nothing below has to move. The returned aspect
 * ratio lets the caller size it — see drawPhotoTile.
 */
export async function blobToSquarePdfImage(blob: Blob): Promise<PdfPhotoImage | null> {
  return blobToPdfImageAt(blob, PDF_THUMB_PX);
}

/** The emailed PO uses this. A supplier PDF is capped at 5 MB by the send
 *  route, and at 1536 px a detailed photo costs ~360 kB (measured 2026-11-09),
 *  so about fourteen of them already pass the cap. 800 px is the Conts value
 *  and cut the same photo to ~110 kB. */
export const PDF_EMAIL_PHOTO_PX = 800;

export function pdfImageAt(maxPx: number): (blob: Blob) => Promise<PdfPhotoImage | null> {
  return (blob) => blobToPdfImageAt(blob, maxPx);
}

async function blobToPdfImageAt(blob: Blob, maxPx: number): Promise<PdfPhotoImage | null> {
  try {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const declared = (blob.type || '').toLowerCase();
    const mime = declared.startsWith('image/') ? declared : sniffImageMime(bytes);
    if (!mime) return null;
    const typed = declared === mime ? blob : new Blob([bytes], { type: mime });
    const bitmap = await createImageBitmap(typed);
    try {
      const longest = Math.max(bitmap.width, bitmap.height);
      if (!(longest > 0)) return null;
      const scale = Math.min(1, maxPx / longest);
      const cw = Math.max(1, Math.round(bitmap.width * scale));
      const ch = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, cw, ch);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      if (dataUrl.startsWith('data:image/jpeg')) return { dataUrl, format: 'JPEG', w: cw, h: ch };
      if (dataUrl.startsWith('data:image/png')) return { dataUrl, format: 'PNG', w: cw, h: ch };
      return null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}
