/* docs/bugs/0931-a-new-title-could-not-be-created-anywhere-the-positions-tab.md
 * — the Titles tab (PositionsTab, ?tab=positions) was switched off on every
 * surface by #744, so no screen could create a Title. It is back in the Team
 * strip for users.manage. Renders the REAL Team page; faked: auth, the api
 * client (every read answers empty) and the toast/dialog hooks.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>() }));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    can: (p: string) => auth.perms.has(p) || auth.perms.has("*"),
    user: { id: 1, email: "admin@houzs.test", name: "Admin", position_name: null, role_name: "Super Admin" },
  }),
}));
vi.mock("../api/client", () => ({
  api: { get: vi.fn(async () => ({})), post: vi.fn(), patch: vi.fn(), del: vi.fn(), putBinary: vi.fn() },
  tokenStore: { set: vi.fn(), get: vi.fn(), clear: vi.fn() },
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true), prompt: vi.fn(async () => null) }),
}));

import { Team } from "./Team";

function mount(perms: string[], tab = "positions") {
  auth.perms = new Set(perms);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/team?tab=${tab}`]}>
        <Team />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});

describe("Team strip: Titles", () => {
  test("a users.manage caller sees the Titles tab and ?tab=positions opens the Titles page", async () => {
    mount(["users.read", "users.manage", "roles.read"]);
    expect(screen.getByRole("button", { name: "Titles" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /New Title/ })).toBeTruthy();
  });

  test("a users.read-only caller gets no Titles tab, and ?tab=positions falls through to their first tab", () => {
    mount(["users.read"]);
    expect(screen.queryByRole("button", { name: "Titles" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New Title/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Directory" })).toBeTruthy();
  });
});
