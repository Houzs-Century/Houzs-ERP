
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
  } catch { }
}
