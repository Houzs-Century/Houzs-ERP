// Project-detail (PMS) section-level access — port of the reference repo's
// src/lib/pms-access.ts, adapted to the production AuthUser + projects model.
//
// This layers ON TOP of the remaining gates:
//   1. the page matrix (projects.list) — can you open the project area at all
//   2. company scope — a project is only visible within its own company
// (The old PIC + brand row-level ACL was removed 2026-08-19: within a company,
//  any projects-permitted user sees every project.)
// pmsAccess then decides WHICH SECTIONS of a project's detail page render, and
// crucially hides the financial snapshot + rental amount from everyone except
// directors/finance. See docs/PERMISSION-MATRIX.md (PMS section table).
//
// PIC is a PER-PROJECT assignment (projects.pic_id === user.id), NOT a job
// title — a sales person is "PIC" only on the projects they're assigned to.

import type { AuthUser } from "./auth";

export type PmsRole =
  | "DIRECTOR" // owner/IT (*), Super Admin, Sales Director, Finance — full incl. financials
  | "PIC" // sales person who is this project's PIC — most of it, no financials
  | "SALES" // sales person who can see it but isn't the PIC
  | "PURCHASING"
  | "LOGISTIC"
  | "DRIVER" // Driver / Helper — use the driver portal, not this page
  | "OTHER" // Ops / HQ non-admin — view-only, no financials
  | "NONE";

export type PmsSection =
  | "EDIT"
  | "FINANCIAL" // sales / cost / profit snapshot
  | "RENTAL" // rental amount
  | "PAYMENT" // payment status / proof
  | "PROJECT_STAGE"
  | "PM_WORKFLOW"
  | "WF_SENSITIVE" // agreement/quotation + security deposit
  | "BOOTH_LAYOUT"
  | "SETUP_DISMANTLE"
  | "EXPO_MAP"
  | "EVENT_CHAT"
  | "INTEGRATIONS"
  | "ACTIONS"; // delete project

const SECTIONS_BY_ROLE: Record<PmsRole, PmsSection[]> = {
  DIRECTOR: [
    "EDIT", "FINANCIAL", "RENTAL", "PAYMENT", "PROJECT_STAGE", "PM_WORKFLOW", "WF_SENSITIVE",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT", "INTEGRATIONS", "ACTIONS",
  ],
  // Sales PIC: OPEN + VIEW the project, but read-only on the project itself
  // (no broad EDIT). They may still tick/attach the checklist/document items
  // badged for their own function — that runs through the per-item
  // required_perm / role_label gate, not this project-wide EDIT flag. Owner
  // rule 2026-07 (Sales-department visibility): finance / payment / rental /
  // quotation / agreement stay hidden (none of those sections listed here).
  // Owner rule 2026-07-17 (REVERSES the 2026-07-15 hide): Sales — including the
  // non-PIC Sales staff below — may VIEW Setup & Dismantle (crew per lorry +
  // dates) on mobile and laptop. SETUP_DISMANTLE is a VISIBILITY section only;
  // "EDIT" is still withheld from PIC/SALES, so they stay read-only on it.
  PIC: [
    "PROJECT_STAGE", "PM_WORKFLOW",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT", "INTEGRATIONS",
  ],
  LOGISTIC: [
    "EDIT", "PROJECT_STAGE", "PM_WORKFLOW",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "INTEGRATIONS",
  ],
  SALES: ["SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT"], // view-only S&D restored (owner 2026-07-17)
  PURCHASING: ["BOOTH_LAYOUT", "SETUP_DISMANTLE"],
  DRIVER: ["BOOTH_LAYOUT", "SETUP_DISMANTLE", "PM_WORKFLOW"],
  OTHER: [
    "PROJECT_STAGE", "PM_WORKFLOW",
    "BOOTH_LAYOUT", "SETUP_DISMANTLE", "EXPO_MAP", "EVENT_CHAT", "INTEGRATIONS",
  ],
  NONE: [],
};

