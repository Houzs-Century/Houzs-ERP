/* The desktop Invite modal carries a Role select (2026-09-16): it defaults to
 * the baseline role (defaultRoleId), the admin can pick another, and the chosen
 * id is what POST /api/users/invite receives. A scoped Sales Director sees no
 * Role field — the server forces the baseline for that caller. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const post = vi.fn(async () => ({ invite_url: "https://erp.test/invite/x", email_sent: true }));
vi.mock("../../api/client", () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: (...a: unknown[]) => post(...(a as [])),
    patch: vi.fn(async () => ({})),
    put: vi.fn(),
    del: vi.fn(),
    putBinary: vi.fn(),
  },
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { TeamInviteModal } from "./TeamInviteModal";
import type { Role } from "../../types";

const roles = [
  { id: 8, name: "Sales Person", is_system: false, permissions: ["sales.read"] },
  { id: 328, name: "Position Preview", is_system: false, permissions: [] },
  { id: 7, name: "Super Admin", is_system: true, permissions: ["*"] },
] as unknown as Role[];

function mount(salesDirScoped = false) {
  return render(
    <TeamInviteModal
      open
      onClose={() => {}}
      departments={[]}
      positions={[]}
      roles={roles}
      members={[]}
      companies={[]}
      salesDirScoped={salesDirScoped}
      presetDeptId={null}
      onInvited={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  post.mockClear();
});

describe("TeamInviteModal — Role", () => {
  test("defaults to the baseline role and sends the one the admin picks", async () => {
    mount();
    const select = screen.getByLabelText("Role") as HTMLSelectElement;
    expect(select.value).toBe("328");

    fireEvent.change(select, { target: { value: "8" } });
    fireEvent.change(screen.getByPlaceholderText(/@/), { target: { value: "new.member@houzs.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Send invite/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/api/users/invite");
    expect(body.role_id).toBe(8);
    expect(body.email).toBe("new.member@houzs.test");
  });

  test("a scoped Sales Director gets no Role field", () => {
    mount(true);
    expect(screen.queryByLabelText("Role")).toBeNull();
  });
});
