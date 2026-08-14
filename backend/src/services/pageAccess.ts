/**
 * Per-page access model — page catalogue + helpers.
 *
 * Each page has a per-role access entry in `role_page_access`:
 * one of 'none' / 'partial' / 'full'. The `*` wildcard on a role
 * short-circuits the matrix lookup ('full' on every page).
 *
 * Pages with sub-tabs (Projects, Team, Logistics, ASSR, Orders) are
 * modelled as a parent page plus child sub-page entries. The parent's
 * level cascades to children:
 *   parent = "full"    → all children granted at full
 *   parent = "none"    → all children denied
 *   parent = "partial" → child rows take effect; admins pick per child
 *
 * The flattening happens in `loadPageAccessForRole`. Consumers read
 * the flat map `user.page_access` keyed by the leaf page_key
 * (e.g. `projects.calendar`).
 *
 * Phase 1 of the rollout (Sales pilot) shipped. Sub-page splitting
 * shipped 2026-05-12 — Projects' 4 top-level views are wired through
 * `requirePageAccess(...)`; other parents have catalogue entries but
 * their tab-level UI gating lands in follow-up slices.
 */

import type { Env } from "../types";

// Two vocabularies share one union. The legacy ROLE matrix (role_page_access)
// is 3-level: none/partial/full. The POSITION matrix (position_page_access) is
// 4-level: none/view/edit/full. 'partial' is kept and ranked equal to 'view'
// (rank 1) so both coexist in one page_access map + one meetsLevel comparator
// with NO migration of existing role rows.
export type AccessLevel = "none" | "partial" | "view" | "edit" | "full";

// Writable level set for the ROLE editor (unchanged — 3-level).
export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "partial", "full"] as const;
// Writable level set for the POSITION editor (4-level).
export const POSITION_ACCESS_LEVELS: readonly AccessLevel[] = ["none", "view", "edit", "full"] as const;

export interface PageDef {
  /** Stable identifier stored in `role_page_access.page_key`.
   *  Sub-pages use dotted form `<parent>.<leaf>` (e.g. `projects.calendar`). */
  key: string;
  /** Human label for the admin UI. */
  label: string;
  /** Short description of what "partial" means for this page —
   *  rendered as a tooltip on the Partial radio in the admin UI. */
  partialMeaning: string;
  /** Whether the partial level is a meaningful state for this page.
   *  Settings and Sales Team Maintenance, for example, are full-or-
   *  none. The admin UI hides the Partial radio when this is false. */
  supportsPartial: boolean;
  /** If set, this page is a sub-page of `parent`. The parent's level
   *  cascades to children (full → all children full; none → all
   *  children none; partial → per-child config). */
  parent?: string;
  /** One-shot backfill rule: given a role's permission set, decide
   *  the level. Used by `scripts/backfill-role-page-access.mjs`
   *  and as a fallback when no explicit matrix row exists yet. */
  backfill: (perms: ReadonlySet<string>) => AccessLevel;
}

const has = (perms: ReadonlySet<string>, ...keys: string[]): boolean =>
  keys.some((k) => perms.has(k));

const isOwner = (perms: ReadonlySet<string>): boolean => perms.has("*");

// ── Backfill helpers — replaces `projects.read/write/manage` etc. into
//    a level estimation per sub-page. Used by the admin UI's "computed"
//    defaults and by `computeBackfillLevel` on first session load.
const projectsBackfill = (p: ReadonlySet<string>): AccessLevel =>
  isOwner(p) || has(p, "projects.manage")
    ? "full"
    : has(p, "projects.write", "projects.read", "projects.chat", "projects.checklist.tick")
      ? "partial"
      : "none";

const teamBackfill = (p: ReadonlySet<string>): AccessLevel =>
  isOwner(p) || has(p, "users.manage", "roles.manage")
    ? "full"
    : has(p, "users.read", "roles.read")
      ? "partial"
      : "none";

const serviceCasesBackfill = (p: ReadonlySet<string>): AccessLevel =>
  isOwner(p) || has(p, "service_cases.manage")
    ? "full"
    : has(p, "service_cases.read", "service_cases.write")
      ? "partial"
      : "none";

