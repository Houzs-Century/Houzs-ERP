import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ROUTE_ALIASES, resolveAlias } from "./routeAliases";

// App.tsx is read as TEXT rather than imported — importing it would pull in
// the whole lazy-loaded page graph, providers and auth context for what is a
// pure routing-table assertion. This mirrors the existing pattern in
// `src/auth/permissionDivergence.test.ts`.
const appSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../App.tsx"),
  "utf8",
);

/** Every `path="..."` literal declared in App.tsx's route tree. */
const declaredPaths = new Set(
  [...appSource.matchAll(/path="([^"]+)"/g)].map((m) => m[1]),
);

describe("ROUTE_ALIASES", () => {
  it("declares at least one alias (the table did not silently empty)", () => {
    expect(ROUTE_ALIASES.length).toBeGreaterThan(0);
  });

  // ── The owner's condition: old paths must keep working. ──────────────────
  describe("every alias resolves to its destination", () => {
    it.each(ROUTE_ALIASES.map((a) => [a.from, a.to]))(
      "%s resolves to %s",
      (from, to) => {
        expect(resolveAlias(from)).toBe(to);
      },
    );
  });

  describe("every destination is a route that actually exists", () => {
    it.each(ROUTE_ALIASES.map((a) => [a.to, a.from]))(
      "%s is declared in App.tsx (aliased from %s)",
      (to) => {
        expect(declaredPaths).toContain(to);
      },
    );
  });

  // ── Safety invariants. ──────────────────────────────────────────────────
  it("no alias shadows a real route", () => {
    // A `from` that is also a declared route would hijack a working page and
    // bounce it elsewhere — the exact silent dead end this work exists to
    // avoid.
    const shadowing = ROUTE_ALIASES.filter((a) => declaredPaths.has(a.from));
    expect(shadowing).toEqual([]);
  });

  it("no alias points at another alias (no redirect chains)", () => {
    const froms = new Set(ROUTE_ALIASES.map((a) => a.from));
    const chained = ROUTE_ALIASES.filter((a) => froms.has(a.to));
    expect(chained).toEqual([]);
  });

  it("no alias redirects to itself (no infinite loop)", () => {
    expect(ROUTE_ALIASES.filter((a) => a.from === a.to)).toEqual([]);
  });

  it("has no duplicate sources", () => {
    const froms = ROUTE_ALIASES.map((a) => a.from);
    expect(froms.length).toBe(new Set(froms).size);
  });

  it("uses absolute paths only", () => {
    for (const a of ROUTE_ALIASES) {
      expect(a.from.startsWith("/")).toBe(true);
      expect(a.to.startsWith("/")).toBe(true);
    }
  });

  it("returns null for a path that is not an alias", () => {
    expect(resolveAlias("/definitely-not-a-route")).toBeNull();
    expect(resolveAlias("/")).toBeNull();
  });

  // ── Regression pins for the specific reported pain. ──────────────────────
  describe("the reported 404 class", () => {
    it("a spurious /scm prefix on the fair report now resolves", () => {
      expect(resolveAlias("/scm/reports/fair-report")).toBe(
        "/reports/fair-report",
      );
    });

    it("a missing /scm prefix on sales orders now resolves", () => {
      expect(resolveAlias("/sales-orders")).toBe("/scm/sales-orders");
    });

    it("a missing /scm prefix on SO maintenance now resolves", () => {
      expect(resolveAlias("/sales-orders/maintenance")).toBe(
        "/scm/sales-orders/maintenance",
      );
    });
  });

  // ── The renames deliberately NOT made. ───────────────────────────────────
  // These paths double as permission identifiers (see routeAliases.ts header).
  // If a future PR renames them, these assertions fail and force the author to
  // update every mirror — Sidebar NAV_TABS, MOBILE_MENU_GROUPS,
  // destinationScreen(), gateVia targets and SO_RESERVED_SEGMENTS.
  describe("identifier paths remain untouched", () => {
    it.each([
      "/reports/fair-report",
      "/scm/sales-orders/maintenance",
      "/scm/delivery-returns",
      "/scm/fleet",
      "/my-cases",
    ])("%s is still a declared route", (path) => {
      expect(declaredPaths).toContain(path);
    });
  });
});
