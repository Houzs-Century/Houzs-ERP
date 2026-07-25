// ---------------------------------------------------------------------------
// vision-blocks.ts — turn an uploaded image or PDF into Anthropic content blocks
// so the Assistant can READ the file. The app already sends images/PDFs to Claude
// natively in the scan-OCR routes (scan-payment.ts / scan-so.ts); this is the
// same shape, factored out for the assistant. NO new R2 bucket, NO SDK, NO beta
// header — claude-sonnet-4-6 reads images + PDFs GA.
//
// PDFs are sent NATIVELY as `document` base64 blocks (no text extraction). VIDEO
// is not a Messages-API content type and the model cannot ingest raw video — the
// allowlist rejects it. Files never persist here; the base64 is in-memory only,
// so callers must cap count + size (below) to respect the Worker isolate.
// ---------------------------------------------------------------------------

export const ASSISTANT_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const ASSISTANT_PDF_MIME = "application/pdf";
/** Anthropic's per-image cap is 5MB; base64 inflates ~33%, so keep images small. */
export const ASSISTANT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ASSISTANT_MAX_PDF_BYTES = 20 * 1024 * 1024;
export const ASSISTANT_MAX_FILES = 5;

export type ContentBlock = {
  type: "image" | "document";
  source: { type: "base64"; media_type: string; data: string };
};

// ArrayBuffer -> base64, chunked (Workers have no Node Buffer). Same impl as the
// scan routes' private toBase64.
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

/**
 * Validate + encode the uploaded files into content blocks. Returns an `error`
 * string (for a 400) on the first bad file rather than throwing — the caller
 * rejects the request BEFORE the model call, since askAgentBrain swallows errors
 * into a null answer.
 */
export async function buildFileBlocks(files: File[]): Promise<{ blocks: ContentBlock[]; error?: string }> {
  if (files.length > ASSISTANT_MAX_FILES) {
    return { blocks: [], error: `Too many files (max ${ASSISTANT_MAX_FILES}).` };
  }
  const blocks: ContentBlock[] = [];
  for (const f of files) {
    const mime = (f.type || "").toLowerCase();
    const isImage = ASSISTANT_IMAGE_MIMES.has(mime);
    const isPdf = mime === ASSISTANT_PDF_MIME;
    if (!isImage && !isPdf) {
      const tail = mime.startsWith("video/") ? " — video is not supported" : "";
      return { blocks: [], error: `Unsupported file type: ${mime || "unknown"}. Only images (jpeg/png/webp) and PDF are supported${tail}.` };
    }
    const cap = isImage ? ASSISTANT_MAX_IMAGE_BYTES : ASSISTANT_MAX_PDF_BYTES;
    if (f.size > cap) {
      return { blocks: [], error: `${f.name || "File"} is too large (max ${Math.round(cap / 1024 / 1024)}MB).` };
    }
    const data = toBase64(await f.arrayBuffer());
    blocks.push(
      isImage
        ? { type: "image", source: { type: "base64", media_type: mime, data } }
        : { type: "document", source: { type: "base64", media_type: ASSISTANT_PDF_MIME, data } },
    );
  }
  return { blocks };
}

/** Pull the message text, optional conversationId, and file parts from a
 *  multipart form. `file` is the repeatable field name. */
export async function parseAssistantForm(
  formData: FormData,
): Promise<{ message: string; conversationId?: string; files: File[] }> {
  const rawMsg = formData.get("message");
  const message = typeof rawMsg === "string" ? rawMsg : "";
  const rawCid = formData.get("conversationId");
  const conversationId = typeof rawCid === "string" && rawCid ? rawCid : undefined;
  const files: File[] = [];
  for (const v of formData.getAll("file")) {
    if (v instanceof File) files.push(v);
  }
  return { message, conversationId, files };
}
