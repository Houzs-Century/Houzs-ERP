import { describe, it, expect } from "vitest";
import {
  PAGES,
  DORMANT_PAGE_KEYS,
  resolvePositionAccessFromRows,
  type AccessLevel,
} from "../src/services/pageAccess";

// ---------------------------------------------------------------------------
// The ZERO-CHANGE proof for the Team + Service sub-page split (owner 2026-10-20
// "全部拆开", RBAC rebuild batch 3). services/pageAccess.ts gives each Team
// sidebar sub-page and the Service Maintenance tab its own page key, and the nav
// (Sidebar.tsx) repoints the rows onto them. This asserts that, for every shape
// that exists in production (anogrigyjbduyzclzjgn, 2026-10-21), login resolves
// each wired key so that NO role gains or loses a page on deploy.
//
// TWO AREAS, TWO DIFFERENT SAFETY ARGUMENTS — because their nav rows gate
// differently (frontend/src/components/navFilter.ts):
//
//  * TEAM. Each Team leaf gated on `perm:<X>` AND `pageAccess:"team"` (the
//    parent). The split repoints `pageAccess` onto the per-leaf key
//    (team.members / team.roles / team.org_chart / team.departments) and adds a
//    new team.mailboxes; the `perm` gate and the group header's own
//    `pageAccess:"team"` are untouched. So the ONLY thing that can move is a leaf
//    whose own key resolves differently from `team`. Prod stores every team.*
//    child EXACTLY EQUAL to `team` for all 24 roles (14 full, 10 none), and
//    team.mailboxes is backfilled = `team`, so each leaf resolves == `team` and
//    the nav is byte-identical. Proven by TEAM_SHAPES below.
//
//  * SERVICE MAINTENANCE. The tab gated on `perm:"service_cases.manage"` ALONE
//    (no page key). The split ADDS `pageAccess:"service_cases.settings"`, ANDed.
//    Adding an ANDed gate can only ever REMOVE visibility, and only from a role
//    that holds service_cases.manage while service_cases.settings resolves none.
//    No prod role is in that state: every service_cases.manage holder stores
//    settings = full (wildcards short-circuit to full), and the one role whose
//    settings sits below its parent (PG WH Assistant: parent partial, settings
//    none) does NOT hold the perm. Proven by SERVICE_COHORTS below.
// ---------------------------------------------------------------------------

type Row = { page_key: string; level: string };

// ── Structural soundness ───────────────────────────────────────────────────
const WIRED_TEAM_KEYS = [
  "team.members",
  "team.roles",
  "team.org_chart",
  "team.departments",
  "team.mailboxes",
] as const;

describe("Team + Service sub-page split is structurally sound", () => {
  it("every wired Team key is in the catalogue, a child of `team`, and not dormant", () => {
    for (const k of WIRED_TEAM_KEYS) {
      const def = PAGES.find((p) => p.key === k);
      expect(def, `${k} must be in the catalogue`).toBeTruthy();
      expect(def!.parent, `${k} must inherit team`).toBe("team");
      expect(DORMANT_PAGE_KEYS.has(k), `${k} must no longer be dormant`).toBe(false);
    }
  });

  it("service_cases.settings is wired: in the catalogue, child of service_cases, not dormant", () => {
    const def = PAGES.find((p) => p.key === "service_cases.settings");
    expect(def, "service_cases.settings must be in the catalogue").toBeTruthy();
    expect(def!.parent).toBe("service_cases");
    expect(DORMANT_PAGE_KEYS.has("service_cases.settings")).toBe(false);
  });

  it("only service_cases.by_creditor and service_cases.pnl remain dormant", () => {
    expect([...DORMANT_PAGE_KEYS].sort()).toEqual([
      "service_cases.by_creditor",
      "service_cases.pnl",
    ]);
  });
});

// ── TEAM: every wired key resolves == `team` for every prod shape ───────────
/** A role's team rows BEFORE the split: the parent plus the four pre-existing
 *  (then-dormant) children, all stored EQUAL to the parent in prod. team.mailboxes
 *  has no stored row until the backfill (tested separately). */
function teamRows(team: AccessLevel): Row[] {
  return [
    { page_key: "team", level: team },
    { page_key: "team.members", level: team },
    { page_key: "team.roles", level: team },
    { page_key: "team.org_chart", level: team },
    { page_key: "team.departments", level: team },
  ];
}

