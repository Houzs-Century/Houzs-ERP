import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { hashPassword } from "../services/auth";
import { bustUserSessions } from "../services/sessionCache";
import { audit } from "../services/audit";
import { targetWithinActorCompanies } from "./lib/actor-company-gate";
import {
  FIELD_PIN_DELETE_SQL,
  FIELD_PIN_UPSERT_SQL,
  FIELD_SESSIONS_DELETE_SQL,
  fieldPinProblem,
  isFieldPinEligible,
  isLocked,
  staffCodeFitsFieldLogin,
} from "../services/fieldPin";
import type { PositionCohort, PositionProfile } from "../services/positionPolicyRows";

/**
 * /api/field-pin — Team › member profile, "Crew PIN sign-in" card.
 *
 *   GET    /:userId   status: eligible?, the login to hand over, PIN set?, locked?
 *   POST   /:userId   { pin }  set or replace the PIN (also lifts a lock)
 *   DELETE /:userId   remove the PIN
 *
 * users.manage on all three — the same key every other credential action on a
 * member needs. A PIN is a way into someone's account, so setting or removing
 * one is an account-takeover action and carries the same company rule as
 * reset-password and impersonate: the member's companies must sit inside the
 * actor's (targetWithinActorCompanies). The PIN is never returned or logged;
 * the server keeps a PBKDF2 hash (hashPassword, the password algorithm).
 *
 * Setting or removing a PIN ends the member's live PIN sessions, so a PIN handed
 * to the wrong person stops working the moment the office replaces it.
 */

export type StatusRow = {
  id: number;
  status: string;
  staff_code: string | null;
  cohort: PositionCohort | null;
  profile: PositionProfile | null;
  has_pin: boolean | number | null;
  failed_count: number | null;
  locked_until: string | Date | null;
  set_at: string | Date | null;
};

export type FieldPinStatus = {
  eligible: boolean;
  reason: "ok" | "not_crew_title" | "no_staff_code" | "staff_code_shape" | "inactive";
  login: string | null;
  hasPin: boolean;
  locked: boolean;
  lockedUntil: string | null;
  setAt: string | null;
};

const iso = (v: string | Date | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

export function fieldPinStatusOf(row: StatusRow, now: number): FieldPinStatus {
  const crew = isFieldPinEligible(row.cohort && { cohort: row.cohort, profile: row.profile });
  const reason: FieldPinStatus["reason"] = !crew
    ? "not_crew_title"
    : !row.staff_code
      ? "no_staff_code"
      : !staffCodeFitsFieldLogin(row.staff_code)
        ? "staff_code_shape"
        : row.status !== "active"
          ? "inactive"
          : "ok";
  return {
    eligible: reason === "ok",
    reason,
    login: row.staff_code,
    hasPin: !!row.has_pin,
    locked: isLocked(row.locked_until, now),
    lockedUntil: iso(row.locked_until),
    setAt: iso(row.set_at),
  };
}

async function readStatusRow(env: Env, userId: number): Promise<StatusRow | null> {
  return env.DB.prepare(
    `SELECT u.id, u.status, s.staff_code, pp.cohort, pp.profile,
            (fp.user_id IS NOT NULL) AS has_pin, fp.failed_count, fp.locked_until, fp.set_at
       FROM users u
       LEFT JOIN scm.staff s ON s.user_id = u.id
       LEFT JOIN position_policy pp ON pp.position_id = u.position_id
       LEFT JOIN field_pins fp ON fp.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<StatusRow>();
}

function parseUserId(c: Context<{ Bindings: Env }>): number | null {
  const id = Number(c.req.param("userId"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function endFieldSessions(env: Env, userId: number): Promise<void> {
  await bustUserSessions(env, userId);
  await env.DB.prepare(FIELD_SESSIONS_DELETE_SQL).bind(userId).run();
}

const app = new Hono<{ Bindings: Env }>();

app.get("/:userId", requirePermission("users.manage"), async (c) => {
  const userId = parseUserId(c);
  if (!userId) return c.json({ error: "Invalid member." }, 400);
  const row = await readStatusRow(c.env, userId);
  if (!row) return c.json({ error: "Member not found." }, 404);
  return c.json(fieldPinStatusOf(row, Date.now()));
});

app.post("/:userId", requirePermission("users.manage"), async (c) => {
  const userId = parseUserId(c);
  if (!userId) return c.json({ error: "Invalid member." }, 400);
  let body: { pin?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Send the new PIN." }, 400);
  }
  const problem = fieldPinProblem(body.pin);
  if (problem) return c.json({ error: problem, code: "field_pin_weak" }, 400);

  const gate = await targetWithinActorCompanies(c, userId);
  if (!gate.ok) return c.json(gate.body, 403);
  const row = await readStatusRow(c.env, userId);
  if (!row) return c.json({ error: "Member not found." }, 404);
  const status = fieldPinStatusOf(row, Date.now());
  if (!status.eligible) {
    return c.json({ error: refusalText(status), code: `field_pin_${status.reason}` }, 409);
  }

  const actor = c.get("user");
  await c.env.DB.prepare(FIELD_PIN_UPSERT_SQL)
    .bind(userId, await hashPassword(body.pin as string), actor.id)
    .run();
  await endFieldSessions(c.env, userId);
  await audit(c, {
    action: status.hasPin ? "user.field_pin.replace" : "user.field_pin.set",
    entityType: "user",
    entityId: userId,
    summary: `${status.hasPin ? "Replaced" : "Set"} crew PIN for ${status.login}`,
    meta: { staff_code: status.login, was_locked: status.locked },
  });
  return c.json({ ok: true, login: status.login });
});

app.delete("/:userId", requirePermission("users.manage"), async (c) => {
  const userId = parseUserId(c);
  if (!userId) return c.json({ error: "Invalid member." }, 400);
  const gate = await targetWithinActorCompanies(c, userId);
  if (!gate.ok) return c.json(gate.body, 403);
  const row = await readStatusRow(c.env, userId);
  if (!row) return c.json({ error: "Member not found." }, 404);
  await c.env.DB.prepare(FIELD_PIN_DELETE_SQL).bind(userId).run();
  await endFieldSessions(c.env, userId);
  await audit(c, {
    action: "user.field_pin.clear",
    entityType: "user",
    entityId: userId,
    summary: `Removed crew PIN for ${row.staff_code ?? `user ${userId}`}`,
    meta: { staff_code: row.staff_code, had_pin: !!row.has_pin },
  });
  return c.json({ ok: true });
});

export function refusalText(s: FieldPinStatus): string {
  switch (s.reason) {
    case "not_crew_title":
      return "Crew PIN sign-in is only for members whose Title is a Driver / Helper Title (Roles & Permissions › Titles).";
    case "no_staff_code":
      return "This member has no staff code yet, so there is nothing to sign in with.";
    case "staff_code_shape":
      return `This member's staff code (${s.login}) does not start with EMP-, so it cannot be typed on the crew sign-in screen.`;
    case "inactive":
      return "This member is not active.";
    default:
      return "";
  }
}

export default app;
