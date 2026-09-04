import { describe, expect, test } from "vitest";
import {
  getPmsAccess,
  isFinanceViewer,
  financeHiddenForUser,
  isSensitiveChecklistItem,
  isSetupDismantleSection,
  isSalesUser,
  isDirectorUser,
  isSalesDirectorUser,
  isProductCostViewer,
} from "../src/services/pmsAccess";
import { stripSensitiveChecklist, stripSetupDismantle } from "../src/services/projects";
import { POSITION_ACCESS_SNAPSHOT } from "../src/services/positionAccessSnapshot";
import type { AuthUser } from "../src/services/auth";

// ── LOCKSTEP FIXTURE — MUST stay identical to frontend/src/auth/salesAccess.test.ts ──
// The FE mirror (isDirectorUser / isSalesDirectorUser in salesAccess.ts) must
// classify these exact names the same way this backend does. If you change a
// case here, change it there in the SAME commit; the two files carry no shared
// import (vendored-clone architecture), so these tables are the contract.
const LOCKSTEP_DIRECTOR: ReadonlyArray<[string, boolean]> = [
  // Real prod director positions — still match.
  ["Super Admin", true],
  ["Sales Director", true],
  ["Finance Manager", true],
  // Casing / spacing drift on a real name — still match (normalisation only).
  ["sales director", true],
  ["  Sales   Director ", true],
  // INJECTION names — a free-text rename that merely CONTAINS a director title.
  // These matched under the old /\b(...)\b/i and must now be REJECTED.
  ["Assistant to Sales Director", false],
  ["Deputy Finance Manager", false],
  ["Senior Super Admin", false],
  ["Super Administrator", false],
  // Other real prod non-directors — never matched, still don't.
  ["Sales Manager", false],
  ["HR Manager", false],
  ["Operation Manager", false],
];
const LOCKSTEP_SALES_DIRECTOR: ReadonlyArray<[string, boolean]> = [
  ["Sales Director", true],
  ["  sales director ", true],
  ["Assistant to Sales Director", false],
  ["Sales Executive", false],
  ["Sales Manager", false],
];

// Pure-function tests for the project-detail (PMS) section gating — the
// security boundary that hides financial/rental from non-finance positions.
// PIC is per-project (project.pic_id === user.id), not a job title.

function user(over: {
  id?: number;
  position_name?: string | null;
  department_name?: string | null;
  perms?: string[];
}): AuthUser {
  const perms = over.perms ?? [];
  return {
    id: over.id ?? 1,
    email: "t@test.local",
    name: "t",
    role_id: 1,
    role_name: "r",
    position_id: 1,
    position_name: over.position_name ?? null,
    status: "active",
    permissions: perms,
    permissions_set: new Set(perms),
    manager_id: null,
    scope_to_pic: false,
    department_id: null,
    department_name: over.department_name ?? null,
    brand_scope: null,
    page_access: {},
  } as AuthUser;
}

