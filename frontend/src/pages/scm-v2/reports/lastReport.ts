// ----------------------------------------------------------------------------
// lastReport — the report opened last in this browser tab (batch 6 §1.1): the
// sidebar's one Reports entry goes back to it, else to the first report the
// reader may open. sessionStorage `fin-reports-last` holds the report's sidebar
// address (its `navTo`); lib/browserStorageRegistry lists the key and this file.
//
// Kept apart from reportPrefs so the sidebar — in the app's first download —
// reads one small module. Every read and write is wrapped: a private window or
// blocked storage only means the entry opens the first report.
// ----------------------------------------------------------------------------

const LAST_KEY = 'fin-reports-last';

/** The sidebar address of the report opened last in this tab, or null. */
export function readLastReport(): string | null {
  try {
    const v = window.sessionStorage.getItem(LAST_KEY);
    return v && v.startsWith('/') ? v : null;
  } catch {
    return null;
  }
}

export function writeLastReport(navTo: string): void {
  try {
    window.sessionStorage.setItem(LAST_KEY, navTo);
  } catch { /* nothing remembered */ }
}
