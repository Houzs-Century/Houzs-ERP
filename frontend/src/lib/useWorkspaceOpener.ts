// Back from a document to the page it was opened from (owner 2026-10-21: 我从
// merchant recon 点开 SO，返回也要返回 merchant recon).
//
// The tab strip (lib/workspaceTabs) records, on a tab opened as a DOCUMENT, the
// tab and page it was opened from (WorkspaceTab.opener). This module reads that
// and acts on it, through the strip's public API only — it lives OUTSIDE the
// strip's module because only the document pages need it, and the strip ships
// in the app shell's first download (the initial-JS budget,
// scripts/check-bundle-size.mjs).

import { useSyncExternalStore } from "react";
import {
  activateWorkspaceTab, closeWorkspaceTab, getWorkspaceTabsSnapshot, subscribeWorkspaceTabs, workspaceTabLabel,
  type WorkspaceTabsSnapshot,
} from "./workspaceTabs";

/** Names for the pages an order is opened from whose generic route label reads
    as the bare app section. */
const OPENER_LABELS: Array<[RegExp, string]> = [
  [/^\/scm\/merchant-recon(?:\/|$)/, "Merchant Recon"],
  [/^\/scm\/bank-recon(?:\/|$)/, "Bank Recon"],
  [/^\/scm\/fair-pending(?:\/|$)/, "Fair Links"],
];

/** The opener of the ACTIVE tab, and whether its tab is still in the strip —
    null unless the active tab was opened as a document from another page. */
export function workspaceOpener(
  snapshot: WorkspaceTabsSnapshot = getWorkspaceTabsSnapshot(),
): { id: string; href: string; tabOpen: boolean } | null {
  const active = snapshot.tabs.find((t) => t.id === snapshot.activeId);
  if (!active?.opener) return null;
  const { id, href } = active.opener;
  return { id, href, tabOpen: snapshot.tabs.some((t) => t.id === id) };
}

/**
 * Back to the page the active document was opened from. When the opener's tab
 * is still in the strip it becomes the active tab and this document's tab
 * closes — the way closing a browser tab hands you back the one that opened
 * it, without leaving a second copy of that page in the strip. Otherwise this
 * tab goes back there itself. Returns the address to navigate to (the page as
 * it was when the document was opened), or null when the active tab was not
 * opened as a document.
 */
export function returnToWorkspaceOpener(): string | null {
  const snapshot = getWorkspaceTabsSnapshot();
  const opener = workspaceOpener(snapshot);
  if (!opener) return null;
  const docTab = snapshot.activeId;
  if (opener.tabOpen && docTab) {
    activateWorkspaceTab(opener.id);
    closeWorkspaceTab(docTab);
  }
  return opener.href;
}

/** The page the open document was opened from, named for its Back button —
    null when this tab was not opened as a document (Back then keeps going to
    the document's own list). Re-read whenever the strip changes. */
export function useWorkspaceOpener(): { href: string; label: string } | null {
  const snapshot = useSyncExternalStore(subscribeWorkspaceTabs, getWorkspaceTabsSnapshot, getWorkspaceTabsSnapshot);
  const opener = workspaceOpener(snapshot);
  if (!opener) return null;
  const path = opener.href.split("?")[0] ?? opener.href;
  const named = OPENER_LABELS.find(([re]) => re.test(path))?.[1];
  return { href: opener.href, label: named ?? (workspaceTabLabel(path) || "the previous page") };
}
