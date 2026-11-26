
import { resolveAlias } from "../lib/routeAliases";
import { isKnownStaffLocation } from "../routing/routeManifest";

/** Where a URL points, once resolved. */
export type MobileRoute =
  | { t: "home" }
  | { t: "tab"; tab: "profile" }
  | { t: "menu"; to: string; label: string }
  | { t: "so-detail"; docNo: string }
  | { t: "locked"; label: string }
  | { t: "desktop-only"; path: string }
  | { t: "not-found"; path: string };

export type MobileDestination = { to: string; label: string };

const SO_RESERVED_SEGMENTS = new Set(["new", "generate", "maintenance"]);

function normalisePath(pathname: string): string {
  const path = (pathname || "/").split("?")[0].split("#")[0];
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function splitLocation(location: string): { path: string; query: string } {
  const withoutHash = (location || "/").split("#")[0];
  const queryAt = withoutHash.indexOf("?");
  const rawPath = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutHash.slice(queryAt + 1);
  return { path: normalisePath(rawPath), query };
}

function includesDeclaredQuery(requested: string, declared: string): boolean {
  const requestedParams = new URLSearchParams(requested);
  const declaredParams = new URLSearchParams(declared);
  for (const key of new Set(declaredParams.keys())) {
    const expected = declaredParams.getAll(key).sort();
    const actual = requestedParams.getAll(key).sort();
    if (actual.length !== expected.length) return false;
    if (expected.some((value, index) => actual[index] !== value)) return false;
  }
  return true;
}

/**
 * Whether a browser location names one declared mobile destination.
 *
 * Query-bearing destinations are distinct identities. In particular,
 * `/team?tab=members` must never match `/team?tab=departments`: those rows can
 * carry different gates and open different screens. A bare `/team` keeps the
 * existing default-to-first-tab behaviour. Destinations without a declared
 * query continue to tolerate incidental browser query parameters.
 */
export function mobileDestinationMatches(location: string, destination: string): boolean {
  const requested = splitLocation(location);
  const declared = splitLocation(destination);
  if (requested.path !== declared.path) return false;
  if (!declared.query) return true;
  if (!requested.query) return true;
  return includesDeclaredQuery(requested.query, declared.query);
}

function canonicalLocation(location: string): string {
  const { path, query } = splitLocation(location);
  const canonicalPath = resolveAlias(path) ?? path;
  return query ? `${canonicalPath}?${query}` : canonicalPath;
}

/**
 * @param location    Browser pathname + search + hash (query/hash tolerated).
 * @param visible     Destinations this user may open — MobileApp's already
 *                    permission-filtered menu + profile rows.
 * @param allKnown    Every destination the mobile app implements, gate ignored.
 *                    A path in here but not in `visible` is `locked`; a path in
 *                    neither is `desktop-only`.
 */
export function resolveMobileRoute(
  location: string,
  visible: readonly MobileDestination[],
  allKnown: readonly MobileDestination[],
): MobileRoute {
  const canonical = canonicalLocation(location);
  const { path } = splitLocation(canonical);

  if (path === "/") return { t: "home" };

  if (path === "/profile") return { t: "tab", tab: "profile" };

  const match = (list: readonly MobileDestination[]) =>
    list.find((d) => mobileDestinationMatches(canonical, d.to));

  const visibleHit = match(visible);
  if (visibleHit) return { t: "menu", to: visibleHit.to, label: visibleHit.label };

  const knownHit = match(allKnown);
  if (knownHit) return { t: "locked", label: knownHit.label };

  const soDeep = /^\/scm\/sales-orders\/([^/]+)$/.exec(path);
  if (soDeep && !SO_RESERVED_SEGMENTS.has(soDeep[1])) {
    const canSo = visible.some((d) => mobileDestinationMatches("/scm/sales-orders", d.to));
    if (!canSo) return { t: "locked", label: "Sales Orders" };
    try {
      return { t: "so-detail", docNo: decodeURIComponent(soDeep[1]) };
    } catch {
      return { t: "not-found", path };
    }
  }

  return isKnownStaffLocation(path)
    ? { t: "desktop-only", path }
    : { t: "not-found", path };
}
