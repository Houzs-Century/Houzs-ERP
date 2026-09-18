// Does the printed purchase order actually SHOW the photograph its line
// carries? Owner 2026-09-11: 「重点是有照片的带出来PDF可以吗？」 — the whole
// backfill in docs/bugs/0819 is worthless if the answer is no, and the answer
// had never been asserted anywhere: pdf-item-photos.test.ts pins the grouping
// and packing through stubs, and purchase-order-pdf-sofa.test.ts renders a real
// PDF but carries no photo on any line.
//
// So this renders a REAL PDF through the real generator with a real JPEG on the
// line, and asserts the heading, the row chip and an image XObject are in the
// bytes. jsPDF streams are uncompressed, so the text is greppable; an embedded
// photo shows up as `/Subtype /Image`.
//
// WHAT IS STUBBED, and why that is honest. Two browser facilities jsdom does
// not have: the network (`fetchPoItemPhotoBlob`, mocked to hand back the JPEG
// the way the signed-URL read path does) and the canvas decode
// (`createImageBitmap` + `toDataURL`, which is Chrome's code, not ours). Every
// line of OUR path between a `photo_urls` key and a drawn photo is the real
// thing: buildPhotoGroups, photoKeyOwners, fetchLinePhotoForPdf's thumb-then-
// original fallback, collectPhotoImages, blobToSquarePdfImage's own mime and
// scale rules, layoutPhotoGroups and drawItemPhotosBlock.
//
// PHOTO_PDF_SRC=<file.jpg> swaps in a real photograph and PHOTO_PDF_OUT=<file>
// writes the PDF, for showing the owner an actual document.
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
/* jsdom's Blob has no `arrayBuffer()`; Node's does, and every real browser's
   does. Using the platform one keeps the decode path un-stubbed. */
import { Blob as NodeBlob } from 'node:buffer';

/* A 1x1 JPEG — enough to be a real image the encoder accepts. Swapped for a
   real sofa sketch when PHOTO_PDF_SRC is set. */
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoLhcYGRomJygkKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

const PHOTO_KEY = 'so-items/HC-SO-013422/376d3ab1-a904-4464-b439-4b4e56a89970/ac-919030-1.jpg';

let jpeg: Buffer;
let dataUrl: string;

/* The read path hands the PDF a Blob. `.thumb` is tried first and 404s for an
   AutoCount cutover key (docs/bugs/0815), which is the case here, so the mock
   refuses the thumb and serves the original — the real fallback, exercised. */
vi.mock('./sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchPoItemPhotoBlob: async (_poId: string, _itemId: string, key: string) => {
    if (key.endsWith('.thumb')) throw new Error('404');
    return new NodeBlob([jpeg], { type: 'image/jpeg' }) as unknown as Blob;
  },
  loadSofaCompartmentArtForPrint: async () => new Map(),
}));

beforeAll(() => {
  jpeg = process.env.PHOTO_PDF_SRC
    ? readFileSync(process.env.PHOTO_PDF_SRC)
    : Buffer.from(TINY_JPEG_B64, 'base64');
  dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

  /* jsdom has neither createImageBitmap nor a 2d context. Both belong to the
     browser, so they are supplied rather than asserted — what is under test is
     what our code does with them. */
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width: 600, height: 800, close() {},
  });
  const proto = globalThis.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = () => ({ fillStyle: '', fillRect() {}, drawImage() {} });
  proto.toDataURL = () => dataUrl;
});

/* Typed off the generator's own signature rather than cast with `as never`.
   The repo bans that cast (no-restricted-syntax) for the reason it names: a
   hand-written fixture pushed past its type hides the field the code actually
   reads, which for THIS test would be `id` or `photo_urls` — the two the photo
   block depends on. `printDocumentPdf.ts` takes the same shape the same way. */
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

const line = (photos: string[]): PoArgs[1][number] => ({
  id: 'po-line-1',
  item_code: '9058-1A(LHF)',
  material_name: 'SOFA 9058 1A LHF',
  supplier_sku: 'HOK-9058-1A',
  qty: 1,
  unit_price_sen: 100000,
  line_total_sen: 100000,
  uom: 'UNIT',
  item_group: 'sofa',
  so_doc_no: 'HC-SO-013422',
  variants: {},
  photo_urls: photos,
});

const render = async (photos: string[]) => {
  const { purchaseOrderPdfBase64 } = await import('./purchase-order-pdf');
  const pdf = Buffer.from(await purchaseOrderPdfBase64(header, [line(photos)]), 'base64');
  return { pdf, raw: pdf.toString('latin1') };
};

describe('purchase-order-pdf — a line that carries a photo prints it', () => {
  it('puts the photograph and the ITEM PHOTOS block on the document', async () => {
    const { pdf, raw } = await render([PHOTO_KEY]);
    expect(raw).toContain('ITEM PHOTOS');
    // The chip names the SUPPLIER's code, because that is what they act on.
    expect(raw).toContain('HOK-9058-1A');
    // An embedded bitmap, not just a caption: this is what was missing.
    expect(raw).toContain('/Subtype /Image');
    if (process.env.PHOTO_PDF_OUT) writeFileSync(process.env.PHOTO_PDF_OUT, pdf);
  });

  it('prints no photo block at all when the line carries no key', async () => {
    const { raw } = await render([]);
    expect(raw).not.toContain('ITEM PHOTOS');
    expect(raw).not.toContain('/Subtype /Image');
  });
});
