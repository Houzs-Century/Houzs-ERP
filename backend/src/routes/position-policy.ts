import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { audit } from "../services/audit";
import {
  resolvePositionPolicy,
  positionGrantsWildcard,
} from "../services/positionPolicy";
import {
  POSITION_COHORTS,
  RESTRICTED_PROFILES,
  SALES_PROFILES,
  loadAllPositionPolicyRows,
  loadPositionPolicyRow,
  validatePolicyRow,
  type PositionPolicyRow,
} from "../services/positionPolicyRows";

/* Roles & Permissions › Titles (owner 2026-09-16, part B of the review): the
 * per-Title policy row — cohort, profile, money / config / fleet — that
 * services/positionPolicy.ts resolves from before its name-keyed fallback.
 * Reads ride users.read like the sibling matrix; writes need roles.manage and
 * are audited. The whitelists a profile names stay code. */

const app = new Hono<{ Bindings: Env }>();

type PositionRow = { id: number; name: string; slug: string; department_name: string | null; active: number };

type EffectivePolicy = {
  cohort: "god" | "full" | "restricted" | "sales";
  profile: string | null;
  can_move_money: boolean;
  can_write_config: boolean;
  is_fleet: boolean;
};

/** What a Title resolves to right now — from its row when it has one, else
 *  from the name rule (reported as `source: "name"` so the editor can show
 *  "not set — defaults to …"). A name-resolved Title has no profile the code
 *  can name, so it reads null there. */
function effectiveFor(p: PositionRow, row: PositionPolicyRow | null): { source: "row" | "name"; effective: EffectivePolicy } {
  if (row) {
    return {
      source: "row",
      effective: {
        cohort: row.cohort,
        profile: row.profile,
        can_move_money: row.can_move_money,
        can_write_config: row.can_write_config,
        is_fleet: row.is_fleet,
      },
    };
  }
  const god = positionGrantsWildcard(p.name, null);
  const policy = resolvePositionPolicy({ position_name: p.name, department_name: p.department_name }, null);
  return {
    source: "name",
    effective: {
      cohort: god ? "god" : policy.cohort,
      profile: null,
      can_move_money: god || policy.flags.canMoveMoney,
      can_write_config: god || policy.flags.canWriteConfig,
      is_fleet: false,
    },
  };
}

async function loadPosition(env: Env, id: number): Promise<PositionRow | null> {
  return env.DB.prepare(
    `SELECT p.id, p.name, p.slug, p.active, d.name AS department_name
       FROM positions p LEFT JOIN departments d ON d.id = p.department_id
      WHERE p.id = ?`,
  )
    .bind(id)
    .first<PositionRow>();
}

/** GET /api/position-policy — every Title with its row (if any) and what it
 *  resolves to, plus the vocabularies the editor renders. */
app.get("/", requirePermission("users.read"), async (c) => {
  const [positions, rows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.id, p.name, p.slug, p.active, d.name AS department_name
         FROM positions p LEFT JOIN departments d ON d.id = p.department_id
        ORDER BY p.id`,
    ).all<PositionRow>(),
    loadAllPositionPolicyRows(c.env),
  ]);
  return c.json({
    cohorts: POSITION_COHORTS,
    restricted_profiles: RESTRICTED_PROFILES,
    sales_profiles: SALES_PROFILES,
    positions: (positions.results ?? []).map((p) => {
      const row = rows.get(p.id) ?? null;
      return { id: p.id, name: p.name, slug: p.slug, department_name: p.department_name, active: !!p.active, row, ...effectiveFor(p, row) };
    }),
  });
});

/** PUT /api/position-policy/:positionId — set (upsert) one Title's row.
 *  Body: { cohort, profile, can_move_money, can_write_config, is_fleet }. */
app.put("/:positionId", requirePermission("roles.manage"), async (c) => {
  const positionId = parseInt(c.req.param("positionId"), 10);
  if (!Number.isFinite(positionId) || positionId <= 0)
    return c.json({ error: "Invalid position id." }, 400);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const v = validatePolicyRow(positionId, body);
  if (!v.ok) return c.json({ error: v.error }, 400);

  const position = await loadPosition(c.env, positionId);
  if (!position) return c.json({ error: "Position not found." }, 404);

  const before = await loadPositionPolicyRow(c.env, positionId);
  const row = v.row;
  await c.env.DB.prepare(
    `INSERT INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (position_id) DO UPDATE SET
       cohort = excluded.cohort,
       profile = excluded.profile,
       can_move_money = excluded.can_move_money,
       can_write_config = excluded.can_write_config,
       is_fleet = excluded.is_fleet,
       updated_by = excluded.updated_by,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      positionId,
      row.cohort,
      row.profile,
      row.can_move_money ? 1 : 0,
      row.can_write_config ? 1 : 0,
      row.is_fleet ? 1 : 0,
      c.get("user").id,
    )
    .run();

  await audit(c, {
    action: "position_policy.update",
    entityType: "position",
    entityId: positionId,
    summary: `Set policy of Title "${position.name}" to ${row.cohort}${row.profile ? ` / ${row.profile}` : ""}`,
    meta: { position: position.name, slug: position.slug, before, after: row },
  });

  const after = await loadPositionPolicyRow(c.env, positionId);
  return c.json({ ok: true, row: after, ...effectiveFor(position, after) });
});

/** DELETE /api/position-policy/:positionId — remove the row; the Title goes
 *  back to the name rule (reported as source "name" on the next GET). */
app.delete("/:positionId", requirePermission("roles.manage"), async (c) => {
  const positionId = parseInt(c.req.param("positionId"), 10);
  if (!Number.isFinite(positionId) || positionId <= 0)
    return c.json({ error: "Invalid position id." }, 400);
  const position = await loadPosition(c.env, positionId);
  if (!position) return c.json({ error: "Position not found." }, 404);
  const before = await loadPositionPolicyRow(c.env, positionId);
  if (!before) return c.json({ ok: true, row: null, ...effectiveFor(position, null) });
  await c.env.DB.prepare(`DELETE FROM position_policy WHERE position_id = ?`).bind(positionId).run();
  await audit(c, {
    action: "position_policy.reset",
    entityType: "position",
    entityId: positionId,
    summary: `Reset policy of Title "${position.name}" to the name rule`,
    meta: { position: position.name, slug: position.slug, before },
  });
  return c.json({ ok: true, row: null, ...effectiveFor(position, null) });
});

export default app;
