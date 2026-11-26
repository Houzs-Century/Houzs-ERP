// Pure, React-free engine behind the role matrix's Excel/CSV export + import
// (RBAC rebuild, Option A — PR3). It sits ON TOP of roleMatrixModel.ts: this
// file only turns the live matrix into a workbook and an edited workbook back
// into the two write-API payloads. All the meaning (what a level grants, the
// scm.access umbrella, the "never auto-grant an approval/money key" rule) stays
// in roleMatrixModel so the UI, the mobile editor and this importer can never
// disagree about it.
//
// WHY A WORKBOOK, NOT JUST A GRID. The owner configures roles in Excel. His
// working file lists FUNCTIONS and PAGES as rows and ROLES as columns, a cell
// per role: a tick (✓) or dash (−) for a function, 无/看/改/批 for a page. This
// mirrors that exactly, so a round-trip (export → edit a few cells → import)
// reproduces his habit instead of fighting it.
//
// ROBUSTNESS OVER A FIXED LAYOUT. The parser never trusts sheet names or column
// order. It finds the role columns by matching each header to a known role (its
// id prefix or its name) and the "key" column by which column's cells best match
// the known page/permission keys, then classifies every data ROW by whether its
// key is a page key or a permission key. So a three-sheet export, a single
// combined sheet, or the owner's hand-made v3 all import the same way — only the
// cosmetic column labels differ.
//
// FORGIVING BY DESIGN (non-engineer owner). A BLANK cell means "leave it alone"
// (no change), never "revoke": importing an untouched export, or a file where he
// only filled part of the grid, changes nothing he did not touch. Removal needs
// an explicit token (− / x / 0 / 无 / none). Every unmatched column, unknown
// key, locked role and unreadable cell is reported in the preview rather than
// silently dropped.

import type { PermissionDef, Role } from "../types";
import {
  type MatrixLevel,
  type PageLite,
  MATRIX_LEVEL_LABEL_EN,
  PARENT_DERIVED_KEYS,
  buildMatrixModules,
  normalizeStoredLevel,
  isNeverByLevel,
  pageRowsToSend,
  reconcileScmAccess,
  levelRank,
  SCM_ACCESS_KEY,
} from "./roleMatrixModel";

export type CellValue = string | number | boolean | null;
export interface SheetData {
  name: string;
  aoa: CellValue[][];
}
export interface WorkbookData {
  sheets: SheetData[];
}

/** A role reduced to what export/import needs: identity + whether it is locked
 *  (system role or `*` wildcard — never written, same as the backend/UI). */
export interface RoleLite {
  id: number;
  name: string;
  locked: boolean;
  memberCount: number;
}

/** The live matrix: the catalogues plus each role's current function keys and
 *  per-page levels. Everything export writes and import diffs against. */
export interface MatrixSnapshot {
  roles: RoleLite[];
  pages: PageLite[];
  permissions: PermissionDef[];
  permsByRole: Map<number, ReadonlySet<string>>;
  levelsByRole: Map<number, Readonly<Record<string, MatrixLevel>>>;
}

// Sheet names mirror the owner's own draft (他的 v3) so the exported file reads
// like the one he already configures in.
export const EXCEL_SHEET_FUNCTIONS = "Functions (what they can do)";
export const EXCEL_SHEET_PAGES = "Pages (what they can see)";
export const EXCEL_SHEET_ROLES = "Roles";
export const ROLE_MATRIX_IMPORT_ACCEPT = ".xlsx,.xls,.csv";

const GRANT_MARK = "✓";
// A not-granted function cell is left BLANK (the owner's convention: ✓ = give,
// 空 = 不给), not dashed — see `blankMeans` below.

/**
 * How a BLANK cell is read on import.
 * - "none": the file is the COMPLETE desired matrix — blank = not granted /
 *   not visible (the owner's v3 convention, "✓=给 空=不给 / 看改 空=不可见").
 *   This is the default and what Export produces.
 * - "unchanged": only the cells the file fills change; blank = leave as-is.
 *   For a partial, hand-trimmed file.
 * Either way a page/role absent as a ROW/COLUMN is always left untouched.
 */
export type BlankMode = "none" | "unchanged";

