import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ROUTE_ALIASES, resolveAlias } from "./routeAliases";

const appSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../App.tsx"),
  "utf8",
);

const declaredPaths = new Set(
  [...appSource.matchAll(/path="([^"]+)"/g)].map((m) => m[1]),
);

describe("ROUTE_ALIASES", () => {
  it("declares at least one alias (the table did not silently empty)", () => {
    expect(ROUTE_ALIASES.length).toBeGreaterThan(0);
  });

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

  it("no alias shadows a real route", () => {
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
