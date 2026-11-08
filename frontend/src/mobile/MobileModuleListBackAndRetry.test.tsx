/* The phone's generic list (Suppliers, Purchase Orders, ...):
   - a failed load used to say "Pull to refresh to try again" on a screen with no
     pull-to-refresh, so there was no way back short of leaving (Conts-ERP #594);
     it now has a Retry button;
   - opening a card replaces the list, so Back remounted it with the search and
     chips cleared (the phone side of Conts-ERP #406); they are now kept. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "../lib/storageIdentity";

const authedFetch = vi.fn();
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 7, role: "admin" }, can: () => true, pageAccess: () => "full" }),
}));
vi.mock("../vendor/scm/lib/authed-fetch", () => ({ authedFetch: (...a: unknown[]) => authedFetch(...a) }));

import { MobileModuleList, type ModuleConfig } from "./MobileModuleList";

const CONFIG: ModuleConfig = {
  title: "Things",
  endpoint: "/test-things",
  listKey: "things",
  primary: (r: { name: string }) => r.name,
};

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileModuleList config={CONFIG} onBack={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authedFetch.mockReset();
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  bindBrowserStorageIdentity(7);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearBrowserStorageIdentity();
  sessionStorage.clear();
});

describe("the phone's list screens", () => {
  it("a failed load offers Retry, and Retry loads the list", async () => {
    authedFetch.mockRejectedValueOnce(new Error("HTTP 503")).mockResolvedValue({ things: [{ id: 1, name: "Alpha" }] });
    renderList();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(/Pull to refresh/)).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText("Alpha")).toBeTruthy();
  });

  it("keeps the search on Back from a card", async () => {
    authedFetch.mockResolvedValue({ things: [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }] });
    const first = renderList();
    const box = await screen.findByPlaceholderText("Search things");
    fireEvent.change(box, { target: { value: "bet" } });
    first.unmount();

    renderList();
    await waitFor(() => expect((screen.getByPlaceholderText("Search things") as HTMLInputElement).value).toBe("bet"));
  });
});
