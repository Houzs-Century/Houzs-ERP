/* docs/bugs/0928-a-sales-director-s-desktop-classic-edit-member-panel-offered.md
 * — the classic desktop Edit Member panel (/team?tab=members) offered a
 * department-scoped Sales Director Email, Email Alias, departments, Position,
 * Role, Company, Reports to and Set password. PATCH /api/users/:id deletes all
 * of them for that caller and still answers ok, so the panel said "Saved" and
 * those fields did not change; its photo, showroom, reset-link and delete writes
 * require users.manage and were refused.
 *
 * Renders the REAL panel for each caller. Faked: `api` (the PATCH body is the
 * assertion) and the toast.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Department, Position, TeamMember } from "../../types";

const { get, patch, success, error } = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { get, patch, post: vi.fn(), del: vi.fn(), putBinary: vi.fn() },
  tokenStore: { set: vi.fn(), get: vi.fn(), clear: vi.fn() },
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success, error }) }));

import { EditMemberPanel } from "../Team";
import { editMemberOffers, editMemberPatchFor } from "./editMemberScope";
import { SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS } from "../../mobile/member-invite-form";
import { stripComments } from "../../auth/sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));

const MEMBER = {
  id: 42,
  email: "aina@houzs.test",
  name: "Aina",
  status: "active",
  status_reason: null,
  role_id: 3,
  role_name: "Sales",
  manager_id: 7,
  manager_name: "Boss",
  manager_email: "boss@houzs.test",
  department_id: 5,
  department_name: "Sales Department",
  department_color: "16695f",
  department_ids: [5],
  division: "Team Peter",
  position_id: 9,
  position_name: "Sales Executive",
  brands: [],
  company_ids: [1],
  invited_at: null,
  joined_at: null,
  last_login_at: null,
  created_at: "2026-09-01T00:00:00Z",
  profile_pic_r2_key: null,
  phone: "0123456789",
  email_alias: "aina@houzscentury.com",
} satisfies TeamMember;

const BOSS: TeamMember = { ...MEMBER, id: 7, email: "boss@houzs.test", name: "Boss", manager_id: null };

const DEPARTMENTS: Department[] = [
  { id: 5, name: "Sales Department", description: null, color: "16695f", sort_order: 0, member_count: 2 },
];
const POSITIONS: Position[] = [
  {
    id: 9,
    department_id: 5,
    department_name: "Sales Department",
    slug: "sales-executive",
    name: "Sales Executive",
    level: 1,
    sort_order: 0,
    active: true,
    member_count: 1,
  },
];

const STRIPPED_FIELD_LABELS = [
  "Email",
  "Email Alias",
  "Primary department",
  "Also in",
  "Position",
  "Role",
  "Company",
  "Reports to",
  "Set password",
];
const APPLIED_FIELD_LABELS = ["Name", "Phone", "Division"];

function mount(salesDirScoped: boolean, member: TeamMember = MEMBER) {
  const onSaved = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <EditMemberPanel
        user={member}
        departments={DEPARTMENTS}
        positions={POSITIONS}
        members={[member, BOSS]}
        onClose={() => {}}
        onSaved={onSaved}
        onChanged={() => {}}
        onSendReset={() => {}}
        onResendInvite={() => {}}
        onToggleStatus={() => {}}
        onRemove={() => {}}
        multiCompany
        companies={[
          { id: 1, code: "HOUZS", name: "Houzs Century" },
          { id: 2, code: "2990", name: "2990" },
        ]}
        salesDirScoped={salesDirScoped}
      />
    </QueryClientProvider>,
  );
  return { onSaved };
}

const inputAfterLabel = (label: string) => {
  const input = screen.getByText(label).parentElement?.querySelector("input");
  if (!input) throw new Error(`no input under the ${label} label`);
  return input;
};

async function saveAndReadBody(onSaved: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(patch).toHaveBeenCalledTimes(1);
  const [path, body] = patch.mock.calls[0] as [string, Record<string, unknown>];
  return { path, body };
}

beforeEach(() => {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/roles") return { roles: [{ id: 3, name: "Sales" }, { id: 1, name: "Super Admin" }] };
    if (path === "/api/scm/staff/showrooms") {
      return { showrooms: [{ id: "wh-1", code: "SR1", name: "KL Showroom", venueName: "KL", active: true }] };
    }
    if (path === "/api/scm/staff") return { staff: [{ id: "st-1", userId: 42, showroomWarehouseId: null }] };
    return {};
  });
  patch.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("classic Edit Member panel, scoped Sales Director", () => {
  test("offers Name, Phone and Division, and none of the fields their save strips", () => {
    mount(true);
    for (const label of APPLIED_FIELD_LABELS) expect(screen.getByText(label)).toBeTruthy();
    for (const label of STRIPPED_FIELD_LABELS) expect(screen.queryByText(label)).toBeNull();
  });

  test("offers no photo, showroom, reset link or delete (each needs users.manage); Disable stays", () => {
    mount(true);
    expect(screen.queryByRole("button", { name: "Change photo" })).toBeNull();
    expect(screen.queryByText("Sales venue")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send password reset link/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete permanently/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Disable account/ })).toBeTruthy();
  });

  test("an invited member offers no Resend invitation either", () => {
    mount(true, { ...MEMBER, status: "invited" });
    expect(screen.queryByRole("button", { name: /Resend invitation/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Enable account/ })).toBeTruthy();
  });

  test("a Save sends only fields PATCH /api/users/:id applies for that caller", async () => {
    const { onSaved } = mount(true);
    fireEvent.change(inputAfterLabel("Name"), { target: { value: "Aina Binti" } });
    fireEvent.change(inputAfterLabel("Division"), { target: { value: "Team Siti" } });
    const { path, body } = await saveAndReadBody(onSaved);
    expect(path).toBe("/api/users/42");
    expect(body).toEqual({ name: "Aina Binti", division: "Team Siti" });
    expect(success).toHaveBeenCalledWith("Saved Aina Binti");
  });

  test("a hidden field whose stored value differs from the panel's stays out of the body", async () => {
    const { onSaved } = mount(true, { ...MEMBER, email_alias: "" });
    fireEvent.change(inputAfterLabel("Name"), { target: { value: "Aina Binti" } });
    const { body } = await saveAndReadBody(onSaved);
    expect(body).toEqual({ name: "Aina Binti" });
    for (const k of Object.keys(body)) expect(SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS).toContain(k);
  });
});

describe("classic Edit Member panel, full admin (the narrowing is per caller)", () => {
  test("still offers every field, the photo, showroom parking and every account action", async () => {
    mount(false);
    for (const label of [...APPLIED_FIELD_LABELS, ...STRIPPED_FIELD_LABELS]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Change photo" })).toBeTruthy();
    expect(screen.getByText("Sales venue")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send password reset link/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete permanently/ })).toBeTruthy();
    await screen.findByRole("option", { name: /KL Showroom/ });
  });

  test("still sends a changed email", async () => {
    const { onSaved } = mount(false);
    fireEvent.change(inputAfterLabel("Email"), { target: { value: "aina.new@houzs.test" } });
    const { body } = await saveAndReadBody(onSaved);
    expect(body).toEqual({ email: "aina.new@houzs.test" });
  });

  test("premise of the hidden-field test: a stored empty alias goes into the body as null", async () => {
    const { onSaved } = mount(false, { ...MEMBER, email_alias: "" });
    fireEvent.change(inputAfterLabel("Name"), { target: { value: "Aina Binti" } });
    const { body } = await saveAndReadBody(onSaved);
    expect(body).toEqual({ name: "Aina Binti", email_alias: null });
  });
});

describe("editMemberOffers / editMemberPatchFor", () => {
  test("a scoped caller is offered exactly the listed PATCH keys; anything else, named later or not, is hidden", () => {
    for (const k of SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS) expect(editMemberOffers(k, true)).toBe(true);
    for (const k of ["role_id", "manager_id", "profile_pic", "showroom", "delete", "a_field_added_later"]) {
      expect(editMemberOffers(k, true)).toBe(false);
      expect(editMemberOffers(k, false)).toBe(true);
    }
  });

  test("everyone else's body is passed through, same object", () => {
    const body = { role_id: 1, name: "x" };
    expect(editMemberPatchFor(body, false)).toBe(body);
    expect(editMemberPatchFor(body, true)).toEqual({ name: "x" });
  });
});

describe("the Team page hands the classic panel its one scoped answer", () => {
  const team = stripComments(readFileSync(resolve(HERE, "../Team.tsx"), "utf8"));

  const element = (tag: string) => {
    const start = team.search(new RegExp(`<${tag}\\s`));
    expect(start, `<${tag} not found in Team.tsx`).toBeGreaterThan(-1);
    return team.slice(start, team.indexOf("/>", start));
  };

  test("Members tab and Edit Member panel both get salesDirScoped={salesDirScoped}", () => {
    expect(element("MembersTab")).toMatch(/salesDirScoped=\{salesDirScoped\}/);
    expect(element("EditMemberPanel")).toMatch(/salesDirScoped=\{salesDirScoped\}/);
  });
});
