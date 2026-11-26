
export const MAIL_ATTACH_MAX_COUNT = 10;
export const MAIL_ATTACH_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const MAIL_ATTACH_ALLOWED_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "heic",
  "heif",
  "pdf",
] as const;

export interface MailAttachmentInput {
  filename?: string;
  contentBase64?: string;
}

export interface MailAttachmentValidationResult {
  ok: boolean;
  error?: string;
  totalDecodedBytes: number;
}

export function decodedBase64Bytes(contentBase64: string): number {
  const s = (contentBase64 ?? "").trim();
  if (s.length === 0) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

export function isAllowedMailAttachment(filename: string): boolean {
  const ext = fileExtension((filename ?? "").trim());
  return (MAIL_ATTACH_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

export function validateMailAttachments(
  attachments: MailAttachmentInput[] | undefined,
): MailAttachmentValidationResult {
  const list = attachments ?? [];
  if (list.length === 0) return { ok: true, totalDecodedBytes: 0 };

  if (list.length > MAIL_ATTACH_MAX_COUNT) {
    return {
      ok: false,
      error: `You can attach at most ${MAIL_ATTACH_MAX_COUNT} files.`,
      totalDecodedBytes: 0,
    };
  }

  let total = 0;
  for (const a of list) {
    const filename = (a?.filename ?? "").trim();
    const contentBase64 = (a?.contentBase64 ?? "").trim();
    if (!filename || !contentBase64) {
      return {
        ok: false,
        error: "Each attachment needs a filename and file content.",
        totalDecodedBytes: total,
      };
    }
    if (!isAllowedMailAttachment(filename)) {
      return {
        ok: false,
        error: `"${filename}" is not an allowed type. Only images and PDF files can be attached.`,
        totalDecodedBytes: total,
      };
    }
    total += decodedBase64Bytes(contentBase64);
  }

  if (total > MAIL_ATTACH_MAX_TOTAL_BYTES) {
    return {
      ok: false,
      error: "Attachments exceed the 5 MB limit.",
      totalDecodedBytes: total,
    };
  }

  return { ok: true, totalDecodedBytes: total };
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

export interface StoredMailAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export function toStoredMailAttachments(
  attachments: Array<{ filename: string; contentBase64: string }>,
): StoredMailAttachment[] {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType:
      CONTENT_TYPE_BY_EXTENSION[fileExtension(attachment.filename.trim())] ??
      "application/octet-stream",
    contentBase64: attachment.contentBase64.replace(/^data:[^;]+;base64,/, ""),
  }));
}