export const PAGES: PageDef[] = [
  // ── Standalone pages (no sub-tabs) ──────────────────────────
  {
    key: "sales",
    label: "Sales Entries",
    partialMeaning: "See and edit only your own entries; cannot manage, void, or push.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "sales.manage")
        ? "full"
        : has(p, "sales.write", "sales.read")
          ? "partial"
          : "none",
  },
  {
    key: "settings",
    label: "System Settings",
    partialMeaning: "(not used for this page)",
    supportsPartial: false,
    backfill: (p) => (isOwner(p) || has(p, "settings.manage") ? "full" : "none"),
  },

  // ── Service Cases / ASSR (parent + sub-tabs) ────────────────
  {
    key: "service_cases",
    label: "ASSR / Service Cases",
    partialMeaning: "Pick which ASSR sub-tabs this role can access.",
    supportsPartial: true,
    backfill: serviceCasesBackfill,
  },
  {
    key: "service_cases.cases",
    parent: "service_cases",
    label: "Cases list",
    partialMeaning: "View + edit assigned cases; cannot triage.",
    supportsPartial: true,
    backfill: serviceCasesBackfill,
  },
  {
    key: "service_cases.by_creditor",
    parent: "service_cases",
    label: "Cases by Creditor",
    partialMeaning: "View only.",
    supportsPartial: true,
    backfill: serviceCasesBackfill,
  },
  {
    key: "service_cases.metrics",
    parent: "service_cases",
    label: "Metrics",
    partialMeaning: "View only.",
    supportsPartial: true,
    backfill: serviceCasesBackfill,
  },
  {
    key: "service_cases.pnl",
    parent: "service_cases",
    label: "P&L",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "service_cases.manage") ? "full" : "none",
  },
  {
    key: "service_cases.settings",
    parent: "service_cases",
    label: "Settings",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "service_cases.manage") ? "full" : "none",
  },

  // ── Projects (parent + sub-tabs) — wired end-to-end ─────────
  {
    key: "projects",
    label: "Projects",
    partialMeaning: "Pick which Projects sub-tabs this role can access.",
    supportsPartial: true,
    backfill: projectsBackfill,
  },
  {
    key: "projects.list",
    parent: "projects",
    label: "List + project detail",
    partialMeaning: "PIC + brand row-filter applies; limited project detail view.",
    supportsPartial: true,
    backfill: projectsBackfill,
  },
  {
    key: "projects.calendar",
    parent: "projects",
    label: "Calendar",
    partialMeaning: "Read-only calendar view; same PIC + brand row-filter.",
    supportsPartial: true,
    backfill: projectsBackfill,
  },
  {
    key: "projects.finances",
    parent: "projects",
    label: "Finances (list / analytics / P&L)",
    partialMeaning: "Limited finance view; ledger locked, cost columns hidden.",
    supportsPartial: true,
    backfill: projectsBackfill,
  },
  {
    key: "projects.maintenance",
    parent: "projects",
    label: "Maintenance (brands / event types / templates / cost rates)",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "projects.manage") ? "full" : "none",
  },

  // ── Team (parent + sub-tabs) ────────────────────────────────
  {
    key: "team",
    label: "Team",
    partialMeaning: "Pick which Team sub-tabs this role can access.",
    supportsPartial: true,
    backfill: teamBackfill,
  },
  {
    key: "team.members",
    parent: "team",
    label: "Members",
    partialMeaning: "View list; cannot invite, edit, or disable.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "users.manage")
        ? "full"
        : has(p, "users.read")
          ? "partial"
          : "none",
  },
  {
    key: "team.roles",
    parent: "team",
    label: "Roles",
    partialMeaning: "View roles; cannot edit permissions or page access.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "roles.manage")
        ? "full"
        : has(p, "roles.read")
          ? "partial"
          : "none",
  },
  {
    key: "team.org_chart",
    parent: "team",
    label: "Org chart",
    partialMeaning: "View only.",
    supportsPartial: true,
    backfill: (p) =>
      isOwner(p) || has(p, "users.manage")
        ? "full"
        : has(p, "users.read")
          ? "partial"
          : "none",
  },
  {
    key: "team.departments",
    parent: "team",
    label: "Departments",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) =>
      isOwner(p) || has(p, "users.manage") ? "full" : "none",
  },

  // ── Supply Chain (parent + area children) ───────────────────
  // ADDITIVE per-position gating for the ported 2990 SCM. These page
  // keys only GRANT access to a position explicitly given them in the
  // matrix; they NEVER remove the existing access path. SCM is still
  // unconditionally unlocked by the `*` wildcard and the `scm.access`
  // permission at the /api/scm/* gate (index.ts) + the frontend nav /
  // route guards — those checks are ORed with these page keys, so no
  // current SCM user loses access. A position with no SCM row resolves
  // to "none" here (safe default) and falls back to whatever permission
  // path it already had. Backfill is owner-only (the role matrix relies
  // on scm.access, NOT on these keys), so legacy roles are unaffected.
  {
    key: "scm",
    label: "Supply Chain Management",
    partialMeaning: "Pick which Supply Chain areas this position can access.",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  // ── L1 areas (parents of the L2 sub-pages below). Each L1 area is itself
  //    a child of `scm` and a parent to its own per-sub-page L2 keys. Setting
  //    an L1 area = full grants its whole sub-tree (inherit, pass-2 of
  //    loadPageAccessForPosition); overriding a single L2 child to "none"
  //    hides just that one sub-page. Every L2 key defaults to "none" + inherits
  //    its L1 parent, and backfill stays owner-only — so this is purely
  //    additive: no current SCM user (via `*` / `scm.access`) loses access.
  {
    key: "scm.sales",
    parent: "scm",
    label: "Sales",
    partialMeaning: "View the sales-side documents; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.sales.orders",
    parent: "scm.sales",
    label: "Sales Orders",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.sales.delivery",
    parent: "scm.sales",
    label: "Delivery Orders",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.sales.invoices",
    parent: "scm.sales",
    label: "Sales Invoices",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.sales.returns",
    parent: "scm.sales",
    label: "Delivery Returns",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.procurement",
    parent: "scm",
    label: "Procurement",
    partialMeaning: "View the procurement-side documents; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.procurement.products",
    parent: "scm.procurement",
    label: "Products & Maintenance",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.procurement.suppliers",
    parent: "scm.procurement",
    label: "Suppliers",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.procurement.mrp",
    parent: "scm.procurement",
    label: "MRP · Stock Status",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.procurement.po",
    parent: "scm.procurement",
    label: "Purchase Orders",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.procurement.grn",
    parent: "scm.procurement",
    label: "Goods Receipt",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.procurement.pi",
    parent: "scm.procurement",
    label: "Purchase Invoices",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.procurement.pr",
    parent: "scm.procurement",
    label: "Purchase Returns",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.consignment",
    parent: "scm",
    label: "Consignment",
    partialMeaning: "View the consignment documents; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.consignment.orders",
    parent: "scm.consignment",
    label: "Consignment Order",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.consignment.notes",
    parent: "scm.consignment",
    label: "Consignment Note",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.consignment.returns",
    parent: "scm.consignment",
    label: "Consignment Return",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.consignment.po_orders",
    parent: "scm.consignment",
    label: "Purchase Consignment Order",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.consignment.po_receives",
    parent: "scm.consignment",
    label: "Purchase Consignment Receive",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.consignment.po_returns",
    parent: "scm.consignment",
    label: "Purchase Consignment Return",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.transportation",
    parent: "scm",
    label: "Transportation",
    partialMeaning: "View the transportation pages; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.transportation.drivers",
    parent: "scm.transportation",
    label: "Drivers",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.warehouse",
    parent: "scm",
    label: "Warehouse",
    partialMeaning: "View the warehouse pages; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    // Inventory L2 also covers the Stock Card drill-down + the Warehouses
    // master (both live under the Warehouse nav group, no finer nav split).
    key: "scm.warehouse.inventory",
    parent: "scm.warehouse",
    label: "Inventory",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    // Stock ADJUSTMENT — split OFF Inventory because adjusting changes stock
    // valuation. view = open the adjustment page; edit = perform an adjustment
    // (POST /inventory/adjustments, its own guard in scm/index.ts).
    key: "scm.warehouse.adjustments",
    parent: "scm.warehouse",
    label: "Adjustments",
    partialMeaning: "View the adjustment page; edit to perform adjustments.",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.warehouse.transfers",
    parent: "scm.warehouse",
    label: "Transfers",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.warehouse.stock_take",
    parent: "scm.warehouse",
    label: "Stock Take",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.finance",
    parent: "scm",
    label: "Finance",
    partialMeaning: "View the SCM finance pages; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.finance.accounting",
    parent: "scm.finance",
    label: "Accounting",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
  {
    key: "scm.finance.outstanding",
    parent: "scm.finance",
    label: "Outstanding",
    partialMeaning: "View only; write gating is per-route (later).",
    supportsPartial: true,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },

  // ── System Health (infra health + org-wide audit trail) ─────
  // High-privilege admin page (was Owner-only). Now configurable per position
  // so an IT/ops position can be granted it; default stays Owner-only via the
  // backfill (no role row → only `*` resolves to full).
  {
    key: "system_health",
    label: "System Health",
    partialMeaning: "(not used; full or none)",
    supportsPartial: false,
    backfill: (p) => (isOwner(p) ? "full" : "none"),
  },
];

const PAGE_KEYS = new Set(PAGES.map((p) => p.key));

export function isValidPageKey(key: string): boolean {
  return PAGE_KEYS.has(key);
}

/**
 * RETIRED KEYS — keys that were once in PAGES[] and have since left it.
 *
 * WHY THIS LIST EXISTS. Deleting a key from PAGES[] does not delete the rows
 * keyed on it. `position_page_access` / `role_page_access` keep them, and both
 * resolvers filter every row through `isValidPageKey` — so the row survives,
 * stops being read, and grants nothing. Nobody is told. The admin's saved
 * configuration silently stops corresponding to anything.
 *
 * That is not hypothetical. On 2026-06-13 the owner set "money pages: Finance
 * only" in Team > Positions and saved it correctly. On 2026-06-18 commit
 * 6e59f071 ("chore: remove inert dead code left by the strip-to-core cutover")
 * pruned 14 keys out of PAGES[] as part of a cleanup. Six of them were his:
 * `overview`, `petty_cash`, `orders`, `orders.balance`, `orders.overdue`,
 * `orders.pnl`. His rows were never touched — they just stopped corresponding
 * to a catalogue entry. They are still in prod, still inert, and they are the
 * record of a rule he believes is in force. The editor cannot have caused this:
 * both PATCH endpoints 400 on an unknown page_key (positions.ts:549,
 * roles.ts:281), so an orphan is never an honest save gone wrong — it is always
 * the catalogue moving out from under one.
 *
 * WHAT GOES IN HERE. Any key removed from PAGES[]. `pageCatalogueDrift.test.ts`
 * pins the union of PAGES[] and this list, so a deletion fails CI until the key
 * is named here — which is the point: the failure is the notice nobody got in
 * June. When you add one, say what happened to the rows.
 *
 * THIS IS NOT DORMANT_PAGE_KEYS, and the two must not be conflated:
 *   dormant = the key IS in PAGES[]; it is settable and read by nothing.
 *             The row renders greyed. Fix = wire it, or leave it greyed.
 *   retired = the key is NOT in PAGES[]; rows may still exist and are inert.
 *             There is no cell to render. Fix = migrate the rows, or accept
 *             that they are dead and record why here.
 *
 * INERT BY CONSTRUCTION. Nothing reads this at resolve time and nothing may
 * start: `isValidPageKey` must keep returning false for every key here, or the
 * orphan rows would come back to life and silently change who can see what.
 * `pageCatalogueDrift.test.ts` pins that inertness rather than trusting it.
 */
export const RETIRED_PAGE_KEYS: ReadonlySet<string> = new Set([
  // All 14 removed by 6e59f071 on 2026-06-18. The six marked (orphan) are the
  // ones the owner had saved rows for — verified against the prod photograph in
  // positionAccessSnapshot.ts, which counts exactly these six and no others.
  "delivery_orders",
  "logistics",
  "logistics.fleet",
  "logistics.trips",
  "orders", // (orphan) Finance Manager = view
  "orders.balance", // (orphan) Finance Manager = view
  "orders.overdue", // (orphan) Finance Manager = view
  "orders.pnl", // (orphan) Finance Manager = full
  "orders.sales_orders",
  "overview", // (orphan) Finance Manager = full
  "petty_cash", // (orphan) Finance Manager = view
  "purchase_orders",
  "sales_team",
  "sales_team_maintenance",
]);

export function isRetiredPageKey(key: string): boolean {
  return RETIRED_PAGE_KEYS.has(key);
}

/**
 * DORMANT KEYS — declared here, settable in Team > Positions, and read by
 * NOTHING. Setting one has never done anything, and the UI said "Saved" every
 * time. This is the literal, countable form of the owner's standing complaint
 * "那個設定很多都設定不到", and his ruling on it (2026-07-17) is:
 *   "不能留着了，然后「頁面灰色」点不到吗？最重要是我要它的 UI"
 * — stop pretending they work, grey them out, and KEEP the row: he wants the
 * visual inventory of what the system is MEANT to have. So this list drives a
 * disabled control in the editor, and nothing else.
 *
 * IT CHANGES NO RESOLUTION. `loadPageAccessForRole` / `loadPageAccessForPosition`
 * do not read it; a dormant key still hydrates, still cascades, still resolves to
 * exactly what it resolved to yesterday. It has to be that way — a dormant key
 * may already carry a `= none` row (the seed writes three: hr_manager's
 * `team.roles` + `team.departments`, seed-user-management.mjs:71), and the moment
 * anything READS these keys that row starts 403-ing someone on the Monday after.
 * Greying the editor is the safe half of the ruling; WIRING them is his call and
 * needs his export first.
 *
 * HOW THIS LIST WAS DERIVED, so the next reader re-checks instead of trusting:
 * every `PAGES[].key` grepped across frontend/src + backend/src for a consumer
 * outside this file and positionAccessSnapshot.ts — `<PageGuard page="X">`,
 * `requirePageAccess("X")`, `usePageAccess("X")`, `scmAreaGuard("X")`,
 * `page_access["X"]`, or the key as a literal in any gate. No dynamic key
 * construction exists anywhere (re-verified 2026-07-17 — every lookup helper
 * takes a string and every call site passes a literal), so a literal grep is
 * exhaustive rather than merely suggestive.
 *
 * `team.members` IS THE SEVENTH, and `feat/jd-rules-from-record` counted six.
 * It was missed because the Team nav LOOKS wired: Sidebar.tsx renders
 * /team?tab=members, but that entry gates on `pageAccess: "team"` — the PARENT —
 * plus a flat `users.read`. All four `team.*` children are read by nothing; the
 * tab strip inside Team.tsx calls no page-access hook at all. Same evidence
 * profile as `team.roles` and `team.departments`: catalogue + seed writer + docs,
 * zero gates. If those two are dead, this one is dead by the same test.
 */
// `scm.warehouse.adjustments` WAS the eighth dormant key, greyed when stock
// ADJUSTMENT writes were fused onto `scm.warehouse.inventory`. The owner has now
// split the two apart (viewing inventory vs. adjusting it — the latter changes
// valuation), so this key is LIVE again: POST /inventory/adjustments is gated on
// it by a real `scmAreaGuard('scm.warehouse.adjustments')` (its own sub-mount in
// scm/index.ts), and the FE nav + /scm/stock-adjustments routes gate on it
// (Sidebar.tsx / App.tsx). It is therefore no longer dormant. The Finance Manager
// snapshot row's stored `view` now means "may open the adjustment page, but the
// write still needs edit" — identical to the fused inventory-era behaviour (view
// could not POST).
export const DORMANT_PAGE_KEYS: ReadonlySet<string> = new Set([
  "service_cases.by_creditor",
  "service_cases.pnl",
  "service_cases.settings",
  "team.members",
  "team.roles",
  "team.org_chart",
  "team.departments",
]);

export function isDormantPageKey(key: string): boolean {
  return DORMANT_PAGE_KEYS.has(key);
}

export function getPageDef(key: string): PageDef | null {
  return PAGES.find((p) => p.key === key) ?? null;
}

export function isValidAccessLevel(level: string): level is AccessLevel {
  return (
    level === "none" ||
    level === "partial" ||
    level === "view" ||
    level === "edit" ||
    level === "full"
  );
}

/** Validator for POSITION matrix writes (4-level; rejects legacy 'partial'). */
export function isValidPositionLevel(level: string): boolean {
  return level === "none" || level === "view" || level === "edit" || level === "full";
}

/**
 * Numeric ordering for comparing access levels. Higher = more access.
 * `none` < `partial` < `full`. Used by `requirePageAccess` to decide
 * if a user's level satisfies a route's minimum.
 */
export function levelRank(level: AccessLevel): number {
  switch (level) {
    case "full":
      return 3;
    case "edit":
      return 2;
    case "view":
      return 1;
    case "partial":
      return 1; // legacy alias of view (role matrix)
    default:
      return 0; // none
  }
}

export function meetsLevel(actual: AccessLevel, required: AccessLevel): boolean {
  return levelRank(actual) >= levelRank(required);
}

/**
 * Synchronous "everything full" map — used for the service user and
 * any wildcard-permission caller that doesn't go through D1.
 */
export function fullAccessMap(): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  for (const p of PAGES) out[p.key] = "full";
  return out;
}

