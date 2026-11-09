// A PO emailed to a supplier is refused outright by the send route above 5 MB,
// and the PDF grows by every embedded photo (measured 2026-11-09 through the
// real generator: ~360 kB per detailed 1536 px photo, so 15 photos = 5.28 MB).
// The emailed PDF now steps down to 800 px photos, then to no photos, instead
// of failing the send.
//
// Stubbed, as in purchase-order-pdf-photos.test.ts: the network and Chrome's
// canvas. The stub encoder returns a JPEG whose size follows the canvas width
// our code chose, so the step-down is driven by our own scaling rule.
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blob as NodeBlob } from 'node:buffer';

vi.mock('../../../hooks/useBranding', () => ({ ensureBrandingForActiveCompany: async () => {} }));

const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoLhcYGRomJygkKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';
const tiny = Buffer.from(TINY_JPEG_B64, 'base64');

vi.mock('./sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchPoItemPhotoBlob: async () => new NodeBlob([tiny], { type: 'image/jpeg' }) as unknown as Blob,
  loadSofaCompartmentArtForPrint: async () => new Map(),
}));

/* Bytes per photo at a given encoded width: 1536 px -> 400 kB, 800 px -> 120 kB. */
const bytesAt = (w: number) => (w >= 1536 ? 400_000 : w >= 800 ? 120_000 : 30_000);

beforeAll(() => {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width: 4032, height: 3024, close() {},
  });
  const proto = globalThis.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = () => ({ fillStyle: '', fillRect() {}, drawImage() {} });
  let n = 0;
  proto.toDataURL = function (this: HTMLCanvasElement) {
    n += 1;
    const pad = Buffer.alloc(bytesAt(this.width), n % 251);
    return 'data:image/jpeg;base64,' + Buffer.concat([tiny, pad]).toString('base64');
  };
});

type PoArgs = Parameters<typeof import('./purchase-order-pdf').purchaseOrderPdfBase64>;

const header: PoArgs[0] = {
  id: 'po-1',
  po_number: 'HC-PO-010148',
  supplier_id: null,
  status: 'SUBMITTED',
  po_date: '2026-09-07',
  expected_at: null,
  currency: 'MYR',
  subtotal_sen: 100000,
  tax_sen: 0,
  total_sen: 100000,
  notes: null,
  supplier: { code: '400-TEST', name: 'TEST SUPPLIER SDN. BHD.', address: '1 JALAN TEST' },
};

const lines = (n: number): PoArgs[1] => Array.from({ length: n }, (_, i) => ({
  id: 'po-line-' + i,
  item_code: 'ITEM-' + i,
  material_name: 'ITEM ' + i,
  supplier_sku: 'SUP-' + i,
  qty: 1,
  unit_price_sen: 1000,
  line_total_sen: 1000,
  uom: 'UNIT',
  item_group: 'accessory',
  so_doc_no: 'HC-SO-013422',
  variants: {},
  photo_urls: ['so-items/HC-SO-013422/x/photo-' + i + '.jpg'],
}));

const imageCount = (b64: string) => (Buffer.from(b64, 'base64').toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;

describe('purchaseOrderPdfForEmail', () => {
  it('keeps full-size photos when the PDF fits', async () => {
    const { purchaseOrderPdfForEmail, base64Bytes, PO_EMAIL_PDF_CAP_BYTES } = await import('./purchase-order-pdf');
    const r = await purchaseOrderPdfForEmail(header, lines(3));
    expect(r.photos).toBe('full');
    expect(base64Bytes(r.pdfBase64)).toBeLessThanOrEqual(PO_EMAIL_PDF_CAP_BYTES);
    expect(base64Bytes(r.pdfBase64)).toBeGreaterThan(3 * 400_000);
    expect(imageCount(r.pdfBase64)).toBe(3);
  });

  it('15 photos pass the cap at full size, so they go at 800 px instead of failing', async () => {
    const { purchaseOrderPdfBase64, purchaseOrderPdfForEmail, base64Bytes, PO_EMAIL_PDF_CAP_BYTES } = await import('./purchase-order-pdf');
    expect(base64Bytes(await purchaseOrderPdfBase64(header, lines(15)))).toBeGreaterThan(PO_EMAIL_PDF_CAP_BYTES);
    const r = await purchaseOrderPdfForEmail(header, lines(15));
    expect(r.photos).toBe('reduced');
    expect(base64Bytes(r.pdfBase64)).toBeLessThanOrEqual(PO_EMAIL_PDF_CAP_BYTES);
    expect(imageCount(r.pdfBase64)).toBe(15);
  });

  it('too big even at 800 px: sent without photos, and says so', async () => {
    const { purchaseOrderPdfForEmail, base64Bytes, PO_EMAIL_PDF_CAP_BYTES } = await import('./purchase-order-pdf');
    const r = await purchaseOrderPdfForEmail(header, lines(50));
    expect(r.photos).toBe('omitted');
    expect(base64Bytes(r.pdfBase64)).toBeLessThanOrEqual(PO_EMAIL_PDF_CAP_BYTES);
    expect(imageCount(r.pdfBase64)).toBe(0);
    const { poEmailPhotosNote } = await import('./po-email-photos');
    expect(poEmailPhotosNote('omitted')).toContain('WITHOUT');
    expect(poEmailPhotosNote('reduced')).toContain('smaller');
    expect(poEmailPhotosNote('full')).toBe('');
  });

  it('the cap matches the send route', async () => {
    const { PO_EMAIL_PDF_CAP_BYTES } = await import('./purchase-order-pdf');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../../../../backend/src/scm/lib/po-email.ts'), 'utf8');
    const m = /export const PO_ATTACHMENT_CAP_BYTES = (\d+) \* 1024 \* 1024;/.exec(src);
    expect(m, 'PO_ATTACHMENT_CAP_BYTES not found in po-email.ts').not.toBeNull();
    expect(PO_EMAIL_PDF_CAP_BYTES).toBe(Number(m![1]) * 1024 * 1024);
  });
});
