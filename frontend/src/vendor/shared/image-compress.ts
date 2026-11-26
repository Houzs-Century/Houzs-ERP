
import { rasterizeScannerPdf } from './pdf-rasterize';

const SKIP_UNDER_BYTES = 2 * 1024 * 1024;
const MAX_EDGE_PX = 2000;
const JPEG_QUALITY = 0.85;

const isImage = (file: File): boolean => file.type.startsWith('image/');

function toJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * Re-render an image file to a ~150-DPI-equivalent JPEG for OCR upload.
 * Returns the ORIGINAL file whenever compressing would not help or cannot be
 * done — a compression bug must never block a scan.
 */
export async function compressForOcr(file: File): Promise<File> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return rasterizeScannerPdf(file);
  if (!isImage(file)) return file;
  if (file.size <= SKIP_UNDER_BYTES) return file;

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const longEdge = Math.max(bitmap.width, bitmap.height);
      const scale = Math.min(1, MAX_EDGE_PX / longEdge);
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);
      if (!width || !height) return file;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);

      const blob = await toJpegBlob(canvas, JPEG_QUALITY);
      if (!blob || blob.size >= file.size) return file;

      const name = file.name.replace(/\.[^.]+$/, '') || 'scan';
      return new File([blob], `${name}.jpg`, {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}

/** compressForOcr over a list, preserving order. */
export async function compressAllForOcr(files: File[]): Promise<File[]> {
  return Promise.all(files.map((f) => compressForOcr(f)));
}