/** The column header for a role: `Sales Director\n(1 member)`.
 *  The member count is a human hint; the parser matches on the name (and an
 *  `id ·` prefix if one is present). */
export function roleColumnHeader(r: RoleLite): string {
  return `${r.name}\n(${r.memberCount} ${r.memberCount === 1 ? "member" : "members"})`;
}


/** Assemble a snapshot from the raw API shapes the matrix already loads, so the
 *  desktop tab, the mobile editor and the tests build it the one way. */
export function snapshotFromApi(
  roles: Role[],
  pages: PageLite[],
  permissions: PermissionDef[],
  pageRoles: ReadonlyArray<{ role_id: number; levels: Record<string, string> }>,
): MatrixSnapshot {
  const levelsByApiRole = new Map(pageRoles.map((r) => [r.role_id, r.levels]));
  const permsByRole = new Map<number, ReadonlySet<string>>();
  const levelsByRole = new Map<number, Readonly<Record<string, MatrixLevel>>>();
  for (const r of roles) {
    permsByRole.set(r.id, new Set(r.permissions));
    const stored = levelsByApiRole.get(r.id) ?? {};
    const levels: Record<string, MatrixLevel> = {};
    for (const p of pages) levels[p.key] = normalizeStoredLevel(stored[p.key]);
    levelsByRole.set(r.id, levels);
  }
  return {
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      locked: !!r.is_system || r.permissions.includes("*"),
      memberCount: r.member_count,
    })),
    pages,
    permissions,
    permsByRole,
    levelsByRole,
  };
}


function editablePages(pages: PageLite[]): PageLite[] {
  return pages.filter((p) => !PARENT_DERIVED_KEYS.includes(p.key));
}

/** pageKey → the owner-facing module label, for the 页面 sheet's 模块 column. */
function pageModuleLabels(snap: MatrixSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of buildMatrixModules(snap.pages, snap.permissions)) {
    for (const p of m.pages) out.set(p.key, m.labelEn);
  }
  return out;
}

function exportablePermissions(permissions: PermissionDef[]): PermissionDef[] {
  return permissions.filter((p) => p.key !== "*");
}

/** The page cell the owner reads: none is BLANK (他的「空=不可见」), the rest
 *  their Chinese level. */
function pageLevelCell(level: MatrixLevel): string {
  return level === "none" ? "" : MATRIX_LEVEL_LABEL_EN[level];
}

/** The whole live matrix as a three-sheet workbook (功能 / 页面 / 角色),
 *  laid out like the owner's draft: functions ✓/空, pages 看/改/批/空. */
export function buildWorkbook(snap: MatrixSnapshot): WorkbookData {
  const roleCols = snap.roles;
  const roleHeaders = roleCols.map(roleColumnHeader);

  // 功能 — one row per permission key, ✓ (给) / 空 (不给) per role.
  const fnHeader: CellValue[] = ["Module", "Function", "Description", "key", ...roleHeaders];
  const fnRows: CellValue[][] = exportablePermissions(snap.permissions).map((perm) => {
    const cells = roleCols.map((r) =>
      (snap.permsByRole.get(r.id) ?? new Set()).has(perm.key) ? GRANT_MARK : "",
    );
    return [perm.resource, perm.label || perm.key, perm.description, perm.key, ...cells];
  });

  // 页面 — one row per editable page, 看/改/批 per role (空 = 不可见).
  const moduleLabels = pageModuleLabels(snap);
  const pgHeader: CellValue[] = ["Module", "Page", "key", "Status", ...roleHeaders];
  const pgRows: CellValue[][] = editablePages(snap.pages).map((p) => {
    const cells = roleCols.map((r) => pageLevelCell((snap.levelsByRole.get(r.id) ?? {})[p.key] ?? "none"));
    return [moduleLabels.get(p.key) ?? "", p.label, p.key, p.dormant ? "Dormant" : "", ...cells];
  });

  // 角色 — the legend tying each column to a role id, and which are locked.
  const roleHeaderRow: CellValue[] = ["ID", "Role", "System", "Members", "Locked"];
  const roleRows: CellValue[][] = roleCols.map((r) => [
    r.id,
    r.name,
    r.locked ? "Yes" : "",
    r.memberCount,
    r.locked ? "Yes" : "",
  ]);

  return {
    sheets: [
      { name: EXCEL_SHEET_FUNCTIONS, aoa: [fnHeader, ...fnRows] },
      { name: EXCEL_SHEET_PAGES, aoa: [pgHeader, ...pgRows] },
      { name: EXCEL_SHEET_ROLES, aoa: [roleHeaderRow, ...roleRows] },
    ],
  };
}


