// ----------------------------------------------------------------------------
// sofa-compartment-art — the module artwork the POS Custom Builder draws,
// prepared for jsPDF.
//
// PORTED FROM POS, at the owner's instruction (2026-08-28: 「你自己去检查好整个
// POS 系统的做法，然后把我们的照片跟着 POS 系统的做法做完」). The source is
// wenwei4046/2990s — apps/pos/src/lib/sofa-art.ts and the tile placement in
// apps/pos/src/components/SofaCellsPreview.tsx.
//
// WHY THE PDF LOOKED WRONG, AND IT WAS NOT "no photos". Two separate faults:
//
//   1. `loadSofaCompartmentPhotos` treated EVERY imageKey as an uploaded R2
//      object and fetched it through the API. The DEFAULT key is
//      `sofa-modules/<code>.svg` — bundled art served from /public, no API
//      involved — so every default compartment 404'd, was swallowed by a
//      `catch`, and the sheet fell back to its own drawn schematic. The
//      Maintenance list and POS both resolve THREE key shapes; the PDF
//      implemented one. That is what `resolveCompartmentArtUrl` below fixes.
//
//   2. Even with the bytes in hand, drawing them into the cell rectangle would
//      still have looked wrong, and POS has already paid for this: "All module
//      art is 1024×1024 with the drawn silhouette PADDED INSIDE; to tile modules
//      tightly we measure each silhouette's alpha bbox once and scale/offset the
//      img so the silhouette fills its cm footprint." Skip that and the modules
//      render small with gaps between them — POS's own comment calls it "the 2WC
//      card bug, 2026-05-24".
//
// SO THE ART IS CROPPED TO ITS SILHOUETTE HERE, before jsPDF ever sees it.
// POS achieves the same thing with an oversized <img> inside an overflow:hidden
// box; jsPDF cannot clip, so the crop is baked into a canvas instead. Same
// result, and it also lets the rotation be baked in — jsPDF's addImage rotation
// is not available on every version this repo has shipped.
//
// PNG, NOT SVG, and that is POS's choice rather than a preference: jsPDF embeds
// raster only, and POS tiles from `${id}.png` for the same reason its canvas
// does. 25 of the 63 bundled files are PNG; the 13 SVG-only codes are the
// power/recliner variants ((P)/(R)/(L)) and Console-WC, which POS itself does
// NOT tile — it draws those through renderSeamlessSofa because "the tile path
// would render it blank". Those fall back to the drawn schematic here, which is
// honest and visible, rather than to an empty rectangle.
// ----------------------------------------------------------------------------

/** Silhouette bbox within the art, as fractions (0..1) of its width/height. */
export type ArtBbox = { l: number; t: number; r: number; b: number };

/* POS's fallback, used when a measurement cannot be made. It tiles roughly,
   which is what POS chose over `objectFit: contain` — that rendered the
   silhouette tiny with gaps. */
export const ART_BBOX_FALLBACK: ArtBbox = { l: 0.1, t: 0.2, r: 0.9, b: 0.8 };

const BUNDLED_PREFIX = 'sofa-modules/';
const UPLOADED_PREFIX = 'sofa-compartments/';

/**
 * The THREE shapes an imageKey can take, resolved the same way the Maintenance
 * list resolves them (`resolveCompartmentImageSrc` in Products.tsx).
 *
 * Kept deliberately in step with that function: two surfaces resolving the same
 * key differently is precisely the fault this module exists to repair, and a
 * third copy would be the next one. `sofa-compartment-art.test.ts` reads both
 * files and asserts they agree.
 *
 * Bundled keys are answered as `.png` regardless of the extension the key
 * carries — the seed writes `.svg`, and the raster twin beside it is what can be
 * embedded. Returns null when there is no PNG twin, so the caller can fall back
 * rather than fetch a 404.
 */
