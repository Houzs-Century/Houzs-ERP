import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { ROUTE_ALIASES } from "../lib/routeAliases";
import {
  MOBILE_MENU_GROUPS,
  PROFILE_ORG_ITEMS,
  destinationScreen,
} from "../mobile/MobileApp";
import {
  mobileDestinationMatches,
  resolveMobileRoute,
  type MobileDestination,
} from "../mobile/mobileRoute";
import {
  PUBLIC_ROUTE_PATTERNS,
  ROUTE_CONTRACT,
  STAFF_LEGACY_REDIRECT_PATTERNS,
  STAFF_ROUTE_PATTERNS,
  isKnownStaffLocation,
} from "./routeManifest";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (relative: string) => readFileSync(resolve(HERE, "..", relative), "utf8");

const appSource = src("App.tsx");
const mainSource = src("main.tsx");
const portalSource = src("portal/PortalApp.tsx");

const appLiteralPaths = [...appSource.matchAll(/path="([^"]+)"/g)].map((match) => match[1]);
const appPages = appLiteralPaths.filter(
  (path) => path !== "*" && !(STAFF_LEGACY_REDIRECT_PATTERNS as readonly string[]).includes(path),
);

const flattenNav = (tabs: readonly NavTab[]): NavTab[] =>
  tabs.flatMap((tab) => [tab, ...flattenNav(tab.children ?? [])]);

const allMobile: MobileDestination[] = [
  ...MOBILE_MENU_GROUPS.flatMap((group) => group.items),
  ...PROFILE_ORG_ITEMS,
];

describe("executable route contract", () => {
  it("matches every canonical staff page mounted by App.tsx, with no extras", () => {
    // 143 since 2026-08-21: /scm/do-load, the DO print's loading-QR landing page.
    // 144 since 2026-08-25: /scm/loading-list, the warehouse no-price loading queue.
    // (143 since 2026-08-25: driver POD; 142 since 2026-08-16: /scm/daily-bank.)
    // (141 since 2026-08-15: /autocount-sync, the AutoCount write-back queue.)
    expect(STAFF_ROUTE_PATTERNS).toHaveLength(144);
    expect(new Set(STAFF_ROUTE_PATTERNS).size).toBe(STAFF_ROUTE_PATTERNS.length);
    expect([...STAFF_ROUTE_PATTERNS].sort()).toEqual([...appPages].sort());
  });

  it("records every public surface instead of treating App.tsx as the whole app", () => {
    expect(PUBLIC_ROUTE_PATTERNS).toEqual([
      "/survey/:token",
      "/track",
      "/portal/case/:ref/:token",
      "/portal/case/:token",
      "/portal/supplier/:token",
      "/reset/:token",
      "/invite/:token",
      "/privacy",
    ]);
    const mountedPublic = [...`${mainSource}\n${portalSource}`.matchAll(/path="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => path !== "*");
    expect([...new Set(["/survey/:token", ...mountedPublic])].sort())
      .toEqual([...PUBLIC_ROUTE_PATTERNS].sort());
    // 153 since 2026-08-25 — /scm/loading-list; see the staff-route count above.
    // (152 since 2026-08-21.) (151 since 2026-08-16.) (150 since 2026-08-15.)
    expect(ROUTE_CONTRACT).toHaveLength(153);
  });

  it("keeps every desktop nav destination on a live staff route", () => {
    const dead = flattenNav(NAV_TABS)
      .filter((tab) => tab.to)
      .map((tab) => tab.to!.split("?")[0])
      .filter((path) => !(STAFF_ROUTE_PATTERNS as readonly string[]).includes(path));
    expect(dead).toEqual([]);
  });

  it("keeps the public/staff surface decision reactive inside BrowserRouter", () => {
    expect(mainSource).toContain("const surface = useAppSurface()");
    expect(mainSource).not.toContain("const path = window.location.pathname");
  });

  it("recognises static and dynamic desktop-only paths, but not typos", () => {
    expect(isKnownStaffLocation("/scm/hr/settings")).toBe(true);
    expect(isKnownStaffLocation("/SCM/HR/SETTINGS/")).toBe(true);
    expect(isKnownStaffLocation("/scm/purchase-orders/PO-2607-001?from=mail")).toBe(true);
    expect(isKnownStaffLocation("/scm/inventory/stock-card/SKU%2F001")).toBe(true);
    expect(isKnownStaffLocation("/definitely-not-a-page")).toBe(false);
  });
});

describe("mobile route drift gate", () => {
  it("pins the complete runtime destination inventory", () => {
    // 35 since 2026-08-15: the System group and its one row, /autocount-sync.
    expect(MOBILE_MENU_GROUPS.flatMap((group) => group.items)).toHaveLength(35);
    expect(PROFILE_ORG_ITEMS).toHaveLength(5);
    expect(allMobile).toHaveLength(40);
    expect(new Set(allMobile.map((item) => item.to)).size).toBe(40);
    expect(new Set(allMobile.map((item) => item.to.split("?")[0])).size).toBe(39);
  });

  it("maps every declared mobile row to a real screen, never a placeholder stub", () => {
    const stubs = allMobile
      .filter((item) => destinationScreen(item.to, item.label).t === "stub")
      .map((item) => `${item.label} (${item.to})`);
    expect(stubs).toEqual([]);
  });

  it("proves alias parity against the full runtime menu, not a hand-written subset", () => {
    const nativeAliases = ROUTE_ALIASES.filter((alias) =>
      allMobile.some((item) => mobileDestinationMatches(alias.to, item.to)),
    );
    const desktopOnlyAliases = ROUTE_ALIASES.filter((alias) => !nativeAliases.includes(alias));
    expect(nativeAliases).toHaveLength(21);
    expect(desktopOnlyAliases).toHaveLength(10);

    for (const alias of ROUTE_ALIASES) {
      const canonical = resolveMobileRoute(alias.to, allMobile, allMobile);
      const legacy = resolveMobileRoute(alias.from, allMobile, allMobile);
      expect(legacy, `${alias.from} drifted from ${alias.to}`).toEqual(canonical);
      if (nativeAliases.includes(alias)) {
        expect(canonical.t, `${alias.to} is a real mobile destination`).toBe("menu");
      } else {
        expect(canonical.t, `${alias.to} is intentionally desktop-only`).toBe("desktop-only");
      }
    }
  });

  it("distinguishes a known desktop page from a nonexistent URL", () => {
    expect(resolveMobileRoute("/scm/hr/settings", allMobile, allMobile))
      .toEqual({ t: "desktop-only", path: "/scm/hr/settings" });
    expect(resolveMobileRoute("/typo-that-exists-nowhere", allMobile, allMobile))
      .toEqual({ t: "not-found", path: "/typo-that-exists-nowhere" });
  });
});
