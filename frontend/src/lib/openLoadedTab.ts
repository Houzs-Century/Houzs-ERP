/* Opening a file that has to be fetched first (an authed attachment, a scan, a
   print view). A `window.open` that runs after an `await` has lost the tap, and
   phone browsers block it as a popup without any error: the tap did nothing.
   So the tab is opened HERE, synchronously, before the first await, and pointed
   at the file once it has loaded. Callers must call this directly from the tap
   handler, before any await of their own. */

export const POPUP_BLOCKED_MESSAGE =
  "Your browser blocked the new tab. Allow pop-ups for this site and try again.";

export async function openLoadedTab(
  load: () => Promise<string>,
  revokeAfterMs: number | null,
): Promise<void> {
  const tab = window.open("", "_blank");
  if (!tab) throw new Error(POPUP_BLOCKED_MESSAGE);
  let url: string;
  try {
    url = await load();
  } catch (e) {
    tab.close();
    throw e;
  }
  // The same isolation "noopener" gave: the opened page cannot reach back.
  tab.opener = null;
  tab.location.href = url;
  if (revokeAfterMs !== null) window.setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}
