import { describe, it, expect } from "vitest";
import { NAV_TABS, type NavTab } from "./Sidebar";
import { makeNavFilter, makeNavVisible, type NavFilterCtx } from "./navFilter";
import type { AuthUser } from "../types";

/**
 * Desktop/phone nav agreement — owner's standing rule: "電腦電話的權限應該一樣的"
 * (the laptop and the phone must grant the same thing).
 *
 * The two surfaces consume NAV_TABS through DIFFERENT walks: the desktop filters
 * the TREE (a hidden group is dropped whole, children unmapped), the phone gates
 * each destination against the matching LEAF. So a leaf can disagree with itself
 * across surfaces without either walk looking wrong on its own — that is exactly
 * how the Amendments rule below sat dead on desktop for a day while shipping on
 * the phone. These tests pin the agreement itself, not either walk.
 */

const rep = (over: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 1,
    email: "rep@example.test",
    name: "Rep",
    role_id: 1,
    role_name: "user",
    status: "active",
    permissions: [],
    position_name: "Sales Executive",
    department_name: "Sales Department",
    ...over,
  }) as AuthUser;

const ctxFor = (
  user: AuthUser,
  access: Record<string, string> = {},
): NavFilterCtx => ({
  user,
  can: (p) => (user.permissions ?? []).includes(p),
  pageAccess: (page) => (access[page] ?? "none") as never,
});

/** The desktop Sidebar's view: filter the tree, then flatten what survived. */
function desktopPaths(ctx: NavFilterCtx): string[] {
  const filterTab = makeNavFilter(ctx);
  const out: string[] = [];
  const walk = (t: NavTab) => {
    if (t.to) out.push(t.to.split("?")[0]);
    (t.children ?? []).forEach(walk);
  };
  NAV_TABS.map(filterTab)
    .filter((t): t is NavTab => t !== null)
    .forEach(walk);
  return out;
}

/** The mobile shell's view — a faithful copy of MobileApp's `allowed(to)`:
 *  walk the RAW tree and ask whether ANY node at that path is visible. Fails
 *  CLOSED on an unmatched path, mirroring the 2026-07-19 flip in MobileApp (every
 *  path asserted here has a NAV_TABS entry, so this only keeps the copy honest). */
function phoneAllows(ctx: NavFilterCtx, to: string): boolean {
  const navVisible = makeNavVisible(ctx);
  const flat: NavTab[] = [];
  const walk = (t: NavTab) => {
    flat.push(t);
    (t.children ?? []).forEach(walk);
  };
  NAV_TABS.forEach(walk);
  const path = to.split("?")[0];
  const matches = flat.filter((t) => t.to?.split("?")[0] === path);
  return matches.length === 0 ? false : matches.some(navVisible);
}

describe("nav — Amendments for a sales rep (owner rule 2026-07-16)", () => {
  const access = { "scm.sales.orders": "edit" };

  it("shows Amendments on BOTH desktop and phone", () => {
    const ctx = ctxFor(rep(), access);
    expect(desktopPaths(ctx)).toContain("/scm/amendments");
    expect(phoneAllows(ctx, "/scm/amendments")).toBe(true);
  });

  it("shows it exactly once on desktop — no duplicate row", () => {
    const ctx = ctxFor(rep(), access);
    const hits = desktopPaths(ctx).filter((p) => p === "/scm/amendments");
    expect(hits).toHaveLength(1);
  });

  /* The rep leaf must not depend on the SCM matrix: /scm/amendments is an
     `allowSales` route (App.tsx ScmGuard), which admits ANY sales staff whatever
     their page access. A nav gate stricter than the route would hide a page the
     rep can still reach by typing the URL. */
  it("shows Amendments even with no SCM page access at all", () => {
    const ctx = ctxFor(rep(), {});
    expect(desktopPaths(ctx)).toContain("/scm/amendments");
    expect(phoneAllows(ctx, "/scm/amendments")).toBe(true);
  });
});

