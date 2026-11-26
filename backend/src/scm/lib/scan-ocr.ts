
export const CLAUDE_MODEL = 'claude-sonnet-4-6';

export const SCAN_SO_MODELS = ['claude-sonnet-4-6', 'claude-sonnet-5-5'];
export function scanSoModel(env: { SCAN_SO_MODEL?: string }): string {
  const model = (env.SCAN_SO_MODEL ?? '').trim();
  return SCAN_SO_MODELS.includes(model) ? model : CLAUDE_MODEL;
}

export function modelRequestFields(model: string): Record<string, unknown> {
  return model === 'claude-sonnet-5-5' ? { thinking: { type: 'between_tools' } } : { temperature: 0 };
}
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const RETRYABLE_ANTHROPIC_STATUS = new Set([429, 500, 502, 503, 529]);

export async function anthropicFetchWithRetry(
  init: RequestInit,
  tries = 3,
): Promise<Response> {
  let resp: Response | null = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    resp = await fetch(ANTHROPIC_URL, init);
    if (resp.ok) return resp;
    let overloaded = false;
    try {
      const peek = await resp.clone().text();
      if (/overloaded/i.test(peek)) overloaded = true;
    } catch { }
    const retryable = RETRYABLE_ANTHROPIC_STATUS.has(resp.status) || overloaded;
    if (!retryable || attempt === tries - 1) return resp;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  return resp as Response;
}

export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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

  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const fenceMatch = trimmed.match(fenceRe);
  if (fenceMatch?.[1]) trimmed = fenceMatch[1].trim();

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
  stop_reason?: string | null;
  usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

export type ContentBlock = Record<string, unknown>;
export type UploadedImage = { index: number; buffer: ArrayBuffer; mime: string };
export type ScanFileParse = {
  fileBlocks: ContentBlock[];
  uploadedImages: UploadedImage[];
  allFiles: Array<{ buffer: ArrayBuffer; mime: string }>;
  firstBuffer: ArrayBuffer | null;
  fileCount: number;
};

export async function parseScanFiles(
  formData: FormData,
): Promise<{ ok: true; parsed: ScanFileParse } | { ok: false; reason: string }> {
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
