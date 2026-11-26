
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
      console.warn("[assr-upload] thumb upload failed (attachment saved):", e);
    }
  }
  return res;
}
