import type { Env } from "../types";
import type { AuthUser } from "./auth";
import { hasPermission } from "./permissions";
import { isDirectorUser } from "./pmsAccess";
import { subtreeUserIds, subtreeAgentNames } from "./orgScope";

/**
 * WHO may see WHICH service case, and what gets stripped from it.
 *
 * This lived inline in `routes/assr.ts`, which meant `GET /api/assr/:id` had the
 * rule and `GET /api/assr-print/:id` — which emits the same case content as a
 * letterheaded document — did not. A visibility-scoped salesperson could render
 * any case in their own company by walking the id, and see the supplier identity
 * the JSON route withholds from them. A rule enforced on one of two routes that
 * emit the same content is not enforced, so it lives here now and both call it.
 *
 * `services/` cannot import from `routes/`, which is the other reason: this is
 * the only direction that composes.
 */
// ── Row-level visibility (owner spec 2026-07) ─────────────────
// Full view = `*` wildcard (Owner / IT Admin) or `service_cases.manage`
// (the existing admin-tier ASSR key — no new permission invented), OR a
// director by STABLE ORG FIELD (Owner/IT `*`, Super Admin, Sales Director,
// Finance Manager) — owner rule "Director sees ALL". Everyone else sees only
// cases they CREATED or are ASSIGNED TO (plus their users.manager_id downline,
// full depth — services/orgScope.ts), AND legacy cases whose free-text
// sales_agent matches a downline member's name (assrVisibleAgentNames).
//
// This tier predicate is shared by the id-scope and the agent-name-scope
// resolvers so the two can never disagree on who is unrestricted.
export function assrUnrestricted(user: AuthUser | undefined): boolean {
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  return (
    hasPermission(granted, "*") ||
    hasPermission(granted, "service_cases.manage") ||
    isDirectorUser(user)
  );
}

export async function assrVisibleUserIds(c: {
  get(key: "user"): unknown;
  env: Env;
}): Promise<number[] | undefined> {
  const user = c.get("user") as AuthUser | undefined;
  if (assrUnrestricted(user)) return undefined; // unrestricted
  if (user?.id == null) return []; // fail closed, never open
  return subtreeUserIds(c.env, Number(user.id));
}

// Companion to assrVisibleUserIds for the LEGACY free-text `sales_agent` field:
// the display names of the caller's reporting subtree. OLD cases predate the
// created_by/assigned_to id linkage, so a scoped salesperson (and their upline)
// reach their own old cases only by name. undefined = unrestricted (same tier
// as the id resolver); [] = no resolvable identity (fail closed).
export async function assrVisibleAgentNames(c: {
  get(key: "user"): unknown;
  env: Env;
}): Promise<string[] | undefined> {
  const user = c.get("user") as AuthUser | undefined;
  if (assrUnrestricted(user)) return undefined; // unrestricted
  if (user?.id == null) return []; // fail closed, never open
  return subtreeAgentNames(c.env, Number(user.id));
}

// Supplier identity (creditor fields) is office + supplier-portal only
// (Nick 2026-07-15: 这个我要 office, supplier 看到而已) — sales-scoped
// callers get case payloads without it. assrVisibleUserIds() returning
// undefined marks an unrestricted (office) caller; an id list marks a
// sales-scoped one. Dual-named keys because the PG driver camelCases
// result columns.
const CREDITOR_KEYS = [
  "creditor_code", "creditorCode",
  "creditor_name", "creditorName",
  "creditor_email", "creditorEmail",
  "creditor_phone", "creditorPhone",
  "creditor_mobile", "creditorMobile",
  "creditor_attention", "creditorAttention",
  "creditor_source", "creditorSource",
] as const;
export function stripCreditorFields(row: Record<string, any> | null | undefined): void {
  if (!row) return;
  for (const k of CREDITOR_KEYS) {
    if (k in row) delete row[k];
  }
}

/**
 * Row-level visibility for ONE case — "may this caller see this case at all?".
 *
 * Exported because the PRINT route needs the identical answer and did not have
 * it. `GET /api/assr/:id` applied this rule; `GET /api/assr-print/:id` applied
 * only the company check, so a visibility-scoped salesperson could render any
 * case in their own company as a letterheaded document — customer name, phone,
 * address, the inlined attachments, and the supplier identity that
 * stripCreditorFields withholds from them on the JSON route. A rule enforced on
 * one of two routes that emit the same content is not enforced.
 *
 * Returns `true` for an unrestricted (office) caller — `assrVisibleUserIds`
 * answers `undefined` for them, which is the same three-state sentinel the list
 * uses. Dual-read camelCase ?? snake_case: the PG driver camelCases columns.
 */
export async function assrCaseRowInScope(
  c: Parameters<typeof assrVisibleUserIds>[0] & { req: any },
  row: Record<string, any> | null | undefined,
): Promise<boolean> {
  const visibleIds = await assrVisibleUserIds(c);
  if (visibleIds === undefined) return true;
  if (!row) return false;
  const createdBy = Number(row.createdBy ?? row.created_by ?? NaN);
  const assignedTo = Number(row.assignedTo ?? row.assigned_to ?? NaN);
  // Co-assignee (assigned_to_2) — the LIST scopes on it too (services/assr.ts),
  // so a co-assignee who sees the case in their list must be able to open it.
  const assignedTo2 = Number(row.assignedTo2 ?? row.assigned_to_2 ?? NaN);
  if (
    (Number.isFinite(createdBy) && visibleIds.includes(createdBy)) ||
    (Number.isFinite(assignedTo) && visibleIds.includes(assignedTo)) ||
    (Number.isFinite(assignedTo2) && visibleIds.includes(assignedTo2))
  ) return true;
  // Legacy agent-name reach — mirrors the list scope so an old case that shows
  // in the salesperson's list (matched on sales_agent) also opens.
  const agent = String(row.salesAgent ?? row.sales_agent ?? "").trim().toLowerCase();
  if (!agent) return false;
  const names = await assrVisibleAgentNames(c as any);
  return names === undefined || names.some((n) => agent.includes(n));
}

/** Is this caller visibility-RESTRICTED (i.e. must not see supplier identity)? */
export async function assrCallerIsScoped(
  c: Parameters<typeof assrVisibleUserIds>[0],
): Promise<boolean> {
  return (await assrVisibleUserIds(c)) !== undefined;
}
