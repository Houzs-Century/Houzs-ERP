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
  return { id, name, description: null, permissions, is_system: false, member_count: 0, ...over };
}

const ROLES: Role[] = [
  role(10, "Sales Person", ["service_cases.read"]),
  role(11, "Storekeeper", ["scm.access"]),
  role(1, "Owner", ["*"], { is_system: true }),
];

const PAGE_ROLES = [
  { role_id: 10, levels: { service_cases: "view", "service_cases.cases": "view" } as Record<string, string> },
  { role_id: 11, levels: { scm: "edit", "scm.warehouse": "edit" } as Record<string, string> },
];

function snap(): MatrixSnapshot {
  return snapshotFromApi(ROLES, PAGES, PERMS, PAGE_ROLES);
}

function sheet(sheets: SheetData[], name: string): SheetData {
  const s = sheets.find((x) => x.name === name);
  if (!s) throw new Error(`no sheet ${name}`);
  return s;
}

/** The row whose cell at `keyCol` equals `key`. */
function rowFor(s: SheetData, keyCol: number, key: string): CellValue[] {
  const r = s.aoa.find((row) => row[keyCol] === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
}

// Column layout of the built sheets (see buildWorkbook):
//   功能: 0 模块 | 1 功能 | 2 说明 | 3 key | 4 role10 | 5 role11 | 6 owner
//   页面: 0 模块 | 1 页面 | 2 key  | 3 状态 | 4 role10 | 5 role11 | 6 owner
const FN_KEY = 3;
const PG_KEY = 2;

describe("snapshotFromApi", () => {
  it("normalizes stored levels and marks locked roles", () => {
    const s = snap();
    expect(s.roles.find((r) => r.id === 1)?.locked).toBe(true);
    expect(s.roles.find((r) => r.id === 10)?.locked).toBe(false);
    expect(s.levelsByRole.get(10)?.service_cases).toBe("view");
    expect(s.levelsByRole.get(10)?.sales).toBe("none");
  });
});

describe("buildWorkbook", () => {
  it("writes the three sheets with Name\\n(N人) role headers", () => {
    const wb = buildWorkbook(snap());
    expect(wb.sheets.map((x) => x.name)).toEqual([
      EXCEL_SHEET_FUNCTIONS,
      EXCEL_SHEET_PAGES,
      EXCEL_SHEET_ROLES,
    ]);
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    expect(fn.aoa[0]!.slice(0, 4)).toEqual(["模块", "功能", "说明", "key"]);
    expect(fn.aoa[0]!.slice(4)).toEqual(["Sales Person\n(0人)", "Storekeeper\n(0人)", "Owner\n(0人)"]);
  });

  it("ticks granted functions and leaves the rest BLANK", () => {
    const wb = buildWorkbook(snap());
    const fn = sheet(wb.sheets, EXCEL_SHEET_FUNCTIONS);
    const readRow = rowFor(fn, FN_KEY, "service_cases.read");
    expect(readRow[4]).toBe("✓"); // Sales Person granted
    expect(readRow[5]).toBe(""); // Storekeeper not — blank, not a dash
  });

  it("writes page levels (none = blank) and never emits the derived scm umbrella", () => {
    const wb = buildWorkbook(snap());
    const pg = sheet(wb.sheets, EXCEL_SHEET_PAGES);
    expect(pg.aoa.some((r) => r[PG_KEY] === "scm")).toBe(false);
    const warehouse = rowFor(pg, PG_KEY, "scm.warehouse");
    expect(warehouse[5]).toBe("改"); // Storekeeper edit
    const sales = rowFor(pg, PG_KEY, "sales");
    expect(sales[4]).toBe(""); // Sales Person none → blank
  });

  it("flags dormant pages in the status column", () => {
    const wb = buildWorkbook(snap());
    const pnl = rowFor(sheet(wb.sheets, EXCEL_SHEET_PAGES), PG_KEY, "service_cases.pnl");
    expect(pnl[3]).toBe("停用 dormant");
  });

  it("writes a role legend with ids and the locked flag", () => {
    const roles = sheet(buildWorkbook(snap()).sheets, EXCEL_SHEET_ROLES);
    const owner = roles.aoa.find((r) => r[0] === 1);
    expect(owner?.[1]).toBe("Owner");
    expect(owner?.[4]).toBe("是"); // locked
  });
});

describe("round-trip is a no-op (blankMode none)", () => {
  it("export → parse yields no changes", () => {
    const s = snap();
    const parsed = parseMatrixWorkbook(buildWorkbook(s).sheets, s);
    expect(parsed.changedRoles).toEqual([]);
    expect(parsed.totalAdded).toBe(0);
    expect(parsed.totalRemoved).toBe(0);
    expect(parsed.empty).toBe(false);
    expect(parsed.badCells).toEqual([]);
  });
});

describe("parse: function edits", () => {
  it("ticking a blank cell adds the key", () => {
    const s = snap();
    const fn = sheet(buildWorkbook(s).sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, FN_KEY, "service_cases.read")[5] = "✓"; // Storekeeper gets read
    const store = parseMatrixWorkbook([fn], s).changedRoles.find((r) => r.roleId === 11)!;
    expect(store.functionsAdded).toContain("service_cases.read");
    expect(store.addedCount).toBe(1);
    expect(store.permsPayload).toContain("service_cases.read");
  });

  it("clearing a ticked cell revokes it (complete-matrix: blank = not granted)", () => {
    const s = snap();
    const fn = sheet(buildWorkbook(s).sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, FN_KEY, "service_cases.read")[4] = ""; // Sales Person loses read
    const sales = parseMatrixWorkbook([fn], s).changedRoles.find((r) => r.roleId === 10)!;
    expect(sales.functionsRemoved).toContain("service_cases.read");
    expect(sales.permsPayload).not.toContain("service_cases.read");
  });

  it("blankMode 'unchanged' leaves a cleared cell alone", () => {
    const s = snap();
    const fn = sheet(buildWorkbook(s).sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, FN_KEY, "service_cases.read")[4] = "";
    expect(parseMatrixWorkbook([fn], s, "unchanged").changedRoles).toEqual([]);
  });
});

describe("parse: page edits reconcile scm.access", () => {
  it("raising an SCM area adds scm.access; clearing all removes it", () => {
    const s = snap();
    const pg = sheet(buildWorkbook(s).sheets, EXCEL_SHEET_PAGES);
    rowFor(pg, PG_KEY, "scm.sales")[4] = "看"; // Sales Person (role10)
    const sales = parseMatrixWorkbook([pg], s).changedRoles.find((r) => r.roleId === 10)!;
    expect(sales.pageChanges.some((c) => c.pageKey === "scm.sales" && c.to === "view")).toBe(true);
    expect(sales.functionsAdded).toContain("scm.access");
    expect(sales.pagePayload.find((e) => e.pageKey === "scm")?.level).toBe("view");
  });

  it("lowering a page counts as removed and withdraws the umbrella", () => {
    const s = snap();
    const pg = sheet(buildWorkbook(s).sheets, EXCEL_SHEET_PAGES);
    rowFor(pg, PG_KEY, "scm.warehouse")[5] = ""; // Storekeeper edit → none (blank)
    const store = parseMatrixWorkbook([pg], s).changedRoles.find((r) => r.roleId === 11)!;
    expect(store.pageChanges.some((c) => c.pageKey === "scm.warehouse" && c.to === "none")).toBe(true);
    expect(store.removedCount).toBeGreaterThanOrEqual(1);
    expect(store.functionsRemoved).toContain("scm.access");
  });
});

describe("parse: locked roles and bad data", () => {
  it("never writes a locked role; flags it when a NON-blank cell targets it", () => {
    const s = snap();
    const fn = sheet(buildWorkbook(s).sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, FN_KEY, "service_cases.read")[6] = "✓"; // Owner column (locked)
    const parsed = parseMatrixWorkbook([fn], s);
    expect(parsed.changedRoles.some((r) => r.roleId === 1)).toBe(false);
    expect(parsed.lockedWithEdits).toContain("Owner");
  });

  it("reports an unreadable cell instead of guessing", () => {
    const s = snap();
    const fn = sheet(buildWorkbook(s).sheets, EXCEL_SHEET_FUNCTIONS);
    rowFor(fn, FN_KEY, "service_cases.read")[5] = "maybe?";
    const parsed = parseMatrixWorkbook([fn], s);
    expect(parsed.badCells.length).toBe(1);
    expect(parsed.badCells[0]!.value).toBe("maybe?");
  });

  it("reports an unknown key row", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["key", "10 · Sales Person"],
        ["not.a.real.key", "✓"],
        ["service_cases.read", "✓"],
        ["service_cases.write", "✓"],
      ],
    };
    expect(parseMatrixWorkbook([sheetData], s).unknownKeys).toContain("not.a.real.key");
  });
});

