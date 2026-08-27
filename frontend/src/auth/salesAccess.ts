import { ACCESS_RANK, type AuthUser, type AccessLevel } from "../types";
// Concrete module, NOT the @2990s/shared barrel: this file is eagerly imported
// by App.tsx, and the barrel drags the whole vendored shared graph (sofa-build,
// mfg-pricing, phone, …, ~24 KB raw) into the initial bundle for one boolean.
import { COSTING_DISPLAY_ENABLED } from "../vendor/shared/costing-enabled";
import { capability } from "./capabilities";

/**
 * Sales-access model — CODE-KEYED off STABLE ORG FIELDS (position_name /
 * department), NOT the configurable per-page permission matrix. The owner
 * explicitly wants the Sales cohort's visibility driven from the org chart in
 * code (the RBAC-config matrix has unresolved issues), so these helpers are the
 * single client-side source of truth for the nav + route guards.
 *
 * Mirrors the backend classification in `services/pmsAccess.ts`
 * (`getPmsRole` / `isFinanceViewer`) so the FE and BE agree on who is a
 * "director" and who is "sales staff". Backend stays the authority — these
 * guards are UX + defence-in-depth only.
 *
 * FOLDED TO THE BACKEND (owner's 2026-07-19 ruling, #835/#839). Three of the
 * helpers below no longer COMPUTE their answer from position names / flags — they
 * READ the server-resolved capability set (auth/capabilities): `isDirectorUser`
 * -> `org.director`, `canViewFairReport` -> `fair.report.view`, and the position
 * half of `canViewScmCosting` -> `scm.finance.view`. They stay as named helpers
 * (their callers are unchanged and one still composes the SCM display switch),
 * but the rule now lives in ONE place, server-side, and each fails CLOSED when the
 * capability set did not resolve. The remaining helpers (isSalesStaff /
 * isSalesDirectorUser / isSalesNonDirector / fairAllowedStages / product-cost) are
 * still client-side and still mirror pmsAccess.
 */

