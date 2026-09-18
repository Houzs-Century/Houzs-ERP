/* Owner 2026-09-15, answering 「我加了新的role 但是title没有」 with option A: the
 * desktop member profile carries a Role picker beside Title, the control the
 * phone's member form and the classic edit panel already had. Pinned here: the
 * field names the member's role, a new role saves as role_id alone, an edit that
 * leaves the role alone never sends one, and a viewer who cannot manage members,
 * or has no role list, cannot change it. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Role, TeamMember } from "../../types";

const { get, patch, success, error, confirm } = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../api/client", () => ({ api: { get, patch, post: vi.fn() } }));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success, error }) }));
vi.mock("../../hooks/useDialog", () => ({ useDialog: () => ({ confirm, prompt: vi.fn() }) }));

import { TeamMemberProfile } from "./TeamMemberProfile";
import { roleOptions } from "./teamShared";

const role = (id: number, name: string): Role => ({
  id,
  name,
  description: null,
  permissions: [],
  is_system: false,
  member_count: 0,
});

const ROLES: Role[] = [role(337, "PG WH Assistant"), role(328, "Position Preview"), role(1, "Super Admin")];

const MEMBER = {
  id: 151,
  email: "wh@example.test",
  name: "PG WH Assistant",
  status: "active",
  role_id: 328,
  role_name: "Position Preview",
  manager_id: null,
  manager_name: null,
  manager_email: null,
  department_id: null,
  department_name: null,
  department_color: null,
  division: null,
  position_id: null,
  position_name: null,
  brands: [],
  company_ids: [],
  invited_at: null,
  joined_at: null,
  last_login_at: "2026-09-14T09:00:00Z",
  created_at: "2026-09-14T08:57:52Z",
  profile_pic_r2_key: null,
  phone: null,
} satisfies TeamMember;

function mount(over: { canManage?: boolean; roles?: Role[] } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TeamMemberProfile
          member={MEMBER}
          members={[MEMBER]}
          departments={[]}
          positions={[]}
          roles={over.roles ?? ROLES}
          companies={[]}
          canManage={over.canManage ?? true}
          canImpersonate={false}
          onLoginAs={() => {}}
          onClose={() => {}}
          onChanged={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const roleField = () => screen.getByRole("textbox", { name: "Role" }) as HTMLInputElement;

function pickRole(label: string) {
  // Opening the picker seeds its search with the current role, so type the new one.
  fireEvent.focus(roleField());
  fireEvent.change(roleField(), { target: { value: label } });
  const option = [...document.querySelectorAll("li")].find((li) => li.textContent === label);
  if (!option) throw new Error(`no Role option named ${label}`);
  fireEvent.mouseDown(option);
}

beforeEach(() => {
  get.mockReset();
  patch.mockReset().mockResolvedValue({ ok: true });
  success.mockReset();
  error.mockReset();
});

describe("TeamMemberProfile — Role", () => {
  test("names the member's current role", () => {
    mount();
    expect(roleField().value).toBe("Position Preview");
    expect(roleField().disabled).toBe(false);
  });

  test("a role made in Roles & Permissions can be picked, and saves as role_id alone", async () => {
    mount();
    pickRole("PG WH Assistant");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/users/151", { role_id: 337 });
    expect(success).toHaveBeenCalledWith("Assignment saved");
  });

  test("an edit that leaves the role alone does not send one", async () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText("e.g. Driver Fleet"), { target: { value: "Penang" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/users/151", { division: "Penang" });
  });

  test("a viewer who cannot manage members sees the role but cannot change it", () => {
    mount({ canManage: false });
    expect(roleField().value).toBe("Position Preview");
    expect(roleField().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("with no role list the field still names the member's role, locked", () => {
    mount({ roles: [] });
    expect(roleField().value).toBe("Position Preview");
    expect(roleField().disabled).toBe(true);
  });
});

describe("roleOptions", () => {
  test("lists the roles by name", () => {
    expect(roleOptions(ROLES, { id: 328, name: "Position Preview" }).map((o) => o.label)).toEqual([
      "PG WH Assistant",
      "Position Preview",
      "Super Admin",
    ]);
  });

  test("keeps the member's own role when the list lacks it, once", () => {
    const opts = roleOptions([role(1, "Super Admin")], { id: 328, name: "Position Preview" });
    expect(opts).toEqual([
      { value: "328", label: "Position Preview" },
      { value: "1", label: "Super Admin" },
    ]);
    expect(roleOptions(ROLES, { id: 328, name: "Position Preview" }).filter((o) => o.value === "328")).toHaveLength(1);
  });

  test("with no current role, only the list", () => {
    expect(roleOptions([], null)).toEqual([]);
  });
});