describe("parse: robust column + sheet detection", () => {
  it("matches a role column by name with the owner's (N人) decoration", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "whatever",
      aoa: [
        ["key", "Sales Person\n(39人)"],
        ["service_cases.write", "✓"],
        ["service_cases.read", "✓"],
      ],
    };
    const sales = parseMatrixWorkbook([sheetData], s).changedRoles.find((r) => r.roleId === 10)!;
    expect(sales.functionsAdded).toContain("service_cases.write");
  });

  it("reports an id-prefixed column whose id is unknown", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["key", "999 · Ghost Role"],
        ["service_cases.read", "✓"],
        ["service_cases.write", "✓"],
      ],
    };
    expect(parseMatrixWorkbook([sheetData], s).ignoredColumns).toContain("999 · Ghost Role");
  });

  it("reports an ambiguous role name", () => {
    const s = snapshotFromApi([...ROLES, role(12, "Sales Person", [])], PAGES, PERMS, PAGE_ROLES);
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["key", "Sales Person"],
        ["service_cases.read", "✓"],
        ["service_cases.write", "✓"],
      ],
    };
    expect(parseMatrixWorkbook([sheetData], s).ambiguousColumns).toContain("Sales Person");
  });

  it("classifies pages and functions in ONE combined sheet by their key", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "combined",
      aoa: [
        ["key", "11 · Storekeeper"],
        ["service_cases.write", "✓"],
        ["service_cases.read", "✓"],
        ["scm.sales", "看"],
      ],
    };
    const store = parseMatrixWorkbook([sheetData], s).changedRoles.find((r) => r.roleId === 11)!;
    expect(store.functionsAdded).toContain("service_cases.write");
    expect(store.pageChanges.some((c) => c.pageKey === "scm.sales")).toBe(true);
  });

  it("skips a sheet with no key column (the 角色 legend)", () => {
    const s = snap();
    const roles = sheet(buildWorkbook(s).sheets, EXCEL_SHEET_ROLES);
    const parsed = parseMatrixWorkbook([roles], s);
    expect(parsed.empty).toBe(true);
    expect(parsed.changedRoles).toEqual([]);
  });
});

