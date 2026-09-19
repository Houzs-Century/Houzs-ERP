// ---------------------------------------------------------------------------
// scan-anthropic — the document-type-agnostic OCR transport shared by every
// scanner (SO slip, supplier Delivery Order → GR, supplier Invoice → PI).
//
// These helpers used to live INSIDE scan-so.ts and were copied byte-for-byte
// into scan-lorry-invoice.ts ("kept private so scan-so's surface does not
// widen"). The GR/PI slices (tasks/PLAN-ocr-scan-gr-pi.md) add two more
// scanners on the SAME transport, so a third and fourth copy is one too many:
// the retry policy, the 20MB ceiling, the base64 chunking and the multipart
// parse are the parts that MUST behave identically on every surface. They are
// pure — no catalog, no SO shape, no request — so they factor out cleanly, and
// scan-so.ts now imports them from here instead of declaring its own.
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// The vision model every scanner calls. One constant so a model bump moves all
// of them together (SO, GR, PI).
export const CLAUDE_MODEL = 'claude-sonnet-4-6';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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

// Strip a ```json fence and any chain-of-thought preamble: take from the first
// `{` to the last `}`. The valid OCR payload is always one JSON object.
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

// A Claude content block (image or document per uploaded file). Loose by
// design — the caller assembles the messages array around it.
export type ContentBlock = Record<string, unknown>;

// Per-IMAGE provenance, indexed by the SAME `index` the model classifies in its
// output "images" array — fileBlocks is built in file order, so image #N in the
// model's view is uploadedImages[N]. PDFs are NOT displayable inline so they are
// never stored as an image (they still ride into the prompt as document blocks).
export type UploadedImage = { index: number; buffer: ArrayBuffer; mime: string };

export type ScanFileParse = {
  // Claude content blocks (image or document per file), in upload order.
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
