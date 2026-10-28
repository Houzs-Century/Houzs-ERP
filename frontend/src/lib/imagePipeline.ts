// ----------------------------------------------------------------------------
// imageCompress — shared client-side photo downscale/re-encode + thumbnail
// generation for every image upload flow (WO-7, perf/image-pipeline).
//
// WHY CLIENT-SIDE: the backend is a Cloudflare Worker and cannot run native
// image codecs (no sharp, no node-canvas). Phone photos arrive at 3-8 MB;
// re-encoding in the browser before upload cuts that to ~300-800 KB and costs
// the server nothing. Every upload helper funnels through prepareImageForUpload
// so the policy lives in ONE place — do not copy-paste per page.
//
// GUARANTEES:
//   - Never throws for "cannot compress" reasons: any decode/encode failure,
//     missing canvas API, or a result that is not actually smaller falls back
//     to uploading the ORIGINAL file unchanged. Compression is best-effort;
//     upload must never be blocked by it.
//   - EXIF orientation is preserved: decode goes through
//     createImageBitmap(file, { imageOrientation: 'from-image' }) so the
//     pixels are upright BEFORE re-encode (canvas re-encode strips EXIF, so
//     baking the rotation in is mandatory or delivery photos arrive sideways).
//     If that decode path is unavailable the ORIGINAL file is uploaded — we
//     never re-encode through a path that might drop the rotation.
//   - PNG sources are only converted to WebP (alpha preserved) — never to
//     JPEG, which would flatten transparency onto black. If the browser
//     cannot encode WebP the PNG uploads unchanged.
//   - Thumbnails are best-effort too: `thumb` is null whenever generation
//     fails, and callers must treat that as "upload without a thumb".
//
// DO NOT wire this into the scan/OCR upload paths (scan-so, scan-payment
// extract): those bytes feed Claude vision and must keep full resolution.
// ----------------------------------------------------------------------------

/** Deterministic sibling suffix for thumbnail objects in R2. The backend
 *  mirrors this constant; a thumbnail for key `a/b/c.jpg` always lives at
 *  `a/b/c.jpg.thumb`. Appending to an already-encoded URL segment is safe
 *  because every character in the suffix is URL-unreserved. */
export const THUMB_KEY_SUFFIX = ".thumb";

/** Thumb URL for a main-image URL served by a key-suffix proxy route
 *  (product-model gallery, ASSR attachments, announcement attachments).
 *  NOT valid for signed S3 URLs — those must be signed server-side. */
export function thumbUrlFor(url: string): string {
  return url + THUMB_KEY_SUFFIX;
}

/**
 * Thumb-first loader for the blob-URL display components (ASSR grid,
 * announcement media). Tries `<basePath>.thumb` and falls back to the
 * original on ANY thumb failure — every photo uploaded before thumbnails
 * shipped has no `.thumb` object and 404s. A failure of the ORIGINAL is a
 * real error and propagates to the caller; it is never swallowed here.
 */
export async function loadThumbFirst(
  fetchUrl: (path: string) => Promise<string>,
  basePath: string,
  preferThumb = true,
): Promise<string> {
  if (preferThumb) {
    try {
      return await fetchUrl(thumbUrlFor(basePath));
    } catch {
      // Fall through to the original (pre-thumb object, or transient).
    }
  }
  return fetchUrl(basePath);
}

export interface PrepareImageOptions {
  /** Longest output side for the main image, px. */
  maxDimension?: number;
  /** JPEG/WebP encode quality for the main image, 0..1. */
  quality?: number;
  /** Longest side of the generated thumbnail, px. Ignored when wantThumb=false. */
  thumbDimension?: number;
  /** Thumbnail encode quality, 0..1. */
  thumbQuality?: number;
  /** Generate a thumbnail alongside the main image. Default true. */
  wantThumb?: boolean;
}

export interface PreparedImage {
  /** The file to upload as the main object — re-encoded when that made it
   *  smaller, otherwise the untouched original. */
  file: File;
  /** Small preview to upload under the `.thumb` sibling key, or null when
   *  thumbnail generation was not possible. */
  thumb: File | null;
  /** True when `file` is a re-encoded (downscaled) version of the input. */
  compressed: boolean;
}

const DEFAULTS: Required<PrepareImageOptions> = {
  maxDimension: 2000,
  quality: 0.8,
  thumbDimension: 400,
  thumbQuality: 0.72,
  wantThumb: true,
};

/** Main images at or under this size AND within maxDimension skip the
 *  re-encode (the transfer win would be marginal and JPEG->JPEG re-encodes
 *  can grow small files). Thumbnails are still generated. */
const SKIP_REENCODE_BYTES = 600 * 1024;