function cellText(v: CellValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v).trim();
}

const GRANT_TOKENS = new Set(["✓", "✔", "√", "y", "yes", "true", "1", "有", "是", "x"]);
const REVOKE_TOKENS = new Set(["-", "–", "—", "−", "0", "n", "no", "false", "否", "无"]);

type GrantParse = "grant" | "revoke" | "bad";
function parseGrantCell(raw: string): GrantParse {
  const t = raw.trim().toLowerCase();
  if (GRANT_TOKENS.has(t)) return "grant";
  if (REVOKE_TOKENS.has(t)) return "revoke";
  return "bad";
}

const LEVEL_TOKENS = new Map<string, MatrixLevel>([
  ["无", "none"],
  ["none", "none"],
  ["看", "view"],
  ["view", "view"],
  ["partial", "view"],
  ["改", "edit"],
  ["edit", "edit"],
  ["批", "full"],
  ["full", "full"],
]);
type LevelParse = { level: MatrixLevel } | "bad";
function parseLevelCell(raw: string): LevelParse {
  const level = LEVEL_TOKENS.get(raw.trim().toLowerCase());
  return level ? { level } : "bad";
}


function leadingId(header: string): number | null {
  const m = /^\s*#?\s*(\d+)\b/.exec(header);
  return m ? Number(m[1]) : null;
}

