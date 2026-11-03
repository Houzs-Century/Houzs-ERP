import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AliasRedirect, FoldRedirect, aliasRedirectTarget, foldRedirectTarget } from "./AliasRedirect";

afterEach(cleanup);

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

describe("AliasRedirect", () => {
  it("preserves query and hash when forming the canonical bookmark", () => {
    expect(aliasRedirectTarget("/scm/purchase-orders", "?source=mail&page=3", "#row-17"))
      .toBe("/scm/purchase-orders?source=mail&page=3#row-17");
  });

  it("replaces an alias without dropping its query/hash state", async () => {
    render(
      <MemoryRouter
        initialEntries={["/purchase-orders?source=mail&page=3#row-17"]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/purchase-orders" element={<AliasRedirect to="/scm/purchase-orders" />} />
          <Route path="/scm/purchase-orders" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("location")).textContent)
      .toBe("/scm/purchase-orders?source=mail&page=3#row-17");
  });
});

/* Money in's Official receipts folded into Receipts (Claude Design, batch 5
   §1): a bookmark or a To do link lands on the kind, its status and month kept. */
describe("FoldRedirect", () => {
  it("sets the folded page's own params over the ones the old address carried", () => {
    expect(foldRedirectTarget("/scm/receipts", { kind: "official" }, "?status=DRAFT&month=2026-09", ""))
      .toBe("/scm/receipts?status=DRAFT&month=2026-09&kind=official");
    expect(foldRedirectTarget("/scm/receipts", { kind: "official" }, "", "#x")).toBe("/scm/receipts?kind=official#x");
  });

  it("replaces the old address with the new page", async () => {
    render(
      <MemoryRouter initialEntries={["/scm/official-receipts?month=all"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/scm/official-receipts" element={<FoldRedirect to="/scm/receipts" add={{ kind: "official" }} />} />
          <Route path="/scm/receipts" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("location")).textContent).toBe("/scm/receipts?month=all&kind=official");
  });
});
