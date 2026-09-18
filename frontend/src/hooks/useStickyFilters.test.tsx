import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "../lib/storageIdentity";
import { useStickyFilters } from "./useStickyFilters";

function Probe() {
  const [params] = useStickyFilters("sales", ["q", "status"]);
  return <output data-testid="params">{params.toString()}</output>;
}

afterEach(() => {
  cleanup();
  clearBrowserStorageIdentity();
  localStorage.clear();
  sessionStorage.clear();
});

describe("useStickyFilters identity scope", () => {
  it("restores only the current user's stored filter snapshot", async () => {
    sessionStorage.setItem("filters:sales", "q=legacy-leak");
    bindBrowserStorageIdentity(7);
    sessionStorage.setItem("filters:sales:u7:c0", "q=mine&status=draft");

    render(<MemoryRouter initialEntries={["/"]}><Probe /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByTestId("params").textContent).toBe("q=mine&status=draft");
    });
    expect(screen.getByTestId("params").textContent).not.toContain("legacy-leak");
  });

  it("does not expose the previous user's filter after identity changes", async () => {
    sessionStorage.setItem("filters:sales:u7:c0", "q=private-customer");
    bindBrowserStorageIdentity(8);

    render(<MemoryRouter initialEntries={["/"]}><Probe /></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId("params").textContent).toBe(""));
    expect(screen.getByTestId("params").textContent).not.toContain("private-customer");
  });

  it("keeps a bookmarked URL authoritative over stored state", async () => {
    bindBrowserStorageIdentity(7);
    sessionStorage.setItem("filters:sales:u7:c0", "q=stored");

    render(<MemoryRouter initialEntries={["/?q=bookmark"]}><Probe /></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId("params").textContent).toBe("q=bookmark"));
  });
});

// Owner 2026-08-24: "i want make it my filter didnt close until i manually clear
// filter or close erp then filter will auto clear" — the storage KIND is the
// feature here, so it is asserted rather than left to the hook's comment.
describe("useStickyFilters is session-scoped", () => {
  it("survives a remount — the open-a-project-and-come-back case", async () => {
    bindBrowserStorageIdentity(7);
    render(<MemoryRouter initialEntries={["/?q=kept&status=draft"]}><Probe /></MemoryRouter>);
    await waitFor(() =>
      expect(sessionStorage.getItem("filters:sales:u7:c0")).toBe("q=kept&status=draft"),
    );
    cleanup();

    // Remount with a BARE url, exactly as returning from /projects/:id does.
    render(<MemoryRouter initialEntries={["/"]}><Probe /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByTestId("params").textContent).toBe("q=kept&status=draft"),
    );
  });

  it("ignores and cleans up a pre-2026-08-24 localStorage snapshot", async () => {
    bindBrowserStorageIdentity(7);
    // What a previous login left behind; it must not resurrect the old view.
    localStorage.setItem("filters:sales:u7:c0", "q=last-week");

    render(<MemoryRouter initialEntries={["/"]}><Probe /></MemoryRouter>);

    await waitFor(() =>
      expect(localStorage.getItem("filters:sales:u7:c0")).toBeNull(),
    );
    expect(screen.getByTestId("params").textContent).toBe("");
  });
});