describe("pmsAccess — project-detail section gating", () => {
  test("Sales Director sees financials + rental + payment + sensitive + delete", () => {
    const a = getPmsAccess(user({ position_name: "Sales Director" }), { pic_id: 99 });
    expect(a.role).toBe("DIRECTOR");
    expect(a.canFinancial).toBe(true);
    expect(a.canRental).toBe(true);
    expect(a.canPayment).toBe(true);
    expect(a.canSensitive).toBe(true);
    expect(a.canSetupDismantle).toBe(true);
    expect(a.canEdit).toBe(true);
    expect(a.sections).toContain("ACTIONS");
  });

  test("Sales PIC is READ-ONLY on the project (no broad EDIT) and no payment/sensitive", () => {
    const a = getPmsAccess(user({ id: 7, position_name: "Sales Executive" }), { pic_id: 7 });
    expect(a.role).toBe("PIC");
    expect(a.canEdit).toBe(false);
    expect(a.canPayment).toBe(false);
    expect(a.canSensitive).toBe(false);
    expect(a.sections).not.toContain("EDIT");
    expect(a.sections).not.toContain("PAYMENT");
    expect(a.sections).not.toContain("WF_SENSITIVE");
    // Still opens + views the project.
    expect(a.canOpen).toBe(true);
    // Owner 2026-07-17: "sales supposed can view mobile and laptop for this
    // part" — this REVERSES his 2026-07-15 hide (7f7fc27). SETUP_DISMANTLE is a
    // VISIBILITY section only; it grants no edit, which is why restoring it does
    // not weaken the read-only assertions above. The newer ruling wins.
    expect(a.canSetupDismantle).toBe(true);
    expect(a.sections).toContain("SETUP_DISMANTLE");
  });

  test("BD (agreement.approve + projects.manage) SEES the agreement and can EDIT, without becoming a director (owner 2026-07-29)", () => {
    const bd = user({
      position_name: "Operation Executive",
      perms: ["projects.write", "projects.manage", "agreement.approve"],
    });
    const a = getPmsAccess(bd, { pic_id: 99 });
    expect(a.role).toBe("OTHER"); // still NOT a director
    expect(a.canSensitive).toBe(true); // agreement.approve unhides WF_SENSITIVE
    expect(a.canEdit).toBe(true); // projects.manage unlocks EDIT
    // Gains nothing else — money stays director-only.
    expect(a.canFinancial).toBe(false);
    expect(a.canRental).toBe(false);
  });

  test("projects.finance.view grants canFinancial to a non-director — the flag the project-detail strip reads (owner 2026-09-04)", () => {
    const bd = user({
      position_name: "Operation Executive",
      perms: ["projects.write", "projects.manage", "projects.finance.view"],
    });
    const a = getPmsAccess(bd, { pic_id: 99 });
    // isFinanceViewer honoured this permission from the day it was added;
    // canFinancial did not, so GET /projects/:id still stripped `finance` +
    // `finance_lines` from a holder. The two must agree — otherwise the
    // Rental box renders, accepts a number, and cannot read back the line it
    // just wrote, so every retype books ANOTHER line (12 on one project).
    expect(isFinanceViewer(bd)).toBe(true);
    expect(a.canFinancial).toBe(true);
    expect(financeHiddenForUser(bd)).toBe(false);
    // Still not a director, and the grant is finance-only.
    expect(a.role).toBe("OTHER");
    expect(isDirectorUser(bd)).toBe(false);
    expect(a.canPayment).toBe(false);
  });

  test("projects.write ALONE does not grant EDIT or WF_SENSITIVE — a Sales Person stays read-only (over-grant guard)", () => {
    const salesPerson = user({ id: 7, position_name: "Sales Executive", perms: ["projects.write"] });
    const a = getPmsAccess(salesPerson, { pic_id: 7 });
    expect(a.role).toBe("PIC");
    expect(a.canEdit).toBe(false); // NOT projects.manage → no edit
    expect(a.canSensitive).toBe(false); // NOT agreement.approve → no agreement
  });

  test("isFinanceViewer / financeHiddenForUser gate money for non-directors only", () => {
    const director = user({ position_name: "Sales Director" });
    const salesPic = user({ id: 7, position_name: "Sales Executive" });
    const unmigrated = { ...user({ position_name: "Sales Executive" }), position_id: null } as AuthUser;
    expect(isFinanceViewer(director)).toBe(true);
    expect(isFinanceViewer(salesPic)).toBe(false);
    // Director never hidden; sales hidden; un-migrated (no position) keeps legacy access.
    expect(financeHiddenForUser(director)).toBe(false);
    expect(financeHiddenForUser(salesPic)).toBe(true);
    expect(financeHiddenForUser(unmigrated)).toBe(false);
    expect(financeHiddenForUser(null)).toBe(false);
  });

  test("Finance Manager is also a director (sees money)", () => {
    const a = getPmsAccess(user({ position_name: "Finance Manager" }), { pic_id: 99 });
    expect(a.role).toBe("DIRECTOR");
    expect(a.canFinancial).toBe(true);
  });

  test("wildcard (*) role = director", () => {
    const a = getPmsAccess(user({ perms: ["*"], position_name: null }), { pic_id: 1 });
    expect(a.role).toBe("DIRECTOR");
    expect(a.canFinancial).toBe(true);
  });

  test("Sales PIC of THIS project: most sections but NO financial/rental", () => {
    const a = getPmsAccess(user({ id: 7, position_name: "Sales Executive" }), { pic_id: 7 });
    expect(a.role).toBe("PIC");
    expect(a.canFinancial).toBe(false);
    expect(a.canRental).toBe(false);
    expect(a.sections).toContain("EVENT_CHAT");
    expect(a.sections).not.toContain("FINANCIAL");
    expect(a.sections).not.toContain("RENTAL");
  });

  test("Sales NOT the PIC: expo/chat + view-only setup/dismantle, no booth, no money", () => {
    const a = getPmsAccess(user({ id: 7, position_name: "Sales Executive" }), { pic_id: 99 });
    expect(a.role).toBe("SALES");
    expect(a.sections).toEqual(
      expect.arrayContaining(["EXPO_MAP", "EVENT_CHAT"]),
    );
    // Owner 2026-07-17: "sales supposed can view mobile and laptop for this
    // part" — REVERSES his 2026-07-15 removal (7f7fc27). The newer ruling wins.
    expect(a.canSetupDismantle).toBe(true);
    expect(a.sections).toContain("SETUP_DISMANTLE");
    // The money and booth lines are UNCHANGED by that reversal and stay pinned:
    // S&D is a visibility section, and restoring it must not widen anything else.
    expect(a.sections).not.toContain("FINANCIAL");
    expect(a.sections).not.toContain("BOOTH_LAYOUT");
  });

  test("Logistic = PIC sections minus event chat, no money, keeps setup/dismantle", () => {
    const a = getPmsAccess(user({ position_name: "Logistic" }), { pic_id: 99 });
    expect(a.role).toBe("LOGISTIC");
    expect(a.canFinancial).toBe(false);
    expect(a.canSetupDismantle).toBe(true);
    expect(a.sections).toContain("BOOTH_LAYOUT");
    expect(a.sections).toContain("SETUP_DISMANTLE");
    expect(a.sections).not.toContain("EVENT_CHAT");
  });

  test("Purchasing: booth layout + setup only, no money", () => {
    const a = getPmsAccess(user({ position_name: "Purchasing" }), { pic_id: 99 });
    expect(a.role).toBe("PURCHASING");
    expect(a.canFinancial).toBe(false);
    expect(a.sections).toEqual(expect.arrayContaining(["BOOTH_LAYOUT", "SETUP_DISMANTLE"]));
    expect(a.sections).not.toContain("EXPO_MAP");
  });

  test("Driver/Helper → DRIVER role (use the driver portal, not money)", () => {
    expect(getPmsAccess(user({ position_name: "Driver" }), { pic_id: 99 }).role).toBe("DRIVER");
    expect(getPmsAccess(user({ position_name: "Helper" }), { pic_id: 99 }).role).toBe("DRIVER");
  });

  test("Ops / HQ non-admin: view-only OTHER, never financial", () => {
    const a = getPmsAccess(user({ position_name: "Ops Manager" }), { pic_id: 99 });
    expect(a.role).toBe("OTHER");
    expect(a.canFinancial).toBe(false);
    expect(a.sections).not.toContain("FINANCIAL");
  });
});

