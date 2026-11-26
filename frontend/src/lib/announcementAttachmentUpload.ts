
import { api } from "../api/client";
import { prepareImageForUpload } from "./imagePipeline";

export type AnnouncementAttachmentUpload = {
  r2Key: string;
  mime: string;
  size: number;
  name: string;
};

export async function uploadAnnouncementAttachment(
  rawFile: File,
): Promise<AnnouncementAttachmentUpload> {
  const prepared = await prepareImageForUpload(rawFile);
  const f = prepared.file;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  const res = await api.putBinary<{ r2Key: string; mime: string; size: number }>(
    `/api/announcements/compose/attachments/upload?ext=${ext}`,
    f,
    f.type,
  );
  if (prepared.thumb) {
    try {
      await api.putBinary(
        `/api/announcements/compose/attachments/upload-thumb?key=${encodeURIComponent(res.r2Key)}`,
        prepared.thumb,
        prepared.thumb.type,
      );
    } catch (e) {
      console.warn("[announcement-upload] thumb upload failed (attachment saved):", e);
    }
  }
  return { ...res, name: f.name };
}
