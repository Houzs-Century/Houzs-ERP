import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { scmAreaGuard } from "../src/scm/middleware/area-guard";
import { userCanWriteScmConfig } from "../src/services/positionPolicy";

/* ────────────────────────────────────────────────────────────────────────────
   SO MAINTENANCE — the page's own reference reads must be REACHABLE.

   The owner opened /scm/sales-orders/maintenance in production and three of its
   seven reads came back 403, twice each:
       GET /inventory/warehouses
       GET /delivery-planning-regions
       GET /delivery-planning-regions/states
   while venues, so-dropdown-options and state-warehouse-mappings loaded fine on
   the same page load. The asymmetry was the whole clue: the four that worked are
   mounted as cross-area REFERENCE reads (coarse umbrella, or openRead), and the
   three that failed were gated on two unrelated ADMIN areas — scm.warehouse.
   inventory and scm.transportation.drivers — that this page is not.

   These drive the REAL middleware on the REAL mount strings from scm/index.ts
   and assert HTTP status, following scmReturnsGuard.test.ts: proving the option
   is set and proving the door opens are two different claims.

   THE CALLER UNDER TEST is deliberately the WORST case that should still be able
   to read this page: scm_l2_configured, with `none` on both admin areas and no
   `*`. If that caller gets through, every wider one does. `*` is not the
   interesting case — area-guard.ts:101 has always short-circuited it.
   ──────────────────────────────────────────────────────────────────────────── */

/** Mirrors the live mounts in scm/index.ts exactly, including the options. */
function appFor(user: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user as never);
    await next();
  });

  // scm/index.ts — the two mounts this fix changed.
  app.use(
    "/inventory/*",
    scmAreaGuard("scm.warehouse.inventory", { openReadPaths: ["/inventory/warehouses"] }),
  );
  app.use(
    "/delivery-planning-regions/*",
    scmAreaGuard("scm.transportation.drivers", { openRead: true }),
  );

  app.all("/inventory/*", (c) => c.json({ reached: true }));
  app.all("/delivery-planning-regions/*", (c) => c.json({ reached: true }));
  return app;
}

/** A caller with an explicit SCM L2 config that grants NEITHER admin area — the
 *  configuration that produced the owner's 403s. `page_access` carries a real
 *  `none` on both, so the guard's no-lockout fallthrough cannot rescue it. */
const l2ConfiguredNonAdmin = {
  id: 2,
  permissions: ["scm.access"],
  permissions_set: new Set(["scm.access"]),
  position_name: "Sales Executive",
  department_name: "Sales Department",
  scm_l2_configured: true,
  page_access: {
    "scm.sales.orders": "edit" as const,
    "scm.warehouse.inventory": "none" as const,
    "scm.transportation.drivers": "none" as const,
  },
};

describe("SO Maintenance reference reads are reachable", () => {
  test("GET /inventory/warehouses — the warehouse picklist loads", async () => {
    const res = await appFor(l2ConfiguredNonAdmin).request("/inventory/warehouses");
    expect(res.status).toBe(200);
  });

  test("the ?includeInactive query string does not defeat the path match", async () => {
    const res = await appFor(l2ConfiguredNonAdmin).request(
      "/inventory/warehouses?includeInactive=true",
    );
    expect(res.status).toBe(200);
  });

  test("GET /delivery-planning-regions — the region master loads", async () => {
    const res = await appFor(l2ConfiguredNonAdmin).request("/delivery-planning-regions");
    expect(res.status).toBe(200);
  });

  test("GET /delivery-planning-regions/states — the per-state map loads", async () => {
    const res = await appFor(l2ConfiguredNonAdmin).request("/delivery-planning-regions/states");
    expect(res.status).toBe(200);
  });
});

