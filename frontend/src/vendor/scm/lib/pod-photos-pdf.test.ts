// pod-photos-pdf — a job's POD photos as one A4 PDF, two per page, each page
// carrying the document number and each photo its time (to send on WhatsApp
// instead of N separate JPGs).
import { describe, expect, it, vi } from 'vitest';
import {
  buildPodPhotosPdf, fitInSlot, makePodPhotosPdf, pageCount, photoCaption, podPhotosPdfFilename,
  SLOT_H, SLOT_W, type PodPdfPhoto,
} from './pod-photos-pdf';
import type { PdfPhotoImage } from './pdf-item-photos';
import { pdfRawText } from './pdf-raw-text';

// A real 4x3 JPEG: jsPDF parses the bytes, so a fake data URL would not embed.
const JPEG: PdfPhotoImage = { dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAAAwAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAwAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z', format: 'JPEG', w: 4, h: 3 };
const photo = (storedAt: string | null): PodPdfPhoto => ({ image: JPEG, storedAt });
const pdfText = (doc: import('jspdf').jsPDF) => pdfRawText(new Uint8Array(doc.output('arraybuffer')));

describe('pod photos PDF layout', () => {
  it('puts two photos on a page', () => {
    expect([0, 1, 2, 3, 7].map(pageCount)).toEqual([1, 1, 1, 2, 4]);
  });

  it('keeps the whole photo inside its half page, aspect intact', () => {
    const land = fitInSlot(4000, 3000);
    expect(land.w).toBeLessThanOrEqual(SLOT_W + 1e-9);
    expect(land.h).toBeLessThanOrEqual(SLOT_H + 1e-9);
    expect(land.w / land.h).toBeCloseTo(4 / 3);
    const port = fitInSlot(3000, 4000);
    expect(port.h).toBeCloseTo(SLOT_H);
    expect(port.w / port.h).toBeCloseTo(3 / 4);
  });

  it('captions each photo with its number and its time in Malaysia time', () => {
    expect(photoCaption(3, 8, '2026-11-09T06:32:00Z')).toBe('Photo 3 of 8  |  Uploaded 2026/11/09 14:32');
    expect(photoCaption(1, 1, null)).toBe('Photo 1 of 1  |  Time not recorded');
  });

  it('names the file after the document', () => {
    expect(podPhotosPdfFilename('DO-2611-004')).toBe('DO-2611-004 POD photos.pdf');
  });
});

describe('buildPodPhotosPdf', () => {
  it('draws 3 photos on 2 pages, the document number on each page and a time under each photo', async () => {
    const doc = await buildPodPhotosPdf({
      title: 'DO-2611-004',
      photos: [photo('Mon, 09 Nov 2026 06:32:00 GMT'), photo('2026-11-09T06:40:00Z'), photo(null)],
      skipped: 1,
    });
    expect(doc.getNumberOfPages()).toBe(2);
    const text = pdfText(doc);
    expect(text.match(/\(DO-2611-004\) Tj/g)).toHaveLength(2);
    expect(text).toContain('Page 1 of 2');
    expect(text).toContain('Page 2 of 2');
    expect(text).toContain('Photo 1 of 3  |  Uploaded 2026/11/09 14:32');
    expect(text).toContain('Photo 2 of 3  |  Uploaded 2026/11/09 14:40');
    expect(text).toContain('Photo 3 of 3  |  Time not recorded');
    expect(text.match(/1 photo could not be read/g)).toHaveLength(1);
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(1);
  });
});

describe('makePodPhotosPdf', () => {
  it('fetches every photo, skips one it cannot read, reports progress, and returns a PDF', async () => {
    const fetchPhoto = vi.fn(async (p: string) => {
      if (p === '/p/1') throw new Error('404');
      return { blob: new Blob(['x']), storedAt: '2026-11-09T06:32:00Z' };
    });
    const progress: string[] = [];
    const out = await makePodPhotosPdf({
      title: 'DP-0001', paths: ['/p/0', '/p/1', '/p/2', '/p/3', '/p/4'], fetchPhoto,
      shrink: async () => JPEG,
      onProgress: (d, t) => progress.push(`${d}/${t}`),
    });
    expect(fetchPhoto).toHaveBeenCalledTimes(5);
    expect(progress).toEqual(['4/5', '5/5']);
    expect(out.skipped).toBe(1);
    expect(out.filename).toBe('DP-0001 POD photos.pdf');
    expect(out.blob.type).toBe('application/pdf');
  });

  it('refuses to make an empty PDF when no photo could be read', async () => {
    await expect(makePodPhotosPdf({
      title: 'DP-0001', paths: ['/p/0'], fetchPhoto: async () => ({ blob: new Blob(['x']), storedAt: null }),
      shrink: async () => null,
    })).rejects.toThrow('None of the photos could be read');
  });
});