export function resolveCompartmentArtUrl(
  code: string,
  imageKey: string | undefined | null,
  apiBase: string,
): string | null {
  if (!imageKey) return null;
  if (/^https?:\/\//i.test(imageKey)) return imageKey;
  if (imageKey.startsWith(UPLOADED_PREFIX)) {
    return `${apiBase}/maintenance-config/sofa-compartments/${encodeURIComponent(code)}`
      + `/photo/${encodeURIComponent(imageKey)}`;
  }
  if (imageKey.startsWith(BUNDLED_PREFIX)) {
    const stem = imageKey.slice(BUNDLED_PREFIX.length).replace(/\.(svg|png)$/i, '');
    return `/${BUNDLED_PREFIX}${stem}.png`;
  }
  return `/${imageKey}`;
}

/**
 * Measure an image's alpha bbox — POS's `measureArtBbox`, same 2px sampling
 * stride and same alpha>16 threshold, so the two surfaces crop identically.
 *
 * Returns the fallback rather than throwing on any failure: a compartment whose
 * art cannot be measured must still draw, and roughly-tiled beats absent.
 */
export function measureArtBbox(img: HTMLImageElement | ImageBitmap): ArtBbox {
  try {
    const w = img.width;
    const h = img.height;
    if (!(w > 0) || !(h > 0)) return ART_BBOX_FALLBACK;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return ART_BBOX_FALLBACK;
    ctx.drawImage(img as CanvasImageSource, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    let minX = w; let minY = h; let maxX = 0; let maxY = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (d[(y * w + x) * 4 + 3]! > 16) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return ART_BBOX_FALLBACK;
    return { l: minX / w, t: minY / h, r: maxX / w, b: maxY / h };
  } catch {
    return ART_BBOX_FALLBACK;
  }
}

/** One compartment's art, cropped to its silhouette and ready for addImage. */
export type CompartmentArt = { dataUrl: string; format: 'PNG'; rot: number };

/* Rendered pixel size of the LONG edge of a cropped module. The sofa plan on a
   PO is ~55mm wide for the whole arrangement, so one module is often under
   20mm; 512 there is ~650dpi, which survives the same zooming the item photos
   were raised for (2026-08-28). Kept below the item photos' 1536 because a
   sofa plan carries up to six of these and they are line art, not detail. */
export const ART_PX = 512;

/**
 * Fetch one module's art and return it cropped to its silhouette, rotated if the
 * cell is, as a PNG data URL.
 *
 * PNG, not JPEG: the art has transparent padding around a light silhouette, and
 * JPEG has no alpha — flattening it onto white would be fine on white paper and
 * wrong the moment anything is drawn behind it.
 */
export async function loadCompartmentArt(url: string, rot = 0): Promise<CompartmentArt | null> {
  try {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    if (!img) return null;

    const bbox = measureArtBbox(img);
    const sx = bbox.l * img.width;
    const sy = bbox.t * img.height;
    const sw = Math.max(1, (bbox.r - bbox.l) * img.width);
    const sh = Math.max(1, (bbox.b - bbox.t) * img.height);

    const scale = Math.min(1, ART_PX / Math.max(sw, sh));
    const cw = Math.max(1, Math.round(sw * scale));
    const ch = Math.max(1, Math.round(sh * scale));

    /* Rotation is baked in so the caller can place a plain axis-aligned rect —
       POS rotates the DOM box; jsPDF has no equivalent it can rely on. A 90/270
       turn swaps the canvas dimensions, which is why the footprint the caller
       draws into is the ROTATED one. */
    const quarter = ((Math.round(rot / 90) % 4) + 4) % 4;
    const swap = quarter === 1 || quarter === 3;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? ch : cw;
    canvas.height = swap ? cw : ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((quarter * 90 * Math.PI) / 180);
    ctx.drawImage(img, sx, sy, sw, sh, -cw / 2, -ch / 2, cw, ch);

    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.startsWith('data:image/png') ? { dataUrl, format: 'PNG', rot: quarter * 90 } : null;
  } catch {
    return null;
  }
}