// Org-field Sales / director helpers — the code-keyed gate the Service-Case
// access model (rule 8) and the SO/SC data scope (rule 9 director bypass) share.
describe("isSalesUser / isDirectorUser — stable org-field access model", () => {
  test("Sales by position title (starts with 'Sales ')", () => {
    expect(isSalesUser(user({ position_name: "Sales Executive" }))).toBe(true);
    expect(isSalesUser(user({ position_name: "Sales Coordinator" }))).toBe(true);
  });

  test("Sales by department name (contains 'sales', case-insensitive)", () => {
    // No sales position, but the department carries it — prod names it
    // "Sales Department"; the seed is "Sales".
    expect(isSalesUser(user({ position_name: "Coordinator", department_name: "Sales Department" }))).toBe(true);
    expect(isSalesUser(user({ position_name: null, department_name: "sales" }))).toBe(true);
  });

  test("non-sales users are not Sales", () => {
    expect(isSalesUser(user({ position_name: "Ops Manager", department_name: "Operations" }))).toBe(false);
    expect(isSalesUser(user({ position_name: null, department_name: null }))).toBe(false);
    expect(isSalesUser(null)).toBe(false);
  });

  test("director = wildcard OR director/finance position", () => {
    expect(isDirectorUser(user({ perms: ["*"], position_name: null }))).toBe(true);
    expect(isDirectorUser(user({ position_name: "Super Admin" }))).toBe(true);
    expect(isDirectorUser(user({ position_name: "Sales Director" }))).toBe(true);
    expect(isDirectorUser(user({ position_name: "Finance Manager" }))).toBe(true);
  });

  test("Sales Director is a director (director tier governs the data scope)", () => {
    // "Sales Director" matches BOTH helpers (/^Sales / also matches the "Sales "
    // prefix). That's harmless for the gate — both admit the caller — and the
    // data-scope bypass (assrVisibleUserIds) keys off isDirectorUser, so a Sales
    // Director gets the unrestricted "sees ALL" tier, not the scoped Sales tier.
    const sd = user({ position_name: "Sales Director" });
    expect(isDirectorUser(sd)).toBe(true);
    expect(isSalesUser(sd)).toBe(true);
  });

  test("Sales Executive is Sales, not a director", () => {
    const se = user({ position_name: "Sales Executive" });
    expect(isSalesUser(se)).toBe(true);
    expect(isDirectorUser(se)).toBe(false);
  });
});