// Lower-case + collapse internal whitespace + trim. Tolerant to casing/spacing
// drift ONLY — never to substring matching. Mirrors positionPolicy.normalisePosition
// and the FE salesAccess mirror so all three classify a name identically.
function normalisePosition(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Directors / finance — the only roles that see money on the project. Matched by
// EXACT normalised name. This WAS /\b(Super Admin|Sales Director|Finance Manager)\b/i:
// a word-boundary test whose convenience (catch "Test Sales Director") was an
// injection hole — any future free-text rename whose name merely CONTAINED a
// director title ("Assistant to Sales Director", "Deputy Finance Manager",
// "Senior Super Admin") silently inherited FULL director access. Position names
// are owner-editable free text, so a substring match turns a rename into a
// privilege grant. The three names below are the live prod positions
// (positionAccessSnapshot.ts) — a rename TO one of them still grants; a new
// position that only contains the words does not. Keep FE auth/salesAccess.ts
// DIRECTOR_POSITION_NAMES in lockstep (pinned by pmsAccess/salesAccess tests).
const DIRECTOR_POSITION_NAMES: ReadonlySet<string> = new Set(
  ["Super Admin", "Sales Director", "Finance Manager"].map(normalisePosition),
);

function isDirectorPositionName(name: string | null | undefined): boolean {
  return DIRECTOR_POSITION_NAMES.has(normalisePosition(name));
}

// The EXACT "Sales Director" position — the signal for the department-scoped
// Team admin grant (owner 2026-07: a Sales Director manages ONLY his own
// department's members/org-chart/departments + Sales mailboxes, WITHOUT full
// users.manage). Matched by EXACT normalised name so ONLY "Sales Director"
// qualifies — this WAS /\bSales Director\b/i, whose comment already CLAIMED it
// was anchored while the regex actually matched any name CONTAINING "Sales
// Director" ("Assistant to Sales Director" would have been handed the scoped
// admin). Deliberately narrower than isDirectorUser (which also admits Super
// Admin / Finance Manager, both already full admins). Single source of truth the
// users / departments / mail-center routes share; keep FE in lockstep.
const SALES_DIRECTOR_POSITION_NAMES: ReadonlySet<string> = new Set(
  ["Sales Director"].map(normalisePosition),
);

/**
 * True ONLY for the "Sales Director" position (exact, case-insensitive).
 * Drives the department-scoped Team-admin grant — do NOT confuse with
 * isDirectorUser (broader: Super Admin / Sales Director / Finance Manager /
 * `*`). A Sales Director is NOT a full admin; the routes ADD a
 * department-scoped admittance for them on top of the existing users.manage /
 * users.read gates and NEVER widen it to global.
 */
export function isSalesDirectorUser(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  return SALES_DIRECTOR_POSITION_NAMES.has(normalisePosition(user.position_name));
}

// Sales staff — a position whose title starts with "sales" (Sales Executive,
// Sales Coordinator, Salesperson, Sales-Executive, …) OR membership of the Sales
// department. Prod names the department "Sales Department" while the seed is
// "Sales", so match any dept name containing "sales" (same rule
// salesTeam.syncSalesRepFromUser uses). Aligned with the FE salesAccess.ts
// (/^sales/i) — the old /^Sales /i required a trailing space and so missed
// "Salesperson" / "Sales-Executive", disagreeing with the frontend.
const SALES_POSITION = /^sales/i;

/**
 * True when the user is Sales staff by STABLE ORG FIELDS — position_name
 * "Sales …" OR their department name contains "sales". Deliberately keyed off
 * org fields (not the configurable permission matrix) per the owner's
 * code-keyed Sales access model. Note: "Sales Director" also matches here, but
 * every caller resolves the DIRECTOR / view-all tier FIRST (isDirectorUser /
 * canViewAllSales), which supersedes the scoped Sales tier — so a Sales Director
 * is never held to the self+downline Sales scope.
 */
export function isSalesUser(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  const pos = (user.position_name ?? "").trim();
  if (SALES_POSITION.test(pos)) return true;
  const dept = (user.department_name ?? "").trim().toLowerCase();
  return dept.includes("sales");
}

/**
 * True for the DIRECTOR tier that sees ALL data — Owner / IT Admin (`*`
 * wildcard) or a director/finance position (Super Admin, Sales Director,
 * Finance Manager). Same definition getPmsRole() uses for its DIRECTOR role,
 * exposed standalone so the SO / Service-Case scope gates can share one source
 * of truth without constructing a ProjectLike.
 */
export function isDirectorUser(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (user.permissions_set?.has("*")) return true;
  return isDirectorPositionName(user.position_name);
}

// The purchasing function — product COST visibility. Matched by EXACT normalised
// name. This WAS /\bPurchasing\b/i, a word-boundary test that also matched any
// future "…Purchasing…" rename (e.g. "Purchasing Assistant") and silently handed
// it SKU cost. The live prod position is "Procurement/Purchasing"
// (positionAccessSnapshot.ts id 13); "Purchasing" is retained as a DOCUMENTED
// alias for the pre-rename name so a partial revert never silently drops cost
// access. BE-only: the FE reads the product_cost_viewer flag off /auth/me, so
// there is no FE mirror to keep for this one.
const PURCHASING_POSITION_NAMES: ReadonlySet<string> = new Set(
  ["Procurement/Purchasing", "Purchasing"].map(normalisePosition),
);

/**
 * "May this user see a product / SKU COST price."
 *
 * Owner 2026-07-17, shown that his 2026-06-13 red line was not in force:
 *   "那就是采购、Finance，还有 Sales Director 啊？"
 * — restoring 2026-06-13 "Only Purchasing + Finance see cost". Purchasing had
 * simply been lost: the cost question was being answered by isFinanceViewer,
 * whose cohort has no Purchasing in it. This is a RESTORATION, not a new grant.
 *
 * Deliberately its own function rather than a widening of DIRECTOR_POSITION_NAMES /
 * isFinanceViewer. Those answer a DIFFERENT question — "are you a PMS director",
 * i.e. may you see a project's financial snapshot, rental, payment and cost
 * rates. Adding Purchasing there would hand him every project's P&L (SECTIONS_BY_ROLE
 * .DIRECTOR) and make him isDirectorUser, which feeds the sales-scope gates and
 * the nav flags. The owner asked for cost, and only cost. Two questions, two
 * functions.
 *
 * Composed off isDirectorUser rather than restating its list, so the `*`
 * wildcard and any future rename of a director title stay in ONE place. The
 * cohort is therefore a strict SUPERSET of the director cohort: director + the
 * purchasing function. Nothing here can narrow what a director already sees.
 */
export function isProductCostViewer(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (isDirectorUser(user)) return true;
  return PURCHASING_POSITION_NAMES.has(normalisePosition(user.position_name));
}

export interface ProjectLike {
  pic_id: number | null;
  created_by?: number | null;
}

export function getPmsRole(user: AuthUser | null | undefined, project: ProjectLike): PmsRole {
  if (!user) return "NONE";
  const pos = (user.position_name ?? "").trim();

  // Wildcard (Owner / IT Admin) or a director/finance position → full.
  if (user.permissions_set?.has("*") || isDirectorPositionName(pos)) return "DIRECTOR";

  if (/^(Driver|Helper)$/i.test(pos)) return "DRIVER";
  if (/^Purchasing$/i.test(pos)) return "PURCHASING";
  if (/^Logistics?$/i.test(pos)) return "LOGISTIC";

  // Sales staff are assignment-gated: PIC of this project vs merely able to see it.
  if (/^Sales /i.test(pos)) {
    if (project.pic_id != null && project.pic_id === user.id) return "PIC";
    return "SALES";
  }

  // Ops / HQ non-admin who can open the project → view-only, no financials.
  return "OTHER";
}

export interface PmsAccess {
  role: PmsRole;
  canOpen: boolean;
  canEdit: boolean;
  canFinancial: boolean;
  canRental: boolean;
  /** Payment status / proof (mig 090 rental-payment pill). */
  canPayment: boolean;
  /** Agreement / quotation / security deposit (WF_SENSITIVE). */
  canSensitive: boolean;
  /** Setup & Dismantle (logistics crew-per-lorry editor + the "SETUP &
   *  DISMANTLE DOCUMENTS" checklist rows). Owner 2026-07-15: hidden from
   *  every non-director Sales user, even the project's own PIC. Directors /
   *  Logistics / Drivers / Purchasing keep it. */
  canSetupDismantle: boolean;
  sections: PmsSection[];
}

export function getPmsAccess(user: AuthUser | null | undefined, project: ProjectLike): PmsAccess {
  const role = getPmsRole(user, project);
  const sections = SECTIONS_BY_ROLE[role];
  // Granular WF_SENSITIVE grant (owner 2026-07-29): a non-director role that
  // holds `agreement.approve` (e.g. BD Exec) must SEE the Agreement / Quotation
  // — it is the very item they approve, so hiding it strips the whole CONTRACT
  // section from them. Mirrors the isFinanceViewer `projects.finance.view`
  // precedent: additive, directors still qualify via the role sections, and it
  // never widens the director cohort or its view-all / sales-scope side effects.
  const canSensitive =
    sections.includes("WF_SENSITIVE") || !!user?.permissions_set?.has("agreement.approve");
  // Granular EDIT grant (owner 2026-07-29, "open edit for BD"): a non-director
  // role holding `projects.manage` (BD Exec, IT Admin) may EDIT the project
  // detail. Gated on `projects.manage` — NOT `projects.write` — precisely so the
  // 32 Sales Person users (who hold projects.write but must stay read-only on
  // the project per the Sales-PIC rule) are unaffected. Directors/Logistic keep
  // EDIT via their role sections; this only newly admits the management tier.
  const canEdit =
    sections.includes("EDIT") || !!user?.permissions_set?.has("projects.manage");
  /* Granular FINANCIAL grant — the same additive shape as canSensitive and
     canEdit above, and it was the one missing. `projects.finance.view` has
     existed since 2026-07-23 for exactly this ("a specific non-director role
     may be given finance-view explicitly, e.g. the BD role"), isFinanceViewer
     honours it, and the BD Exec role HOLDS it — but this flag read the section
     list alone, so the project-detail GET stripped `finance` + `finance_lines`
     from a user the system had already granted finance view. A permission that
     three of its four readers ignore is not a permission.

     The damage was not a blank panel. QuickRentalField decides between PATCH
     and CREATE by counting the rental lines it can SEE, so a holder of this
     permission typed a rental, got an empty box back, retyped — and booked a
     duplicate line every time: 12 lines on one project, a rental box reading
     201,195 for an event whose rental was 18,126 (owner, 2026-09-04, "why
     since yesterday i key in rental amount suddenly auto deleted"). */
  const canFinancial =
    sections.includes("FINANCIAL") || !!user?.permissions_set?.has("projects.finance.view");
  return {
    role,
    canOpen: role !== "NONE",
    canEdit,
    canFinancial,
    canRental: sections.includes("RENTAL"),
    canPayment: sections.includes("PAYMENT"),
    canSensitive,
    canSetupDismantle: sections.includes("SETUP_DISMANTLE"),
    sections,
  };
}

/**
 * The project-checklist rows governed by WF_SENSITIVE — quotation /
 * agreement. Identified by their template title (mig 066). A position
 * whose PMS role lacks WF_SENSITIVE (getPmsAccess().canSensitive === false)
 * must not receive these rows in the project-detail payload or the print
 * debrief; they are stripped server-side, the same way finance / payment
 * are (rule 5, owner 2026-07). Security Deposit is deliberately NOT
 * included — the owner rule hides quotation & agreement only.
 */
export const SENSITIVE_CHECKLIST_TITLES: ReadonlySet<string> = new Set([
  "Agreement / Quotation",
]);

/** True when a checklist row is one of the WF_SENSITIVE (quotation/agreement) items. */
export function isSensitiveChecklistItem(
  item: { title?: string | null } | null | undefined,
): boolean {
  return !!item && SENSITIVE_CHECKLIST_TITLES.has((item.title ?? "").trim());
}

/**
 * The project-checklist section(s) governed by SETUP_DISMANTLE — the
 * "SETUP & DISMANTLE DOCUMENTS" template section (mig 066: Setup Image,
 * Defect List, Exchange List, Event Complete Image, Dismantle Image, …). A
 * position whose PMS role lacks SETUP_DISMANTLE (getPmsAccess().canSetupDismantle
 * === false) must not receive those rows — nor the setup/dismantle crew JSON —
 * in the project-detail payload; they are stripped server-side, the same way
 * finance / payment / WF_SENSITIVE are (owner 2026-07-15). Matched by the
 * cloned section NAME (case-insensitive), the stable identity that survives the
 * per-project template clone.
 */
export const SETUP_DISMANTLE_SECTION_NAMES: ReadonlySet<string> = new Set([
  "setup & dismantle documents",
]);

/** True when a checklist SECTION is the SETUP_DISMANTLE (documents) section. */
export function isSetupDismantleSection(
  section: { name?: string | null } | null | undefined,
): boolean {
  return (
    !!section &&
    SETUP_DISMANTLE_SECTION_NAMES.has((section.name ?? "").trim().toLowerCase())
  );
}

/**
 * Project-independent "may this user see money at all?" gate, for the
 * finance ledger / payment / analytics / print endpoints that aren't tied
 * to one project's PIC. True only for DIRECTOR-level positions (Owner/IT
 * `*`, Super Admin, Sales Director, Finance Manager). This is the single
 * source of truth the routes and the /me finance-viewer flag both call.
 */
export function isFinanceViewer(user: AuthUser | null | undefined): boolean {
  // Granular grant (owner 2026-07-23): a specific non-director role may be given
  // finance-view explicitly via the `projects.finance.view` permission (e.g. the
  // BD role), WITHOUT widening the DIRECTOR cohort or its view-all / sales-scope
  // side effects. Additive — directors still qualify below; only role-holders of
  // this exact permission are newly admitted. Cost (isProductCostViewer) is a
  // separate gate and is unaffected.
  if (user?.permissions_set?.has("projects.finance.view")) return true;
  return getPmsRole(user, { pic_id: null }) === "DIRECTOR";
}

/**
 * True when finance / payment must be WITHHELD from this user on the wire.
 * Mirrors the detail-GET rule: enforced only once the user has a position
 * assigned (un-migrated users keep legacy access so the rollout doesn't
 * suddenly lock out current finance/director users before positions are
 * seeded), and true for everyone whose role isn't DIRECTOR.
 */
export function financeHiddenForUser(user: AuthUser | null | undefined): boolean {
  if (!user || user.position_id == null) return false;
  return !isFinanceViewer(user);
}
