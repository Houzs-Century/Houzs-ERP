
/** Deterministic sibling suffix for thumbnail objects in R2. The backend
 *  mirrors this constant; a thumbnail for key `a/b/c.jpg` always lives at
 *  `a/b/c.jpg.thumb`. Appending to an already-encoded URL segment is safe
 *  because every character in the suffix is URL-unreserved. */
export { THUMB_KEY_SUFFIX } from "./thumb-key";
import { THUMB_KEY_SUFFIX } from "./thumb-key";

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
    }
  }
  return fetchUrl(basePath);
}

export interface PrepareImageOptions {
  maxDimension?: number;
  quality?: number;
  thumbDimension?: number;
  thumbQuality?: number;
  wantThumb?: boolean;
}

export interface PreparedImage {
  file: File;
  thumb: File | null;
  compressed: boolean;
}

const DEFAULTS: Required<PrepareImageOptions> = {
  maxDimension: 2000,
  quality: 0.8,
  thumbDimension: 400,
  thumbQuality: 0.72,
  wantThumb: true,
};

const SKIP_REENCODE_BYTES = 600 * 1024;

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

async function decodeUpright(file: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
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

  const webp = await canvasToBlob(canvas, "image/webp", quality);
  if (webp && webp.type === "image/webp") return webp;

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
      if (blob && blob.size < file.size) {
        mainFile = new File([blob], renamed(file.name, blob.type), { type: blob.type });
        compressed = true;
      }
    }

    let thumb: File | null = null;
    if (o.wantThumb) {
      const tBlob = await renderScaled(bitmap, o.thumbDimension, o.thumbQuality, file.type);
      if (tBlob && tBlob.size < mainFile.size) {
        thumb = new File([tBlob], renamed(file.name, tBlob.type), { type: tBlob.type });
      }
    }

    return { file: mainFile, thumb, compressed };
  } finally {
    bitmap.close();
  }
}