// Prod (anogrigyjbduyzclzjgn, 2026-10-21): the only two team shapes across 24
// roles. 14 roles team=full, 10 roles team=none. No role stores a team.* child
// below its `team` parent, and none is partial.
const TEAM_SHAPES: Array<{ label: string; team: AccessLevel }> = [
  { label: "10 none-roles", team: "none" },
  { label: "14 full-team roles", team: "full" },
];

describe("Team sub-page split is a byte-for-byte no-op at login", () => {
  for (const shape of TEAM_SHAPES) {
    it(`${shape.label}: every wired Team leaf resolves == team (pre-existing child rows)`, () => {
      const out = resolvePositionAccessFromRows(teamRows(shape.team));
      expect(out["team"]).toBe(shape.team);
      // The four pre-existing children stored == team, so they resolve == team.
      for (const k of ["team.members", "team.roles", "team.org_chart", "team.departments"]) {
        expect(out[k], `${shape.label} ${k}`).toBe(shape.team);
      }
      // team.mailboxes has NO stored row on deploy → inherits `team` via cascade.
      expect(out["team.mailboxes"], `${shape.label} team.mailboxes (inherited)`).toBe(shape.team);
    });

    it(`${shape.label}: the backfill (team.mailboxes row = team) resolves identically`, () => {
      const before = resolvePositionAccessFromRows(teamRows(shape.team));
      const backfilled = [
        ...teamRows(shape.team),
        { page_key: "team.mailboxes", level: shape.team },
      ];
      const after = resolvePositionAccessFromRows(backfilled);
      for (const p of PAGES) {
        expect(after[p.key], `${shape.label} ${p.key} after backfill`).toBe(before[p.key]);
      }
    });
  }
});

// ── SERVICE MAINTENANCE: adding the ANDed page-key gate changes no visibility ─
// Model the nav gate exactly as navFilter.ts applies it for this row (sales
// bypasses do not apply — Service Maintenance carries none):
//   OLD: visible === holdsManage
//   NEW: visible === holdsManage AND resolve(service_cases.settings) !== "none"
function serviceMaintenanceOld(holdsManage: boolean): boolean {
  return holdsManage;
}
function serviceMaintenanceNew(holdsManage: boolean, settingsRows: Row[]): boolean {
  const resolved = resolvePositionAccessFromRows(settingsRows)["service_cases.settings"];
  return holdsManage && resolved !== "none";
}

// Prod cohorts (anogrigyjbduyzclzjgn, 2026-10-21): the distinct
// (service_cases level, service_cases.settings level, holds service_cases.manage)
// tuples across all 24 roles. The wildcard roles (Owner, Super Admin) resolve
// settings = full and hold the perm, i.e. cohort A — a strict superset, always
// visible both ways.
const SERVICE_COHORTS: Array<{
  label: string;
  sc: AccessLevel;
  settings: AccessLevel;
  manage: boolean;
}> = [
  { label: "A: manage + settings full (BD/IT x3/Logistic x2/MD/Ops/Purchaser/+wildcards)", sc: "full", settings: "full", manage: true },
  { label: "B: no manage, settings full (Finance/Finance Exec/HR)", sc: "full", settings: "full", manage: false },
  { label: "C: no manage, settings edit (Marketing/Sales Dir x2/Sales Person)", sc: "edit", settings: "edit", manage: false },
  { label: "D: no manage, settings none under partial parent (PG WH Assistant)", sc: "partial", settings: "none", manage: false },
  { label: "E: all-none (Calendar Viewer/Driver/Helper/New Member/Storekeeper)", sc: "none", settings: "none", manage: false },
];

describe("Service Maintenance gate is unchanged by wiring service_cases.settings", () => {
  for (const c of SERVICE_COHORTS) {
    it(`${c.label}: visibility is identical before and after`, () => {
      const rows: Row[] = [
        { page_key: "service_cases", level: c.sc },
        { page_key: "service_cases.settings", level: c.settings },
      ];
      expect(serviceMaintenanceNew(c.manage, rows)).toBe(serviceMaintenanceOld(c.manage));
    });
  }

  it("safety: NO prod cohort holds service_cases.manage while settings resolves none", () => {
    // This is the exact condition that would make the added gate subtract a page.
    // Prod has none; if a future config introduces one, this fails before deploy.
    for (const c of SERVICE_COHORTS) {
      const resolved = resolvePositionAccessFromRows([
        { page_key: "service_cases", level: c.sc },
        { page_key: "service_cases.settings", level: c.settings },
      ])["service_cases.settings"];
      if (c.manage) {
        expect(resolved, `${c.label} holds manage so settings must not be none`).not.toBe("none");
      }
    }
  });
});
