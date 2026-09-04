import { useLocation } from "react-router-dom";

export type AppSurface =
  | "survey"
  | "portal"
  | "doscan"
  | "doscanbasket"
  | "reset"
  | "invite"
  | "privacy"
  | "contractor"
  | "staff";

/**
 * Pick the top-level application tree for one browser location.
 *
 * This must run from the live Router location, not once at module evaluation:
 * reset/invite screens navigate back to `/`, and a frozen decision leaves the
 * new URL trapped inside the old public-only route tree.
 */
export function appSurfaceForPath(pathname: string): AppSurface {
  if (pathname.startsWith("/survey/")) return "survey";
  if (
    pathname === "/track" ||
    pathname.startsWith("/track/") ||
    pathname === "/portal" ||
    pathname.startsWith("/portal/")
  ) return "portal";
  // The printed delivery-order QR. NO LOGIN — the driver opens it with a phone
  // camera and the 64-hex token in the path is the only credential (owner:
  // 「就跟hookka一样」). It must land OUTSIDE AuthGate for the same reason the
  // survey does: a staff sign-in screen in front of it makes the paper useless.
  /* BEFORE the token branch, or "/d/scan" resolves as a token named "scan" and
     the driver gets "unknown or expired QR code" for a page that exists. Same
     trap the backend's /batch routes carry, and the same fix: the specific path
     is decided first. A real token can never collide — it is 10 or 64 characters
     from a fixed alphabet. */
  if (pathname === "/d/scan" || pathname === "/d/scan/") return "doscanbasket";
  if (pathname.startsWith("/d/")) return "doscan";
  // The per-contractor calendar share link. NO LOGIN — a booth contractor opens
  // it and sees only their confirmed events; the token in the path is the only
  // credential. Outside AuthGate for the same reason /d/ is.
  if (pathname.startsWith("/c/")) return "contractor";
  if (pathname.startsWith("/reset/")) return "reset";
  if (pathname.startsWith("/invite/")) return "invite";
  // The App Store's privacy-policy URL. A static file cannot survive the
  // Pages clean-URL + SPA-fallback combination (BUG-HISTORY 2026-08-06), so
  // the policy is a public surface of the SPA itself.
  if (pathname === "/privacy" || pathname.startsWith("/privacy/")) return "privacy";
  return "staff";
}

export function useAppSurface(): AppSurface {
  return appSurfaceForPath(useLocation().pathname);
}