/** Owner/IT `*` or a director-level position — sees everything. */
// Lower-case + collapse internal whitespace + trim. Tolerant to casing/spacing
// drift ONLY, never substring. Mirror of backend services/pmsAccess.normalisePosition.
function normalisePosition(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A sales position name — matches "Sales Executive", "Sales Coordinator",
 *  "Sales Director", but ALSO the no-space / punctuated variants that the old
 *  `/^Sales\s/` missed and thereby FAILED OPEN on: "Salesperson",
 *  "Sales-Executive", "Sales_Rep". A `Sales`-prefixed title is always a sales
 *  role here, so a prefix test is correct and safe (there is no non-sales
 *  position that starts with "Sales"). The primary, most-robust signal is now
 *  `department_name` (see isSalesStaff); this remains as a fallback for rows
 *  whose department isn't populated. */
const SALES_POSITION = /^sales/i;

/**
 * Director signal — the cohort that sees everything. FOLDED: reads the
 * server-resolved `org.director` capability (backend services/capabilities.ts ->
 * pmsAccess.isDirectorUser = `*` wildcard OR an exact director position name).
 * The position-name matcher and the `project_finance_viewer` OR that used to live
 * here now live once, on the backend; this is a thin read of that answer.
 *
 * Fails CLOSED with the capability set: a caller whose /auth/me carried no
 * `capabilities` (stale PWA shell / a Pages deploy ahead of the Worker) resolves
 * to false here rather than being granted director access off a stale flag. The
 * internal callers below (isSalesNonDirector, isFairManagementUser) inherit that
 * same server answer, so all three read one source.
 */
export function isDirectorUser(user: AuthUser | null | undefined): boolean {
  return capability(user, "org.director");
}

/**
 * Sales staff — a member of the Sales department (director sales reps
 * included, e.g. "Sales Director" also matches). Keyed PRIMARILY off
 * `department_name` (now sent on /auth/me by backend #400) so any position
 * within the Sales department is caught, with the position-name prefix as a
 * fallback. Broadening these matches CLOSES the previous fail-open hole where
 * non-space titles ("Salesperson") slipped through as unrestricted.
 */
export function isSalesStaff(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  const dept = (user.department_name ?? "").toLowerCase();
  if (dept.includes("sales")) return true;
  return SALES_POSITION.test((user.position_name ?? "").trim());
}

/**
 * May this user CREATE an event (New Project)? Owner 2026-07-24: restricted to
 * BD staff, the Owner account, and Lim (weisiang329@gmail.com) — NOT other
 * Super Admins (Nico/Loo) nor anyone else. Mirrored server-side in
 * backend/src/routes/projects.ts on the New Project POST (this is UX/nav gating;
 * the backend stays the authority).
 */
export function canCreateEvent(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  const role = (user.role_name ?? "").toLowerCase();
  const position = (user.position_name ?? "").toLowerCase();
  const email = (user.email ?? "").toLowerCase();
  return /\bbd\b/.test(role) || position === "owner" || email === "weisiang329@gmail.com";
}

/**
 * Non-director sales user — the restricted cohort of the Sales access model
 * (Delivery Returns hidden, Projects Finances hidden, etc.). Directors in the
 * Sales department are explicitly NOT restricted.
 */
export function isSalesNonDirector(user: AuthUser | null | undefined): boolean {
  return isSalesStaff(user) && !isDirectorUser(user);
}

/** Exact "Sales Director" position — the signal for the DEPARTMENT-SCOPED Team
 *  admin grant (owner 2026-07). EXACT normalised name so ONLY "Sales Director"
 *  matches, not "Sales Executive"/"Sales Coordinator" nor a name merely
 *  CONTAINING "Sales Director" ("Assistant to Sales Director"). This WAS
 *  /\bSales Director\b/i. Mirrors backend services/pmsAccess.isSalesDirectorUser;
 *  the backend stays the authority — this drives nav visibility + in-page
 *  scoping (defence-in-depth / UX only). MUST stay identical to the backend
 *  SALES_DIRECTOR_POSITION_NAMES. */
const SALES_DIRECTOR_POSITION_NAMES: ReadonlySet<string> = new Set(
  ["Sales Director"].map(normalisePosition),
);

/**
 * True ONLY for the "Sales Director" position. A Sales Director gets a scoped
 * Team view (own-department Members / Org Chart / Departments + Invite forced
 * into his dept; NO Positions tab, NO permission editing). Distinct from
 * isDirectorUser (broader — also Super Admin / Finance Manager / `*`, all full
 * admins). A caller who already holds users.manage keeps full admin unchanged.
 */
export function isSalesDirectorUser(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  return SALES_DIRECTOR_POSITION_NAMES.has(normalisePosition(user.position_name));
}

/**
 * Quick-action ("+" speed-dial) eligibility — the SINGLE source for whether a
 * user can start a New Sales Order and/or a New Service Case. Both the desktop
 * `QuickActionsFAB` and the mobile `MobileSalesOrders` FAB call this so the
 * "New Service Case includes Sales staff" rule (owner 2026-07: a Sales user
 * always gets the case option even without the service_cases matrix grant)
 * lives in ONE place and can't drift between the two surfaces.
 *
 *   canNewSo   → SO route gate: `scm.access` OR a per-position scm.sales.orders grant.
 *   canNewCase → service_cases.write / service_cases page access, OR any Sales staff.
 */
export function quickActionAccess(
  user: AuthUser | null | undefined,
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
): { canNewSo: boolean; canNewCase: boolean } {
  return {
    /* `edit`, not "not none" — the backend's area guard requires it and this
       gate must not promise what that will refuse. `scm/middleware/area-guard`
       is explicit: GET/HEAD need `view`, POST/PATCH/PUT/DELETE need `edit`,
       "else 403 (ENFORCED)". A view-level Sales Executive could therefore open
       the New SO form and reach "Create Sales Order", and the confirm PATCH
       /:docNo/status came back 403 with the button still sitting there — the
       owner hit exactly that on 2026-07-17.
       ACCESS_RANK already existed (types.ts, and PageGuard has compared through
       it since it was written) and mirrors the backend's levelRank rank-for-rank.
       Nobody called it here; `!== "none"` was the improvisation. */
    canNewSo:
      can("scm.access") ||
      ACCESS_RANK[pageAccess("scm.sales.orders")] >= ACCESS_RANK.edit,
    canNewCase:
      isSalesStaff(user) ||
      can("service_cases.write") ||
      pageAccess("service_cases") !== "none",
  };
}

/**
 * DELIVERY-ORDER / SALES-INVOICE OPERATE gate — "may this user CREATE or CHANGE
 * a DO / SI", and the SINGLE source for it across desktop and mobile.
 *
 * THE RULE (owner 2026-07-17): "后面的人是来操作 DO 和 SI 的。销售人员不可能去
 * 操作 DO 和 SI，所以他们通常只是来看而已" — the Office department operates
 * Delivery Orders and Sales Invoices; Sales OWNS the Sales Order and only LOOKS
 * at these. And 2026-07-18 on the Director: "DO SI 只能看 salesdirector". So the
 * whole Sales cohort, Director included, is view + Print PDF here.
 *
 * WHY IT IS A HELPER AND NOT A `pageAccess(...)` CALL AT EACH SITE. It was four
 * hand-copies, and they disagreed — which is how the bug the owner reported got
 * in. `DeliveryOrderDetailV2`, `MfgDeliveryOrdersListV2` and `SalesInvoicesListV2`
 * each inlined `["edit","full"].includes(pageAccess(...))`; the SO quick-view
 * drawer's "Deliver" button checked NOTHING (status only) and navigated a
 * salesperson to a route that then rendered <Forbidden>; and the entire mobile
 * convert surface (MobileConvertWizard, the module-list "+", the planning
 * board's Create DO) imported no auth at all. Owner: "電話電腦的權限應該一樣的"
 * — one rule, both platforms, so this is the only place that decides.
 *
 * IT MIRRORS THE BACKEND EXACTLY, which is the property that matters — a button
 * this shows must not 403. `scm/middleware/area-guard` requires `edit` on the
 * area for POST/PATCH/PUT/DELETE, and `salesJdAccess.salesJdWriteDenial` denies
 * those writes to the Sales cohort whether or not they are L2-configured. Both
 * terms are reproduced below, in that order:
 *   1. `*` (Owner / IT) always passes — never narrowed, on either side.
 *   2. Sales cohort → false. This is the RULE half. It is not redundant with the
 *      page_access read: the backend writes SALES_JD's `view` into page_access at
 *      login, so term 3 usually agrees on its own — but a stale /auth/me payload
 *      would otherwise re-offer the button the server now refuses.
 *   3. otherwise → the matrix, compared through ACCESS_RANK (the same rank the
 *      backend's meetsLevel uses), so Office keeps exactly what its position
 *      grants and nothing else moves.
 *
 * READS ARE NOT GATED BY THIS. Sales keeps view + Print PDF on both documents
 * (the backend's `readInheritsFrom: "scm.sales.orders"` hatch lets a rep read the
 * DOs and SIs raised off their own SOs). Callers must make the control ABSENT,
 * not disabled — "off, not hide".
 */
function canOperateScmSalesDoc(
  user: AuthUser | null | undefined,
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
  area: "scm.sales.delivery" | "scm.sales.invoices",
): boolean {
  if (can("*")) return true;
  if (isSalesStaff(user)) return false;
  return ACCESS_RANK[pageAccess(area)] >= ACCESS_RANK.edit;
}

/** May this user create or change a DELIVERY ORDER (incl. converting an SO into
 *  one)? See {@link canOperateScmSalesDoc}. */
export function canOperateDeliveryOrders(
  user: AuthUser | null | undefined,
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
): boolean {
  return canOperateScmSalesDoc(user, can, pageAccess, "scm.sales.delivery");
}

/** May this user create or change a SALES INVOICE (incl. converting a DO into
 *  one)? See {@link canOperateScmSalesDoc}. */
export function canOperateSalesInvoices(
  user: AuthUser | null | undefined,
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
): boolean {
  return canOperateScmSalesDoc(user, can, pageAccess, "scm.sales.invoices");
}

/**
 * May this user COMPLETE their own delivery — the driver POD chain (On the way /
 * Arrived / Proof of Delivery)? A driver holds no scm.sales.delivery edit, so
 * canOperateDeliveryOrders is false for them; this admits a position holding the
 * scm.do.dispatch operational capability (the editable Roles & Permissions
 * matrix). The SERVER is the boundary — it additionally enforces that the DO is
 * the caller's OWN, already-dispatched job — so this only decides whether the
 * button SHOWS. Deliberately NOT folded into canOperateDeliveryOrders, which
 * also gates office-only actions (Convert-to-DO).
 */
export function canDriverCompleteDelivery(
  user: AuthUser | null | undefined,
): boolean {
  return (user?.position_capabilities ?? []).includes("scm.do.dispatch");
}

/**
 * May this user REVERT a delivery order — the Ops-lead exception power (undo a
 * wrong scan / accidental dispatch, restoring stock when it crosses back to a
 * pre-ship state)? Gated on the editable scm.do.revert capability. The SERVER is
 * the boundary — it enforces the exact legal transitions, the downstream lock and
 * the inventory reversal — so this only decides whether the Revert controls SHOW.
 */
export function canRevertDelivery(user: AuthUser | null | undefined): boolean {
  return (user?.position_capabilities ?? []).includes("scm.do.revert");
}

/**
 * PROCUREMENT OPERATE gate — "may this user CREATE or CHANGE a PO / GRN".
 *
 * Same job as {@link canOperateScmSalesDoc} for the two supply-chain areas, and
 * split out because the RULE half differs: the Sales-JD write denial keys off
 * `SALES_JD[area] === "view"` (backend `services/salesJdAccess.ts`), which names
 * only `scm.sales.delivery` and `scm.sales.invoices`. Procurement is not a
 * document Sales views-but-cannot-write; it is one they are not granted at all,
 * so the page_access matrix is the whole answer and adding an `isSalesStaff`
 * term here would invent a second, divergent rule.
 *
 * The backend term this mirrors is `scm/middleware/area-guard`: `edit` on the
 * area for POST/PATCH/PUT/DELETE. `MobileConvertWizard` POSTs `/grns` and
 * `/mfg-purchase-orders/from-sos`, so a `view`-level holder offered the "+"
 * walks into a 403 after filling in the whole wizard.
 */
function canOperateScmProcurement(
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
  area: "scm.procurement.po" | "scm.procurement.grn",
): boolean {
  if (can("*")) return true;
  return ACCESS_RANK[pageAccess(area)] >= ACCESS_RANK.edit;
}

/** May this user raise or change a PURCHASE ORDER (incl. SO→PO convert)? */
export function canOperatePurchaseOrders(
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
): boolean {
  return canOperateScmProcurement(can, pageAccess, "scm.procurement.po");
}

/** May this user raise or change a GOODS RECEIPT (incl. PO→GRN convert)? */
export function canOperateGoodsReceipts(
  can: (perm: string) => boolean,
  pageAccess: (page: string) => AccessLevel,
): boolean {
  return canOperateScmProcurement(can, pageAccess, "scm.procurement.grn");
}

/**
 * SCM COSTING gate — "may this user see cost/margin on a SUPPLY-CHAIN surface".
 *
 * Owner 2026-07-17: "margin 給2990開啊 houzs的也是啊 是看什麽position 的" — the
 * POSITION is the control, and it is the `project_finance_viewer` flag below:
 * Super Admin / Sales Director / Finance Manager, plus Owner/IT via the `*`
 * wildcard (backend isFinanceViewer -> getPmsRole -> DIRECTOR,
 * services/pmsAccess.ts:79,154,256). A `Sales *` position routes to PIC/SALES
 * there and never reaches DIRECTOR, so every salesperson below Sales Director
 * gets false. That is the whole rule.
 *
 * Kept as its own helper — NOT because it computes a rule (it no longer does),
 * but because the COSTING_DISPLAY_ENABLED term is SCM-only: it exists so the SCM
 * document surfaces can be switched off without taking the PMS / Projects P&L
 * (real data, same flag) down with them. It was false 2026-07-16..17 (#649) and
 * is true again now — see costing-enabled.ts for what a HOUZS 100% still means
 * until that catalog is costed. Housing that display switch in ONE helper is why
 * the ~9 SCM pages call this rather than inlining it nine times.
 *
 * FOLDED: the PERMISSION half (was `project_finance_viewer`) now reads the
 * server-resolved `scm.finance.view` capability (backend isFinanceViewer — the
 * same function `project_finance_viewer` was computed from, so same cohort), which
 * fails CLOSED on an unresolved capability set.
 *
 * THE DISPLAY SWITCH IS NOW BACKEND-AUTHORITATIVE (fix/cost-display-backend-gate).
 * The env var COSTING_DISPLAY_ENABLED (backend scm/lib/costing-enabled) is ANDed
 * into BOTH canViewScmFinance (which strips cost/margin from the wire) AND the
 * `scm.finance.view` capability this reads — so when it is off the capability is
 * already false here and the columns vanish, in lock-step with the server omitting
 * the fields. The FE `COSTING_DISPLAY_ENABLED` const stays as a build-time
 * defence-in-depth term: it can only hide MORE, never re-show cost the server
 * withheld. One switch, both sides — that is what closed the two-rule split where
 * this const blanked the column while the backend still shipped the numbers.
 *
 * Callers must make the element ABSENT, not blank it ("off, not hide").
 */
export function canViewScmCosting(user: AuthUser | null | undefined): boolean {
  if (!COSTING_DISPLAY_ENABLED) return false;
  return capability(user, "scm.finance.view");
}

// ── Fair Report access (owner-ruled 2026-07-19) ─────────────────────────────
//
// Three tiers, PER STAGE, mirroring the backend lib/fair-report.fairReportAccess:
//   * ordinary salespeople → no access (nav absent + route guard)
//   * Sales Director       → SO stage only
//   * MANAGEMENT           → all three stages
// MANAGEMENT = isFinanceViewer AND NOT a Sales Director = {`*` owner/IT, Super
// Admin, Finance Manager}. isDirectorUser is the FE mirror of the backend
// isFinanceViewer (both OR in project_finance_viewer + the exact director
// position names — see its docblock), so subtracting the Sales Director yields
// management exactly. The Sales-Director check reuses the shared, EXACT-name
// isSalesDirectorUser so a free-text rename can never slide into a tier.
//
// NOTE: deliberately NOT gated on COSTING_DISPLAY_ENABLED (unlike
// canViewScmCosting). The backend endpoint returns cost/margin to these two
// tiers unconditionally, so the FE must not hide behind the SCM costing switch
// or the nav + page would disagree with what the API will serve.

// 'pnl' is the exhibition P&L view — management-only, like do / invoice (a Sales
// Director never gets it), mirroring backend lib/fair-report.fairReportAccess.
export type FairStage = "so" | "do" | "invoice" | "pnl";

/** MANAGEMENT tier for the Fair Report — all stages incl. P&L. */
export function isFairManagementUser(user: AuthUser | null | undefined): boolean {
  return isDirectorUser(user) && !isSalesDirectorUser(user);
}

/** The Fair Report stages this user may open, in canonical order. Empty = no
 *  access. Drives both nav visibility and per-tab visibility on the page. */
export function fairAllowedStages(user: AuthUser | null | undefined): FairStage[] {
  if (isFairManagementUser(user)) return ["so", "do", "invoice", "pnl"];
  if (isSalesDirectorUser(user)) return ["so"];
  return [];
}

/** Nav + route guard — may this user open the Fair Report at all (any stage).
 *  True for management + the Sales Director; false for ordinary sales / office.
 *
 *  FOLDED: reads the server-resolved `fair.report.view` capability (backend
 *  fairReportAccess ORed over every stage — the SAME gate that 403s each refused
 *  stage), instead of re-deriving the tiers here via `fairAllowedStages`. Fails
 *  CLOSED when the capability set did not resolve. `fairAllowedStages` stays
 *  client-side for the PER-TAB visibility INSIDE the already-gated page. */
export function canViewFairReport(user: AuthUser | null | undefined): boolean {
  return capability(user, "fair.report.view");
}

/**
 * PRODUCT COST gate — "may this user see a SKU's cost price".
 *
 * Owner 2026-07-17: "全部對sales person 除了sales director 關閉 就是直接看不到
 * 這個portion" + "電腦版本也是不要看到 電話電腦的權限應該一樣的".
 *
 * Deliberately NOT {@link canViewScmCosting}. The two no longer even resolve to
 * the same cohort (2026-07-17: Purchasing is in this one and not in that one),
 * but they were kept apart while they DID, and this is why. That helper carries
 * the extra COSTING_DISPLAY_ENABLED term —
 * an SCM-wide kill switch that has already been flipped twice (off #649, on
 * 2026-07-17). Cost ENTRY must not ride a switch whose whole purpose is to hide
 * cost DISPLAY: the last time it was off, wiring this to it would have meant
 * nobody — not even the Owner — could type a cost in, and the switch could
 * never have been flipped back. The circularity is the bug, and it stays fixed
 * by keeping the two questions apart rather than by the current value of the
 * flag.
 *
 * `cost_price_sen` is not derived and is not an artifact — whatever is in that
 * column is exactly what someone typed. It is simply CONFIDENTIAL. So this gate
 * is about IDENTITY only.
 *
 * That identity is `product_cost_viewer`, and it is NOT `project_finance_viewer`
 * — the correction of 2026-07-17. Owner, shown that his 2026-06-13 red line
 * ("Only Purchasing + Finance see cost") was not in force because Purchasing is
 * in no cost cohort:
 *
 *     "那就是采购、Finance，还有 Sales Director 啊？"
 *
 * so: Purchasing + Finance Manager + Sales Director, plus Owner/Super Admin via
 * `*`. This gate read `project_finance_viewer` until now — but that flag answers
 * "are you a PMS DIRECTOR" (isFinanceViewer -> getPmsRole -> DIRECTOR,
 * services/pmsAccess.ts:79,154,256), a question with no Purchasing in it. Two
 * questions had one flag, so an owner ruling sat dead for a month. The fix is
 * NOT to widen project_finance_viewer to admit Purchasing: that flag also opens
 * every project's financial snapshot / rental / payment in PMS and makes its
 * holder isDirectorUser, and the owner asked for cost, not for that. It is to
 * ask the cost question separately — backend pmsAccess.isProductCostViewer,
 * surfaced on /auth/me next to its sibling. Same reasoning as the paragraph
 * above, one level up: keep the two questions apart.
 *
 * project_finance_viewer is OR'd in only as a floor. The cost cohort is a strict
 * SUPERSET of the director cohort (isProductCostViewer = isDirectorUser OR
 * Purchasing), so a director is already true here by construction — this cannot
 * widen the cohort by one user. It exists so a director never loses cost against
 * a backend that predates the new flag (a stale PWA SPA shell is the real case);
 * an old backend then yields exactly the old director-only behaviour. Note the
 * inverse is deliberately absent: `isDirectorUser` above must NEVER read
 * product_cost_viewer, or Purchasing would become a director and inherit the
 * sales-scope gates and the 27 nav flags.
 *
 * Callers must make the element ABSENT, not blank it ("off, not hide") — a
 * "Cost: —" column still tells a salesperson the field exists and invites the
 * question.
 */
export function canViewProductCost(user: AuthUser | null | undefined): boolean {
  return !!user?.product_cost_viewer || !!user?.project_finance_viewer;
}

/** Drop the confidential fields a user may not see from a mobile card's field
 *  list. The mobile module cards are driven by one shared MODULE_CONFIGS table
 *  consumed in TWO places (MobileModuleList's ListCard and MobileModuleDetail's
 *  field grid), so the filter lives here rather than at either call site — a
 *  gate applied at one consumer and not the other is the same bug as gating
 *  desktop but not phone. Tuple slot 2 marks confidentiality; see FieldDef. */
export function visibleFields<T extends readonly [unknown, string, ("cost" | undefined)?]>(
  fields: readonly T[] | undefined,
  user: AuthUser | null | undefined,
): T[] {
  if (!fields?.length) return [];
  if (canViewProductCost(user)) return [...fields];
  return fields.filter((f) => f[2] !== "cost");
}

/**
 * True when the caller holds ANY Supply Chain page grant (`scm.*` at a level
 * other than "none"), or the `*` wildcard. Mirrors the backend requireScmAccess
 * umbrella (index.ts: pass on any `scm*` page_access key !== "none").
 *
 * Admits a caller to an SCM HUB landing page (/scm and its sub-group hubs, all
 * gated `ScmGuard area="scm"`). A hub is a navigation INDEX — it only lists the
 * tiles the caller can already reach, and each real page still gates on its own
 * area key. A position that grants a sub-area (a Sales Director's scm.sales=full)
 * but NOT the broad `scm.access` permission or a bare `scm` page row would
 * otherwise be 403'd at the hub door while its own modules sit one click away.
 * Owner 2026-07-20: a Sales Director opens the hub and sees only their own modules.
 */
export function hasAnyScmPageAccess(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (Array.isArray(user.permissions) && user.permissions.includes("*")) return true;
  const pa = user.page_access;
  if (!pa) return false;
  return Object.entries(pa).some(([key, level]) => key.startsWith("scm") && level !== "none");
}

/**
 * SALES-ENTRY WRITE gate — "may this user LOG a sale", and the SINGLE source for
 * it across desktop and mobile.
 *
 * Mirrors the backend rule on the WRITE route exactly:
 * `POST /api/sales/entries` is `requirePageAccess("sales")`
 * (`routes/sales.ts`), i.e. the `*` wildcard or a `sales` page-access level at
 * or above `partial`. `pageAccess()` already collapses the wildcard to "full",
 * so comparing the level through ACCESS_RANK is the whole rule.
 *
 * IT IS NOT `can("sales.write")`, which is what the desktop project page asked.
 * That flat key is not a term the write route reads at all, so it was wrong in
 * both directions at once: a rep holding it without a `sales` page row was shown
 * the button and got a 403, and an office user with the page row but no flat key
 * never saw it.
 *
 * IT IS ALSO NOT the READ rule. `GET /entries` is `requirePageAccessOrSalesView`,
 * whose extra arm admits Sales staff and directors by ORG POSITION — which is
 * why a Sales Director reads the list. The write route has no such arm, so
 * widening this helper to match the read gate would re-offer "+ Quick Log" to
 * exactly the cohort the server refuses. Two routes, two rules.
 */
export function canLogSalesEntry(salesPageLevel: AccessLevel): boolean {
  return ACCESS_RANK[salesPageLevel] >= ACCESS_RANK.partial;
}

/**
 * PROJECT-FINANCE WRITE gate — "may this user set a project's money fields"
 * (Total Sales, and every other `PATCH /api/projects/:id/finance` write).
 *
 * The backend rule is TWO terms and this reproduces both, in order:
 *   1. `requirePermission("projects.write")` — the flat write key.
 *   2. `denyFinance(c)` — a 403 when `pmsAccess.financeHiddenForUser(user)`.
 *
 * `financeHiddenForUser` is `position_id != null && !isFinanceViewer(user)`, and
 * `/auth/me` ships `isFinanceViewer` verbatim as `project_finance_viewer` — so
 * the second term is read off the server's own answer rather than re-derived
 * from position names here. The un-positioned arm is mirrored too: the backend
 * lets a user with NO position through, so this does as well. A client that
 * hides what the server would accept is still a wrong answer — that half is the
 * one that left a finance user with no button for a number they are authorised
 * to set.
 *
 * Deliberately NOT `access.canFinancial`. That flag is the per-project PMS
 * SECTION tier (role === DIRECTOR), which is a strict SUBSET: it excludes the
 * granular `projects.finance.view` holders (the BD role, owner 2026-07-23) that
 * `isFinanceViewer` admits. Gating a WRITE on the section flag would hide the
 * control from people the write route accepts.
 */
export function canWriteProjectFinance(
  user: AuthUser | null | undefined,
  can: (perm: string) => boolean,
): boolean {
  if (!user) return false;
  if (!can("projects.write")) return false;
  if (user.position_id == null) return true; // financeHiddenForUser's legacy arm
  return user.project_finance_viewer === true;
}
