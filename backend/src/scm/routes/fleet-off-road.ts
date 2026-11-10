/* Off the road — staff take a lorry out of service and put it back, from the lorry.

   scm.lorry_maintenance (mig 0053) has always been the availability table: Fleet
   Health's OUT_OF_SERVICE status, the delivery-planning fleet board and Lorry
   Capacity's repair days all read it. Until this file only two machines wrote it
   (a scheduled lorry-service DP job, and Repair Days on Lorry Capacity), so a
   lorry that went to the workshop unplanned could not be marked anywhere.

   The table holds DATES, both NOT NULL, and no "ended" column. Two consequences,
   chosen so no reader has to change:
   - no expected return is stored as OPEN_ENDED_TO, a far date every reader's
     `from <= day <= to` test already treats as "still off";
   - "back on the road" makes the lorry usable TODAY: a window that began before
     today ends yesterday; one that begins today or later never covered a whole
     day and is removed (the audit row keeps what it was).

   Windows written by a DP job or by Repair Days are owned by those screens and
   are refused here: the DP cancel and the Repair Days editor find their rows by
   the reason string, so changing them from here would desync the owner.

   Kept out of fleet-maintenance.ts, which is at its file-size ceiling; mounted on
   the same prefix in index.ts. */
import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { requireHouzsPerm } from "../lib/houzs-perms";
import { activeCompanyId } from "../lib/companyScope";
import { todayMyt } from "../lib/my-time";
import { recordEntityAudit } from "../lib/entity-audit";
import { resolveCallerStaffId } from "../lib/salesScope";
import { isDpLorryBlock } from "../lib/dp-lorry-block";
import type { Env, Variables } from "../env";

export const fleetOffRoad = new Hono<{ Bindings: Env; Variables: Variables }>();

export const OPEN_ENDED_TO = "9999-12-31";
/* lorry-capacity.ts DASHBOARD_REASON; not exported there. */
const REPAIR_DAYS_REASON = "Repair days (dashboard)";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export type OffRoadSource = "manual" | "dp_job" | "repair_days";
export function offRoadSource(reason: string | null | undefined): OffRoadSource {
  if (isDpLorryBlock(reason)) return "dp_job";
  if ((reason ?? "") === REPAIR_DAYS_REASON) return "repair_days";
  return "manual";
}

type WindowRow = { id: string; lorry_id: string; unavailable_from: string; unavailable_to: string; reason: string | null; created_at?: string | null };
const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null);
function shape(w: WindowRow) {
  const to = day(w.unavailable_to);
  return { id: w.id, from: day(w.unavailable_from), to: to === OPEN_ENDED_TO ? null : to, openEnded: to === OPEN_ENDED_TO, reason: w.reason ?? null, source: offRoadSource(w.reason) };
}
const COLS = "id, lorry_id, unavailable_from, unavailable_to, reason, created_at";

fleetOffRoad.get("/vehicles/:id/off-road", supabaseAuth, requireHouzsPerm("fleet.read"), async (c) => {
  // company-scope: unified fleet - see the UNIFIED FLEET note above inHouseLorries (fleet-maintenance.ts). A grounded lorry is grounded for both companies' dispatchers (lorry-capacity.ts PUT /repair-days says the same for this table).
  const { data, error } = await c.get("supabase").from("lorry_maintenance").select(COLS).eq("lorry_id", c.req.param("id")).order("unavailable_from", { ascending: false });
  if (error) return c.json({ error: "load_failed", reason: error.message }, 500);
  return c.json({ today: todayMyt(), windows: (data as WindowRow[]).map(shape) });
});

