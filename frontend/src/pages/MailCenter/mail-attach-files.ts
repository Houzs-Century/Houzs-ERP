// ---------------------------------------------------------------------------
// Mail Center — turning picked FILES into outbound attachments.
//
// `mail-attachments.ts` next door owns the RULE (count / size / extension) and
// stays pure — no DOM. This module owns the one step that needs the browser:
// reading a File into base64 and running that rule over the result, so every
// surface that offers an attach button gets the SAME rejection, in the same
// words, at the same moment.
//
// Three surfaces use it: desktop Compose.tsx, desktop Thread.tsx (reply) and
// the phone's MobileMailCenter.tsx. The first two carried BYTE-IDENTICAL copies
// of `humanSize`, `readFileAsBase64` and the whole pick pipeline; the phone had
// no attach button at all, and adding a third copy is how the rules on those
// two surfaces drifted apart in the first place (see docs/bugs — the Mail
// Center mobile-parity entries). Import this; do not paste it.
// ---------------------------------------------------------------------------
import {
  validateMailAttachments,
  decodedBase64Bytes,
  isAllowedMailAttachment,
  MAIL_ATTACH_MAX_TOTAL_BYTES,
} from "./mail-attachments";

// One picked file, read and measured. `size` is the DECODED byte count (what
// the cap and the server count), never the raw File.size.
export type OutboundAttachment = {
  name: string;
  type: string;
  size: number;
  contentBase64: string;
};

// Human-readable file size for the chip label.
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Read one File into a bare base64 payload (the `data:...;base64,` prefix is
// stripped — the API wants the payload alone).
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export type MailAttachPickResult =
  | { ok: true; files: OutboundAttachment[] }
  | { ok: false; error: string };

/**
 * Merge freshly picked files into the ones already attached.
 *
 * Returns the WHOLE new list on success, or a single English error — the same
 * sentence the backend would answer with, because the check underneath is the
 * shared `validateMailAttachments`.
 *
 * Order matters and is deliberate:
 *   1. extension allow-list, on the NAME, before anything is read;
 *   2. a RAW-size pre-check, so an oversized phone photo is never decoded into
 *      memory first (that hangs a low-RAM tab);
 *   3. read;
 *   4. the shared rule over the decoded batch — count, extensions, total size.
 */
export async function pickMailAttachments(
  picked: File[],
  existing: OutboundAttachment[],
): Promise<MailAttachPickResult> {
  if (picked.length === 0) return { ok: true, files: existing };

  const rejected = picked.filter((f) => !isAllowedMailAttachment(f.name));
  if (rejected.length > 0) {
    return {
      ok: false,
      error: `"${rejected[0].name}" is not an allowed type. Only images and PDF files can be attached.`,
    };
  }

  const existingBytes = existing.reduce((sum, f) => sum + f.size, 0);
  const pickedRawBytes = picked.reduce((sum, f) => sum + f.size, 0);
  if (existingBytes + pickedRawBytes > MAIL_ATTACH_MAX_TOTAL_BYTES) {
    return {
      ok: false,
      error: `Attachments exceed the ${humanSize(MAIL_ATTACH_MAX_TOTAL_BYTES)} limit.`,
    };
  }

  let read: OutboundAttachment[];
  try {
    read = await Promise.all(
      picked.map(async (f) => {
        const contentBase64 = await readFileAsBase64(f);
        return {
          name: f.name,
          type: f.type,
          size: decodedBase64Bytes(contentBase64),
          contentBase64,
        };
      }),
    );
  } catch {
    return { ok: false, error: "Couldn't read one of the files. Please try again." };
  }

  const next = [...existing, ...read];
  const check = validateMailAttachments(
    next.map((f) => ({ filename: f.name, contentBase64: f.contentBase64 })),
  );
  if (!check.ok) return { ok: false, error: check.error ?? "Invalid attachments." };

  return { ok: true, files: next };
}

// The wire shape both POST routes take (compose + reply). Kept here so no
// caller re-invents the field names — `filename`, not `name`.
export function attachmentPayload(
  files: OutboundAttachment[],
): { filename: string; contentBase64: string }[] {
  return files.map((f) => ({ filename: f.name, contentBase64: f.contentBase64 }));
}
