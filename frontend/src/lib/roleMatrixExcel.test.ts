import { describe, it, expect } from "vitest";
import type { PermissionDef, Role } from "../types";
import {
  buildWorkbook,
  parseMatrixWorkbook,
  snapshotFromApi,
  roleColumnHeader,
  sensitiveKeysOf,
  EXCEL_SHEET_FUNCTIONS,
  EXCEL_SHEET_PAGES,
  EXCEL_SHEET_ROLES,
  type SheetData,
  type CellValue,
  type MatrixSnapshot,
} from "./roleMatrixExcel";
import type { PageLite } from "./roleMatrixModel";

// A trimmed catalogue that exercises every branch: a page-bearing module
// (service_cases), a page-less module (mail), two SCM areas, an approval key and
// a fine SCM key (both never-by-level), and the SCM umbrella.
const PAGES: PageLite[] = [
  { key: "sales", label: "Sales Entries", parent: null },
  { key: "service_cases", label: "ASSR", parent: null },
  { key: "service_cases.cases", label: "Cases", parent: "service_cases" },
  { key: "service_cases.pnl", label: "P&L", parent: "service_cases", dormant: true },
  { key: "scm", label: "Supply Chain", parent: null },
  { key: "scm.sales", label: "SCM Sales", parent: "scm" },
  { key: "scm.warehouse", label: "SCM Warehouse", parent: "scm" },
];

const PERMS: PermissionDef[] = [
  { key: "service_cases.read", resource: "Service Cases", verb: "read", label: "Read cases", description: "" },
  { key: "service_cases.write", resource: "Service Cases", verb: "write", label: "Write cases", description: "" },
  { key: "service_cases.manage", resource: "Service Cases", verb: "manage", label: "Manage cases", description: "" },
  { key: "service_cases.approve", resource: "Service Cases", verb: "approve", label: "Approve", description: "" },
  { key: "mail_center.read", resource: "Mail Center", verb: "read", label: "Read mail", description: "" },
  { key: "mail_center.manage", resource: "Mail Center", verb: "manage", label: "Manage mail", description: "" },
  { key: "scm.access", resource: "Supply Chain", verb: "read", label: "SCM access", description: "" },
  { key: "scm.payment_voucher.check", resource: "Supply Chain", verb: "manage", label: "PV check", description: "" },
];

function role(id: number, name: string, permissions: string[], over: Partial<Role> = {}): Role {
  return {
    id,
    name,
    description: null,
    permissions,
    is_system: false,
    member_count: 0,
    ...over,
  };
}

const ROLES: Role[] = [
  role(10, "Sales Person", ["service_cases.read"]),
  role(11, "Storekeeper", ["scm.access"]),
  role(1, "Owner", ["*"], { is_system: true }),
];

// role 10 sees service_cases at view, nothing else; role 11 sees scm.warehouse at edit.
const PAGE_ROLES = [
  { role_id: 10, levels: { service_cases: "view", "service_cases.cases": "view" } as Record<string, string> },
  { role_id: 11, levels: { scm: "edit", "scm.warehouse": "edit" } as Record<string, string> },
];

function snap(): MatrixSnapshot {
  return snapshotFromApi(ROLES, PAGES, PERMS, PAGE_ROLES);
}

/** Find a sheet by name in a built workbook. */
function sheet(sheets: SheetData[], name: string): SheetData {
  const s = sheets.find((x) => x.name === name);
  if (!s) throw new Error(`no sheet ${name}`);
  return s;
}

/** The row (array of cells) whose key column equals `key`, given the key column
 *  index. */
