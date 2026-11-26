
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
  tab.opener = null;
  tab.location.href = url;
  if (revokeAfterMs !== null) window.setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}
