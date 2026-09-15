/* docs/bugs/0929-a-phone-edit-of-an-invited-member-could-never-be-saved-the-f.md
 * — on the phone, Edit on an INVITED member could never be saved.
 * MobileModuleForm seeded the Status select with "invited", a value it has no
 * option for, so the select showed its blank entry (labelled "Active") while
 * Save Changes sent status "invited", and PATCH /api/users/:id refuses any
 * status but the ones it lists.
 *
 * Drives the REAL form. Faked: `api`, whose PATCH refuses a status the way the
 * handler does, with the statuses read from routes/users.ts.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPatch } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPatch: vi.fn() }));
vi.mock("../api/client", () => ({
  api: { get: apiGet, post: vi.fn(), patch: apiPatch, del: vi.fn(), put: vi.fn() },
}));

import { MobileModuleForm, type FormSchema } from "./MobileModuleForm";
import { FORM_MEMBERS_EDIT } from "./MobileModuleList";
import { stripComments } from "../auth/sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The statuses PATCH /api/users/:id accepts, read from the handler itself. */
function patchAcceptedStatuses(): string[] {
  const route = readFileSync(resolve(HERE, "../../../backend/src/routes/users.ts"), "utf8");
  const registration = 'app.patch("/:id"';
  const start = route.indexOf(registration);
  if (start === -1) throw new Error(`${registration} not found in routes/users.ts`);
  const rest = route.slice(start + registration.length);
  const next = rest.search(/\napp\.(post|get|patch|put|delete)\(/);
  const handler = stripComments(next === -1 ? rest : rest.slice(0, next));
  const check = /!\s*\[([^\]]*)\]\.includes\(\s*body\.status\s*\)/.exec(handler);
  if (!check) throw new Error("the status check was not found in PATCH /:id");
  return [...check[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

const ACCEPTED = patchAcceptedStatuses();

const MEMBER = {
  id: 57,
  name: "Farah",
  email: "farah@houzs.test",
  phone: "0112233445",
  role_id: 3,
  department_id: 5,
  position_id: 9,
};

function openEdit(schema: FormSchema, initial: Record<string, unknown>) {
  const onSaved = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MobileModuleForm schema={schema} mode="edit" initial={initial} onBack={() => {}} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return { onSaved };
}

async function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
  const [path, body] = apiPatch.mock.calls[0] as [string, Record<string, unknown>];
  return { path, body };
}

const statusSelect = () => screen.getByLabelText("Status") as HTMLSelectElement;

beforeEach(() => {
  apiGet.mockImplementation(async (path: string) => {
    if (path === "/api/roles") return { roles: [{ id: 3, name: "Sales" }] };
    if (path === "/api/departments") return { departments: [{ id: 5, name: "Sales Department" }] };
    if (path === "/api/positions") return { positions: [{ id: 9, name: "Sales Executive" }] };
    return {};
  });
  apiPatch.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
    if (body.status != null && !ACCEPTED.includes(String(body.status))) {
      throw new Error(`status must be ${ACCEPTED.join(" or ")}`);
    }
    return { ok: true };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the save refuses every status but the ones it lists (premise)", () => {
  it("PATCH /api/users/:id accepts active and disabled, and not invited", () => {
    expect([...ACCEPTED].sort()).toEqual(["active", "disabled"]);
  });

  it("the phone's Status select offers exactly those", () => {
    const status = FORM_MEMBERS_EDIT.fields.find((f) => f.key === "status");
    expect(status?.options?.map((o) => o.value).sort()).toEqual([...ACCEPTED].sort());
  });
});

describe("Edit Member on the phone, an invited member", () => {
  it("saves a new name and phone, and leaves the status alone", async () => {
    const { onSaved } = openEdit(FORM_MEMBERS_EDIT, { ...MEMBER, status: "invited" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Farah Aziz" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "0119988776" } });

    const { path, body } = await save();

    expect(path).toBe("/api/users/57");
    expect(body).toMatchObject({ name: "Farah Aziz", phone: "0119988776" });
    expect(body).not.toHaveProperty("status");
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("57"));
    expect(screen.queryByText(/status must be/)).toBeNull();
  });

  it("the Status select does not read Active for someone who is not", () => {
    openEdit(FORM_MEMBERS_EDIT, { ...MEMBER, status: "invited" });
    expect(statusSelect().value).toBe("");
    expect(statusSelect().selectedOptions[0].textContent).toBe("No change");
  });

  it("choosing Disabled still sends it", async () => {
    openEdit(FORM_MEMBERS_EDIT, { ...MEMBER, status: "invited" });
    fireEvent.change(statusSelect(), { target: { value: "disabled" } });
    const { body } = await save();
    expect(body.status).toBe("disabled");
  });
});

describe("Edit Member on the phone, an active or disabled member (unchanged)", () => {
  for (const status of ["active", "disabled"]) {
    it(`a ${status} member's Status shows it and the save sends it`, async () => {
      const { onSaved } = openEdit(FORM_MEMBERS_EDIT, { ...MEMBER, status });
      expect(statusSelect().value).toBe(status);
      const { body } = await save();
      expect(body.status).toBe(status);
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });
  }
});

describe("the rule lives in the form: a fixed-option select seeds only a value it offers", () => {
  const THING: FormSchema = {
    title: "Thing",
    base: "core",
    createPath: "/api/things",
    updatePath: (id) => `/api/things/${id}`,
    idKey: "id",
    fields: [
      { key: "name", label: "Name", type: "text" },
      { key: "kind", label: "Kind", type: "select", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }] },
      { key: "live", label: "Live", type: "select", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] },
    ],
  };

  it("a stored value with no option is not sent back", async () => {
    openEdit(THING, { id: 1, name: "x", kind: "LEGACY", live: false });
    const { body } = await save();
    expect(body).not.toHaveProperty("kind");
    expect(body).toMatchObject({ name: "x", live: false });
  });

  it("a stored value that is an option still is", async () => {
    openEdit(THING, { id: 1, name: "x", kind: "B", live: true });
    const { body } = await save();
    expect(body).toMatchObject({ name: "x", kind: "B", live: true });
  });
});