function rowFor(s: SheetData, keyCol: number, key: string): CellValue[] {
  const r = s.aoa.find((row) => row[keyCol] === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
}

describe("snapshotFromApi", () => {
  it("normalizes stored levels and marks locked roles", () => {
    const s = snap();
    expect(s.roles.find((r) => r.id === 1)?.locked).toBe(true); // system
    expect(s.roles.find((r) => r.id === 10)?.locked).toBe(false);
    expect(s.levelsByRole.get(10)?.service_cases).toBe("view");
    // every page present, defaulting to none
    expect(s.levelsByRole.get(10)?.sales).toBe("none");
  });
});

describe("buildWorkbook", () => {
  it("writes the three sheets with id·name role headers", () => {
    const wb = buildWorkbook(snap());
    expect(wb.sheets.map((x) => x.name)).toEqual([
      EXCEL_SHEET_FUNCTIONS,
      EXCEL_SHEET_PAGES,
      EXCEL_SHEET_ROLES,
    ]);
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    // header: 模块, 功能, Key, then one column per role
    expect(fn.aoa[0]!.slice(0, 3)).toEqual(["模块 Module", "功能 Function", "Key"]);
    expect(fn.aoa[0]!.slice(3)).toEqual(["10 · Sales Person", "11 · Storekeeper", "1 · Owner"]);
  });

  it("ticks granted functions and dashes the rest", () => {
    const wb = buildWorkbook(snap());
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    // role 10 (col index 3) holds service_cases.read
    const readRow = rowFor(fn, 2, "service_cases.read");
    expect(readRow[3]).toBe("✓"); // Sales Person granted
    expect(readRow[4]).toBe("−"); // Storekeeper not
  });

  it("writes page levels and never emits the derived scm umbrella row", () => {
    const wb = buildWorkbook(snap());
    const pg = sheet(wb.sheets, EXCEL_SHEET_PAGES);
    expect(pg.aoa.some((r) => r[2] === "scm")).toBe(false); // umbrella excluded
    const warehouse = rowFor(pg, 2, "scm.warehouse");
    // cols: 0=模块,1=页面,2=Key,3=状态,4=role10,5=role11 → role11 (Storekeeper) edit
    expect(warehouse[5]).toBe("改");
  });

  it("flags dormant pages in the status column", () => {
    const wb = buildWorkbook(snap());
    const pg = sheet(wb.sheets, EXCEL_SHEET_PAGES);
    const pnl = rowFor(pg, 2, "service_cases.pnl");
    expect(pnl[3]).toBe("停用 dormant");
  });

  it("writes a role legend with ids and the locked flag", () => {
    const wb = buildWorkbook(snap());
    const roles = sheet(wb.sheets, EXCEL_SHEET_ROLES);
    const owner = roles.aoa.find((r) => r[0] === 1); // id column holds numbers
    expect(owner?.[1]).toBe("Owner");
    expect(owner?.[4]).toBe("是 yes"); // locked
  });
});

describe("round-trip is a no-op", () => {
  it("export → parse yields no changes", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const parsed = parseMatrixWorkbook(wb.sheets, s);
    expect(parsed.changedRoles).toEqual([]);
    expect(parsed.totalAdded).toBe(0);
    expect(parsed.totalRemoved).toBe(0);
    expect(parsed.empty).toBe(false);
    expect(parsed.badCells).toEqual([]);
  });
});

describe("parse: function edits", () => {
  it("granting a dashed cell adds the key", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    // give Storekeeper (col 4) service_cases.read
    const row = rowFor(fn, 2, "service_cases.read");
    row[4] = "✓";
    const parsed = parseMatrixWorkbook([fn], s);
    const store = parsed.changedRoles.find((r) => r.roleId === 11)!;
    expect(store.functionsAdded).toContain("service_cases.read");
    expect(store.addedCount).toBe(1);
    expect(store.permsChanged).toBe(true);
    expect(store.permsPayload).toContain("service_cases.read");
  });

  it("an explicit dash revokes a currently-granted key", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, 2, "service_cases.read")[3] = "−"; // Sales Person loses read
    const parsed = parseMatrixWorkbook([fn], s);
    const sales = parsed.changedRoles.find((r) => r.roleId === 10)!;
    expect(sales.functionsRemoved).toContain("service_cases.read");
    expect(sales.removedCount).toBe(1);
    expect(sales.permsPayload).not.toContain("service_cases.read");
  });

  it("a blank cell leaves the current grant untouched", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, 2, "service_cases.read")[3] = ""; // blank, not a dash
    const parsed = parseMatrixWorkbook([fn], s);
    expect(parsed.changedRoles).toEqual([]);
  });
});

describe("parse: page edits reconcile scm.access", () => {
  it("raising an SCM area adds scm.access; clearing all removes it", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const pg = sheet(wb.sheets, EXCEL_SHEET_PAGES);
    // give Sales Person (col 4 of the pages sheet: 模块,页面,Key,状态 then roles)
    rowFor(pg, 2, "scm.sales")[4] = "看"; // role 10 is first role col = index 4
    const parsed = parseMatrixWorkbook([pg], s);
    const sales = parsed.changedRoles.find((r) => r.roleId === 10)!;
    expect(sales.pageChanges.some((c) => c.pageKey === "scm.sales" && c.to === "view")).toBe(true);
    expect(sales.functionsAdded).toContain("scm.access"); // reconciled
    // payload carries the derived umbrella
    expect(sales.pagePayload.find((e) => e.pageKey === "scm")?.level).toBe("view");
  });

  it("lowering a page counts as removed", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const pg = sheet(wb.sheets, EXCEL_SHEET_PAGES);
    rowFor(pg, 2, "scm.warehouse")[5] = "无"; // role 11 (second role col = index 5) edit→none
    const parsed = parseMatrixWorkbook([pg], s);
    const store = parsed.changedRoles.find((r) => r.roleId === 11)!;
    expect(store.pageChanges.some((c) => c.pageKey === "scm.warehouse" && c.to === "none")).toBe(true);
    expect(store.removedCount).toBeGreaterThanOrEqual(1);
    // all SCM areas now none → scm.access withdrawn
    expect(store.functionsRemoved).toContain("scm.access");
  });
});

