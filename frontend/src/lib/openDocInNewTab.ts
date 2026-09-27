import { getActiveCompanyId } from "./activeCompany";

/* Open an in-app page in a new browser tab ON THIS TAB'S COMPANY (owner
   2026-09-27: the SO relationship map opens linked documents in a new tab).
   A fresh tab otherwise boots into the user's stored default company, which
   can be the other tenant, and a 2990 document would not load under HOUZS.
   `?company=` is the same boot seed the switcher's "Open in new window" uses;
   main.tsx consumes and strips it. */
export function docTabUrl(path: string, companyId: number | null): string {
  if (companyId == null) return path;
  return `${path}${path.includes("?") ? "&" : "?"}company=${companyId}`;
}

export function openDocInNewTab(path: string): void {
  window.open(docTabUrl(path, getActiveCompanyId()), "_blank", "noopener,noreferrer");
}
