// ----------------------------------------------------------------------------
// positionPolicyRows — the per-Title policy ROW (table `position_policy`),
// keyed by position_id, that positionPolicy.ts resolves from before it falls
// back to its name-keyed sets.
//
// WHY (Roles & Permissions review, owner 2026-09-16: 「先做 A，然后走 B」). Every
// cohort and flag in positionPolicy.ts was keyed on the Title's NAME, so a
// rename or a bulk "move to position" on the Team page changed a person's
// access with nothing saying so (the Storekeeper Supervisor reviewer, the
// Warehouse Crew KL fall-through to full, Outsource Transporter on full). This
// row is the same decision stored against the id: cohort, which whitelist or
// sales tier, and the three per-position flags. The whitelists themselves
// (which pages a "storekeeper" profile opens) stay code — they are shapes, not
// per-position settings — so a profile name is all a row carries.
//
// This module holds the TYPES, the VALIDATION, the LOADER and the SEED table.
// The resolution (row → PositionPolicy) lives in positionPolicy.ts, next to
// the whitelists it needs; this module must not import positionPolicy (cycle).
// ----------------------------------------------------------------------------

import type { Env } from "../types";

export const POSITION_COHORTS = ["god", "full", "restricted", "sales"] as const;
export type PositionCohort = (typeof POSITION_COHORTS)[number];

export const RESTRICTED_PROFILES = [
  "driver_helper",
  "storekeeper",
  "storekeeper_supervisor",
  "calendar_viewer",
] as const;
export type RestrictedProfile = (typeof RESTRICTED_PROFILES)[number];

export const SALES_PROFILES = ["director", "rep"] as const;
export type SalesProfile = (typeof SALES_PROFILES)[number];

export type PositionProfile = RestrictedProfile | SalesProfile;

export interface PositionPolicyRow {
  position_id: number;
  cohort: PositionCohort;
  /** restricted → which whitelist; sales → director or rep; god / full → null. */
  profile: PositionProfile | null;
  /** full cohort only: may post journals / raise vouchers (Finance Manager). */
  can_move_money: boolean;
  /** full cohort only: may write SCM master data without the flat key. */
  can_write_config: boolean;
  /** restricted cohort only: sees only their OWN delivery jobs and fails closed
   *  to an empty board when unlinked (Driver / Helper). */
  is_fleet: boolean;
}

export type PositionPolicyInputRow = Omit<PositionPolicyRow, "position_id">;

const COHORT_SET: ReadonlySet<string> = new Set(POSITION_COHORTS);
const RESTRICTED_SET: ReadonlySet<string> = new Set(RESTRICTED_PROFILES);
const SALES_SET: ReadonlySet<string> = new Set(SALES_PROFILES);

export function isPositionCohort(v: unknown): v is PositionCohort {
  return typeof v === "string" && COHORT_SET.has(v);
}

function asFlag(v: unknown): boolean | null {
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "false" || v == null) return false;
  return null;
}

/**
 * Validate an editor / API body into a row. Refuses a profile that does not
 * belong to the cohort and a flag that the cohort cannot carry, so a stored
 * row is always one the resolver can honour (a bad row would otherwise fall
 * through to the name rule and silently un-do the edit).
 */
export function validatePolicyRow(
  positionId: number,
  body: Record<string, unknown> | null | undefined,
): { ok: true; row: PositionPolicyRow } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be an object." };
  const cohort = body.cohort;
  if (!isPositionCohort(cohort))
    return { ok: false, error: `cohort must be one of ${POSITION_COHORTS.join(", ")}.` };

  const rawProfile = body.profile == null || body.profile === "" ? null : body.profile;
  let profile: PositionProfile | null = null;
  if (cohort === "restricted") {
    if (typeof rawProfile !== "string" || !RESTRICTED_SET.has(rawProfile))
      return { ok: false, error: `A restricted Title needs a profile: ${RESTRICTED_PROFILES.join(", ")}.` };
    profile = rawProfile as RestrictedProfile;
  } else if (cohort === "sales") {
    if (typeof rawProfile !== "string" || !SALES_SET.has(rawProfile))
      return { ok: false, error: `A sales Title needs a profile: ${SALES_PROFILES.join(", ")}.` };
    profile = rawProfile as SalesProfile;
  } else if (rawProfile != null) {
    return { ok: false, error: `A ${cohort} Title carries no profile.` };
  }

  const money = asFlag(body.can_move_money);
  const config = asFlag(body.can_write_config);
  const fleet = asFlag(body.is_fleet);
  if (money == null || config == null || fleet == null)
    return { ok: false, error: "can_move_money, can_write_config and is_fleet must be true or false." };
  if (fleet && cohort !== "restricted")
    return { ok: false, error: "Only a restricted Title can be fleet." };
  if ((money || config) && cohort !== "full" && cohort !== "god")
    return { ok: false, error: "Money and config writes are flags of a full Title; restricted and sales Titles take them from their profile." };

  return {
    ok: true,
    row: {
      position_id: positionId,
      cohort,
      profile,
      can_move_money: cohort === "god" ? true : money,
      can_write_config: cohort === "god" ? true : config,
      is_fleet: fleet,
    },
  };
}

