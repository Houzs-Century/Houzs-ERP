
import { fmtDateTime } from '@2990s/shared';
import { blobToSquarePdfImage, type PdfPhotoImage } from './pdf-item-photos';
import { safeName } from './pdf-common';
import { PDF_COMPRESS } from './pdf-options';

export type PodPdfPhoto = { image: PdfPhotoImage; storedAt: string | null };

const PAGE_W = 210;
const PAGE_H = 297;
const M = 12;
const HEAD_H = 20;
const CAPTION_H = 8;
const GAP = 4;
export const PHOTOS_PER_PAGE = 2;
/** One photo's box on the page (mm): full measure, half the height left after the header. */
export const SLOT_W = PAGE_W - 2 * M;
export const SLOT_H = (PAGE_H - 2 * M - HEAD_H - PHOTOS_PER_PAGE * CAPTION_H - GAP) / PHOTOS_PER_PAGE;

export const pageCount = (photos: number): number => Math.max(1, Math.ceil(photos / PHOTOS_PER_PAGE));

/** The photo's drawn size inside its slot: whole photo, aspect kept, never cropped. */
export function fitInSlot(w: number, h: number): { w: number; h: number } {
  const s = Math.min(SLOT_W / w, SLOT_H / h);
  return { w: w * s, h: h * s };
}

export const photoCaption = (n: number, total: number, storedAt: string | null): string =>
  `Photo ${n} of ${total}  |  ${storedAt ? `Uploaded ${fmtDateTime(storedAt)}` : 'Time not recorded'}`;

/** Draws the pages. Pure over its inputs: no network, no canvas. */
export async function buildPodPhotosPdf(o: {
  title: string;
  photos: PodPdfPhoto[];
  skipped: number;
}): Promise<import('jspdf').jsPDF> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  doc.setProperties({ title: `${o.title} - POD photos` });
  const total = o.photos.length;
  const pages = pageCount(total);
  const sub = [
    `Proof of delivery  |  ${total} photo${total === 1 ? '' : 's'}`,
    o.skipped ? `${o.skipped} photo${o.skipped === 1 ? '' : 's'} could not be read` : '',
  ];

  for (let p = 0; p < pages; p++) {
    if (p > 0) doc.addPage();
    doc.setTextColor(20, 20, 20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(o.title, M, M + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(105, 105, 100);
    doc.text(`Page ${p + 1} of ${pages}`, PAGE_W - M, M + 5, { align: 'right' });
    doc.text((p === 0 ? sub : sub.slice(0, 1)).filter(Boolean).join('  |  '), M, M + 11);
    doc.setDrawColor(215, 213, 207);
    doc.setLineWidth(0.3);
    doc.line(M, M + 15, PAGE_W - M, M + 15);

    for (let k = 0; k < PHOTOS_PER_PAGE && p * PHOTOS_PER_PAGE + k < total; k++) {
      const i = p * PHOTOS_PER_PAGE + k;
      const photo = o.photos[i];
      const top = M + HEAD_H + k * (SLOT_H + CAPTION_H + GAP);
      const fit = fitInSlot(photo.image.w, photo.image.h);
      doc.addImage(photo.image.dataUrl, photo.image.format, M + (SLOT_W - fit.w) / 2, top + (SLOT_H - fit.h) / 2, fit.w, fit.h);
      doc.setFontSize(10);
      doc.setTextColor(20, 20, 20);
      doc.text(photoCaption(i + 1, total, photo.storedAt), M, top + SLOT_H + 5);
    }
  }
  return doc;
}

export const podPhotosPdfFilename = (title: string): string => `${safeName(title, 40)} POD photos.pdf`;

/**
 * Fetches each photo (four at a time: quicker than one by one, and a phone
 * never holds every full-size photo at once), shrinks it, and builds the PDF.
 * `fetchPhoto` is injected so the album passes its authed client and a test
 * passes a fake.
 */
export async function makePodPhotosPdf(o: {
  title: string;
  paths: string[];
  fetchPhoto: (path: string) => Promise<{ blob: Blob; storedAt: string | null }>;
  onProgress?: (done: number, total: number) => void;
  shrink?: (blob: Blob) => Promise<PdfPhotoImage | null>;
}): Promise<{ blob: Blob; filename: string; skipped: number }> {
  const shrink = o.shrink ?? blobToSquarePdfImage;
  const read: Array<PodPdfPhoto | null> = [];
  for (let i = 0; i < o.paths.length; i += 4) {
    read.push(...await Promise.all(o.paths.slice(i, i + 4).map(async (path) => {
      try {
        const { blob, storedAt } = await o.fetchPhoto(path);
        const image = await shrink(blob);
        return image ? { image, storedAt } : null;
      } catch {
        return null;
      }
    })));
    o.onProgress?.(Math.min(i + 4, o.paths.length), o.paths.length);
  }
  const photos = read.filter((x): x is PodPdfPhoto => x !== null);
  const skipped = read.length - photos.length;
  if (!photos.length) throw new Error('None of the photos could be read, so there is nothing to put in the PDF.');
  const doc = await buildPodPhotosPdf({ title: o.title, photos, skipped });
  return { blob: doc.output('blob'), filename: podPhotosPdfFilename(o.title), skipped };
}