describe("scm.access is derived, never set by a function cell", () => {
  it("a 功能 scm.access cell neither grants nor revokes it directly", () => {
    const s = snap(); // Storekeeper (11) currently holds scm.access
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["key", "11 · Storekeeper"],
        ["scm.access", ""], // cleared — must NOT revoke (it is page-derived)
        ["service_cases.read", "✓"],
        ["service_cases.write", "✓"],
      ],
    };
    const store = parseMatrixWorkbook([sheetData], s).roleResults.find((r) => r.roleId === 11)!;
    // Storekeeper's SCM pages are unchanged (not in the file), so reconcile keeps
    // scm.access exactly as it was — the blank cell did not strip it.
    expect(store.functionsRemoved).not.toContain("scm.access");
    expect(store.permsPayload).toContain("scm.access");
  });
});

describe("key-column detection needs a MAJORITY of rows", () => {
  it("skips a sheet whose best column only has a couple of stray keys", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "pages-like",
      aoa: [
        ["页面", "现在由什么控制", "10 · Sales Person"],
        ["Overview", "所有登录用户", "看"],
        ["Cases", "service_cases.read", "看"],
        ["Maintenance", "service_cases.manage", "改"],
        ["Planning", "* 或 scm.access", "看"],
        ["Map", "* 或 scm.access", "看"],
        ["Bank", "* / PV key", "改"],
      ],
    };
    const parsed = parseMatrixWorkbook([sheetData], s);
    // The gate column has 2 exact keys out of 6 rows (<50%) → no key column.
    expect(parsed.empty).toBe(true);
    expect(parsed.badCells).toEqual([]);
    expect(parsed.unknownKeys).toEqual([]);
  });
});

describe("sensitiveKeysOf", () => {
  it("flags approval / money keys in a change", () => {
    const s = snap();
    const sheetData: SheetData = {
      name: "x",
      aoa: [
        ["key", "10 · Sales Person"],
        ["service_cases.approve", "✓"],
        ["service_cases.read", "✓"],
        ["scm.payment_voucher.check", "✓"],
      ],
    };
    const sales = parseMatrixWorkbook([sheetData], s).roleResults.find((r) => r.roleId === 10)!;
    expect(sensitiveKeysOf(sales)).toEqual(["scm.payment_voucher.check", "service_cases.approve"]);
  });
});

describe("roleColumnHeader", () => {
  it("is name over the member count", () => {
    expect(roleColumnHeader({ id: 7, name: "Finance", locked: false, memberCount: 2 })).toBe("Finance\n(2人)");
  });
});
