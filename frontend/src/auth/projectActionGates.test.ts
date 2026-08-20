// ----------------------------------------------------------------------------
// FOUR desktop controls that rendered for people the SERVER refuses.
//
// Each one is a live button on `pages/Projects.tsx` whose only condition was
// state ("is it archived?") or the WRONG permission key. The mobile twin gated
// each of them; the desktop one did not, so the user clicked and got a raw
// permission error — the control should not have been there.
//
//   1. Archive / Restore  -> POST /:id/archive|/unarchive  requirePermission("projects.manage")
//   2. Status dropdown    -> PATCH /:id                    requirePermission("projects.write")
//   3. + Total Sales      -> PATCH /:id/finance            projects.write + denyFinance
//   4. + Quick Log        -> POST /api/sales/entries       requirePageAccess("sales")
//
// TWO HALVES, deliberately.
//
// The unit half pins the two composite predicates — what they answer, and that
// they answer it the way the SERVER does. A helper is the only place a rule of
// more than one term can live without becoming a per-surface copy.
//
// The source-scan half pins that the four SITES ask them. Scanning is the
// established shape here (see soMaintenanceGate.test.ts): the sites are inline
// in a ~15,000-line component under constant concurrent edit, and rendering it
// would couple this test to its router, lazy boundaries and query client — it
// would then break for reasons that have nothing to do with the gate. What must
// not drift is WHICH predicate each site reads, and that is what the text says.
// Each scan is anchored on the control's own markup and looks only at the window
// immediately before it, so a match cannot be satisfied by the same words
// appearing somewhere else in the file.
// ----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { canLogSalesEntry, canWriteProjectFinance } from "./salesAccess";
import type { AuthUser } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

const u = (over: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 1,
    email: "t@example.test",
    name: "T",
    role_id: 1,
    role_name: "user",
    status: "active",
    permissions: [],
    position_name: null,
    department_name: null,
    ...over,
  }) as AuthUser;

/** A `can` closure with the same wildcard behaviour AuthContext gives it. */
const canFor = (perms: string[]) => (perm: string) =>
  perms.includes("*") || perms.includes(perm);

describe("canLogSalesEntry — mirrors requirePageAccess('sales') on POST /api/sales/entries", () => {
  it("admits any level at or above partial, and refuses none", () => {
    // backend meetsLevel(level, 'partial') over levelRank: none 0 < view/partial 1
    // < edit 2 < full 3. ACCESS_RANK is the FE copy of that same table.
    expect(canLogSalesEntry("full")).toBe(true);
    expect(canLogSalesEntry("edit")).toBe(true);
    expect(canLogSalesEntry("partial")).toBe(true);
    expect(canLogSalesEntry("view")).toBe(true);
    expect(canLogSalesEntry("none")).toBe(false);
  });

  it("does NOT admit a Sales Director who has no 'sales' matrix row", () => {
    // The read route is requirePageAccessOrSalesView, so a Sales Director READS
    // entries by org position. The WRITE route is plain requirePageAccess, which
    // has no such arm — offering them "+ Quick Log" is a guaranteed 403. This is
    // the exact case the old `can("sales.write")` gate got wrong in the other
    // direction, and the one thing this helper must not "helpfully" widen.
    expect(canLogSalesEntry("none")).toBe(false);
  });
});

describe("canWriteProjectFinance — mirrors projects.write + denyFinance on PATCH /:id/finance", () => {
  it("needs projects.write — sales.write is not a term in that rule", () => {
    // The live bug: a rep holding sales.write but not projects.write was shown
    // "+ Total Sales" and got "You don't have permission to view financial
    // information." on save.
    const salesRep = u({ position_id: 7, position_name: "Sales Executive" });
    expect(canWriteProjectFinance(salesRep, canFor(["sales.write"]))).toBe(false);
  });

  it("needs finance visibility — a positioned non-viewer is refused by denyFinance", () => {
    const positionedNonViewer = u({ position_id: 7, project_finance_viewer: false });
    expect(canWriteProjectFinance(positionedNonViewer, canFor(["projects.write"]))).toBe(false);
  });

  it("admits a finance viewer holding projects.write, with no sales grant at all", () => {
    // The other live consequence: someone authorised to SET the number never saw
    // a button for it, because the button asked for a sales permission instead.
    const financeUser = u({ position_id: 3, project_finance_viewer: true });
    expect(canWriteProjectFinance(financeUser, canFor(["projects.write"]))).toBe(true);
  });

  it("keeps the backend's un-positioned legacy arm: position_id null is not hidden", () => {
    // financeHiddenForUser returns FALSE for a user with no position so the
    // rollout does not lock out current finance users before positions are
    // seeded. Mirror it exactly rather than inventing a stricter client rule —
    // a client that hides what the server would accept is still a wrong answer.
    const unmigrated = u({ position_id: null });
    expect(canWriteProjectFinance(unmigrated, canFor(["projects.write"]))).toBe(true);
  });

  it("fails closed on no user", () => {
    expect(canWriteProjectFinance(null, canFor(["*"]))).toBe(false);
  });
});

// ── The four sites ──────────────────────────────────────────────────────────
// `window` = the source immediately BEFORE the control's own markup, which is
// where its JSX gate has to live. Sized to a few hundred characters so it cannot
// reach past the enclosing conditional into unrelated code.
const projects = () => src("pages/Projects.tsx");

const windowBefore = (needle: string, chars: number): string => {
  const text = projects();
  const at = text.indexOf(needle);
  expect(at, `anchor disappeared from Projects.tsx: ${needle}`).toBeGreaterThan(-1);
  return text.slice(Math.max(0, at - chars), at);
};

describe("Projects.tsx — the desktop control is gated on what the server enforces", () => {
  it("Archive / Restore asks for projects.manage", () => {
    // Was: `p ? (...)` only — visible to anyone who could open the project.
    expect(windowBefore('setArchiveMenuOpen((o) => !o)', 500)).toContain('"projects.manage"');
  });

  it("the STATUS dropdown asks for projects.write AND the PMS edit section", () => {
    // Was: `!p.archived_at` only — archived is STATE, not permission.
    const w = windowBefore("<ProjectStatusSelect", 400);
    expect(w).toContain('"projects.write"');
    // Same second term mobile carries (owner 2026-07-20: a project-level edit
    // needs the PMS EDIT section, so a sales PIC stays read-only).
    expect(w).toContain("canEditDetail");
  });

  it("+ Total Sales asks the finance-write helper, not a sales permission", () => {
    const w = windowBefore("> Total Sales", 1100);
    expect(w).toContain("canSetTotalSales");
    expect(w).not.toContain('can("sales.write")');
  });

  it("+ Quick Log asks the sales PAGE-ACCESS helper, not sales.write", () => {
    const w = windowBefore("> Quick Log", 700);
    expect(w).toContain("canLogSale");
    expect(w).not.toContain('can("sales.write")');
  });

  it("the sales section no longer derives either gate from can('sales.write')", () => {
    // One predicate per question, read from the shared helper — not a third copy
    // of a rule that already exists on the server and on mobile.
    expect(projects()).not.toContain('can("sales.write")');
  });
});
