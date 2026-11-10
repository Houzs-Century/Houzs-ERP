// ---------------------------------------------------------------------------
// unsavedWork — "would reloading this tab right now throw away something the
// operator typed?"
//
// The create / edit forms register through hooks/useLeaveGuard; this file does
// not depend on every form doing so. It answers the question CONSERVATIVELY from two sources,
// and a caller that is about to reload WITHOUT asking treats either one as "yes":
//
//   1. HOLDERS — a component that knows it holds unbooked input says so while it
//      does: PaymentsTable's unsaved payment rows, any <Panel> passed `dirty`,
//      and every form that holds the leave guard (hooks/useLeaveGuard).
//   2. THE URL — every create / convert / edit surface in this app is addressed
//      by one: `/new`, `/from-<doc>`, `?edit=…`. A reload there is never done
//      automatically, whether or not the form has been touched yet.
//
// What it CANNOT see, stated plainly: an in-page edit toggle that neither changes
// the URL nor registers a holder. The only automatic reload that consults this
// (chunkActionRecovery.ts) fires from a Print preview on a detail page in VIEW
// mode, which is the shape it was checked against.
// ---------------------------------------------------------------------------

import { useEffect } from "react";

const holders = new Set<symbol>();

/** Hold "unsaved work" until the returned release runs. Idempotent release. */
export function holdUnsavedWork(): () => void {
  const token = Symbol("unsaved-work");
  holders.add(token);
  return () => {
    holders.delete(token);
  };
}

/** Hold unsaved work for as long as `dirty` is true and the caller is mounted. */
export function useUnsavedWork(dirty: boolean): void {
  useEffect(() => (dirty ? holdUnsavedWork() : undefined), [dirty]);
}

export function isEditorUrl(location: { pathname: string; search: string }): boolean {
  const edit = new URLSearchParams(location.search).get("edit");
  if (edit !== null && edit !== "0" && edit !== "false") return true;
  return location.pathname
    .split("/")
    .some((segment) => segment === "new" || segment === "edit" || segment.startsWith("from-"));
}

export function hasUnsavedWork(location: { pathname: string; search: string }): boolean {
  return holders.size > 0 || isEditorUrl(location);
}