// Position names are owner-editable FREE TEXT. The director / sales-director /
// purchasing matchers used to key off a word-boundary regex, so a rename whose
// name merely CONTAINED a privileged title (e.g. "Assistant to Sales Director")
// silently inherited that title's access. These pin the closed hole: real prod
// names still match, injection names never do, the two documented renames are
// handled, and no real prod position changes the role it resolved to before.
describe("position-name matcher hardening — no rename injection", () => {
  test("isDirectorUser matches ONLY the exact director names (lockstep fixture)", () => {
    for (const [name, expected] of LOCKSTEP_DIRECTOR) {
      expect(isDirectorUser(user({ position_name: name }))).toBe(expected);
    }
    // The `*` wildcard is a director regardless of position name.
    expect(isDirectorUser(user({ perms: ["*"], position_name: "Assistant to Sales Director" }))).toBe(true);
  });

  test("isSalesDirectorUser matches ONLY the exact 'Sales Director' (lockstep fixture)", () => {
    for (const [name, expected] of LOCKSTEP_SALES_DIRECTOR) {
      expect(isSalesDirectorUser(user({ position_name: name }))).toBe(expected);
    }
  });

  test("isProductCostViewer: directors + purchasing by exact name, incl. the rename alias", () => {
    // Real prod cost cohort: the three directors + Procurement/Purchasing.
    expect(isProductCostViewer(user({ position_name: "Procurement/Purchasing" }))).toBe(true);
    // Documented pre-rename alias ("Purchasing" -> "Procurement/Purchasing").
    expect(isProductCostViewer(user({ position_name: "Purchasing" }))).toBe(true);
    expect(isProductCostViewer(user({ position_name: "Finance Manager" }))).toBe(true);
    expect(isProductCostViewer(user({ position_name: "Sales Director" }))).toBe(true);
    // INJECTION: a name merely CONTAINING "Purchasing" no longer inherits cost.
    expect(isProductCostViewer(user({ position_name: "Purchasing Assistant" }))).toBe(false);
    expect(isProductCostViewer(user({ position_name: "Assistant Purchasing Clerk" }))).toBe(false);
    // Non-cohort real positions.
    expect(isProductCostViewer(user({ position_name: "Sales Executive" }))).toBe(false);
    expect(isProductCostViewer(user({ position_name: "Storekeeper" }))).toBe(false);
  });

  // BLAST RADIUS: across all 17 live prod positions the matched cohorts are
  // EXACTLY the intended ones — the only behavioural change is that a future
  // rename can no longer inject. Iterates the generated snapshot so a new prod
  // position added to it is force-classified here.
  test("blast radius over all 17 prod positions is unchanged", () => {
    const directors = new Set(["Super Admin", "Sales Director", "Finance Manager"]);
    const salesDirectors = new Set(["Sales Director"]);
    const costViewers = new Set([
      "Super Admin", "Sales Director", "Finance Manager", "Procurement/Purchasing",
    ]);
    expect(POSITION_ACCESS_SNAPSHOT.length).toBe(17);
    for (const p of POSITION_ACCESS_SNAPSHOT) {
      const u = user({ position_name: p.name, department_name: p.department_name });
      expect(isDirectorUser(u)).toBe(directors.has(p.name));
      expect(isSalesDirectorUser(u)).toBe(salesDirectors.has(p.name));
      expect(isProductCostViewer(u)).toBe(costViewers.has(p.name));
    }
  });
});

