import { Navigate, useLocation } from "react-router-dom";

/** Preserve bookmark/search state while replacing an additive legacy alias. */
export function aliasRedirectTarget(to: string, search: string, hash: string): string {
  return `${to}${search || ""}${hash || ""}`;
}

export function AliasRedirect({ to }: { to: string }) {
  const location = useLocation();
  return (
    <Navigate
      to={aliasRedirectTarget(to, location.search, location.hash)}
      replace
    />
  );
}

/** The address a page that folded into another sends its bookmarks to: the
 *  new page, with `add` set over every search param the old address carried
 *  (Money in's Official receipts became Receipts' kind, batch 5 §1). */
export function foldRedirectTarget(to: string, add: Readonly<Record<string, string>>, search: string, hash: string): string {
  const params = new URLSearchParams(search);
  for (const [k, v] of Object.entries(add)) params.set(k, v);
  const qs = params.toString();
  return `${to}${qs ? `?${qs}` : ""}${hash || ""}`;
}

export function FoldRedirect({ to, add }: { to: string; add: Readonly<Record<string, string>> }) {
  const location = useLocation();
  return <Navigate to={foldRedirectTarget(to, add, location.search, location.hash)} replace />;
}
