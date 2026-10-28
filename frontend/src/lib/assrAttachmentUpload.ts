// ----------------------------------------------------------------------------
// uploadAssrAttachment — the ONE staff-side upload path for service-case
// (ASSR) attachments. Desktop intake, desktop detail slots and the mobile
// case screen all funnel here so the WO-7 photo pipeline (client-side
// compression + `.thumb` sibling upload) lives in a single place instead of
// five copy-pasted putBinary blocks.
//
// Behaviour:
//   - Photos are downscaled/re-encoded via lib/imagePipeline before upload
//     (3-8 MB phone JPEG -> ~300-800 KB). Videos/PDFs pass through untouched.
//   - When a thumbnail could be generated it is uploaded to
//     PUT /api/assr/:id/attachments/thumb?key=... AFTER the main attachment
//     saves. Thumb failure is non-fatal by contract — the attachment row and
//     main object are already durable, and readers fall back to the original.
// ----------------------------------------------------------------------------

import { api } from "../api/client";
import { prepareImageForUpload } from "./imagePipeline";

export type AssrAttachmentUploadResult = { id: number; key: string };

export async function uploadAssrAttachment(
  caseId: number | string,
  rawFile: File,
  category: string,
): Promise<AssrAttachmentUploadResult> {
  const prepared = await prepareImageForUpload(rawFile);
  const file = prepared.file;
  // prepareImageForUpload renames the file when it re-encodes, so this ext
  // always matches the bytes being sent (webp re-encode -> "webp").
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const res = await api.putBinary<AssrAttachmentUploadResult>(
    `/api/assr/${caseId}/attachments?category=${encodeURIComponent(category)}&ext=${ext}&name=${encodeURIComponent(file.name)}`,
    await file.arrayBuffer(),
    file.type,
  );
  if (prepared.thumb) {
    try {
      await api.putBinary(
        `/api/assr/${caseId}/attachments/thumb?key=${encodeURIComponent(res.key)}`,
        await prepared.thumb.arrayBuffer(),
        prepared.thumb.type,
      );
    } catch (e) {
      // Non-fatal: the attachment itself is saved; grids fall back to it.
      console.warn("[assr-upload] thumb upload failed (attachment saved):", e);
    }
  }
  return res;
}
