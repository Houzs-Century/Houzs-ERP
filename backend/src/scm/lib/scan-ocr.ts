// ---------------------------------------------------------------------------
// scan-ocr — document-type-agnostic OCR transport primitives.
//
// Factored out of scan-so.ts (byte-for-byte, no behaviour change) so the GR /
// PI scanners (tasks/PLAN-ocr-scan-gr-pi.md, slices 3+) reuse the SAME transport
// instead of copying it: the Anthropic fetch-with-retry, the base64/sha helpers,
// the JSON-fence stripper, the multipart file parser, and the R2 replay loader
// the queue consumer + reaper rebuild a job's inputs from. Everything here is
// generic — it knows nothing about sale orders, delivery orders or invoices; the
// per-document prompt + normaliser live in each scanner's own module.
// ---------------------------------------------------------------------------

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Anthropic (and gateways in front of it) return transient 429 rate-limits and
// 529 "Overloaded" / 5xx spikes that clear on a retry; a single hit otherwise
// fails the whole scan/distill with a hard error. Retry those a few times with
// an exponential-ish backoff. Non-retryable statuses (4xx other than 429) and
// the final attempt fall straight through to the caller's existing !resp.ok
// handling, so the response shape is unchanged. Only the transport is retried —
// the prompt/body and response parsing are untouched.
const RETRYABLE_ANTHROPIC_STATUS = new Set([429, 500, 502, 503, 529]);

export async function anthropicFetchWithRetry(
  init: RequestInit,
  tries = 3,
): Promise<Response> {
  let resp: Response | null = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    resp = await fetch(ANTHROPIC_URL, init);
    if (resp.ok) return resp;
    // Peek the body for an explicit overloaded_error without consuming the
    // Response the caller reads — clone so the returned body survives. Some
    // gateways surface an overloaded body under a status outside the set.
    let overloaded = false;
    try {
      const peek = await resp.clone().text();
      if (/overloaded/i.test(peek)) overloaded = true;
    } catch { /* body peek is best-effort */ }
    const retryable = RETRYABLE_ANTHROPIC_STATUS.has(resp.status) || overloaded;
    if (!retryable || attempt === tries - 1) return resp;
    // 400ms, 800ms, 1600ms … keeps the whole retry window well under the
    // per-call AbortSignal.timeout budget.
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  return resp as Response;
}

export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ArrayBuffer -> base64. Workers don't expose Node's Buffer; the chunked loop
// keeps stack usage bounded for large files. (Ported from HOOKKA scan-po.)
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function stripJsonFences(text: string): string {
  let trimmed = text.trim();

  // 1) ```json … ``` or ``` … ```
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const fenceMatch = trimmed.match(fenceRe);
  if (fenceMatch?.[1]) trimmed = fenceMatch[1].trim();

  // 2) Strip any chain-of-thought preamble. The valid payload always starts
  //    with `{` — take from the first `{` to the last `}`.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

export type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
  usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

// A Claude content block (image or document per file), in upload order.
export type ContentBlock = Record<string, unknown>;
// Per-IMAGE provenance, indexed by the SAME `index` Claude classifies in the
// OUTPUT "images" array — fileBlocks is built in file order, so image #N in
// the model's view is uploadedImages[N]. PDFs are NOT displayable inline so
// they are never stored under an image key (they still ride the prompt as
// document blocks).
export type UploadedImage = { index: number; buffer: ArrayBuffer; mime: string };
export type ScanFileParse = {
  fileBlocks: ContentBlock[];
  // Image files only (buffer + mime), for R2 provenance storage.
  uploadedImages: UploadedImage[];
  // EVERY accepted file's raw bytes (images AND pdfs) — the enqueue path
  // persists these to R2 for durability before the job runs.
  allFiles: Array<{ buffer: ArrayBuffer; mime: string }>;
  firstBuffer: ArrayBuffer | null;
  fileCount: number;
};

// Accept files under any field name ("file", "files", repeated) — the modal
// sends `file` repeatedly but be liberal in what we accept. Returns a plain
// bad-request reason string on any rejected input (the caller maps it to its
// own 400), or the parsed blocks/buffers.
export async function parseScanFiles(
  formData: FormData,
): Promise<{ ok: true; parsed: ScanFileParse } | { ok: false; reason: string }> {
  // (entries cast to unknown: @cloudflare/workers-types narrows
  // FormDataEntryValue to string, which breaks the instanceof check.)
  const files: File[] = [];
  for (const [, v] of formData.entries() as Iterable<[string, unknown]>) {
    if (v instanceof File && v.size > 0) files.push(v);
  }
  if (files.length === 0) return { ok: false, reason: 'No file uploaded.' };

  const fileBlocks: ContentBlock[] = [];
  const uploadedImages: UploadedImage[] = [];
  const allFiles: Array<{ buffer: ArrayBuffer; mime: string }> = [];
  let firstBuffer: ArrayBuffer | null = null;
  let blockIndex = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, reason: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.` };
    }
    const mime = file.type || '';
    const name = (file.name || '').toLowerCase();
    const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
    const isImage =
      IMAGE_MIMES.has(mime) ||
      name.endsWith('.jpg') || name.endsWith('.jpeg') ||
      name.endsWith('.png') || name.endsWith('.webp');
    if (!isPdf && !isImage) {
      return { ok: false, reason: `Unsupported file type "${mime || name}". Use JPEG / PNG / WEBP / PDF.` };
    }
    const buf = await file.arrayBuffer();
    if (!firstBuffer) firstBuffer = buf;
    const data = toBase64(buf);
    if (isPdf) {
      allFiles.push({ buffer: buf, mime: 'application/pdf' });
      fileBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      });
    } else {
      const mediaType = IMAGE_MIMES.has(mime)
        ? mime
        : name.endsWith('.png') ? 'image/png'
        : name.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';
      allFiles.push({ buffer: buf, mime: mediaType });
      uploadedImages.push({ index: blockIndex, buffer: buf, mime: mediaType });
      fileBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
    }
    blockIndex += 1;
  }
  return {
    ok: true,
    parsed: { fileBlocks, uploadedImages, allFiles, firstBuffer, fileCount: files.length },
  };
}

// Rebuild a scan job's file inputs from the durable R2 copies — the inverse of
// parseScanFiles for a retry / queue redelivery (the original in-memory buffers
// died with the isolate). Block order matches upload order because image_keys
// was appended in file order; the stored contentType decides image vs document
// block, same mapping as parseScanFiles. Returns null (caller errors the job)
// if the bucket is unbound or ANY key is missing.
export async function loadScanJobFilesFromR2(
  bucket: R2Bucket | undefined,
  keys: string[],
): Promise<{
  fileBlocks: ContentBlock[];
  uploadedImages: UploadedImage[];
  firstBuffer: ArrayBuffer | null;
} | null> {
  if (!bucket || keys.length === 0) return null;
  const fileBlocks: ContentBlock[] = [];
  const uploadedImages: UploadedImage[] = [];
  let firstBuffer: ArrayBuffer | null = null;
  let blockIndex = 0;
  for (const key of keys) {
    const obj = await bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    if (!firstBuffer) firstBuffer = buf;
    const mime = obj.httpMetadata?.contentType || 'image/jpeg';
    const data = toBase64(buf);
    if (mime === 'application/pdf') {
      fileBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      });
    } else {
      uploadedImages.push({ index: blockIndex, buffer: buf, mime });
      fileBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data },
      });
    }
    blockIndex += 1;
  }
  return { fileBlocks, uploadedImages, firstBuffer };
}