/**
 * Compute the backfill level for a role on a specific page, given
 * the role's permission set. Used by:
 *   - the one-shot backfill script (writes a row per role × page)
 *   - the `loadPageAccessForRole` fallback when no explicit row exists
 */
export function computeBackfillLevel(
  pageKey: string,
  perms: ReadonlySet<string>,
): AccessLevel {
  const def = getPageDef(pageKey);
  if (!def) return "none";
  return def.backfill(perms);
}

/**
 * Hydrate a role's full page-access map. Reads `role_page_access`
 * for explicit rows; falls back to `computeBackfillLevel` for any
 * page the role doesn't yet have an explicit row for.
 *
 * Parent-child cascade rules applied after the raw read:
 *   - parent = "full"    → all sub-pages forced to "full" in the result
 *   - parent = "none"    → all sub-pages forced to "none"
 *   - parent = "partial" → each sub-page uses its own explicit row or
 *                          backfill (whatever the raw read produced)
 *
 * Called once per session bootstrap from `hydrateAuthUser`. The
 * returned record is attached to `AuthUser.page_access` and read
 * directly by `requirePageAccess` and the frontend `usePageAccess`
 * hook — no D1 round-trip on the hot path.
 */
/**
 * Optional out-parameter for the loaders below. Lets `hydrateAuthUser`
 * learn — from the SAME source it hydrates page_access from (role vs
 * position) — whether the user has ANY explicit `scm*` page-access row
 * (vs the default "none"). This drives the SAFE L2 SCM write-gate rollout
 * in `scmAreaGuard`: a user with NO explicit SCM config falls back to the
 * coarse `scm.access` umbrella (allow), and only users WITH explicit SCM
 * rows get the per-area enforcement. Populated in-place during the
 * explicit-row scan, so no extra DB round-trip. Existing callers that
 * don't care simply omit it.
 */
