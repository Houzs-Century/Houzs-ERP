import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AccessLevel } from "../types";

/* B29 (sister: Conts #761): Finance's pages sit inside sub-groups. A clerk whose
   only grant is Money in was told "You don't have access to any finance modules
   yet", because the hub kept only direct children that have a page. */
let access: Record<string, AccessLevel> = {};

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 7, name: "Money-in clerk", permissions: [], page_access: access },
    can: () => false,
    pageAccess: (k: string) => access[k] ?? "none",
  }),
}));

afterEach(() => {
  cleanup();
  access = {};
});

async function renderFinanceHub() {
  const { ScmSubgroupHub } = await import("./ScmSubgroupHub");
  render(
    <MemoryRouter>
      <ScmSubgroupHub groupId="scm-finance" description="Finance." />
    </MemoryRouter>,
  );
}

describe("ScmSubgroupHub — pages inside a sub-group count", () => {
  it("shows a Money-in-only clerk the Money in pages, not the no-access message", async () => {
    access = { "scm.finance": "partial", "scm.finance.money_in": "full" };
    await renderFinanceHub();
    expect(screen.queryByText(/don't have access/i)).toBeNull();
    expect(screen.getByText("Receipts")).toBeTruthy();
    expect(screen.getByText("Invoices")).toBeTruthy();
    expect(screen.getByText("Debtor maintenance")).toBeTruthy();
    expect(screen.queryByText("Payment vouchers")).toBeNull();
    expect(screen.queryByText("Daily Bank")).toBeNull();
  });

  it("shows only Outstanding pages to an Outstanding-only grant", async () => {
    access = { "scm.finance.outstanding": "view" };
    await renderFinanceHub();
    expect(screen.getByText("Outstanding")).toBeTruthy();
    expect(screen.getByText("Not yet billed")).toBeTruthy();
    expect(screen.queryByText("Receipts")).toBeNull();
  });

  it("still says no access when no Finance page is open to the reader", async () => {
    access = { "scm.sales": "full" };
    await renderFinanceHub();
    expect(screen.getByText(/don't have access to any finance modules/i)).toBeTruthy();
  });
});
