import { api } from "../api/client";
import { openLoadedTab } from "./openLoadedTab";

const REVOKE_AFTER_MS = 60_000;

export function isPdfAttachment(contentType: string | null | undefined): boolean {
  return (contentType ?? "").includes("pdf");
}

export async function openAssrAttachment(r2Key: string, contentType: string | null): Promise<void> {
  await openLoadedTab(
    () => api.fetchBlobUrl(`/api/assr/attachments/${r2Key}`, contentType),
    REVOKE_AFTER_MS,
  );
}