describe("the hatch is READ-ONLY — nothing else in those areas opened", () => {
  /* The reason /inventory/* got openReadPaths and not openRead. Everything else
     under Inventory is stock levels, FIFO lots, movements, COGS and valuation;
     opening those to any authenticated caller would be a real leak, and a future
     edit that widens this to `openRead: true` must break here. */
  test("the rest of the Inventory API is still gated", async () => {
    for (const path of [
      "/inventory/balances",
      "/inventory/movements",
      "/inventory/lots",
      "/inventory/product-totals",
    ]) {
      const res = await appFor(l2ConfiguredNonAdmin).request(path);
      expect(res.status, `${path} must stay gated`).toBe(403);
    }
  });

  test("a warehouse WRITE still requires edit on scm.warehouse.inventory", async () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const res = await appFor(l2ConfiguredNonAdmin).request("/inventory/warehouses", { method });
      expect(res.status, `${method} must stay gated`).toBe(403);
    }
  });

  test("a region WRITE still requires edit on scm.transportation.drivers", async () => {
    for (const [method, path] of [
      ["POST", "/delivery-planning-regions"],
      ["PATCH", "/delivery-planning-regions/abc"],
      ["DELETE", "/delivery-planning-regions/abc"],
      ["PUT", "/delivery-planning-regions/states/Selangor"],
    ] as const) {
      const res = await appFor(l2ConfiguredNonAdmin).request(path, { method });
      expect(res.status, `${method} ${path} must stay gated`).toBe(403);
    }
  });

  test("a grant on the area still works — this narrowed nothing", async () => {
    const storekeeper = {
      ...l2ConfiguredNonAdmin,
      position_name: "Storekeeper",
      department_name: "Operation Department",
      page_access: { "scm.warehouse.inventory": "view" as const },
    };
    const res = await appFor(storekeeper).request("/inventory/balances");
    expect(res.status).toBe(200);
  });
});

describe("the write gate the page's banner reads", () => {
  /* SalesOrderMaintenance.tsx asked `can('scm.config.write')` — the FLAT key
     only — while the API gate (scm/lib/houzs-perms.canWriteScmConfig) has
     accepted `flat OR position` since 2026-07-18. So a position-granted config
     writer was shown "Read-only view" over a page whose edits the API would take.
     Both sides now read userCanWriteScmConfig; these pin what it answers. */

  const withPosition = (position_name: string, department_name: string) => ({
    permissions_set: new Set(["scm.access"]),
    position_name,
    department_name,
  });

  test("a CONFIG_WRITE position passes WITHOUT the flat key", () => {
    for (const p of [
      "Super Admin",
      "Procurement/Purchasing",
      "Operation Manager",
      "Operation Executive",
      "Logistic Admin",
    ]) {
      expect(userCanWriteScmConfig(withPosition(p, "Management")), p).toBe(true);
    }
  });

  test("the flat key alone still passes — nothing that worked stopped working", () => {
    expect(
      userCanWriteScmConfig({
        permissions_set: new Set(["scm.config.write"]),
        position_name: "Service Admin",
        department_name: "Operation Department",
      }),
    ).toBe(true);
  });

  test("the `*` wildcard passes", () => {
    expect(userCanWriteScmConfig({ permissions_set: new Set(["*"]) })).toBe(true);
  });

  test("this is not blanket access — the sales REPS and the restricted cohort stay out", () => {
    for (const [pos, dept] of [
      ["Sales Executive", "Sales Department"],
      ["Sales Manager", "Sales Department"],
      ["Storekeeper", "Operation Department"],
      ["Driver", "Operation Department"],
      ["Finance Manager", "Management"],
    ] as const) {
      expect(userCanWriteScmConfig(withPosition(pos, dept)), pos).toBe(false);
    }
    // The one sales position that DOES hold it (owner 2026-09-01) — asserted
    // here so the exclusion list above can never quietly re-swallow him.
    expect(
      userCanWriteScmConfig(withPosition("Sales Director", "Sales Department")),
      "Sales Director",
    ).toBe(true);
  });

  test("an unidentifiable caller fails CLOSED", () => {
    expect(userCanWriteScmConfig(null)).toBe(false);
    expect(userCanWriteScmConfig(undefined)).toBe(false);
    expect(userCanWriteScmConfig({})).toBe(false);
  });
});
