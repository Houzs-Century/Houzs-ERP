/* Titles (position policy) — the ONE logic layer the desktop editor
 * (pages/team/TeamTitlesPolicy.tsx) and the phone editor (mobile/MobileTitles.tsx)
 * both build on, so the two surfaces cannot disagree about what a cohort saves.
 * Types, the display vocabularies, and the two pure transforms (draftOf +
 * normalise) live here; the vocabularies of VALID values still come from the API
 * payload — nothing here restates a backend list. */

export type PolicyCohort = "god" | "full" | "restricted" | "sales";

export interface TitlePolicyRow {
  position_id: number;
  cohort: PolicyCohort;
  profile: string | null;
  can_move_money: boolean;
  can_write_config: boolean;
  is_fleet: boolean;
  duty: string;
}

export interface TitlePolicyEntry {
  id: number;
  name: string;
  slug: string;
  department_name: string | null;
  active: boolean;
  row: TitlePolicyRow | null;
  source: "row" | "name";
  effective: {
    cohort: PolicyCohort;
    profile: string | null;
    can_move_money: boolean;
    can_write_config: boolean;
    is_fleet: boolean;
    duty?: string;
  };
}

export interface TitlePolicyPayload {
  cohorts: PolicyCohort[];
  restricted_profiles: string[];
  sales_profiles: string[];
  /** Absent from a backend that predates the Duty column. */
  duties?: string[];
  positions: TitlePolicyEntry[];
}

export const DUTY_LABEL: Record<string, string> = {
  management: "Management",
  finance: "Finance",
  purchasing: "Purchasing",
  logistic: "Logistic",
  driver: "Driver",
  helper: "Helper",
  warehouse: "Warehouse crew",
  other: "Other",
};

export const DUTY_HELP =
  "The Title's job on a project page: Management / Finance see money; Purchasing sees product cost; Logistic edits projects; Driver and Helper use the driver view; Helper and Warehouse crew see only events they are crewed on. A Sales Title is Sales on projects whatever this says.";

export const COHORT_LABEL: Record<PolicyCohort, string> = {
  god: "Owner tier",
  full: "Full",
  restricted: "Restricted",
  sales: "Sales",
};

export const COHORT_HELP: Record<PolicyCohort, string> = {
  god: "Every permission, every page. Same as the Super Admin role.",
  full: "Sees every page. Money and master-data writes are the two switches.",
  restricted: "Only the pages of the chosen profile. Field and warehouse crew.",
  sales: "The sales chain: owns Sales Orders, views what Office operates.",
};

export const PROFILE_LABEL: Record<string, string> = {
  driver_helper: "Driver / Helper",
  storekeeper: "Storekeeper",
  storekeeper_supervisor: "Storekeeper Supervisor",
  calendar_viewer: "Calendar only",
  director: "Director",
  rep: "Rep",
};

export function profileLabel(p: string | null): string {
  if (!p) return "—";
  return PROFILE_LABEL[p] ?? p.replace(/_/g, " ");
}

/** Department display order: Management first, then Sales, then Operation. */
export function deptRank(name: string | null): number {
  const n = (name ?? "").toLowerCase();
  if (n.includes("management")) return 0;
  if (n.includes("sales")) return 1;
  if (n.includes("operation")) return 2;
  return 3;
}

export type Draft = Omit<TitlePolicyRow, "position_id">;

export function draftOf(e: TitlePolicyEntry): Draft {
  const src = e.row ?? e.effective;
  return {
    cohort: src.cohort,
    profile: src.profile,
    can_move_money: src.can_move_money,
    can_write_config: src.can_write_config,
    is_fleet: src.is_fleet,
    duty: src.duty ?? "other",
  };
}

/** Coerce a draft into a shape the API accepts for its cohort (a profile
 *  only where the cohort takes one; flags only where the cohort owns them). */
export function normalise(d: Draft, payload: TitlePolicyPayload): Draft {
  const duties = payload.duties ?? [];
  const duty = duties.includes(d.duty) ? d.duty : "other";
  if (d.cohort === "restricted") {
    const profile =
      d.profile && payload.restricted_profiles.includes(d.profile)
        ? d.profile
        : payload.restricted_profiles[0] ?? null;
    return { cohort: d.cohort, profile, can_move_money: false, can_write_config: false, is_fleet: d.is_fleet, duty };
  }
  if (d.cohort === "sales") {
    const profile = d.profile && payload.sales_profiles.includes(d.profile) ? d.profile : "rep";
    return { cohort: d.cohort, profile, can_move_money: false, can_write_config: false, is_fleet: false, duty };
  }
  if (d.cohort === "god")
    return { cohort: d.cohort, profile: null, can_move_money: true, can_write_config: true, is_fleet: false, duty: "management" };
  return { cohort: d.cohort, profile: null, can_move_money: d.can_move_money, can_write_config: d.can_write_config, is_fleet: false, duty };
}

/** Active Titles, Management → Sales → Operation, then by name. Shared so the
 *  two surfaces list them in the same order. */
export function orderedPositions(payload: TitlePolicyPayload): TitlePolicyEntry[] {
  return [...payload.positions]
    .filter((p) => p.active)
    .sort(
      (a, b) => deptRank(a.department_name) - deptRank(b.department_name) || a.name.localeCompare(b.name),
    );
}

/** Which cohorts expose which controls — the single answer both surfaces render
 *  from, so a phone toggle can never be editable where the desktop's is not. */
export function profileOptionsFor(cohort: PolicyCohort, payload: TitlePolicyPayload): string[] {
  if (cohort === "restricted") return payload.restricted_profiles;
  if (cohort === "sales") return payload.sales_profiles;
  return [];
}

export const flagsEditableFor = (cohort: PolicyCohort): boolean => cohort === "full";
export const fleetEditableFor = (cohort: PolicyCohort): boolean => cohort === "restricted";
export const dutyEditableFor = (cohort: PolicyCohort): boolean => cohort !== "god";