/** MIME types this module will attempt to decode. gif is excluded so an
 *  animation is never flattened to its first frame; svg is vector and has
 *  nothing to gain. heic/heif/avif are included opportunistically: browsers
 *  that can decode them get a huge win (HEIC -> WebP), browsers that cannot
 *  fall back to uploading the original. */
const DECODABLE = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
]);

/** True when this file is one the pipeline should try to compress. */
export function isCompressibleImage(file: Blob): boolean {
  return DECODABLE.has((file.type || "").toLowerCase());
}

function targetSize(w: number, h: number, maxDim: number): { w: number; h: number } {
  const longest = Math.max(w, h);
  if (longest <= maxDim) return { w, h };
  const scale = maxDim / longest;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Decode with EXIF orientation applied. Returns null when the environment
 *  cannot guarantee an upright decode — callers then keep the original file. */
async function decodeUpright(file: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Either the format is undecodable here (e.g. HEIC on a non-Safari
    // browser) or the options bag is unsupported. Retry once without options:
    // browsers new enough to lack ONLY the options bag still apply EXIF by
    // default per the current spec; genuinely old engines fail decode
    // entirely and fall to the null path.
    try {
      return await createImageBitmap(file);
    } catch {
      return null;
    }
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/** Draw + encode one output. Returns null on any failure. */
async function renderScaled(
  bitmap: ImageBitmap,
  maxDim: number,
  quality: number,
  sourceType: string,
): Promise<Blob | null> {
  const { w, h } = targetSize(bitmap.width, bitmap.height, maxDim);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);

  // Prefer WebP (better ratio, keeps alpha). canvas.toBlob silently falls
  // back to PNG when the requested type is unsupported, so the result type
  // must be VERIFIED, not assumed.
  const webp = await canvasToBlob(canvas, "image/webp", quality);
  if (webp && webp.type === "image/webp") return webp;

  // No WebP encoder. A PNG source keeps its alpha by staying PNG (i.e. no
  // re-encode win worth the risk) — signal "no result" so the original
  // uploads unchanged. Opaque photo formats re-encode to JPEG.
  const src = sourceType.toLowerCase();
  if (src === "image/png") return null;
  const jpeg = await canvasToBlob(canvas, "image/jpeg", quality);
  if (jpeg && jpeg.type === "image/jpeg") return jpeg;
  return null;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Rebuild the filename so its extension matches the re-encoded type —
 *  several backends derive the R2 key extension from the name/type pair. */
function renamed(name: string, type: string): string {
  const ext = EXT_BY_TYPE[type];
  if (!ext) return name;
  const base = name.replace(/\.[A-Za-z0-9]+$/, "");
  return `${base || "photo"}.${ext}`;
}

/**
 * Downscale + re-encode a photo for upload and generate its thumbnail.
 *
 * Non-image files, undecodable images, and environments without canvas all
 * return `{ file: original, thumb: null, compressed: false }` — callers can
 * pass every file through unconditionally.
 */
export async function prepareImageForUpload(
  file: File,
  opts: PrepareImageOptions = {},
): Promise<PreparedImage> {
  const o = { ...DEFAULTS, ...opts };
  const original: PreparedImage = { file, thumb: null, compressed: false };

  if (!isCompressibleImage(file)) return original;

  const bitmap = await decodeUpright(file);
  if (!bitmap) return original;

  try {
    const type = (file.type || "").toLowerCase();
    const withinDim = Math.max(bitmap.width, bitmap.height) <= o.maxDimension;
    const alreadySmall =
      withinDim && file.size <= SKIP_REENCODE_BYTES && (type === "image/jpeg" || type === "image/jpg" || type === "image/webp");

    let mainFile = file;
    let compressed = false;
    if (!alreadySmall) {
      const blob = await renderScaled(bitmap, o.maxDimension, o.quality, file.type);
      // Only accept a re-encode that actually SHRANK the payload — a quality-
      // 0.8 pass over an already-optimised file can come out larger.
      if (blob && blob.size < file.size) {
        mainFile = new File([blob], renamed(file.name, blob.type), { type: blob.type });
        compressed = true;
      }
    }

    let thumb: File | null = null;
    if (o.wantThumb) {
      const tBlob = await renderScaled(bitmap, o.thumbDimension, o.thumbQuality, file.type);
      // A thumb only helps if it is meaningfully lighter than what the list
      // would otherwise load. (A tiny original can be smaller than its own
      // re-encoded thumb - then the thumb is pure waste.)
      if (tBlob && tBlob.size < mainFile.size) {
        thumb = new File([tBlob], renamed(file.name, tBlob.type), { type: tBlob.type });
      }
    }

    return { file: mainFile, thumb, compressed };
  } finally {
    bitmap.close();
  }
}