fleetOffRoad.post("/vehicles/:id/off-road", supabaseAuth, requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - company_id is stamped for provenance only, as on every fleet table.
  const sb = c.get("supabase");
  const lorryId = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid_json" }, 400); }

  const from = String(body.from ?? "").trim();
  if (!ISO.test(from)) return c.json({ error: "invalid_from", reason: "Enter the day it goes off the road." }, 400);
  const expected = body.expectedReturn == null ? "" : String(body.expectedReturn).trim();
  if (expected !== "" && !ISO.test(expected)) return c.json({ error: "invalid_expected_return", reason: "The expected return is not a date." }, 400);
  if (expected !== "" && expected < from) return c.json({ error: "return_before_start", reason: "The expected return cannot be before the day it goes off the road." }, 400);
  const reason = String(body.reason ?? "").trim();
  if (!reason) return c.json({ error: "reason_required", reason: "Say why it is off the road." }, 400);
  if (reason.length > 500) return c.json({ error: "reason_too_long", reason: "Keep the reason under 500 characters." }, 400);
  if (offRoadSource(reason) !== "manual") return c.json({ error: "reserved_reason", reason: "That wording is used by lorry service jobs and Repair Days. Describe it in your own words." }, 400);

  const { data: lorry, error: lErr } = await sb.from("lorries").select("id, plate").eq("id", lorryId).maybeSingle();
  if (lErr) return c.json({ error: "load_failed", reason: lErr.message }, 500);
  if (!lorry) return c.json({ error: "vehicle_not_found" }, 404);

  const houzsUser = c.get("houzsUser");
  const companyId = activeCompanyId(c) ?? null;
  const row = {
    id: crypto.randomUUID(),
    company_id: companyId,
    lorry_id: lorryId,
    unavailable_from: from,
    unavailable_to: expected || OPEN_ENDED_TO,
    reason,
    created_by: await resolveCallerStaffId(sb, houzsUser?.id ?? null),
  };
  const { error } = await sb.from("lorry_maintenance").insert(row);
  if (error) return c.json({ error: "insert_failed", reason: error.message }, 500);

  await recordEntityAudit(sb, {
    entityType: "LORRY_OFF_ROAD", entityId: row.id, entityDocNo: (lorry as { plate?: string | null }).plate ?? null, action: "CREATE",
    actor: houzsUser, companyId, statusSnapshot: "OFF_ROAD",
    fieldChanges: [
      { field: "unavailable_from", from: null, to: from },
      { field: "expected_return", from: null, to: expected || null },
      { field: "reason", from: null, to: reason },
    ],
  });
  return c.json({ ok: true, window: shape({ ...row, unavailable_to: row.unavailable_to }) }, 201);
});

fleetOffRoad.patch("/off-road/:windowId/end", supabaseAuth, requireHouzsPerm("fleet.write"), async (c) => {
  // company-scope: unified fleet - by id, no company predicate: either company's fleet staff may put a shared lorry back on the road.
  const sb = c.get("supabase");
  const windowId = c.req.param("windowId");
  const { data, error } = await sb.from("lorry_maintenance").select(COLS).eq("id", windowId).maybeSingle();
  if (error) return c.json({ error: "load_failed", reason: error.message }, 500);
  if (!data) return c.json({ error: "window_not_found" }, 404);
  const w = data as WindowRow;
  const source = offRoadSource(w.reason);
  if (source === "dp_job") return c.json({ error: "owned_by_dp_job", reason: "A lorry service job set this. Cancel or move the job in Delivery Planning instead." }, 409);
  if (source === "repair_days") return c.json({ error: "owned_by_repair_days", reason: "Repair Days on Lorry Capacity set this. Change it there instead." }, 409);

  const today = todayMyt();
  const from = day(w.unavailable_from)!, to = day(w.unavailable_to)!;
  if (to < today) return c.json({ error: "already_ended", reason: "This lorry is already back on the road for that window." }, 409);

  const yesterday = todayMyt(-1);
  const ended = from < today;
  const { error: wErr } = ended
    ? await sb.from("lorry_maintenance").update({ unavailable_to: yesterday }).eq("id", windowId)
    : await sb.from("lorry_maintenance").delete().eq("id", windowId);
  if (wErr) return c.json({ error: "update_failed", reason: wErr.message }, 500);

  await recordEntityAudit(sb, {
    entityType: "LORRY_OFF_ROAD", entityId: windowId, action: ended ? "UPDATE" : "DELETE",
    actor: c.get("houzsUser"), companyId: activeCompanyId(c) ?? null, statusSnapshot: "BACK_ON_ROAD",
    fieldChanges: ended
      ? [{ field: "unavailable_to", from: to, to: yesterday }]
      : [{ field: "unavailable_from", from, to: null }, { field: "unavailable_to", from: to, to: null }, { field: "reason", from: w.reason, to: null }],
    note: ended ? undefined : "Removed: it had not started before today.",
  });
  return c.json({ ok: true, outcome: ended ? "ended" : "removed", window: ended ? shape({ ...w, unavailable_to: yesterday }) : null });
});
