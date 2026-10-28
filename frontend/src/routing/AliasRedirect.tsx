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