export interface PageAccessMeta {
  /** True iff at least one explicit row had a page_key starting with "scm". */
  explicitScm: boolean;
}

export async function loadPageAccessForRole(
  env: Env,
  roleId: number,
  rolePerms: ReadonlySet<string>,
  meta?: PageAccessMeta,
): Promise<Record<string, AccessLevel>> {
  // Wildcard short-circuits — Owner / IT Admin always see 'full'.
  if (rolePerms.has("*")) {
    return fullAccessMap();
  }

  const rows = await env.DB.prepare(
    `SELECT page_key, level FROM role_page_access WHERE role_id = ?`,
  )
    .bind(roleId)
    .all<{ page_key: string; level: string }>();

  const explicit: Record<string, AccessLevel> = {};
  for (const r of rows.results ?? []) {
    if (isValidPageKey(r.page_key) && isValidAccessLevel(r.level)) {
      explicit[r.page_key] = r.level;
      if (meta && r.page_key.startsWith("scm")) meta.explicitScm = true;
    }
  }

  // Pass 1: resolve every page (parents + standalones) from explicit
  // row or backfill.
  const raw: Record<string, AccessLevel> = {};
  for (const p of PAGES) {
    raw[p.key] = explicit[p.key] ?? computeBackfillLevel(p.key, rolePerms);
  }

  // Pass 2: cascade parent level into children when parent is full/none.
  // When parent is "partial", the child's own row/backfill stands.
  const out: Record<string, AccessLevel> = { ...raw };
  for (const p of PAGES) {
    if (!p.parent) continue;
    const parentLevel = raw[p.parent];
    if (parentLevel === "full") out[p.key] = "full";
    else if (parentLevel === "none") out[p.key] = "none";
    // parentLevel === "partial" → keep the child's resolved level.
  }

  return out;
}

