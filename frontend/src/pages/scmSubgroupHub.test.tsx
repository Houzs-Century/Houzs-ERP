import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { hasAnyScmPageAccess } from "../auth/salesAccess";
import type { AuthUser, AccessLevel } from "../types";

/**
 * Owner 2026-07-20 — a Sales Director may OPEN the /scm/sales-order sub-group hub
 * but must see ONLY their own modules there. Two halves are pinned:
 *   1. the GATE (App.tsx ScmGuard area="scm") admits them via hasAnyScmPageAccess,
 *      mirroring the backend requireScmAccess umbrella (any scm.* page !== "none")
 *      — without needing the broad `scm.access` permission a Sales Director lacks.
 *   2. the hub TILES are filtered to the sections their position grants: a Sales
 *      Director sees Sales Orders / Delivery Orders / Sales Invoices, never
 *      Delivery Returns (scm.sales.returns = none for them).
 */

// A Sales Director's resolved SCM page access (prod position_page_access[5] plus
// the SALES_JD leaf caps): scm.sales=full cascades to orders; delivery/invoices
// are view-capped; returns is denied. No procurement / warehouse / finance grant.
const SD_ACCESS: Record<string, AccessLevel> = {
  "scm.sales": "full",
  "scm.sales.orders": "full",
  "scm.sales.delivery": "view",
  "scm.sales.invoices": "view",
  "scm.sales.returns": "none",
};

// The Sales Director carries RBAC role "Member" (permissions []), so `can()` holds
// nothing — admittance + tiles must come from the position page-access alone.
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      name: "Test Sales Director",
      permissions: [],
      position_name: "Sales Director",
      department_name: "Sales Department",
      page_access: SD_ACCESS,
    },
    can: () => false,
    pageAccess: (k: string) => SD_ACCESS[k] ?? "none",
  }),
}));

const asUser = (over: Partial<AuthUser>): AuthUser =>
  ({ id: 1, permissions: [], page_access: {}, ...over }) as unknown as AuthUser;

afterEach(cleanup);

describe("SCM hub gate — hasAnyScmPageAccess (owner 2026-07-20)", () => {
  it("admits a Sales Director whose position grants scm.sales, with no scm.access", () => {
    expect(hasAnyScmPageAccess(asUser({ page_access: SD_ACCESS }))).toBe(true);
  });

  it("admits the `*` wildcard even with an empty page-access map", () => {
    expect(hasAnyScmPageAccess(asUser({ permissions: ["*"], page_access: {} }))).toBe(true);
  });

  it("denies a caller with no scm.* grant and no wildcard", () => {
    expect(
      hasAnyScmPageAccess(asUser({ page_access: { projects: "view", "scm.sales": "none" } })),
    ).toBe(false);
    expect(hasAnyScmPageAccess(null)).toBe(false);
  });
});

describe("ScmSubgroupHub — a Sales Director sees only their own sales modules", () => {
  it("shows Sales Orders / Delivery Orders / Sales Invoices, hides Delivery Returns", async () => {
    const { ScmSubgroupHub } = await import("./ScmSubgroupHub");
    render(
      <MemoryRouter>
        <ScmSubgroupHub groupId="scm-sales" description="Pick a section." />
      </MemoryRouter>,
    );
    // Granted tiles (scm.sales.orders=full, delivery/invoices=view) render.
    expect(screen.getByText("Sales Orders")).toBeTruthy();
    expect(screen.getByText("Delivery Orders")).toBeTruthy();
    expect(screen.getByText("Sales Invoices")).toBeTruthy();
    // scm.sales.returns = none → the tile is filtered out (own-modules-only).
    expect(screen.queryByText("Delivery Returns")).toBeNull();
  });
});
