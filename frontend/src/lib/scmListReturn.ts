// SCM list-return memory — makes a document detail's back button land on the
// list the user actually came from, WITH their search + filters intact.
//
// Owner 2026-07-24: after searching/filtering a document list then opening one
// row, Back should return to that filtered list — not a bare, reset list.
//
// The SCM V2 lists keep their whole view state in the URL query
// (?q=&status=&view=&page=), NOT in sticky storage. #1188 made every detail's
// back button navigate to the BARE list path, which fixed "back must land on
// the list" but dropped the query — so the search/filter was lost. This module
// restores it without giving up the #1188 guarantee:
//
//   · Scm2990Shell (which wraps every /scm/* list AND detail) records the
//     CURRENT list URL — path + query — on every list render, keyed by section.
//   · A detail's goBack reads back that section's remembered URL and returns
//     there; when nothing is remembered (a direct link, a cross-document jump,
//     a fresh tab) it falls back to the bare list path. Either way Back lands
//     on the list.
//
// sessionStorage, per browser tab — a return target is navigation state, scoped
// to this tab's session exactly like the workspace-tab strip. Values are same-
// origin paths only.

export const SCM_LIST_RETURN_KEY = "houzs.scmListReturn.v1";

/** The sidebar-level section a /scm path belongs to: /scm/<section>[/...] →
 *  "/scm/<section>". Query + trailing id segments are ignored, so a list URL
 *  and its document details map to the same key. */
function sectionOf(pathname: string): string {
  const bare = (pathname || "").split("?")[0].split("#")[0];
  const segs = bare.split("/").filter(Boolean);
  if (segs[0] === "scm" && segs[1]) return `/scm/${segs[1]}`;
  return bare;
}

/** Is this a LIST url (a section root, /scm/<section>) rather than a detail
 *  (/scm/<section>/<id>) or an action child (/new, /maintenance, …)? Only list
 *  URLs are worth remembering as a return target. */
function isListPath(pathname: string): boolean {
  const bare = (pathname || "").split("?")[0].split("#")[0];
  const segs = bare.split("/").filter(Boolean);
  return segs.length === 2 && segs[0] === "scm";
}

function readMap(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(SCM_LIST_RETURN_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Same-origin path only — a stored value is fed to navigate(); reject
      // "//host" (protocol-relative) and anything not rooted at "/".
      if (typeof v === "string" && /^\/(?!\/)/.test(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Record the current list URL (path + query) for its section. No-op unless
 *  `pathname` is a list path, so details/action pages never overwrite the
 *  target their own Back needs. */
export function rememberScmListReturn(pathname: string, search: string): void {
  if (!isListPath(pathname)) return;
  try {
    const map = readMap();
    map[sectionOf(pathname)] = `${pathname}${search || ""}`;
    sessionStorage.setItem(SCM_LIST_RETURN_KEY, JSON.stringify(map));
  } catch {
    // storage disabled (private mode) — Back simply falls back to the bare list
  }
}

/** Where a detail's Back should go: the remembered filtered list URL for this
 *  section, or `listPath` (the bare list) when nothing is remembered. */
export function scmListReturnTo(listPath: string): string {
  const stored = readMap()[sectionOf(listPath)];
  return stored && sectionOf(stored) === sectionOf(listPath) ? stored : listPath;
}