/**
 * Hydrate a POSITION's full page-access map from `position_page_access`
 * (4-level none/view/edit/full). Positions have NO permission-set backfill.
 *
 * INHERIT model (simpler than the role matrix's partial-parent rule): a child
 * sub-page inherits its parent's level unless it has its own explicit row. So
 * the seed can grant a whole area with one parent row (projects:view) and
 * override individual sub-tabs (projects.finances:none to hide finances), or
 * grant just one tab (projects:none + projects.calendar:view). A standalone
 * page with no row is "none".
 *
 * Returned record is attached to `AuthUser.page_access` exactly like the role
 * loader's output, so `requirePageAccess` / `usePageAccess` need no changes.
 */
/**
 * The position inherit model as a PURE function of its rows — the single
 * implementation of the cascade, shared by every source of those rows.
 *
 * WHY THIS IS EXTRACTED RATHER THAN COPIED. The rows can now come from two
 * places: the live `position_page_access` table (below) and the generated
 * `positionAccessSnapshot` photograph. A second local implementation of this
 * cascade is the one thing that must not exist — `positions.ts:306-313` already
 * refused to write one for the export's `resolved` map, for the same reason:
 * "a review table that quietly disagrees with login is worse". Two resolvers
 * would have to be PROVEN equal on every cell forever; one resolver fed from
 * two sources reduces that to "are the rows equal", which is a data question a
 * test can answer once. So `explicit[key] ?? out[parent]` lives here exactly
 * once and both callers pass through it.
 *
 * THE FILTER IS PART OF THE SEMANTICS, not hygiene. `isValidPageKey` drops rows
 * whose key left the registry, and `explicitScm` is set INSIDE that guard — so
 * an orphan `scm*` row does NOT mark a caller L2-configured. The snapshot
 * carries its 6 orphan rows verbatim (the export keeps them on purpose:
 * "a photograph that drops them is not a photograph"), so a snapshot-fed caller
 * that skipped this guard would flip `scm_l2_configured` true and backfill every
 * unlisted SCM key to "none" — the mass lockout z1 measured. Sharing the filter
 * is what makes that impossible rather than merely unlikely.
 */
