import { useEffect, useState } from "react";
import type { OutboundAttachment } from "./mail-attach-files";

const PREVIEWABLE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/** A content type the browser may open in a tab without running script. */
export const canPreviewType = (type: string): boolean => PREVIEWABLE_CONTENT_TYPES.has(type.toLowerCase().split(";")[0].trim());

export function canPreviewAttachment(file: OutboundAttachment): boolean {
  return canPreviewType(file.type);
}

export function isImageAttachment(file: OutboundAttachment): boolean {
  return canPreviewAttachment(file) && file.type.toLowerCase().startsWith("image/");
}

function attachmentBlob(file: OutboundAttachment): Blob {
  const binary = atob(file.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: file.type });
}

export function useAttachmentPreviewUrl(file: OutboundAttachment): string | null {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!canPreviewAttachment(file)) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(attachmentBlob(file));
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return previewUrl;
}
