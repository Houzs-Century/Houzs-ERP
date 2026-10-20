// The browser I/O adapter: a REAL SheetJS round-trip (export bytes → read back)
// proves the aoa ↔ workbook mapping survives an actual .xlsx, which the pure
// engine test cannot see. Also covers the CSV read branch.
import { describe, it, expect } from "vitest";
import type { PermissionDef, Role } from "../types";
import type { PageLite } from "./roleMatrixModel";
import {
  buildWorkbook,
  parseMatrixWorkbook,
  snapshotFromApi,
  EXCEL_SHEET_FUNCTIONS,
  EXCEL_SHEET_PAGES,
  EXCEL_SHEET_ROLES,
} from "./roleMatrixExcel";
import { readWorkbookBytes, workbookToXlsx } from "./roleMatrixExcelFile";

const PAGES: PageLite[] = [
  { key: "projects", label: "Projects", parent: null },
  { key: "scm", label: "Supply Chain", parent: null },
  { key: "scm.sales", label: "SCM Sales", parent: "scm" },
];
const PERMS: PermissionDef[] = [
  { key: "projects.read", resource: "Projects", verb: "read", label: "Read", description: "" },
  { key: "projects.write", resource: "Projects", verb: "write", label: "Write", description: "" },
  { key: "scm.access", resource: "Supply Chain", verb: "read", label: "SCM", description: "" },
];
const ROLES: Role[] = [
  { id: 7, name: "Sales Person", description: null, permissions: ["projects.read"], is_system: false, member_count: 2 },
  { id: 8, name: "Storekeeper", description: null, permissions: ["scm.access"], is_system: false, member_count: 1 },
];
const PAGE_ROLES = [
  { role_id: 7, levels: { projects: "edit" } as Record<string, string> },
  { role_id: 8, levels: { scm: "view", "scm.sales": "view" } as Record<string, string> },
];

describe("workbookToXlsx + readWorkbookBytes", () => {
  it("round-trips through real .xlsx bytes to a no-op import", async () => {
    const snap = snapshotFromApi(ROLES, PAGES, PERMS, PAGE_ROLES);
    const bytes = await workbookToXlsx(buildWorkbook(snap));
    const sheets = await readWorkbookBytes(bytes);
    expect(sheets.map((s) => s.name)).toEqual([
      EXCEL_SHEET_FUNCTIONS,
      EXCEL_SHEET_PAGES,
      EXCEL_SHEET_ROLES,
    ]);
    const parsed = parseMatrixWorkbook(sheets, snap);
    expect(parsed.empty).toBe(false);
    expect(parsed.changedRoles).toEqual([]);
    expect(parsed.badCells).toEqual([]);
  });

  it("an edited cell survives the real .xlsx round-trip", async () => {
    const snap = snapshotFromApi(ROLES, PAGES, PERMS, PAGE_ROLES);
    const wb = buildWorkbook(snap);
    // Flip Storekeeper (col index 4 on the 功能 sheet) to grant projects.read.
    const fn = wb.sheets.find((s) => s.name === EXCEL_SHEET_FUNCTIONS)!;
    const row = fn.aoa.find((r) => r[2] === "projects.read")!;
    row[4] = "✓";
    const sheets = await readWorkbookBytes(await workbookToXlsx(wb));
    const parsed = parseMatrixWorkbook(sheets, snap);
    const store = parsed.changedRoles.find((r) => r.roleId === 8)!;
    expect(store.functionsAdded).toContain("projects.read");
  });
});
