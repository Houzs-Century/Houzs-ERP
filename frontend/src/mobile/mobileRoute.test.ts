import { describe, it, expect } from "vitest";
import {
  mobileDestinationMatches,
  resolveMobileRoute,
  type MobileDestination,
} from "./mobileRoute";
import { ROUTE_ALIASES } from "../lib/routeAliases";

/**
 * The regression these guard is the production incident of 2026-07-19: on a
 * narrow viewport, /scm/purchase-orders rendered the SALES ORDERS page — right
 * down to the title and the /api/scm/mfg-sales-orders request — because the
 * mobile shell never read the URL. Every expectation below that is NOT
 * `{ t: "home" }` is a path that used to silently produce the Orders list.
 */

// A user who can reach everything the mobile app implements.
const ALL: MobileDestination[] = [
  { to: "/scm/sales-orders", label: "Sales Orders" },
  { to: "/scm/sales-orders/maintenance", label: "SO Maintenance" },
  { to: "/scm/amendments", label: "Amendments" },
  { to: "/scm/delivery-orders", label: "Delivery Orders" },
  { to: "/scm/purchase-orders", label: "Purchase Orders" },
  { to: "/scm/purchase-invoices", label: "Purchase Invoices" },
  { to: "/projects", label: "Projects" },
  { to: "/team?tab=members", label: "Members" },
  { to: "/team?tab=departments", label: "Departments" },
];

