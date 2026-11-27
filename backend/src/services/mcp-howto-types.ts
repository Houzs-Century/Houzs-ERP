import type { AuthUser } from "./auth";
import { hasPermission } from "./permissions";
import { hasCapability } from "./capabilities";
import { meetsLevel, type AccessLevel } from "./pageAccess";
import { scmAreaReadable } from "../scm/middleware/area-guard";

/**
 * The ERP route guard a page sits behind, written the way frontend/src/App.tsx writes it
 * (ScmGuard / PageGuard / Guard / the named guards). Evaluated on the backend with the
 * same predicates the API uses (scmAreaReadable, page_access, flat permissions, capabilities).
 */
export type HowtoGate =
  | { kind: "open" }
  | { kind: "scm"; area: string; allowSales?: boolean; allowDirector?: boolean; allowSalesDirector?: boolean }
  | { kind: "page"; page: string; minLevel?: "partial" | "full"; allowSales?: boolean; allowSalesDirector?: boolean }
  | { kind: "perm"; any: string[]; anyAccess?: string[]; allowSales?: boolean }
  | { kind: "deliveryReturns" }
  | { kind: "fairReport" }
  | { kind: "soMaintenance" }
  | { kind: "itPages" };

/** One field on the form: `label` is the exact UI label (checked against frontend/src). */
export type HowtoField = { label: string; required: boolean; format: string; validation: string; example: string };

/**
 * One click. Text quotes UI labels in double quotes ("New Sales Order"); every quoted string
 * must exist in frontend/src. `highlight` is the label of the element to press on `page`.
 */
export type HowtoStep = { text: string; page: string | null; highlight: string | null; role?: string };

/** A full SOP: one staff task ("task") or a whole business chain ("flow"). */
export type HowtoGuide = {
  id: string;
  kind: "task" | "flow";
  title: string;
  module: string;
  keywords: string[];
  purpose: string;
  prerequisites: string[];
  who: string;
  permission: string;
  gate: HowtoGate;
  page: string;
  sidebar: string;
  fields: HowtoField[];
  steps: HowtoStep[];
  checkBefore: string[];
  result: string[];
  warnings: string[];
  undo: string;
  approvals: string[];
  deadlines: string[];
  commonMistakes: { mistake: string; fix: string }[];
  workedExample: string;
  related: string[];
  nextStep: string | null;
  contact: string;
};

const pageLevel = (u: AuthUser, key: string): AccessLevel => {
  if (u.permissions_set.has("*")) return "full";
  const v = u.page_access?.[key];
  return v ?? "none";
};

/** Does this person pass the page's ERP guard? Mirrors the route guard; the API re-checks every write anyway. */
export function gatePasses(gate: HowtoGate, u: AuthUser): boolean {
  const sales = (): boolean => hasCapability(u, "org.sales.staff");
  switch (gate.kind) {
    case "open":
      return true;
    case "scm":
      if (gate.allowSales && sales()) return true;
      if (gate.allowSalesDirector && hasCapability(u, "org.salesDirector")) return true;
      if (gate.allowDirector && hasCapability(u, "org.director")) return true;
      return scmAreaReadable(u, gate.area);
    case "page": {
      if (meetsLevel(pageLevel(u, gate.page), gate.minLevel ?? "partial")) return true;
      if (gate.allowSales && sales()) return true;
      return Boolean(gate.allowSalesDirector && hasCapability(u, "org.salesDirector"));
    }
    case "perm":
      if (gate.allowSales && sales()) return true;
      if (gate.any.some((k) => hasPermission(u.permissions_set, k))) return true;
      return (gate.anyAccess ?? []).some((k) => pageLevel(u, k) !== "none");
    case "deliveryReturns":
      return !sales() && scmAreaReadable(u, "scm.sales.returns");
    case "fairReport":
      return hasCapability(u, "fair.report.view");
    case "soMaintenance":
      return hasCapability(u, "scm.maintenance.open");
    case "itPages":
      return hasCapability(u, "it.pages.view");
  }
}

export const NO_PERMISSION_NOTE = "You don't have permission for this in the ERP — ask your supervisor or admin.";

/** An ERP link with ?highlight=<label> merged into the page's own query. */
export function erpLink(origin: string, page: string, highlight: string | null): string | null {
  if (page.includes(":")) return null;
  if (!highlight) return `${origin}${page}`;
  const sep = page.includes("?") ? "&" : "?";
  return `${origin}${page}${sep}highlight=${encodeURIComponent(highlight)}`;
}

/** One ERP sidebar module, for module_overview. `sidebar` is the exact sidebar label. */
export type ModuleOverview = {
  id: string;
  name: string;
  sidebar: string;
  keywords: string[];
  purpose: string;
  keyPages: { path: string; label: string; what: string }[];
  users: string;
  connects: string[];
  gate: HowtoGate;
};

/** A term staff meet in the UI, for glossary. */
export type GlossaryTerm = { term: string; aliases: string[]; keywords: string[]; definition: string; seeAlso: string[]; page: string | null };

/** A first-week path for one role, for onboarding. `guides` are HOWTO guide ids. */
export type OnboardingPath = {
  role: string;
  title: string;
  keywords: string[];
  days: { day: string; goals: string[]; guides: string[]; pages: string[] }[];
  contact: string;
};

/** A real ERP error / validation message. Each `match` is a substring of the backend's own text. */
export type ErrorEntry = { id: string; match: string[]; module: string; meaning: string; cause: string; fix: string; source: string };
