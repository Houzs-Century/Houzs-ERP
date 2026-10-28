// ----------------------------------------------------------------------------
// image-compress — downscale a camera photo before it goes to the OCR endpoint.
//
// Houzs uploaded the raw camera file. The only gate was MAX_FILE_BYTES = 20MB
// (backend/src/scm/routes/scan-so.ts), which sits ABOVE the Anthropic Messages
// API's real per-image cap: 10MB base64-encoded on the direct API (5MB on
// Bedrock / Vertex). scan-so.ts base64s the bytes itself (toBase64), and base64
// inflates by 4/3 — so a raw photo over ~7.5MB clears Houzs's own gate and is
// then rejected by the model with a 400 invalid_request_error. That 400 is NOT
// in RETRYABLE_ANTHROPIC_STATUS, so it is terminal: the operator is told to key
// the order in by hand. The 8000x8000 px dimension cap is a second way in for a
// high-megapixel phone. Both are closed by shrinking the image here, first.
//
// Why 2000px is the long edge, and why it does not cost OCR accuracy:
// claude-sonnet-4-6 (CLAUDE_MODEL) is a STANDARD-resolution model — the API
// downscales anything over a 1568px long edge / 1568 visual tokens server-side
// before the model ever sees it. Sending a 4000px photo therefore buys nothing;
// those pixels are discarded upstream. 2000px keeps a margin over that 1568px
// cap (so we are never the binding constraint), stays under the stricter 2000px
// dimension rule the API applies to many-image requests, and leaves headroom if
// CLAUDE_MODEL is ever moved to a high-resolution model (2576px long edge) —
// at which point this constant, not the call sites, is the thing to raise.
//
// Quality 0.85 is a deliberate floor, not a default. These are HANDWRITTEN
// slips: the API's own guidance warns that heavy JPEG compression makes text
// hard to read, and that is the failure mode that matters here (a misread digit
// on an order beats a slow upload). 2000px @ q0.85 lands ~400-700KB, which is
// an order of magnitude under the cap — there is no reason to compress harder.
//
// Ported in shape from HOOKKA 843629df (skip-small / keep-smaller / fall-back),
// minus the pdfjs rasteriser: PDFs are passed through untouched here.
// ----------------------------------------------------------------------------

// Under this, leave the file alone: it is already safely inside the API's cap
// (2MB raw -> ~2.7MB base64), and re-encoding would cost handwriting fidelity
// to save bytes that were never a problem. Matches HOOKKA's threshold.
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
  // A PDF has no canvas path here (HOOKKA needed pdfjs for that); scan-so.ts
  // forwards it as a document block, which has its own limits. Leave it be.
  if (!isImage(file)) return file;
  if (file.size <= SKIP_UNDER_BYTES) return file;

  try {
    // imageOrientation: 'from-image' applies the EXIF rotation. Without it a
    // canvas re-render DROPS the EXIF flag, and a phone-portrait slip would
    // reach the model sideways — the API lists rotated images as a known cause
    // of misreads, so this line is load-bearing for accuracy, not cosmetic.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const longEdge = Math.max(bitmap.width, bitmap.height);
      // Never upscale: a small photo re-rendered larger invents no detail and
      // only inflates the payload.
      const scale = Math.min(1, MAX_EDGE_PX / longEdge);
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);
      if (!width || !height) return file;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      // The source is a photo, not line art — smoothing beats nearest-neighbour
      // for keeping pen strokes legible through the downscale.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);

      const blob = await toJpegBlob(canvas, JPEG_QUALITY);
      // Re-encoding an already-optimised JPEG can come out BIGGER. If it did,
      // the re-render bought nothing and cost a lossy generation — drop it.
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
    // Any failure (decode, canvas, memory, an unsupported browser) falls back to
    // the original bytes. This is the operator's primary input path: a scan that
    // might 400 is strictly better than a scan that cannot be attempted.
    return file;
  }
}

/** compressForOcr over a list, preserving order. */
export async function compressAllForOcr(files: File[]): Promise<File[]> {
  return Promise.all(files.map((f) => compressForOcr(f)));
}
