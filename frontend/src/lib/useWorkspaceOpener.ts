import { useSyncExternalStore } from "react";
import { getWorkspaceTabsSnapshot, subscribeWorkspaceTabs, workspaceOpener, workspaceTabLabel } from "./workspaceTabs";

/**
 * The page the open document was opened from, with its name for the Back
 * button — null when this tab was not opened as a document (then Back keeps
 * going to the document's own list). Subscribed to the tab strip, so it is
 * re-read whenever the strip changes.
 * Owner 2026-10-21: 我从 merchant recon 点开 SO，返回也要返回 merchant recon.
 */
export function useWorkspaceOpener(): { href: string; label: string } | null {
  useSyncExternalStore(subscribeWorkspaceTabs, getWorkspaceTabsSnapshot, getWorkspaceTabsSnapshot);
  const opener = workspaceOpener();
  if (!opener) return null;
  const path = opener.href.split("?")[0] ?? opener.href;
  return { href: opener.href, label: workspaceTabLabel(path) || "the previous page" };
}
