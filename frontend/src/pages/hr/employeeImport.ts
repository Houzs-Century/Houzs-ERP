/* Map a spreadsheet to employee rows (Employee Master bulk import, option 2).
 *
 * Pure: the modal reads the file with lib/import-sheet and hands the grid here;
 * this turns each row into the wire shape the /employees/bulk-import endpoint
 * takes, and says why a row cannot go in. The server re-checks everything, so
 * this only has to be a faithful preview — it uses the SAME shared validator
 * (employeeInputProblem) the server does, over the SAME parse (parseEmployeeInput).
 *
 * A blank Employee No is left blank on purpose: the server assigns the next one
 * in sequence, so the preview shows "(auto)". Money columns are RM here and sen
 * on the wire. Headers match loosely (case, spacing and common aliases, English
 * and Chinese), so HR can rename the template columns within reason. */
import { normalizeImportHeader, resolveImportHeaders } from "../../lib/import-sheet";
import { employeeInputProblem, parseEmployeeInput } from "../../vendor/shared/hr-employee";
import { senFromRm, type ImportEmployeeRow } from "./hrApi";

/** The template columns, in order, each with the aliases that also resolve to
 *  it. The first header is what the downloaded template writes. */
export const IMPORT_COLUMNS: ReadonlyArray<{ key: string; header: string; aliases: readonly string[] }> = [
  { key: "name", header: "Name", aliases: ["full name", "employee name", "姓名", "名字"] },
  { key: "empNo", header: "Employee No", aliases: ["emp no", "employee number", "emp_no", "no", "编号", "员工编号"] },
  { key: "accountEmail", header: "ERP Account Email", aliases: ["email", "account email", "erp account", "account", "login", "邮箱", "电邮", "账号"] },
  { key: "phone", header: "Phone", aliases: ["mobile", "hp", "contact", "phone no", "电话", "手机"] },
  { key: "department", header: "Department", aliases: ["dept", "部门"] },
  { key: "position", header: "Position", aliases: ["title", "job", "role", "职位", "岗位"] },
  { key: "joinDate", header: "Join Date (YYYY-MM-DD)", aliases: ["join date", "joined", "start date", "入职日期", "入职"] },
  { key: "payBasis", header: "Pay Basis (Monthly/Daily)", aliases: ["pay basis", "pay mode", "basis", "薪酬方式", "计薪方式"] },
  { key: "basicSalary", header: "Basic Salary (RM)", aliases: ["basic salary", "salary", "basic", "monthly salary", "底薪", "月薪"] },
  { key: "dailyRate", header: "Daily Rate (RM)", aliases: ["daily rate", "day rate", "rate per day", "日薪", "日工资"] },
  { key: "bank", header: "Bank", aliases: ["bank name", "银行"] },
  { key: "bankAccount", header: "Bank Account", aliases: ["account number", "bank account no", "银行账号", "账户号码"] },
  { key: "epf", header: "EPF (Yes/No)", aliases: ["epf", "kwsp", "公积金"] },
  { key: "socso", header: "SOCSO (Yes/No)", aliases: ["socso", "perkeso", "社险"] },
  { key: "eis", header: "EIS (Yes/No)", aliases: ["eis", "sip"] },
  { key: "pcb", header: "PCB (Yes/No)", aliases: ["pcb", "income tax", "所得税"] },
  { key: "nationality", header: "Nationality", aliases: ["citizenship", "国籍"] },
  { key: "icNumber", header: "IC Number", aliases: ["ic", "ic no", "mykad", "nric", "身份证"] },
  { key: "outsource", header: "Outsourced (Yes/No)", aliases: ["outsource", "osc", "外包", "外劳"] },
];

const KNOWN_KEYS = IMPORT_COLUMNS.map((c) => c.key);
const ALIASES: Record<string, string> = {};
for (const col of IMPORT_COLUMNS) {
  ALIASES[normalizeImportHeader(col.header)] = col.key;
  for (const a of col.aliases) ALIASES[normalizeImportHeader(a)] = col.key;
}

export type ImportPreviewRow = {
  /** 1-based row number as the sheet shows it (header is row 1, so data starts at 2). */
  rowNumber: number;
  /** The wire shape to submit, when the row is valid. */
  row: ImportEmployeeRow;
  /** How the employee reads for the preview, before the server assigns Emp No. */
  display: { empNo: string; name: string; account: string; pay: string; link: boolean };
  /** Why the row cannot go in, or null when it can. */
  problem: string | null;
};

