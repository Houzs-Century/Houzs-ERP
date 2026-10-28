import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { resetWorkspaceTabsForTests } from "../lib/workspaceTabs";
import { useOpenDocInTab } from "../lib/openDocInTab";

/* End to end through the real strip (owner 2026-09-27, screenshot): clicking a
   DO on a Sales Order's relationship map adds a Delivery Orders tab beside the
   Sales Orders tab, which stays. */

function FakeSoPage() {
  const openDoc = useOpenDocInTab();
  return <button type="button" onClick={() => openDoc("/scm/delivery-orders/do-1")}>DO-2609-001</button>;
}

beforeEach(() => {
  sessionStorage.clear();
  resetWorkspaceTabsForTests();
});
afterEach(cleanup);

const tabLabels = () =>
  Array.from(document.querySelectorAll('[role="tab"]')).map((el) => el.textContent.trim());

describe("a document opened from a map gets its own strip tab", () => {
  it("the SO tab stays and a Delivery Orders tab opens beside it", () => {
    render(
      <MemoryRouter initialEntries={["/scm/sales-orders/HC-SO-001"]}>
        <WorkspaceTabs />
        <Routes>
          <Route path="/scm/sales-orders/:doc" element={<FakeSoPage />} />
          <Route path="/scm/delivery-orders/:id" element={<div>DO page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const before = tabLabels().length;
    fireEvent.click(screen.getByRole("button", { name: "DO-2609-001" }));
    expect(screen.getByText("DO page")).toBeTruthy();
    const after = tabLabels();
    expect(after.length).toBe(before + 1);
    expect(after.some((t) => /Sales Orders/.test(t))).toBe(true);
    expect(after.some((t) => /Delivery Orders/.test(t))).toBe(true);
  });
});