describe("resolveMobileRoute", () => {
  it("keeps the app's landing on the default tab", () => {
    // The PWA start_url and every post-login redirect. If this ever resolved
    // to desktop-only the app would open on a dead end.
    expect(resolveMobileRoute("/", ALL, ALL)).toEqual({ t: "home" });
    expect(resolveMobileRoute("", ALL, ALL)).toEqual({ t: "home" });
  });

  it("opens the Profile tab for /profile", () => {
    // The tab exists, so claiming it "hasn't been built for phones" would be a
    // new small lie in place of the big one.
    expect(resolveMobileRoute("/profile", ALL, ALL)).toEqual({ t: "tab", tab: "profile" });
  });

  it("opens the RIGHT screen for a path the mobile app implements", () => {
    // The incident's headline case: this used to render Sales Orders.
    expect(resolveMobileRoute("/scm/purchase-orders", ALL, ALL))
      .toEqual({ t: "menu", to: "/scm/purchase-orders", label: "Purchase Orders" });
    expect(resolveMobileRoute("/scm/purchase-invoices", ALL, ALL))
      .toEqual({ t: "menu", to: "/scm/purchase-invoices", label: "Purchase Invoices" });
    expect(resolveMobileRoute("/scm/delivery-orders", ALL, ALL))
      .toEqual({ t: "menu", to: "/scm/delivery-orders", label: "Delivery Orders" });
  });

  it("says so plainly when there is no mobile screen at all", () => {
    // Two desktop-only URLs from the incident report. Neither has a mobile
    // screen; both used to render the Sales Orders list. (/scm/stock-transfers
    // was the third such example here until it was given a mobile menu row —
    // it is a real destination now, so asserting the opposite would make this
    // test itself the lie it was written to catch.)
    expect(resolveMobileRoute("/scm/lorry-capacity", ALL, ALL))
      .toEqual({ t: "desktop-only", path: "/scm/lorry-capacity" });
    expect(resolveMobileRoute("/scm/hr/settings", ALL, ALL))
      .toEqual({ t: "desktop-only", path: "/scm/hr/settings" });
    // A path that exists nowhere must also NOT fall through to a document list
    // or claim that a desktop page exists.
    expect(resolveMobileRoute("/nonsense", ALL, ALL))
      .toEqual({ t: "not-found", path: "/nonsense" });
    // Dynamic desktop routes are recognised from the executable manifest.
    expect(resolveMobileRoute("/scm/purchase-orders/PO-2607-001", ALL, ALL))
      .toEqual({ t: "desktop-only", path: "/scm/purchase-orders/PO-2607-001" });
  });

  it("locks a real destination the user's position may not open", () => {
    // In allKnown but not in visible. Landing such a user on Orders would be
    // the same lie in a smaller form.
    const visible = ALL.filter((d) => d.to !== "/scm/purchase-orders");
    expect(resolveMobileRoute("/scm/purchase-orders", visible, ALL))
      .toEqual({ t: "locked", label: "Purchase Orders" });
  });

  it("deep-links a single sales order, and never mistakes a flow for a doc", () => {
    expect(resolveMobileRoute("/scm/sales-orders/SO-2607-001", ALL, ALL))
      .toEqual({ t: "so-detail", docNo: "SO-2607-001" });
    // Reserved segments are creation flows / their own destinations, not docNos.
    expect(resolveMobileRoute("/scm/sales-orders/new", ALL, ALL))
      .toEqual({ t: "desktop-only", path: "/scm/sales-orders/new" });
    expect(resolveMobileRoute("/scm/sales-orders/generate", ALL, ALL))
      .toEqual({ t: "desktop-only", path: "/scm/sales-orders/generate" });
    // maintenance is an exact destination and must win before the docNo rule.
    expect(resolveMobileRoute("/scm/sales-orders/maintenance", ALL, ALL))
      .toEqual({ t: "menu", to: "/scm/sales-orders/maintenance", label: "SO Maintenance" });
    // Deeper than one segment is a desktop wizard, not a document.
    expect(resolveMobileRoute("/scm/sales-orders/new/guided", ALL, ALL))
      .toEqual({ t: "desktop-only", path: "/scm/sales-orders/new/guided" });
  });

  it("gates the SO deep link on the SO list being visible", () => {
    const visible = ALL.filter((d) => d.to !== "/scm/sales-orders");
    expect(resolveMobileRoute("/scm/sales-orders/SO-2607-001", visible, ALL))
      .toEqual({ t: "locked", label: "Sales Orders" });
  });

  it("uses Members as the default for a bare /team URL", () => {
    expect(resolveMobileRoute("/team", ALL, ALL))
      .toEqual({ t: "menu", to: "/team?tab=members", label: "Members" });
  });

  it("refreshes each Team bookmark into its exact tab", () => {
    expect(resolveMobileRoute("/team?tab=members", ALL, ALL))
      .toEqual({ t: "menu", to: "/team?tab=members", label: "Members" });
    expect(resolveMobileRoute("/team?tab=departments", ALL, ALL))
      .toEqual({ t: "menu", to: "/team?tab=departments", label: "Departments" });
  });

  it("never lets the Members path authorize another Team tab", () => {
    const membersOnly = ALL.filter((d) => d.to !== "/team?tab=departments");
    expect(resolveMobileRoute("/team?tab=departments", membersOnly, ALL))
      .toEqual({ t: "locked", label: "Departments" });

    // Positions is intentionally absent from every implemented mobile
    // destination: the owner manages it through backend/tooling only.
    expect(resolveMobileRoute("/team?tab=positions", membersOnly, ALL))
      .toEqual({ t: "desktop-only", path: "/team" });
  });

  it("treats query-bearing Team destinations as separate identities", () => {
    expect(mobileDestinationMatches("/team?tab=members", "/team?tab=members")).toBe(true);
    expect(mobileDestinationMatches("/team?tab=members", "/team?tab=departments")).toBe(false);
    expect(mobileDestinationMatches("/team?tab=departments", "/team?tab=members")).toBe(false);
    // Query ordering does not create a second identity.
    expect(mobileDestinationMatches("/team?view=list&tab=members", "/team?tab=members&view=list")).toBe(true);
    // Incidental URL state does not erase the declared tab identity.
    expect(mobileDestinationMatches("/team?tab=members&utm_source=bookmark", "/team?tab=members")).toBe(true);
    // Ambiguous/repeated identity params remain fail-closed.
    expect(mobileDestinationMatches("/team?tab=members&tab=departments", "/team?tab=members")).toBe(false);
  });

  it("applies desktop's canonical aliases before resolving mobile routes", () => {
    expect(resolveMobileRoute("/sales-orders", ALL, ALL))
      .toEqual({ t: "menu", to: "/scm/sales-orders", label: "Sales Orders" });
    expect(resolveMobileRoute("/purchase-orders?source=bookmark", ALL, ALL))
      .toEqual({ t: "menu", to: "/scm/purchase-orders", label: "Purchase Orders" });
  });

  it.each(ROUTE_ALIASES.map((alias) => [alias.from, alias.to]))(
    "gives mobile alias %s the same outcome as canonical %s",
    (from, to) => {
      expect(resolveMobileRoute(from, ALL, ALL)).toEqual(resolveMobileRoute(to, ALL, ALL));
    },
  );

  it("treats a trailing slash, a query and a hash as the same page", () => {
    for (const p of ["/scm/purchase-orders/", "/scm/purchase-orders?x=1", "/scm/purchase-orders#top"]) {
      expect(resolveMobileRoute(p, ALL, ALL))
        .toEqual({ t: "menu", to: "/scm/purchase-orders", label: "Purchase Orders" });
    }
  });

  it("decodes an escaped document number", () => {
    expect(resolveMobileRoute("/scm/sales-orders/SO%2F2607%2F001", ALL, ALL))
      .toEqual({ t: "so-detail", docNo: "SO/2607/001" });
  });

  it("fails a malformed escaped document number into 404 instead of throwing", () => {
    expect(resolveMobileRoute("/scm/sales-orders/%E0%A4%A", ALL, ALL))
      .toEqual({ t: "not-found", path: "/scm/sales-orders/%E0%A4%A" });
  });
});