export function resolvePositionAccessFromRows(
  rows: Iterable<{ page_key: string; level: string }>,
  meta?: PageAccessMeta,
): Record<string, AccessLevel> {
  const explicit: Record<string, AccessLevel> = {};
  for (const r of rows) {
    if (isValidPageKey(r.page_key) && isValidAccessLevel(r.level)) {
      explicit[r.page_key] = r.level;
      if (meta && r.page_key.startsWith("scm")) meta.explicitScm = true;
    }
  }

  // Pass 1: every page resolves to its explicit row or "none".
  const raw: Record<string, AccessLevel> = {};
  for (const p of PAGES) raw[p.key] = explicit[p.key] ?? "none";

  // Pass 2: children inherit the parent's RESOLVED level unless they have an
  // explicit row of their own (inherit model — see docstring). Reading the
  // already-resolved `out[p.parent]` (not the pass-1 `raw[p.parent]`) lets the
  // inherit cascade through grandchildren too: PAGES is ordered parents-before-
  // children, so by the time we reach a grandchild (e.g. scm.sales.orders) its
  // parent (scm.sales) has already inherited from the grandparent (scm). This
  // makes "set scm = full" grant the whole 3-level SCM sub-tree, while an
  // explicit override on any node (parent or leaf) still stands.
  const out: Record<string, AccessLevel> = { ...raw };
  for (const p of PAGES) {
    if (!p.parent) continue;
    out[p.key] = explicit[p.key] ?? out[p.parent];
  }

  return out;
}

export async function loadPageAccessForPosition(
  env: Env,
  positionId: number,
  meta?: PageAccessMeta,
): Promise<Record<string, AccessLevel>> {
  const rows = await env.DB.prepare(
    `SELECT page_key, level FROM position_page_access WHERE position_id = ?`,
  )
    .bind(positionId)
    .all<{ page_key: string; level: string }>();

  return resolvePositionAccessFromRows(rows.results ?? [], meta);
}
