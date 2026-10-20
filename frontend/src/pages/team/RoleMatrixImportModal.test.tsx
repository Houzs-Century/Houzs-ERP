// RoleMatrixImportModal — the owner imports an edited matrix file: pick → local
// preview (added/removed/unchanged) → Apply writes the two PR2 APIs per changed
// role. The file reader is mocked (no real xlsx/File I/O), so the test drives the
// REAL parse engine + REAL apply, and asserts the exact PATCH payloads. No prod:
// the page-access API is branch-only and the dev build talks to prod.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionDef, Role } from "../../types";
import type { PageLite } from "../../lib/roleMatrixModel";
import { snapshotFromApi, type SheetData } from "../../lib/roleMatrixExcel";

const { apiPatch } = vi.hoisted(() => ({ apiPatch: vi.fn() }));
vi.mock("../../api/client", () => ({
  api: { get: vi.fn(), patch: apiPatch, post: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

// The file reader is mocked so the test never touches SheetJS or a real File —
// `nextSheets` is what the next readMatrixSheets() returns.
let nextSheets: SheetData[] = [];
vi.mock("../../lib/roleMatrixExcelFile", () => ({
  readMatrixSheets: () => Promise.resolve(nextSheets),
  UNREADABLE_MATRIX_FILE: "unreadable",
  exportRoleMatrix: vi.fn(),
}));

import { RoleMatrixImportModal } from "./RoleMatrixImportModal";

const PAGES: PageLite[] = [
  { key: "projects", label: "Projects", parent: null },
  { key: "scm", label: "Supply Chain", parent: null },
  { key: "scm.sales", label: "SCM Sales", parent: "scm" },
];
const PERMISSIONS: PermissionDef[] = [
  { key: "projects.read", resource: "Projects", verb: "read", label: "", description: "" },
  { key: "projects.write", resource: "Projects", verb: "write", label: "", description: "" },
  { key: "scm.access", resource: "Supply Chain", verb: "read", label: "", description: "" },
];
const ROLES: Role[] = [
  { id: 7, name: "Test Role", description: null, permissions: [], is_system: false, member_count: 3 },
];
const PAGE_ROLES = [{ role_id: 7, levels: {} as Record<string, string> }];

function snap() {
  return snapshotFromApi(ROLES, PAGES, PERMISSIONS, PAGE_ROLES);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  nextSheets = [];
});

function chooseCsv() {
  const input = screen.getByLabelText("选择角色权限文件");
  fireEvent.change(input, { target: { files: [new File(["x"], "matrix.csv", { type: "text/csv" })] } });
}

describe("RoleMatrixImportModal", () => {
  it("previews added changes then applies the two write APIs with correct payloads", async () => {
    apiPatch.mockResolvedValue({ ok: true });
    nextSheets = [
      {
        name: "combined",
        aoa: [
          ["Key", "7 · Test Role"],
          ["projects.read", "✓"],
          ["projects.write", "✓"],
          ["scm.sales", "看"],
        ],
      },
    ];
    const onApplied = vi.fn();
    render(<RoleMatrixImportModal open onClose={() => {}} snapshot={snap()} onApplied={onApplied} />);

    chooseCsv();

    // Preview: one role changes, and its name is shown.
    await waitFor(() => expect(screen.getByText("Test Role")).toBeTruthy());
    expect(screen.getByText("应用 1 个角色的改动")).toBeTruthy();

    fireEvent.click(screen.getByText("应用 1 个角色的改动"));

    await waitFor(() =>
      expect(apiPatch.mock.calls.find((c) => c[0] === "/api/roles/7/page-access")).toBeTruthy(),
    );

    const paCall = apiPatch.mock.calls.find((c) => c[0] === "/api/roles/7/page-access")!;
    const entries: Array<{ pageKey: string; level: string }> = paCall[1].entries;
    expect(entries.find((e) => e.pageKey === "scm.sales")?.level).toBe("view");
    expect(entries.find((e) => e.pageKey === "scm")?.level).toBe("view"); // derived umbrella

    const permCall = apiPatch.mock.calls.find((c) => c[0] === "/api/roles/7")!;
    const perms: string[] = permCall[1].permissions;
    expect(perms).toContain("projects.read");
    expect(perms).toContain("projects.write");
    expect(perms).toContain("scm.access"); // reconciled from the SCM page level

    expect(onApplied).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/已导入/)).toBeTruthy());
  });

  it("rejects a file with no role columns or keys", async () => {
    nextSheets = [{ name: "junk", aoa: [["a", "b"], ["c", "d"]] }];
    render(<RoleMatrixImportModal open onClose={() => {}} snapshot={snap()} onApplied={() => {}} />);
    chooseCsv();
    await waitFor(() => expect(screen.getByText(/没找到角色列或功能\/页面的 key/)).toBeTruthy());
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("surfaces a per-role apply failure", async () => {
    apiPatch.mockRejectedValue(new Error("role is locked by the server"));
    nextSheets = [
      {
        name: "combined",
        aoa: [
          ["Key", "7 · Test Role"],
          ["projects.read", "✓"],
          ["projects.write", "✓"],
        ],
      },
    ];
    render(<RoleMatrixImportModal open onClose={() => {}} snapshot={snap()} onApplied={() => {}} />);
    chooseCsv();
    await waitFor(() => expect(screen.getByText("应用 1 个角色的改动")).toBeTruthy());
    fireEvent.click(screen.getByText("应用 1 个角色的改动"));
    await waitFor(() => expect(screen.getByText(/没有保存成功/)).toBeTruthy());
    expect(screen.getByText(/role is locked by the server/)).toBeTruthy();
  });
});