describe("parse: locked roles and bad data", () => {
  it("never writes a locked role, reports it when the file edits it", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, 2, "service_cases.read")[5] = "−"; // Owner column (locked)
    const parsed = parseMatrixWorkbook([fn], s);
    expect(parsed.changedRoles.some((r) => r.roleId === 1)).toBe(false);
    expect(parsed.lockedWithEdits).toContain("Owner");
  });

  it("reports an unreadable cell instead of guessing", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, 2, "service_cases.read")[4] = "maybe?";
    const parsed = parseMatrixWorkbook([fn], s);
    expect(parsed.badCells.length).toBe(1);
    expect(parsed.badCells[0]!.value).toBe("maybe?");
  });

  it("reports an unknown key row", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["Key", "10 · Sales Person"],
        ["not.a.real.key", "✓"],
        ["service_cases.read", "✓"],
        ["service_cases.write", "✓"],
      ],
    };
    const parsed = parseMatrixWorkbook([sheetData], s);
    expect(parsed.unknownKeys).toContain("not.a.real.key");
  });
});

describe("parse: robust column + sheet detection", () => {
  it("matches a role column by name when there is no id prefix", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "whatever",
      aoa: [
        ["Key", "Sales Person"],
        ["service_cases.write", "✓"],
        ["service_cases.manage", "✓"],
      ],
    };
    const parsed = parseMatrixWorkbook([sheetData], s);
    const sales = parsed.changedRoles.find((r) => r.roleId === 10)!;
    expect(sales.functionsAdded).toContain("service_cases.write");
  });

  it("reports an id-prefixed column whose id is unknown", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["Key", "999 · Ghost Role"],
        ["service_cases.read", "✓"],
        ["service_cases.write", "✓"],
      ],
    };
    const parsed = parseMatrixWorkbook([sheetData], s);
    expect(parsed.ignoredColumns).toContain("999 · Ghost Role");
  });

  it("reports an ambiguous role name", () => {
    const dupeRoles = [...ROLES, role(12, "Sales Person", [])];
    const s = snapshotFromApi(dupeRoles, PAGES, PERMS, PAGE_ROLES);
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["Key", "Sales Person"],
        ["service_cases.read", "✓"],
        ["service_cases.write", "✓"],
      ],
    };
    const parsed = parseMatrixWorkbook([sheetData], s);
    expect(parsed.ambiguousColumns).toContain("Sales Person");
  });

  it("classifies pages and functions in ONE combined sheet by their key", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "combined",
      aoa: [
        ["Key", "11 · Storekeeper"],
        ["service_cases.write", "✓"], // function
        ["service_cases.read", "✓"], // function (needed for key-col signal)
        ["scm.sales", "看"], // page
      ],
    };
    const parsed = parseMatrixWorkbook([sheetData], s);
    const store = parsed.changedRoles.find((r) => r.roleId === 11)!;
    expect(store.functionsAdded).toContain("service_cases.write");
    expect(store.pageChanges.some((c) => c.pageKey === "scm.sales")).toBe(true);
  });

  it("skips a sheet with no key column (the 角色 legend)", () => {
    const s = snap();
    const wb = buildWorkbook(s);
    const roles = sheet(wb.sheets, EXCEL_SHEET_ROLES);
    const parsed = parseMatrixWorkbook([roles], s);
    expect(parsed.empty).toBe(true);
    expect(parsed.changedRoles).toEqual([]);
  });
});

describe("sensitiveKeysOf", () => {
  it("flags approval / money keys in a change", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["Key", "10 · Sales Person"],
        ["service_cases.approve", "✓"],
        ["service_cases.read", "✓"],
        ["scm.payment_voucher.check", "✓"],
      ],
    };
    const parsed = parseMatrixWorkbook([sheetData], s);
    const sales = parsed.roleResults.find((r) => r.roleId === 10)!;
    expect(sensitiveKeysOf(sales)).toEqual(["scm.payment_voucher.check", "service_cases.approve"]);
  });
});

describe("roleColumnHeader", () => {
  it("is id · name", () => {
    expect(roleColumnHeader({ id: 7, name: "Finance", locked: false, memberCount: 0 })).toBe("7 · Finance");
  });
});