describe("nav — the rep SCM trim stays trimmed", () => {
  /* The guard on the fix. The Amendments leaf sits inside a hideForSalesRep
     group whose OTHER children are not individually flagged, so the tempting
     "make the filter recurse into hidden groups" fix would have surfaced all of
     these too. Each one is a real permission boundary, not a nicety. */
  const leaked = [
    "/scm/consignment-orders",
    "/scm/consignment-notes",
    "/scm/consignment-returns",
    "/scm/purchase-consignment-orders",
    "/scm/purchase-consignment-receives",
    "/scm/purchase-consignment-returns",
    "/scm/accounting",
    "/scm/payment-vouchers",
    "/scm/outstanding",
    "/scm/unbilled-deliveries",
    "/scm/currencies",
    "/scm/products",
    "/scm/suppliers",
    "/scm/mrp",
    "/scm/purchase-orders",
    "/scm/grns",
    "/scm/inventory",
    "/scm/stock-takes",
    "/scm/delivery-returns",
  ];

  it.each(leaked)("hides %s from a sales rep on desktop AND phone", (path) => {
    const ctx = ctxFor(rep(), { "scm.sales.orders": "edit" });
    expect(desktopPaths(ctx)).not.toContain(path);
    expect(phoneAllows(ctx, path)).toBe(false);
  });
});

describe("nav — Adjustments gates on scm.warehouse.adjustments after the split (2026-07-18)", () => {
  /* Stock ADJUSTMENT was split off Inventory (owner 2026-07-18): POST
     /inventory/adjustments is now gated server-side on scm.warehouse.adjustments
     by its own area-guard sub-mount (scm/index.ts) — adjusting stock changes
     valuation, so it is separable from viewing inventory. The nav + route now gate
     on that same key. These pin the split from the FE side: the Adjustments entry
     shows for a holder of scm.warehouse.adjustments and is HIDDEN from a holder of
     only scm.warehouse.inventory (who keeps Inventory) — the Storekeeper case. All
     fixtures use an Operation-dept member (not a sales rep) so hideForSalesRep does
     not confound the result, and each sets an L1 area key so the "Supply Chain"
     umbrella (anyAccess = L1 keys only) resolves visible — otherwise the whole
     subtree is dropped before the leaf is reached. */
  const opsMember = (): AuthUser =>
    rep({ position_name: "Storekeeper", department_name: "Operation Department" });

  it("shows Adjustments to a holder of scm.warehouse.adjustments on desktop AND phone", () => {
    const ctx = ctxFor(opsMember(), {
      "scm.warehouse": "view", // L1 grant opens the umbrella + group
      "scm.warehouse.adjustments": "edit", // the real gate the server now enforces
    });
    expect(desktopPaths(ctx)).toContain("/scm/stock-adjustments");
    expect(phoneAllows(ctx, "/scm/stock-adjustments")).toBe(true);
  });

  it("HIDES Adjustments from the Storekeeper whitelist (warehouse+inventory view, no adjustments), who still sees Inventory", () => {
    // The Storekeeper resolved map: scm.warehouse = view (L1, opens the umbrella +
    // group), scm.warehouse.inventory = view, and adjustments/transfers/stock_take
    // = none. Post-split, viewing inventory must NOT surface the Adjustments page —
    // a Storekeeper VIEWS racking/bin but cannot adjust (the server 403s the POST).
    const ctx = ctxFor(opsMember(), {
      "scm.warehouse": "view",
      "scm.warehouse.inventory": "view",
      "scm.warehouse.adjustments": "none",
      "scm.warehouse.transfers": "none",
      "scm.warehouse.stock_take": "none",
    });
    const paths = desktopPaths(ctx);
    expect(paths).not.toContain("/scm/stock-adjustments");
    expect(paths).toContain("/scm/inventory"); // Inventory stays visible
    expect(phoneAllows(ctx, "/scm/stock-adjustments")).toBe(false);
  });

  it("a full-cohort member (adjustments=full) sees both Inventory and Adjustments", () => {
    // Under the position policy, an unrestricted position resolves to full on
    // every key — including the new scm.warehouse.adjustments — so it keeps the
    // whole warehouse group.
    const ctx = ctxFor(opsMember(), {
      "scm.warehouse": "full",
      "scm.warehouse.inventory": "full",
      "scm.warehouse.adjustments": "full",
    });
    const paths = desktopPaths(ctx);
    expect(paths).toContain("/scm/stock-adjustments");
    expect(paths).toContain("/scm/inventory");
  });
});