describe("WF_SENSITIVE checklist stripping — quotation / agreement", () => {
  test("isSensitiveChecklistItem matches the Agreement / Quotation row only", () => {
    expect(isSensitiveChecklistItem({ title: "Agreement / Quotation" })).toBe(true);
    // Tolerates stray surrounding whitespace from a hand-edited row.
    expect(isSensitiveChecklistItem({ title: "  Agreement / Quotation " })).toBe(true);
    expect(isSensitiveChecklistItem({ title: "Security Deposit" })).toBe(false);
    expect(isSensitiveChecklistItem({ title: "3D Design" })).toBe(false);
    expect(isSensitiveChecklistItem({ title: null })).toBe(false);
    expect(isSensitiveChecklistItem(null)).toBe(false);
  });

  test("strips the sensitive row + its comments/attachments and drops the emptied section", () => {
    const detail = {
      checklist: [
        { id: 1, title: "Agreement / Quotation", section_id: 10, status: "done" },
        { id: 2, title: "3D Design", section_id: 20, status: "pending" },
      ],
      checklist_comments: [
        { id: 100, item_id: 1, body: "signed" },
        { id: 101, item_id: 2, body: "wip" },
      ],
      checklist_attachments: [
        { id: 200, item_id: 1 },
        { id: 201, item_id: 2 },
      ],
      sections: [
        { id: 10, name: "CONTRACT", sort_order: 10 },
        { id: 20, name: "3D APPROVAL", sort_order: 20 },
      ],
      section_progress: [
        { id: 10, name: "CONTRACT", total: 1, done: 1, na: 0, complete: 1 },
        { id: 20, name: "3D APPROVAL", total: 1, done: 0, na: 0, complete: 0 },
      ],
    };
    const out = stripSensitiveChecklist(detail);
    expect(out.checklist.map((r: any) => r.id)).toEqual([2]);
    expect(out.checklist_comments.map((r: any) => r.id)).toEqual([101]);
    expect(out.checklist_attachments.map((r: any) => r.id)).toEqual([201]);
    // CONTRACT held only the sensitive row → section + its progress dropped.
    expect(out.sections.map((s: any) => s.id)).toEqual([20]);
    expect(out.section_progress.map((s: any) => s.id)).toEqual([20]);
  });

  test("keeps a section that still holds other items, recomputing its progress", () => {
    const detail = {
      checklist: [
        { id: 1, title: "Agreement / Quotation", section_id: 10, status: "done" },
        { id: 3, title: "Other contract doc", section_id: 10, status: "pending" },
      ],
      checklist_comments: [],
      checklist_attachments: [],
      sections: [{ id: 10, name: "CONTRACT", sort_order: 10 }],
      section_progress: [
        { id: 10, name: "CONTRACT", total: 2, done: 1, na: 0, complete: 0 },
      ],
    };
    const out = stripSensitiveChecklist(detail);
    expect(out.checklist.map((r: any) => r.id)).toEqual([3]);
    expect(out.sections.map((s: any) => s.id)).toEqual([10]);
    const cp = out.section_progress.find((s: any) => s.id === 10);
    expect(cp).toMatchObject({ total: 1, done: 0, na: 0, complete: 0 });
  });

  test("no sensitive rows → returns the payload untouched (same reference)", () => {
    const detail = {
      checklist: [{ id: 2, title: "3D Design", section_id: 20, status: "pending" }],
      checklist_comments: [],
      checklist_attachments: [],
      sections: [{ id: 20, name: "3D APPROVAL", sort_order: 20 }],
      section_progress: [{ id: 20, total: 1, done: 0, na: 0, complete: 0 }],
    };
    expect(stripSensitiveChecklist(detail)).toBe(detail);
  });
});