export type ImportMapping = {
  rows: ImportPreviewRow[];
  /** Columns in the file that matched no known field (an import ignores them). */
  ignoredHeaders: string[];
};

const YES = /^(y|yes|true|1|✓|on|是|有|要|ya)$/i;
const DAILY = /daily|per day|day|日|天/i;
const pad = (s: string) => s.padStart(2, "0");

/** A date cell to ISO YYYY-MM-DD. Accepts YYYY-MM-DD, DD/MM/YYYY and the common
 *  separators; an unrecognised non-blank value is returned as written so the
 *  shared validator flags it rather than this guessing. */
function toIso(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return t;
}

const rowIsBlank = (cells: readonly string[]): boolean => cells.every((c) => c.trim() === "");

/**
 * Map the grid (header row first) to preview rows.
 *
 * @param grid              rows of text cells, exactly as lib/import-sheet reads them.
 * @param departmentsByName lower-cased, trimmed department name -> id (for the Department column).
 * @param today             today in YYYY-MM-DD, for the salary/join defaults the server also uses.
 */
export function mapImportGrid(grid: string[][], departmentsByName: ReadonlyMap<string, number>, today: string): ImportMapping {
  if (grid.length === 0) return { rows: [], ignoredHeaders: [] };
  const header = grid[0] ?? [];
  const keys = resolveImportHeaders(header, KNOWN_KEYS, ALIASES);
  const ignoredHeaders = header.filter((_h, i) => !KNOWN_KEYS.includes(keys[i])).map((h) => h.trim()).filter(Boolean);

  const rows: ImportPreviewRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    if (rowIsBlank(cells)) continue;
    const cell = (key: string): string => {
      const i = keys.indexOf(key);
      // A row can have fewer cells than the header has columns, so the index may
      // run off the end — keep it as string | undefined rather than string.
      const v = i >= 0 ? cells[i] : undefined;
      return (v ?? "").trim();
    };

    const empNo = cell("empNo").toUpperCase();
    const name = cell("name");
    const accountEmail = cell("accountEmail") || null;
    const deptText = cell("department");
    const salaryText = cell("basicSalary");
    const dailyText = cell("dailyRate");
    const payMode: "MONTHLY" | "DAILY" = DAILY.test(cell("payBasis")) ? "DAILY" : "MONTHLY";

    const departmentId = deptText ? departmentsByName.get(deptText.toLowerCase()) ?? null : null;
    const deptUnknown = deptText !== "" && departmentId === null;

    const row: ImportEmployeeRow = {
      empNo,
      name,
      accountEmail,
      phone: cell("phone"),
      position: cell("position"),
      nationality: cell("nationality"),
      icNumber: cell("icNumber"),
      departmentId,
      joinDate: toIso(cell("joinDate")),
      payMode,
      bankName: cell("bank"),
      bankAccount: cell("bankAccount"),
      epfEnabled: YES.test(cell("epf")),
      socsoEnabled: YES.test(cell("socso")),
      eisEnabled: YES.test(cell("eis")),
      pcbEnabled: YES.test(cell("pcb")),
      isOutsource: YES.test(cell("outsource")),
    };
    if (salaryText) row.basicSalarySen = senFromRm(salaryText);
    if (dailyText) row.dailyRateSen = senFromRm(dailyText);

    // Validate with the shared rules, the way the server will. A blank Emp No is
    // allowed here (the server auto-assigns it), so stand a placeholder in for
    // the check and never report "Employee No is required" for a blank one.
    const check = parseEmployeeInput({ ...row, empNo: empNo || "EMP-AUTO" }, today);
    let problem: string | null = null;
    if (!name) problem = "Name is required.";
    else if (deptUnknown) problem = `Unknown department "${deptText}". Create it first or leave the column blank.`;
    else if (salaryText && !Number.isFinite(senFromRm(salaryText))) problem = "Basic Salary must be a number in RM.";
    else if (dailyText && !Number.isFinite(senFromRm(dailyText))) problem = "Daily Rate must be a number in RM.";
    else problem = employeeInputProblem(check);

    rows.push({
      rowNumber: r + 1,
      row,
      display: {
        empNo: empNo || "(auto)",
        name: name || "(no name)",
        account: accountEmail ?? "",
        pay: payMode === "DAILY" ? (dailyText ? `RM ${dailyText} / day` : "day rate missing") : salaryText ? `RM ${salaryText}` : "RM 1,800 (default)",
        link: accountEmail !== null,
      },
      problem,
    });
  }
  return { rows, ignoredHeaders };
}
