import type { Env } from "../types";
import { hasPermission } from "./permissions";

/**
 * Who may act on a project's checklist — the owner's people rules, extracted
 * from routes/projects.ts (2026-08-14, file-size ratchet).
 *
 * These are the four gates the checklist routes apply on top of the permission
 * middleware: crew scoping, the brand-scoped approver split, the Sales Director
 * floorplan exception, and the two-warehouse defect-review split. They are the
 * rules most likely to be re-read and re-argued, so they live together rather
 * than scattered through a 5,000-line route file.
 */

// Owner 2026-07-21: helpers/storekeepers are CREW-SCOPED — they may view/edit
// only events they're crewed on (setup/dismantle FK slots or the per-lorry
// crew JSON). Matched on the EXACT position name (never \b substrings —
// position names are owner-editable free text; see the pmsAccess note).
// Drivers intentionally stay unscoped (owner kept them see-all).
const CREW_SCOPED_POSITIONS = new Set(["helper", "storekeeper", "storekeeper supervisor"]);

// Two-warehouse defect-review split (owner 2026-08-11). Projects in these
// (canonical, Title-Case) states go to Nancy (Ops Exec) for clean-or-replace;
// every other state goes to Shukor (Storekeeper Supervisor) — Sabah and Sarawak
// among them (owner 2026-08-14). Both escalate a Replace to the purchaser (Sim
// / Farra). "Penang" canonicalises to "Pulau Pinang" (mig 0175), so match that
// spelling.
export const DEFECT_REVIEW_REGION_STATES = ["Pulau Pinang", "Kelantan", "Terengganu", "Perak"];

export function isCrewScopedUser(
  user:
    | { position_name?: string | null; permissions?: string[]; permissions_set?: Set<string> | string[] }
    | null
    | undefined,
): boolean {
  if (!user) return false;
  const granted = (user as any).permissions_set ?? user.permissions;
  if (hasPermission(granted, "*") || hasPermission(granted, "projects.write")) return false;
  const pos = (user.position_name ?? "").trim().toLowerCase();
  // Owner 2026-08-28: the admin-created regional warehouse-crew positions
  // ("Warehouse Crew KL", …) carry the whole helper/storekeeper cohort now —
  // prefix match, mirroring positionPolicy.isWarehouseCrewPosition.
  return CREW_SCOPED_POSITIONS.has(pos) || pos.startsWith("warehouse crew");
}

/** Is this project's state reviewed by the region warehouse (Ops Exec)? */
export function isDefectRegionState(state: string | null | undefined): boolean {
  const s = (state ?? "").trim().toLowerCase();
  return DEFECT_REVIEW_REGION_STATES.some((r) => r.toLowerCase() === s);
}

/** BRAND-SCOPED APPROVAL (owner 2026-08-10: "kris approve stock out transfer
 *  akemi and ergotex only, for zanotti peter approve").
 *
 *  Returns the offending brands when the caller holds the approval key but is
 *  configured for specific brands and THIS item's project isn't one of them;
 *  null when the decision may proceed. An approver with NO `user_brands` rows
 *  (Peter, HQ, the owner) is unrestricted — so this narrows only the people it
 *  is explicitly configured for and can never lock out an existing approver.
 *  Reuses `user_brands`, the per-user brand allow-list the app already keeps.
 *  This is the approval-lane brand split only — it narrows WHICH brands'
 *  approvals a configured director sees; it does NOT affect project
 *  visibility, which is no longer brand-scoped at all (ACL removed 2026-08-19). */
export async function approverBrandBlocked(
  env: Env,
  userId: number | null | undefined,
  itemId: number,
): Promise<{ brands: string[]; brand: string } | null> {
  if (!userId) return null;
  const rows = await env.DB.prepare(`SELECT brand FROM user_brands WHERE user_id = ?`)
    .bind(userId)
    .all<{ brand: string }>();
  const brands = (rows.results ?? []).map((r) => (r.brand ?? "").trim()).filter(Boolean);
  if (brands.length === 0) return null; // unrestricted approver
  const proj = await env.DB.prepare(
    `SELECT p.brand FROM project_checklist pc
       JOIN projects p ON p.id = pc.project_id
      WHERE pc.id = ?`
  )
    .bind(itemId)
    .first<{ brand: string | null }>();
  const brand = (proj?.brand ?? "").trim();
  if (brand && brands.some((b) => b.toUpperCase() === brand.toUpperCase())) return null;
  return { brands, brand };
}

/** Owner 2026-08-10: "kris can upload fill in floorplan". The Filled Floorplan
 *  is the competitor-research plan the Sales Director annotates, but the row is
 *  badged SALES PIC, so the role-badge rule blocked a view-only Sales Director
 *  (no projects.write). Narrow exception: the Sales Director POSITION may
 *  attach to / remove from that ONE document. Everything else still obeys the
 *  badge — this does not open the other SALES PIC deliverables. */
export function salesDirectorMayAttach(
  title: string | null | undefined,
  positionName: string | null | undefined,
): boolean {
  const pos = (positionName ?? "").trim().toLowerCase();
  if (pos !== "sales director") return false;
  return /^filled floor\s*plan/i.test((title ?? "").trim());
}

/** Does the task's role badge admit this user's role? Exact match, plus:
 *  DRIVER-badged field tasks (Setup/Dismantle Image) are worked by the whole
 *  crew interchangeably — helpers/storekeepers are not individually assigned to
 *  events (last-minute swaps), so they edit the driver part too (owner
 *  2026-07-16). Tasks are never badged HELPER/STOREKEEPER. */
export function roleLabelAdmits(
  label: string | null | undefined,
  roleName: string | null | undefined,
): boolean {
  const r = (roleName ?? "").trim().toUpperCase();
  if (!r) return false;
  // A combined badge ("SALES PIC & DRIVER" — the Defect List Setup/Dismantle
  // pair, owner 2026-07-29) admits every listed role; each part keeps the
  // DRIVER → helper/storekeeper extension.
  return (label ?? "")
    .toUpperCase()
    .split("&")
    .some((part) => {
      const l = part.trim();
      return !!l && (l === r || (l === "DRIVER" && (r === "HELPER" || r === "STOREKEEPER")));
    });
}