describe("SETUP_DISMANTLE stripping — crew editor + documents section", () => {
  test("isSetupDismantleSection matches the SETUP & DISMANTLE DOCUMENTS section (case/space-insensitive)", () => {
    expect(isSetupDismantleSection({ name: "SETUP & DISMANTLE DOCUMENTS" })).toBe(true);
    expect(isSetupDismantleSection({ name: "  setup & dismantle documents " })).toBe(true);
    expect(isSetupDismantleSection({ name: "BOOTH LAYOUT & SETUP" })).toBe(false);
    expect(isSetupDismantleSection({ name: null })).toBe(false);
    expect(isSetupDismantleSection(null)).toBe(false);
  });

  // Owner 2026-07-28 ("all users can view the setup & dismantle part"): the
  // crew JSON, service crew, schedule remark and scheduled times are NO LONGER
  // NULLed — the S&D card is view-for-all and editing is gated on the write
  // path instead. Only the DOCUMENT rows are still role-filtered. These two
  // cases used to assert the opposite; they are re-pinned, not deleted, so the
  // ruling stays visible.
  test("KEEPS the crew JSON + times, and strips the document section, comments, attachments, progress", () => {
    const detail = {
      project: {
        id: 1,
        setup_crew: '{"drivers":[{"name":"A"}]}',
        dismantle_crew: '{"drivers":[{"name":"B"}]}',
        service_crew: '{"drivers":[{"name":"C"}]}',
        schedule_remark: "load at 6am",
        setup_start_at: "2026-07-15T08:00:00Z",
        dismantle_start_at: "2026-07-18T20:00:00Z",
      },
      checklist: [
        { id: 1, title: "Setup Image", section_id: 60, status: "done" },
        { id: 2, title: "Defect List", section_id: 60, status: "pending" },
        { id: 3, title: "3D Design", section_id: 20, status: "pending" },
      ],
      checklist_comments: [
        { id: 100, item_id: 1, body: "ok" },
        { id: 101, item_id: 3, body: "wip" },
      ],
      checklist_attachments: [
        { id: 200, item_id: 2 },
        { id: 201, item_id: 3 },
      ],
      sections: [
        { id: 60, name: "SETUP & DISMANTLE DOCUMENTS", sort_order: 60 },
        { id: 20, name: "3D APPROVAL", sort_order: 20 },
      ],
      section_progress: [
        { id: 60, name: "SETUP & DISMANTLE DOCUMENTS", total: 2, done: 1, na: 0, complete: 0 },
        { id: 20, name: "3D APPROVAL", total: 1, done: 0, na: 0, complete: 0 },
      ],
    };
    const out = stripSetupDismantle(detail);
    expect(out.project.setup_crew).toBe('{"drivers":[{"name":"A"}]}');
    expect(out.project.dismantle_crew).toBe('{"drivers":[{"name":"B"}]}');
    expect(out.project.service_crew).toBe('{"drivers":[{"name":"C"}]}');
    expect(out.project.schedule_remark).toBe("load at 6am");
    expect(out.project.setup_start_at).toBe("2026-07-15T08:00:00Z");
    expect(out.project.dismantle_start_at).toBe("2026-07-18T20:00:00Z");
    expect(out.checklist.map((r: any) => r.id)).toEqual([3]);
    expect(out.checklist_comments.map((r: any) => r.id)).toEqual([101]);
    expect(out.checklist_attachments.map((r: any) => r.id)).toEqual([201]);
    expect(out.sections.map((s: any) => s.id)).toEqual([20]);
    expect(out.section_progress.map((s: any) => s.id)).toEqual([20]);
  });

  test("no document section → the crew JSON still survives, and nothing else is touched", () => {
    const detail = {
      project: { id: 1, setup_crew: "{}", dismantle_crew: null, setup_start_at: "x", dismantle_start_at: null },
      checklist: [{ id: 3, title: "3D Design", section_id: 20, status: "pending" }],
      checklist_comments: [],
      checklist_attachments: [],
      sections: [{ id: 20, name: "3D APPROVAL", sort_order: 20 }],
      section_progress: [{ id: 20, total: 1, done: 0, na: 0, complete: 0 }],
    };
    const out = stripSetupDismantle(detail);
    expect(out.project.setup_crew).toBe("{}");
    expect(out.project.setup_start_at).toBe("x");
    // Non-setup checklist untouched.
    expect(out.checklist.map((r: any) => r.id)).toEqual([3]);
    expect(out.sections.map((s: any) => s.id)).toEqual([20]);
  });

  test("a SALES PIC document row stays on the wire even though it lives in the S&D section", () => {
    const detail = {
      project: { id: 1 },
      checklist: [
        { id: 1, title: "Setup Image", section_id: 60, role_label: "SALES PIC", status: "done" },
        { id: 2, title: "Loading List", section_id: 60, role_label: "DRIVER", status: "pending" },
      ],
      checklist_comments: [],
      checklist_attachments: [],
      sections: [{ id: 60, name: "SETUP & DISMANTLE DOCUMENTS", sort_order: 60 }],
      section_progress: [{ id: 60, total: 2, done: 1, na: 0, complete: 0 }],
    };
    const out = stripSetupDismantle(detail);
    expect(out.checklist.map((r: any) => r.id)).toEqual([1]);
    // The section survives because something under it survived.
    expect(out.sections.map((s: any) => s.id)).toEqual([60]);
  });
});