/** Coerce a DB row (D1 answers the flags as 0/1 integers, Postgres through the
 *  shim may answer booleans) into the typed row; null for a malformed row so
 *  the resolver falls back to the name rule rather than trusting garbage. */
export function policyRowFromDb(raw: {
  position_id?: unknown;
  cohort?: unknown;
  profile?: unknown;
  can_move_money?: unknown;
  can_write_config?: unknown;
  is_fleet?: unknown;
} | null | undefined): PositionPolicyRow | null {
  if (!raw || raw.cohort == null) return null;
  const positionId = Number(raw.position_id);
  if (!Number.isFinite(positionId)) return null;
  const v = validatePolicyRow(positionId, {
    cohort: raw.cohort,
    profile: raw.profile ?? null,
    can_move_money: asFlag(raw.can_move_money) ?? false,
    can_write_config: asFlag(raw.can_write_config) ?? false,
    is_fleet: asFlag(raw.is_fleet) ?? false,
  });
  return v.ok ? v.row : null;
}

export async function loadPositionPolicyRow(
  env: Env,
  positionId: number,
): Promise<PositionPolicyRow | null> {
  const raw = await env.DB.prepare(
    `SELECT position_id, cohort, profile, can_move_money, can_write_config, is_fleet
       FROM position_policy WHERE position_id = ?`,
  )
    .bind(positionId)
    .first<Record<string, unknown>>();
  return policyRowFromDb(raw ?? null);
}

export async function loadAllPositionPolicyRows(env: Env): Promise<Map<number, PositionPolicyRow>> {
  const res = await env.DB.prepare(
    `SELECT position_id, cohort, profile, can_move_money, can_write_config, is_fleet
       FROM position_policy ORDER BY position_id`,
  ).all<Record<string, unknown>>();
  const out = new Map<number, PositionPolicyRow>();
  for (const raw of res.results ?? []) {
    const row = policyRowFromDb(raw);
    if (row) out.set(row.position_id, row);
  }
  return out;
}

/**
 * THE SEED — one row per production Title as of 2026-09-16, transcribed from
 * what the name-keyed rules resolved that day (positionPolicyRows.test.ts pins
 * that each row resolves byte-identically to its name, and that the SQL
 * migration carries exactly these tuples). By SLUG, which is stable; the
 * migration inserts `SELECT id FROM positions WHERE slug = ...`, so a slug this
 * environment lacks simply seeds nothing.
 */
export interface PositionPolicySeedEntry extends PositionPolicyInputRow {
  slug: string;
  /** The production name on 2026-09-16 — used by the parity test only. */
  name: string;
  department: string | null;
}

const seed = (
  slug: string,
  name: string,
  department: string | null,
  cohort: PositionCohort,
  profile: PositionProfile | null,
  flags: { money?: boolean; config?: boolean; fleet?: boolean } = {},
): PositionPolicySeedEntry => ({
  slug,
  name,
  department,
  cohort,
  profile,
  can_move_money: cohort === "god" ? true : flags.money ?? false,
  can_write_config: cohort === "god" ? true : flags.config ?? false,
  is_fleet: flags.fleet ?? false,
});

export const POSITION_POLICY_SEED: ReadonlyArray<PositionPolicySeedEntry> = [
  seed("super_admin", "Super Admin", "Management", "god", null),
  seed("owner", "Owner", "Management", "god", null),
  seed("managing_director", "Managing Director", "Management", "god", null),
  seed("hr_manager", "HR Manager", "HR Department", "full", null),
  seed("finance_manager", "Finance Manager", "Finance Department", "full", null, { money: true }),
  seed("it_developer_executive", "IT Developer Executive", "IT Department", "full", null),
  seed("service_admin", "Service Admin", "Operation Department", "full", null),
  seed("pg_wh_assistant", "PG WH Assistant", "Operation Department", "full", null),
  seed("ops_director", "Operation Manager", "Operation Department", "full", null, { config: true }),
  seed("ops_executive", "Operation Executive", "Operation Department", "full", null, { config: true }),
  seed("purchasing", "Procurement/Purchasing", "Operation Department", "full", null, { config: true }),
  seed("logistic", "Logistic Admin", "Operation Department", "full", null, { config: true }),
  seed("sales_director", "Sales Director", "Sales Department", "sales", "director"),
  seed("sales_manager", "Sales Manager", "Sales Department", "sales", "rep"),
  seed("sales_executive", "Sales Executive", "Sales Department", "sales", "rep"),
  seed("sales_person", "Sales Person", "Sales Department", "sales", "rep"),
  seed("storekeeper", "Storekeeper", "Operation Department", "restricted", "storekeeper"),
  seed("storekeeper_supervisor", "Storekeeper Supervisor", "Operation Department", "restricted", "storekeeper_supervisor"),
  seed("warehouse_crew_kl", "Warehouse Crew KL", "Operation Department", "restricted", "storekeeper"),
  seed("driver", "Driver", "Operation Department", "restricted", "driver_helper", { fleet: true }),
  seed("helper", "Helper", "Operation Department", "restricted", "driver_helper", { fleet: true }),
  seed("outsource_transporter", "Outsource Transporter", "Operation Department", "restricted", "driver_helper"),
  seed("calendar-viewer", "Calendar Viewer", "Management", "restricted", "calendar_viewer"),
];
