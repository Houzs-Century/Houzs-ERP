import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The mocked useQuery must return a STABLE object per key (the real TanStack
// wrapper memoises `data`); a fresh object each render would re-fire the
// grants-seeding effect forever.
const { QUERY } = vi.hoisted(() => {
  const ROLES = [
    { id: 1, name: "Owner", description: "Full access", permissions: ["*"], is_system: true, member_count: 1 },
    {
      id: 2,
      name: "Sales Manager",
      description: "Owns the pipeline",
      permissions: ["service_cases.read", "projects.read", "projects.write"],
      is_system: false,
      member_count: 2,
    },
    { id: 3, name: "Sales Rep", description: "Creates orders", permissions: ["service_cases.read"], is_system: false, member_count: 8 },
  ];
  const PERMISSIONS = [
    { key: "service_cases.read", resource: "Service Cases", verb: "read", label: "View service cases", description: "" },
    { key: "service_cases.create", resource: "Service Cases", verb: "create", label: "Log service cases", description: "" },
    { key: "service_cases.write", resource: "Service Cases", verb: "write", label: "Edit service cases", description: "" },
    { key: "service_cases.manage", resource: "Service Cases", verb: "manage", label: "Manage service cases", description: "" },
    { key: "projects.read", resource: "Projects", verb: "read", label: "View projects", description: "" },
    { key: "projects.write", resource: "Projects", verb: "write", label: "Edit projects", description: "" },
    { key: "projects.approve", resource: "Projects", verb: "manage", label: "Approve gated steps", description: "" },
  ];
  const USERS = [
    { id: 10, name: "Chan Wei Ming", email: "a@x.my", role_id: 2 },
    { id: 11, name: "Nurul Aisyah", email: "b@x.my", role_id: 2 },
  ];
  const reload = () => {};
  const wrap = (data: unknown) => ({ data, loading: false, fetching: false, placeholder: false, error: null, reload });
  return {
    QUERY: {
      "/api/roles": wrap({ roles: ROLES }),
      "/api/roles/permissions": wrap({ permissions: PERMISSIONS }),
      "/api/users": wrap({ users: USERS }),
    } as Record<string, unknown>,
  };
});

vi.mock("../hooks/useQuery", () => ({
  useQuery: (key: string) =>
    QUERY[key] ?? { data: null, loading: false, fetching: false, placeholder: false, error: null, reload: () => {} },
}));

vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));

vi.mock("../api/client", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ id: 99 }),
    patch: vi.fn().mockResolvedValue({ ok: true }),
    del: vi.fn().mockResolvedValue({ ok: true }),
    fetchBlobUrl: vi.fn(),
  },
  onForbidden: () => () => {},
}));

import { ToastProvider } from "../hooks/useToast";
import { DialogProvider } from "../hooks/useDialog";
import { RolesTab } from "./Roles";

function renderTab() {
  return render(
    <ToastProvider>
      <DialogProvider>
        <RolesTab creating={false} onCloseCreate={() => {}} />
      </DialogProvider>
    </ToastProvider>
  );
}

afterEach(cleanup);

describe("RolesTab", () => {
  it("defaults to the system role and shows the All-permissions empty state (no matrix)", () => {
    renderTab();
    expect(screen.getByText("All permissions")).toBeTruthy();
    expect(screen.getByText("Sales Manager")).toBeTruthy();
    expect(screen.getByText("Sales Rep")).toBeTruthy();
    expect(screen.queryByText("Resource")).toBeNull();
  });

  it("renders the resource x verb matrix for a custom role", () => {
    renderTab();
    fireEvent.click(screen.getByText("Sales Manager"));
    expect(screen.getByText("Resource")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Manage")).toBeTruthy();
    // The heterogeneous "approve" grant is its own row in the Manage column.
    fireEvent.click(screen.getByText("Projects"));
    expect(screen.getByText("Approve gated steps")).toBeTruthy();
  });

  it("stages a cell toggle and shows the save bar attributed to the right role", () => {
    renderTab();
    fireEvent.click(screen.getByText("Sales Manager"));
    const offCells = screen.getAllByTitle("Not granted");
    expect(offCells.length).toBeGreaterThan(0);
    fireEvent.click(offCells[0]);
    expect(screen.getByText(/1 unsaved change on Sales Manager/)).toBeTruthy();
    fireEvent.click(screen.getByText("Discard"));
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it("enters bulk mode with a Bulk edit badge when two roles are checked", () => {
    renderTab();
    const checkboxes = screen.getAllByLabelText(/Check role for bulk edit/);
    fireEvent.click(checkboxes[1]); // Sales Manager
    fireEvent.click(checkboxes[2]); // Sales Rep
    expect(screen.getByText("2 roles selected")).toBeTruthy();
    expect(screen.getByText("Bulk edit")).toBeTruthy();
  });
});
