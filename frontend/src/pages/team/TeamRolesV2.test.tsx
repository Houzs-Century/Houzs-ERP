// Roles & Permissions — the "Roles" section (owner 2026-09-07): the ROLE
// editor (role list + permission checkboxes + New Role) is embedded as the
// first section, so an admin can reach a role's permissions from the strip
// instead of the ?tab=roles URL. The position matrix keeps its sections.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, canValue } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  canValue: { value: true },
}));
vi.mock("../../api/client", () => ({ api: { get: apiGet, post: apiPost, patch: vi.fn(), put: vi.fn(), del: vi.fn() } }));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ can: () => canValue.value }),
}));
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true), prompt: vi.fn(async () => null) }),
}));
vi.mock("../../hooks/useQuery", async () => {
  const React = await import("react");
  return {
    useQuery: (_key: string, fn: () => Promise<unknown>) => {
      const [state, setState] = React.useState<{ data: unknown; loading: boolean }>({ data: null, loading: true });
      const load = React.useCallback(() => void fn().then((d) => setState({ data: d, loading: false })), [fn]);
      React.useEffect(() => {
        load();
      }, []);
      return { ...state, error: null, fetching: false, placeholder: false, reload: load };
    },
  };
});

import { TeamRolesV2 } from "./TeamRolesV2";

function mockApi() {
  apiGet.mockImplementation(async (url: string) => {
    if (url === "/api/positions") return { positions: [] };
    if (url === "/api/roles/pages") return { pages: [] };
    if (url.startsWith("/api/roles/") && url.endsWith("/page-access")) return { page_access: {} };
    if (url === "/api/position-capabilities") return { capabilities: [], scm_keys: [], baselines: {}, grants: [], overrides: [] };
    if (url === "/api/roles") {
      return {
        roles: [
          { id: 1, name: "Owner", description: null, is_system: true, permissions: ["*"], member_count: 1, unknown_permissions: [] },
          { id: 7, name: "MD", description: "Managing Director", is_system: false, permissions: ["announcements.read"], member_count: 1, unknown_permissions: [] },
        ],
      };
    }
    if (url === "/api/roles/permissions") {
      return {
        permissions: [
          { key: "announcements.read", resource: "Announcements", verb: "read", label: "View announcements", description: "" },
          { key: "announcements.approve", resource: "Announcements", verb: "approve", label: "Approve announcements", description: "" },
        ],
      };
    }
    return {};
  });
}

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  canValue.value = true;
});

describe("TeamRolesV2 — Roles section", () => {
  it("opens on the Roles section: the role list from /api/roles, with New Role for roles.manage", async () => {
    mockApi();
    render(<TeamRolesV2 />);
    expect(await screen.findByRole("tab", { name: "Roles" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("MD")).toBeTruthy());
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByRole("button", { name: /New Role/ })).toBeTruthy();
    // The role editor is the classic one: opening a custom role shows the
    // permission checkboxes, grouped by module.
    fireEvent.click(screen.getByText("Edit permissions →"));
    await waitFor(() => expect(screen.getByText("Approve announcements")).toBeTruthy());
  });

  it("New Role opens the create editor; without roles.manage the button is absent", async () => {
    mockApi();
    render(<TeamRolesV2 />);
    await waitFor(() => expect(screen.getByText("MD")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /New Role/ }));
    await waitFor(() => expect(screen.getByText("New Role", { selector: "h2, h3, div, span" })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Create Role/ })).toBeTruthy();

    cleanup();
    canValue.value = false;
    render(<TeamRolesV2 />);
    await waitFor(() => expect(screen.getByText("MD")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /New Role/ })).toBeNull();
  });

  it("the position matrix is still there behind the Actions section", async () => {
    mockApi();
    render(<TeamRolesV2 />);
    fireEvent.click(await screen.findByRole("tab", { name: "Actions" }));
    await waitFor(() => expect(screen.getByText("Position")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /New Role/ })).toBeNull();
  });
});
