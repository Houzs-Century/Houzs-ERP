/* "An order moved between fairs" — told across the project page's blocks, so
 * the sales report and the Sales Orders list both read again after a transfer
 * in either (owner 2026-10-20). A window event rather than a prop: the page that
 * renders both blocks (Projects.tsx) is at its file-size ceiling.
 */
import { useEffect } from "react";

const PROJECT_SALES_CHANGED = "houzs:project-sales-changed";

export function announceProjectSalesChanged(): void {
  window.dispatchEvent(new Event(PROJECT_SALES_CHANGED));
}

/** Run `reload` whenever a transfer on this page moved an order. */
export function useOnProjectSalesChanged(reload: () => void): void {
  useEffect(() => {
    const onChange = () => reload();
    window.addEventListener(PROJECT_SALES_CHANGED, onChange);
    return () => window.removeEventListener(PROJECT_SALES_CHANGED, onChange);
  }, [reload]);
}