function stripIdPrefix(header: string): string {
  return header.replace(/^\s*#?\s*\d+\s*[·.\-:：]?\s*/, "").trim();
}

/** The role name inside a header, stripped of the owner's decorations: the first
 *  line only (his count rides a second line, `Sales Person\n(39人)`) and a
 *  trailing member-count paren `(39人)` / `(39)` if it sits on that line. A
 *  parenthetical WITHOUT digits (e.g. `New Member (no access)`) is part of the
 *  name and kept. */
function roleNameInHeader(header: string): string {
  const firstLine = header.split(/\r?\n/)[0] ?? header;
  return firstLine.replace(/\s*[(（]\s*\d+\s*(?:人|members?)?\s*[)）]\s*$/i, "").trim();
}

type ColumnMatch =
  | { kind: "role"; roleId: number }
  | { kind: "ambiguous" }
  | { kind: "none" };

function matchRoleColumn(header: string, roles: RoleLite[]): ColumnMatch {
  const id = leadingId(header);
  if (id !== null) {
    const byId = roles.find((r) => r.id === id);
    if (byId) return { kind: "role", roleId: byId.id };
  }
  const name = roleNameInHeader(header);
  const candidates = [name.toLowerCase(), stripIdPrefix(name).toLowerCase()].filter(
    (s) => s.length > 0,
  );
  const hits = roles.filter((r) => candidates.includes(r.name.trim().toLowerCase()));
  if (hits.length === 1) return { kind: "role", roleId: hits[0]!.id };
  if (hits.length > 1) return { kind: "ambiguous" };
  return { kind: "none" };
}


export interface PageChange {
  pageKey: string;
  label: string;
  from: MatrixLevel;
  to: MatrixLevel;
}

export interface RoleImportResult {
  roleId: number;
  roleName: string;
  locked: boolean;
  functionsAdded: string[];
  functionsRemoved: string[];
  pageChanges: PageChange[];
  addedCount: number;
  removedCount: number;
  permsChanged: boolean;
  pagesChanged: boolean;
  permsPayload: string[];
  pagePayload: Array<{ pageKey: string; level: MatrixLevel }>;
}

export interface BadCell {
  sheet: string;
  cell: string;
  value: string;
}

export interface ParsedImport {
  roleResults: RoleImportResult[];
  changedRoles: RoleImportResult[];
  ignoredColumns: string[];
  ambiguousColumns: string[];
  unknownKeys: string[];
  lockedWithEdits: string[];
  badCells: BadCell[];
  totalAdded: number;
  totalRemoved: number;
  empty: boolean;
}

const BAD_CELL_CAP = 50;

function cellRef(row: number, col: number): string {
  let c = col;
  let s = "";
  do {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${s}${row + 1}`;
}

interface WorkingRole {
  perms: Set<string>;
  levels: Record<string, MatrixLevel>;
}

/**
 * Parse an edited workbook into per-role write payloads and a human diff, never
 * trusting layout. Starts every role from its CURRENT state, then applies the
 * file's cells. `blankMode` decides a blank cell: "none" (default — the file is
 * the complete desired matrix, blank = not granted / not visible, the owner's
 * convention) or "unchanged" (blank = leave as-is, for a partial file). A page
 * or role ABSENT as a row/column is always left untouched either way. scm.access
 * is reconciled from the resulting page levels (the UI's safety net) before the
 * diff, so the preview shows the umbrella exactly as it will be written.
 */
export function parseMatrixWorkbook(
  sheets: SheetData[],
  snap: MatrixSnapshot,
  blankMode: BlankMode = "none",
): ParsedImport {
  const pageByKey = new Map(snap.pages.map((p) => [p.key, p]));
  const permKeys = new Set(snap.permissions.filter((p) => p.key !== "*").map((p) => p.key));
  const knownKeys = new Set<string>([...permKeys, ...snap.pages.map((p) => p.key)]);

  const working = new Map<number, WorkingRole>();
  for (const r of snap.roles) {
    working.set(r.id, {
      perms: new Set(snap.permsByRole.get(r.id) ?? []),
      levels: { ...(snap.levelsByRole.get(r.id) ?? {}) },
    });
  }

  const ignoredColumns = new Set<string>();
  const ambiguousColumns = new Set<string>();
  const unknownKeys = new Set<string>();
  const lockedTouched = new Set<number>();
  const rolesInFile = new Set<number>();
  const badCells: BadCell[] = [];
  let sheetsWithKeys = 0;

  const lockedById = new Map(snap.roles.map((r) => [r.id, r.locked]));
  const addBad = (sheet: string, row: number, col: number, value: string): void => {
    if (badCells.length < BAD_CELL_CAP) badCells.push({ sheet, cell: cellRef(row, col), value });
  };

  for (const sheet of sheets) {
    const rows = sheet.aoa;
    if (rows.length < 2) continue;
    const header = rows[0]!;

    const roleColOf = new Map<number, number>();
    const otherCols: number[] = [];
    for (let c = 0; c < header.length; c++) {
      const h = cellText(header[c] ?? null);
      if (h === "") {
        otherCols.push(c);
        continue;
      }
      const match = matchRoleColumn(h, snap.roles);
      if (match.kind === "role") {
        roleColOf.set(match.roleId, c);
        rolesInFile.add(match.roleId);
      } else if (match.kind === "ambiguous") {
        ambiguousColumns.add(h);
      } else if (leadingId(h) !== null) {
        ignoredColumns.add(h);
      } else {
        otherCols.push(c);
      }
    }

    // The key column = the candidate whose data cells most often hit a known
    // key. It must carry keys in a MAJORITY of data rows, not just a couple:
    // a sheet whose only key-ish column is an incidental one (e.g. v3's
    // "现在由什么控制" gate notes, where a stray cell equals a real key, or the
    // 角色 legend) has no key column and is skipped — not mis-parsed.
    const dataRows = rows.length - 1;
    const keyThreshold = Math.max(2, Math.floor(dataRows * 0.5));
    let keyCol = -1;
    let keyHits = -1;
    for (const c of otherCols) {
      let hits = 0;
      for (let r = 1; r < rows.length; r++) {
        if (knownKeys.has(cellText(rows[r]![c] ?? null))) hits++;
      }
      if (hits > keyHits) {
        keyHits = hits;
        keyCol = c;
      }
    }
    if (keyCol < 0 || keyHits < keyThreshold) continue;
    sheetsWithKeys++;

    for (let r = 1; r < rows.length; r++) {
      const key = cellText(rows[r]![keyCol] ?? null);
      if (key === "") continue;
      const isPerm = permKeys.has(key);
      const isPage = pageByKey.has(key) && !PARENT_DERIVED_KEYS.includes(key);
      if (!isPerm && !isPage) {
        if (!knownKeys.has(key)) unknownKeys.add(key);
        continue;
      }
      for (const [roleId, col] of roleColOf) {
        const raw = cellText(rows[r]![col] ?? null);
        const w = working.get(roleId);
        if (!w) continue;
        if (lockedById.get(roleId)) {
          if (raw !== "") lockedTouched.add(roleId);
          continue;
        }
        if (isPerm) {
          if (key === SCM_ACCESS_KEY) continue;
          let grant: boolean;
          if (raw === "") {
            if (blankMode !== "none") continue;
            grant = false;
          } else {
            const g = parseGrantCell(raw);
            if (g === "bad") {
              addBad(sheet.name, r, col, raw);
              continue;
            }
            grant = g === "grant";
          }
          if (grant) w.perms.add(key);
          else w.perms.delete(key);
        } else {
          let level: MatrixLevel;
          if (raw === "") {
            if (blankMode !== "none") continue;
            level = "none";
          } else {
            const lv = parseLevelCell(raw);
            if (lv === "bad") {
              addBad(sheet.name, r, col, raw);
              continue;
            }
            level = lv.level;
          }
          w.levels[key] = level;
        }
      }
    }
  }

  for (const [roleId, w] of working) {
    if (lockedById.get(roleId)) continue;
    const reconciled = reconcileScmAccess(w.perms, w.levels);
    w.perms = reconciled;
  }

  const roleResults: RoleImportResult[] = [];
  for (const role of snap.roles) {
    if (!rolesInFile.has(role.id)) continue;
    if (role.locked) continue;
    const w = working.get(role.id)!;
    const current = snap.permsByRole.get(role.id) ?? new Set<string>();
    const currentLevels = snap.levelsByRole.get(role.id) ?? {};

    const functionsAdded: string[] = [];
    const functionsRemoved: string[] = [];
    for (const key of w.perms) if (!current.has(key)) functionsAdded.push(key);
    for (const key of current) if (!w.perms.has(key)) functionsRemoved.push(key);

    const pageChanges: PageChange[] = [];
    for (const p of editablePages(snap.pages)) {
      const from = currentLevels[p.key] ?? "none";
      const to = w.levels[p.key] ?? "none";
      if (from !== to) pageChanges.push({ pageKey: p.key, label: p.label, from, to });
    }

    const addedCount =
      functionsAdded.length + pageChanges.filter((c) => levelRank(c.to) > levelRank(c.from)).length;
    const removedCount =
      functionsRemoved.length +
      pageChanges.filter((c) => levelRank(c.to) < levelRank(c.from)).length;

    const permsChanged = functionsAdded.length > 0 || functionsRemoved.length > 0;
    const pagesChanged = pageChanges.length > 0;

    roleResults.push({
      roleId: role.id,
      roleName: role.name,
      locked: role.locked,
      functionsAdded: functionsAdded.sort(),
      functionsRemoved: functionsRemoved.sort(),
      pageChanges,
      addedCount,
      removedCount,
      permsChanged,
      pagesChanged,
      permsPayload: [...w.perms].sort(),
      pagePayload: pageRowsToSend(snap.pages, w.levels),
    });
  }

  const changedRoles = roleResults.filter((r) => r.permsChanged || r.pagesChanged);
  const lockedWithEdits = snap.roles
    .filter((r) => lockedTouched.has(r.id))
    .map((r) => r.name);

  return {
    roleResults,
    changedRoles,
    ignoredColumns: [...ignoredColumns],
    ambiguousColumns: [...ambiguousColumns],
    unknownKeys: [...unknownKeys].sort(),
    lockedWithEdits,
    badCells,
    totalAdded: changedRoles.reduce((n, r) => n + r.addedCount, 0),
    totalRemoved: changedRoles.reduce((n, r) => n + r.removedCount, 0),
    empty: sheetsWithKeys === 0,
  };
}

/** The function keys a change touches that are approval / money / fine-SCM keys —
 *  surfaced in the preview so an explicit Excel grant of a sensitive key is never
 *  invisible (the matrix dropdown refuses these; a direct tick is allowed but
 *  shown). */
export function sensitiveKeysOf(result: RoleImportResult): string[] {
  return [...result.functionsAdded, ...result.functionsRemoved].filter(isNeverByLevel).sort();
}
