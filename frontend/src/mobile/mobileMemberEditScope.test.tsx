/* docs/bugs/0924-a-sales-director-s-phone-edit-of-a-member-s-role-department.md
 * — the phone's Edit Member Save sends every field the form shows
 * (MobileModuleForm buildBody), while PATCH /api/users/:id deletes role,
 * department, position and email for a department-scoped Sales Director and
 * still answers ok. The form that caller sees must therefore hold only what that
 * save applies.
 *
 * Drives the REAL form with the schema MobileApp hands it for each caller
 * (member-invite-form.test.ts pins that MobileApp does). Faked: `api` — the
 * PATCH body is the assertion.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPatch } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPatch: vi.fn() }));
vi.mock("../api/client", () => ({
  api: { get: apiGet, post: vi.fn(), patch: apiPatch, del: vi.fn(), put: vi.fn() },
}));

import { MobileModuleForm } from "./MobileModuleForm";
import { FORM_MEMBERS_EDIT } from "./MobileModuleList";
import { memberEditFormFor, SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS } from "./member-invite-form";

const MEMBER = {
  id: 42,
  name: "Aina",
  email: "aina@houzs.test",
  phone: "0123456789",
  role_id: 3,
  department_id: 5,
  position_id: 9,
  status: "active",
};

function openEdit(scopedSalesDirector: boolean) {
  const onSaved = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MobileModuleForm
        schema={memberEditFormFor(FORM_MEMBERS_EDIT, scopedSalesDirector)}
        mode="edit"
        initial={MEMBER}
        onBack={() => {}}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { onSaved };
}

async function saveAndReadBody(onSaved: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(apiPatch).toHaveBeenCalledTimes(1);
  const [path, body] = apiPatch.mock.calls[0] as [string, Record<string, unknown>];
  return { path, body };
}

beforeEach(() => {
  apiGet.mockImplementation(async (path: string) => {
    if (path === "/api/roles") return { roles: [{ id: 3, name: "Sales" }] };
    if (path === "/api/departments") return { departments: [{ id: 5, name: "Sales Department" }] };
    if (path === "/api/positions") return { positions: [{ id: 9, name: "Sales Executive" }] };
    return {};
  });
  apiPatch.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Edit Member on the phone, scoped Sales Director", () => {
  it("shows Name, Phone and Status and nothing the save would strip", () => {
    openEdit(true);
    for (const label of ["Name", "Phone", "Status"]) expect(screen.getByText(label)).toBeTruthy();
    for (const label of ["Email", "Role", "Department", "Position"]) expect(screen.queryByText(label)).toBeNull();
  });

  it("sends only fields PATCH /api/users/:id applies for that caller", async () => {
    const { onSaved } = openEdit(true);
    const { path, body } = await saveAndReadBody(onSaved);
    expect(path).toBe("/api/users/42");
    expect(Object.keys(body).sort()).toEqual(["name", "phone", "status"]);
    for (const k of Object.keys(body)) expect(SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS).toContain(k);
  });
});

describe("Edit Member on the phone, full admin (the filter is per caller)", () => {
  it("still shows and sends role, department, position and email", async () => {
    const { onSaved } = openEdit(false);
    for (const label of ["Email", "Role", "Department", "Position"]) expect(screen.getByText(label)).toBeTruthy();
    await screen.findByRole("option", { name: "Sales Department" });
    const { body } = await saveAndReadBody(onSaved);
    expect(body).toMatchObject({ email: "aina@houzs.test", role_id: 3, department_id: 5, position_id: 9 });
  });
});