describe("nav — office and director are untouched by the rep leaf", () => {
  /* The Supply Chain umbrella lists only L1 area keys in its anyAccess, so a
     user reaching Amendments by the subgroup path needs the L1 scm.sales grant,
     not just the L2 scm.sales.orders one. */
  const officeAccess = { "scm.sales": "edit", "scm.sales.orders": "edit" };

  it("keeps Amendments for a Sales Director (subgroup path)", () => {
    const dir = rep({
      position_name: "Sales Director",
      project_finance_viewer: true,
    });
    const ctx = ctxFor(dir, officeAccess);
    const hits = desktopPaths(ctx).filter((p) => p === "/scm/amendments");
    expect(hits).toHaveLength(1);
    expect(phoneAllows(ctx, "/scm/amendments")).toBe(true);
  });

  it("keeps Amendments for non-sales office staff", () => {
    const office = rep({
      position_name: "Admin Executive",
      department_name: "Office",
    });
    const ctx = ctxFor(office, officeAccess);
    const hits = desktopPaths(ctx).filter((p) => p === "/scm/amendments");
    expect(hits).toHaveLength(1);
  });

  it("does not give the rep-only leaf to office staff", () => {
    const office = rep({
      position_name: "Admin Executive",
      department_name: "Office",
    });
    const ctx = ctxFor(office, {});
    expect(desktopPaths(ctx)).not.toContain("/scm/amendments");
  });
});

/**
 * Finance + HR lifted OUT of Supply Chain (owner 2026-07-18: "finance and HR is
 * not under supply chain").
 *
 * A lift like this is exactly where nav refactors leak access: as an SCM child a
 * group was gated on parent AND self (filterTab drops a hidden group's subtree
 * unmapped), so moving it to the root SILENTLY REMOVES the parent's half of the
 * condition. These tests pin that nothing widened.
 */
describe("nav — Finance / HR are top-level, not under Supply Chain", () => {
  const admin = () => rep({ permissions: ["*"], position_name: "IT Admin", department_name: "IT Department" });

  const topLevelLabels = (ctx: NavFilterCtx): string[] => {
    const filterTab = makeNavFilter(ctx);
    return NAV_TABS.map(filterTab)
      .filter((t): t is NavTab => t !== null)
      .map((t) => t.label);
  };

  it("both are ROOT entries for a user who can see everything", () => {
    const labels = topLevelLabels(ctxFor(admin()));
    expect(labels).toContain("Finance");
    expect(labels).toContain("HR");
  });

  it("neither is a child of Supply Chain any more", () => {
    const scm = NAV_TABS.find((t) => t.groupId === "scm");
    const childLabels = (scm?.children ?? []).map((c) => c.label);
    expect(childLabels).not.toContain("Finance");
    expect(childLabels).not.toContain("HR");
  });

  it("every Finance and HR URL still resolves — a reorganisation, not a route change", () => {
    const paths = desktopPaths(ctxFor(admin()));
    for (const p of [
      "/scm/accounting", "/scm/payment-vouchers", "/scm/outstanding",
      "/scm/unbilled-deliveries", "/scm/currencies",
      "/scm/hr/commission", "/scm/hr/settings",
    ]) expect(paths).toContain(p);
  });

  /* NO WIDENING — Finance. Its own gate can only pass when the OLD parent's gate
     would also have passed: the anyPerm lists are identical, and page-access is
     hierarchical (a parent at "none" denies every child), so a granted
     scm.finance.* implies scm.finance and scm — both listed in Supply Chain's
     anyAccess. A user with NO SCM grant at all must still see nothing. */
  it("Finance stays absent for a user with no SCM access at all", () => {
    const ctx = ctxFor(rep({ position_name: "Storekeeper", department_name: "Operation Department" }));
    expect(topLevelLabels(ctx)).not.toContain("Finance");
    expect(desktopPaths(ctx)).not.toContain("/scm/accounting");
  });

  it("a Finance-only grant shows Finance and still no other SCM area", () => {
    const ctx = ctxFor(
      rep({ position_name: "Account Executive", department_name: "Management" }),
      { scm: "view", "scm.finance": "view", "scm.finance.accounting": "view" },
    );
    const paths = desktopPaths(ctx);
    expect(paths).toContain("/scm/accounting");
    expect(paths).not.toContain("/scm/purchase-orders");
    expect(paths).not.toContain("/scm/inventory");
  });

  /* HR is gated on its FLAT keys alone — deliberately no scm.access. That now
     matches the routes, which carry anyPerm ["*","scm.hr.read","scm.hr.manage"]
     and no ScmGuard (App.tsx). Holding neither key must still show nothing. */
  it("HR stays absent without an HR permission, even with full SCM access", () => {
    const ctx = ctxFor(
      rep({ position_name: "Purchaser", department_name: "Operation Department" }),
      { scm: "full", "scm.procurement": "full", "scm.procurement.po": "full" },
    );
    expect(topLevelLabels(ctx)).not.toContain("HR");
    expect(desktopPaths(ctx)).not.toContain("/scm/hr/commission");
  });

  it("scm.hr.read alone shows Commission but NOT the HR Settings editor", () => {
    const ctx = ctxFor(
      rep({ permissions: ["scm.hr.read"], position_name: "HR Executive", department_name: "Management" }),
    );
    const paths = desktopPaths(ctx);
    expect(paths).toContain("/scm/hr/commission");
    expect(paths).not.toContain("/scm/hr/settings");
  });

  it("a non-director sales rep sees neither group (hideForSalesRep survives the lift)", () => {
    const ctx = ctxFor(rep({ permissions: ["scm.hr.read"] }), { "scm.sales.orders": "edit" });
    const labels = topLevelLabels(ctx);
    expect(labels).not.toContain("Finance");
    expect(labels).not.toContain("HR");
  });

  it("desktop and phone agree on both groups' leaves", () => {
    const ctx = ctxFor(admin());
    for (const p of ["/scm/accounting", "/scm/hr/commission", "/scm/hr/settings"]) {
      expect(desktopPaths(ctx)).toContain(p);
      expect(phoneAllows(ctx, p)).toBe(true);
    }
  });
});

