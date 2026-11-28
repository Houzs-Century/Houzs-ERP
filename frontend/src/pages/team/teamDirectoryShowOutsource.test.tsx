// Team directory — the "Show outsource" toggle (owner 2026-11-28, PR2). Outsource
// logins are hidden by default; an admin flips the toggle and the directory
// refetches /api/users?includeExternal=1 so they can set / reset a password.
// Uses the REAL useQuery so the key change actually drives a refetch — the whole
// point of the feature is that the two result sets do not share a cache entry.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiGet, canValue } = vi.hoisted(() => ({ apiGet: vi.fn(), canValue: { value: true } }));
vi.mock("../../api/client", () => ({
  api: { get: apiGet, post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
  tokenStore: { get: () => null, set: vi.fn() },
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, name: "Admin" }, can: () => canValue.value }),
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../hooks/useDialog", () => ({ useDialog: () => ({ confirm: vi.fn(async () => true), prompt: vi.fn(async () => null) }) }));

import { TeamDirectory } from "./TeamDirectory";

function mockApi() {
  apiGet.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/users?") || url === "/api/users") return { users: [] };
    if (url === "/api/departments") return { departments: [] };
    if (url === "/api/positions") return { positions: [] };
    if (url === "/api/roles") return { roles: [] };
    if (url === "/api/companies") return { companies: [], activeCompanyCode: "HC" };
    if (url === "/api/users/impersonation-enabled") return { enabled: false };
    return {};
  });
}

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TeamDirectory inviteOpen={false} onCloseInvite={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

afterEach(cleanup);

describe("Show outsource toggle", () => {
  it("fetches the plain list first, then adds ?includeExternal=1 when flipped on", async () => {
    canValue.value = true;
    mockApi();
    wrap();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/users"));
    expect(apiGet).not.toHaveBeenCalledWith("/api/users?includeExternal=1");

    fireEvent.click(screen.getByLabelText("Show outsource"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/users?includeExternal=1"));
  });

  it("does not offer the toggle to someone who cannot manage members", async () => {
    canValue.value = false;
    mockApi();
    wrap();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/users"));
    expect(screen.queryByLabelText("Show outsource")).toBeNull();
  });
});
