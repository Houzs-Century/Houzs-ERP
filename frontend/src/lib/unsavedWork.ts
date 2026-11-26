
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