/**
 * Assistant is gated by the server-resolved capability (org.assistant.use), not
 * a position-name list. The nav link and the /assistant route guard read the
 * SAME answer, so they can no longer disagree — the drift that let a Sales user
 * see a launcher that 403s. capability() fails closed, so a shell with no
 * resolved set hides the link rather than leaking it.
 */
describe("nav — Assistant gates on the org.assistant.use capability", () => {
  const withCap = (v: boolean) =>
    rep({ position_name: "Operation Manager", department_name: "Operation Department", capabilities: { "org.assistant.use": v } });

  it("shows Assistant on desktop AND phone when the capability is true", () => {
    const ctx = ctxFor(withCap(true));
    expect(desktopPaths(ctx)).toContain("/assistant");
    expect(phoneAllows(ctx, "/assistant")).toBe(true);
  });

  it("hides Assistant on both surfaces when the capability is false", () => {
    const ctx = ctxFor(withCap(false));
    expect(desktopPaths(ctx)).not.toContain("/assistant");
    expect(phoneAllows(ctx, "/assistant")).toBe(false);
  });

  it("hides Assistant when no capability set was resolved (fails closed)", () => {
    const ctx = ctxFor(rep({ position_name: "Operation Manager", department_name: "Operation Department" }));
    expect(desktopPaths(ctx)).not.toContain("/assistant");
    expect(phoneAllows(ctx, "/assistant")).toBe(false);
  });
});

/**
 * Every groupId App.tsx mounts a sub-group hub for must resolve SOMEWHERE in
 * NAV_TABS. ScmSubgroupHub used to look these up inside `scm.children` only, so
 * lifting Finance to the root turned /scm/finance — a live, bookmarkable URL —
 * into "Not found". The lookup is tree-wide now; this pins that it stays true.
 */
describe("nav — every sub-group hub groupId still resolves", () => {
  const findGroup = (tabs: readonly NavTab[], id: string): NavTab | undefined => {
    for (const t of tabs) {
      if (t.groupId === id) return t;
      const hit = t.children && findGroup(t.children, id);
      if (hit) return hit;
    }
    return undefined;
  };

  it.each([
    "scm-sales", "scm-consignment", "scm-procurement",
    "scm-transportation", "scm-warehouse", "scm-finance",
  ])("%s exists and has children to render", (id) => {
    const g = findGroup(NAV_TABS, id);
    expect(g, `groupId "${id}" is mounted by App.tsx but absent from NAV_TABS`).toBeDefined();
    expect(g!.children?.length ?? 0).toBeGreaterThan(0);
  });
});
