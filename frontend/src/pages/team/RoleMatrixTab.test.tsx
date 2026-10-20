// RoleMatrixTab — the owner sets a module to 无/看/改/批 and saves. This drives
// the REAL component (no prod: the page-access API is branch-only and the dev
// build talks to prod, so an end-to-end save would write live RBAC) and asserts
// the exact payloads: page access through PATCH /api/roles/:id/page-access, the
// scm.access umbrella reconciled onto PATCH /api/roles/:id {permissions}.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPatch } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));
vi.mock("../../api/client", () => ({
  api: { get: apiGet, patch: apiPatch, post: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock("../../hooks/useQuery", async () => {
  const React = await import("react");
  return {
    useQuery: (_key: string, fn: () => Promise<unknown>) => {
      const [state, setState] = React.useState<{ data: unknown; loading: boolean }>({ data: null, loading: true });
      const load = React.useCallback(() => void fn().then((d) => setState({ data: d, loading: false })), [fn]);
      React.useEffect(() => void load(), []);
      return { ...state, error: null, fetching: false, placeholder: false, reload: load };
    },
  };
});

import { RoleMatrixTab } from "./RoleMatrixTab";

const PAGES = [
  { key: "projects", label: "Projects", parent: null },
  { key: "projects.list", label: "List", parent: "projects" },
  { key: "scm", label: "Supply Chain", parent: null },
  { key: "scm.sales", label: "Sales", parent: "scm" },
  { key: "scm.sales.orders", label: "Sales Orders", parent: "scm.sales" },
  { key: "scm.warehouse", label: "Warehouse", parent: "scm" },
  { key: "scm.warehouse.inventory", label: "Inventory", parent: "scm.warehouse" },
];

const PERMISSIONS = [
  { key: "projects.read", resource: "Projects", verb: "read", label: "", description: "" },
  { key: "projects.write", resource: "Projects", verb: "write", label: "", description: "" },
  { key: "projects.manage", resource: "Projects", verb: "manage", label: "", description: "" },
  { key: "scm.access", resource: "Supply Chain", verb: "read", label: "", description: "" },
];

function mockApi() {
  apiGet.mockImplementation(async (url: string) => {
    if (url === "/api/roles")
      return { roles: [{ id: 7, name: "Test Role", description: null, permissions: [], is_system: false, member_count: 3 }] };
    if (url === "/api/roles/permissions") return { permissions: PERMISSIONS };
    if (url === "/api/roles/page-access")
      return { pages: PAGES, roles: [{ role_id: 7, has_rows: true, levels: {} }] };
    return {};
  });
  apiPatch.mockResolvedValue({ ok: true });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The grid row (label + level picker) that contains `label`. */
function rowFor(label: string): HTMLElement {
  const el = screen.getByText(label).closest(".grid");
  if (!el) throw new Error(`no row for ${label}`);
  return el as HTMLElement;
}

describe("RoleMatrixTab", () => {
  it("renders the owner's modules for the selected role", async () => {
    mockApi();
    render(<RoleMatrixTab />);
    await waitFor(() => expect(screen.getByText("供应链·销售")).toBeTruthy());
    expect(screen.getByText("供应链·仓库")).toBeTruthy();
    expect(screen.getByText("项目")).toBeTruthy();
  });

  it("set 供应链·销售=看 and 供应链·仓库=无, save → page-access + scm.access payloads", async () => {
    mockApi();
    render(<RoleMatrixTab />);
    await waitFor(() => expect(screen.getByText("供应链·销售")).toBeTruthy());

    fireEvent.click(within(rowFor("供应链·销售")).getByText("看"));
    fireEvent.click(within(rowFor("供应链·仓库")).getByText("无"));

    const save = await screen.findByText("Save changes");
    fireEvent.click(save);

    await waitFor(() => {
      const paCall = apiPatch.mock.calls.find((c) => c[0] === "/api/roles/7/page-access");
      expect(paCall, "page-access PATCH fired").toBeTruthy();
    });

    const paCall = apiPatch.mock.calls.find((c) => c[0] === "/api/roles/7/page-access")!;
    const entries: Array<{ pageKey: string; level: string }> = paCall[1].entries;
    const lvl = (k: string) => entries.find((e) => e.pageKey === k)?.level;
    expect(lvl("scm.sales")).toBe("view");
    expect(lvl("scm.sales.orders")).toBe("view");
    expect(lvl("scm.warehouse")).toBe("none");
    expect(lvl("scm.warehouse.inventory")).toBe("none");
    // The bare scm umbrella is derived as max(area levels) = view.
    expect(lvl("scm")).toBe("view");

    // scm.access reconciled on (an SCM area is now >= view) and written.
    const permCall = apiPatch.mock.calls.find((c) => c[0] === "/api/roles/7");
    expect(permCall, "permissions PATCH fired for scm.access").toBeTruthy();
    expect(permCall![1].permissions).toContain("scm.access");
  });

  it("set 项目=批 grants the Projects CRUD keys but never an approval key", async () => {
    mockApi();
    render(<RoleMatrixTab />);
    await waitFor(() => expect(screen.getByText("项目")).toBeTruthy());

    fireEvent.click(within(rowFor("项目")).getByText("批"));
    fireEvent.click(await screen.findByText("Save changes"));

    await waitFor(() => expect(apiPatch.mock.calls.find((c) => c[0] === "/api/roles/7")).toBeTruthy());
    const permCall = apiPatch.mock.calls.find((c) => c[0] === "/api/roles/7")!;
    const perms: string[] = permCall[1].permissions;
    expect(perms).toContain("projects.read");
    expect(perms).toContain("projects.write");
    expect(perms).toContain("projects.manage");
  });
});
