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

// ----------------------------------------------------------------------------
// The MIRROR IMAGE of the four above (bug 0546): a desktop control that did not
// render for someone the SERVER ALLOWS. The attach endpoint admits
// projects.write OR projects.checklist.tick + roleLabelAdmits(role_label,
// role_name); both desktop gates asked projects.write alone, so the day 0489
// stripped that permission from the Purchaser role she lost the Attach button on
// her own PURCHASER-badged documents while mobile and the API still allowed it.
// ----------------------------------------------------------------------------
const allWindowsBefore = (needle: string, chars: number): string[] => {
  const text = projects();
  let at = text.indexOf(needle);
  expect(at, `anchor disappeared from Projects.tsx: ${needle}`).toBeGreaterThan(-1);
  const out: string[] = [];
  while (at > -1) {
    out.push(text.slice(Math.max(0, at - chars), at));
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
};

describe("Projects.tsx — Attach is offered to every role the server admits (0546)", () => {
  it("both surfaces read the badge rule from the one shared module", () => {
    // Backend original: backend/src/services/projectGates.ts roleLabelAdmits.
    // Desktop had NO copy of it (bug 0546) and mobile had its own inline one;
    // both now import auth/roleLabelAdmits, which is unit-tested next door.
    // Asserting the IMPORT, not a local definition, is the point — a re-inlined
    // third copy is how these two surfaces drifted from the server twice.
    for (const f of ["pages/Projects.tsx", "mobile/MobilePMS.tsx"]) {
      expect(src(f), `${f} no longer imports the shared badge rule`)
        .toContain('from "../auth/roleLabelAdmits"');
      expect(src(f), `${f} re-inlined its own copy of the rule`)
        .not.toContain("function roleLabelAdmitsRole(");
    }
  });

  it("every desktop Attach button reads a role-aware predicate, not projects.write alone", () => {
    const wins = allWindowsBefore("void startAttach()", 160);
    expect(wins.length).toBeGreaterThanOrEqual(2);
    for (const w of wins) expect(w).toMatch(/mayAttachRow/);
  });

  it("the document-table gate admits a tick-only role on its OWN badged row", () => {
    const w = windowBefore("canTick && roleLabelAdmitsRole(it.role_label", 500);
    expect(w).toContain("mayAttach");
    // The Sales Director exception (owner 2026-08-10) must survive beside it.
    expect(w).toContain("isSalesDirectorPos");
  });

  it("file DELETE follows ATTACH on BOTH surfaces (owner 2026-09-03)", () => {
    // "every user can delete/remove file or image from their own task, both pc
    // and mobile pms" — replacing the 2026-08-05 managers-only rule. The point
    // is the EQUIVALENCE: whoever may put a file on a task may take one off, so
    // neither surface may re-introduce a projects.manage term here.
    const text = projects();
    const w = windowBefore("aria-label=\"Remove attachment\"", 900);
    expect(w).toContain("mayDeleteFile");
    expect(text).toContain("roleLabelAdmitsRole(roleLabel, user?.role_name)");
    // The card-section chip trash IS the attach capability, verbatim.
    expect(text).toContain("mayAttachRow && !readOnlyAttach && a.id > 0");
    // A merged crew photo (id < 0) is never removable.
    expect(text).toContain("attachment.id > 0 &&");

    // Mobile has THREE delete gates, not one — the file chip, the document
    // tiles and the floor-plan card. All follow the caller's edit right now.
    const mobile = src("mobile/MobilePMS.tsx");
    const mobileCode = mobile
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(mobileCode).toContain("const canRemoveFile = canAttach;");
    expect(mobileCode).toContain("const canDeleteFiles = canTick;");
    expect(mobileCode).toContain("const canDeleteFiles = canWrite;");
    const mobileDeleteGates =
      mobileCode.match(/const (?:canDeleteFiles|canRemoveFile) = [^;]*/g) ?? [];
    expect(mobileDeleteGates.length).toBe(3);
    for (const gate of mobileDeleteGates) {
      expect(
        gate,
        "a mobile delete gate re-introduced projects.manage — the surfaces have drifted again",
      ).not.toContain("projects.manage");
    }
  });

  it("the file-card knows which task badge it is rendering", () => {
    // mayDeleteFile is only as good as the badge it is given: both
    // TaskAttachmentRow call sites must pass the item's role_label, or the
    // predicate silently answers false and the trash stays hidden.
    const uses = (projects().match(/<TaskAttachmentRow/g) ?? []).length;
    const passes = (projects().match(/roleLabel=\{item\.role_label\}/g) ?? []).length;
    expect(passes, "a TaskAttachmentRow renders without its role badge").toBe(uses);
  });
});

// Source-scanned here because this file already reads Projects.tsx, and the
// list is a module-level const inside a ~15,000-line component that must not be
// imported into a test (see the header above).
describe("Projects.tsx — every list filter param is sticky", () => {
  it("PROJECTS_LIST_FILTER_KEYS covers each param the toolbar reads", () => {
    const text = projects();
    const keys = text.slice(
      text.indexOf("const PROJECTS_LIST_FILTER_KEYS = ["),
      text.indexOf("] as const;", text.indexOf("const PROJECTS_LIST_FILTER_KEYS = [")),
    );
    // Owner 2026-08-24: "once i filter here and click in project, then i back to
    // project list back all my filter gone". from/to (the date range that
    // replaced year+month) were missing, so useStickyFilters' pluck() dropped
    // them and the range alone did not survive the round-trip.
    for (const p of ["section", "task", "brand", "from", "to", "status", "page"]) {
      expect(keys, `${p} is read from the URL but never mirrored`).toContain(`"${p}"`);
    }
  });

  it("EXPORT sends every filter the on-screen list sends", () => {
    // Owner 2026-09-02: filtered Setup & Dismantle + My pending tasks to 10
    // rows, exported, and got every confirmed event — the export omitted
    // my_pending on purpose ("export is the full filtered list"). An export
    // that disagrees with the screen is a wrong document, so the two parameter
    // sets are now asserted equal rather than kept in step by hand.
    const text = projects();
    const between = (a: string, b: string) => {
      const i = text.indexOf(a);
      expect(i, `anchor disappeared: ${a}`).toBeGreaterThan(-1);
      return text.slice(i, text.indexOf(b, i));
    };
    const keysOf = (block: string) =>
      [...new Set((block.match(/^\s{10,14}([a-z_]+):/gm) ?? []).map((k) => k.trim().replace(":", "")))];
    const listKeys = keysOf(between("const list = useQuery", "per_page: perPage,"));
    const exportKeys = keysOf(between("const exportProjects = async", "per_page: per,"));
    expect(listKeys.length).toBeGreaterThan(8);
    for (const k of listKeys) {
      expect(exportKeys, `the export drops "${k}", so its rows differ from the screen`).toContain(k);
    }
  });
});
