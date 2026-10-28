import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AliasRedirect, aliasRedirectTarget } from "./AliasRedirect";

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
