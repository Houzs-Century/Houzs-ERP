import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { audit } from "../services/audit";
import {
  POSITION_CAPABILITY_DEFS,
  isValidPositionCapability,
} from "../services/positionCapabilities";
import {
  SCM_OVERRIDE_KEYS,
  isValidOverrideKey,
  isValidOverrideLevel,
} from "../services/positionPageOverrides";
import {
  resolvePositionPolicy,
  positionGrantsWildcard,
} from "../services/positionPolicy";

/* The editable Roles & Permissions matrix (owner 2026-08-22: "要界面可编辑",
 * extended same day to 全部 SCM 模块). Two editable axes:
 *   - operational capabilities → position_capabilities (mig 0322/150)
 *   - SCM module access        → position_page_overrides (mig 0323/151),
 *     deltas over the code-defined positionPolicy baseline, composed at
 *     session hydration and enforced by the existing scmAreaGuard.
 * The catalogues of valid keys are code; the grants are data.
 *
 * Reads ride users.read (the matrix is org-shaped info, same tier as the
 * positions list); writes require roles.manage — the access-control edit
 * permission, which in practice is the owner tier. */

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/position-capabilities
 * The whole matrix: capability catalogue + every (position_id, capability)
 * grant row. Positions themselves come from GET /api/positions.
 */
app.get("/", requirePermission("users.read"), async (c) => {
  const [capRows, overrideRows, positionRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT position_id, capability
         FROM position_capabilities
        ORDER BY position_id, capability`,
    ).all<{ position_id: number; capability: string }>(),
    c.env.DB.prepare(
      `SELECT position_id, page_key, level
         FROM position_page_overrides
        ORDER BY position_id, page_key`,
    ).all<{ position_id: number; page_key: string; level: string }>(),
    c.env.DB.prepare(
      `SELECT p.id, p.name, d.name AS department_name
         FROM positions p
         LEFT JOIN departments d ON d.id = p.department_id`,
    ).all<{ id: number; name: string; department_name: string | null }>(),
  ]);

  // Per-position POLICY BASELINE for the SCM leaf keys — what the code-defined
  // policy answers before any stored override. The matrix renders this as the
  // inherited value; an override cell differs from it visibly. God positions
  // read as full everywhere (the wildcard bypasses the guard).
  const baselines: Record<number, Record<string, string>> = {};
  for (const p of positionRows.results) {
    const god = positionGrantsWildcard(p.name);
    const policy = god
      ? null
      : resolvePositionPolicy({
          position_name: p.name,
          department_name: p.department_name,
        });
    const map: Record<string, string> = {};
    for (const key of SCM_OVERRIDE_KEYS) {
      map[key] = god ? "full" : (policy?.pageAccess[key] ?? "none");
    }
    baselines[p.id] = map;
  }

  return c.json({
    capabilities: POSITION_CAPABILITY_DEFS,
    grants: capRows.results,
    scm_keys: SCM_OVERRIDE_KEYS,
    overrides: overrideRows.results,
    baselines,
  });
});

/**
 * PUT /api/position-capabilities/:positionId
 * Replace one position's capability set. Body: { capabilities: string[] }.
 * Unknown keys 400 (the catalogue is code — a typo cannot mint a capability).
 */
app.put("/:positionId", requirePermission("roles.manage"), async (c) => {
  const positionId = parseInt(c.req.param("positionId"), 10);
  if (!Number.isFinite(positionId) || positionId <= 0)
    return c.json({ error: "Invalid position id." }, 400);

  let body: { capabilities?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  if (!Array.isArray(body.capabilities))
    return c.json({ error: "Body must carry a capabilities array." }, 400);
  const requested = [...new Set(body.capabilities.map(String))];
  const invalid = requested.filter((k) => !isValidPositionCapability(k));
  if (invalid.length)
    return c.json({ error: `Unknown capability: ${invalid.join(", ")}` }, 400);

  const position = await c.env.DB.prepare(
    `SELECT id, name, slug FROM positions WHERE id = ?`,
  )
    .bind(positionId)
    .first<{ id: number; name: string; slug: string }>();
  if (!position) return c.json({ error: "Position not found." }, 404);

  const before = await c.env.DB.prepare(
    `SELECT capability FROM position_capabilities WHERE position_id = ? ORDER BY capability`,
  )
    .bind(positionId)
    .all<{ capability: string }>();
  const beforeKeys = before.results.map((r) => r.capability);

  const statements = [
    c.env.DB.prepare(`DELETE FROM position_capabilities WHERE position_id = ?`).bind(
      positionId,
    ),
    ...requested.map((key) =>
      c.env.DB.prepare(
        `INSERT INTO position_capabilities (position_id, capability, created_by) VALUES (?, ?, ?)`,
      ).bind(positionId, key, c.get("user").id),
    ),
  ];
  await c.env.DB.batch(statements);

  await audit(c, {
    action: "position.capabilities.update",
    entityType: "position",
    entityId: positionId,
    summary: `${position.name}: [${beforeKeys.join(", ")}] → [${requested.sort().join(", ")}]`,
    meta: { before: beforeKeys, after: requested },
  });

  return c.json({ position_id: positionId, capabilities: requested.sort() });
});

/**
 * PUT /api/position-capabilities/:positionId/pages
 * Replace one position's SCM page-override set. Body:
 *   { overrides: { "<scm leaf key>": "none"|"view"|"edit"|"full" } }
 * A key absent from the body has no override — the position inherits the
 * policy baseline there. Unknown keys and levels 400; targets are validated
 * against the catalogue-derived SCM leaf list, the exact keys scmAreaGuard
 * reads. God positions are refused: the wildcard bypasses the guard, so a
 * stored row there would be theatre.
 */
app.put("/:positionId/pages", requirePermission("roles.manage"), async (c) => {
  const positionId = parseInt(c.req.param("positionId"), 10);
  if (!Number.isFinite(positionId) || positionId <= 0)
    return c.json({ error: "Invalid position id." }, 400);

  let body: { overrides?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  if (body.overrides == null || typeof body.overrides !== "object" || Array.isArray(body.overrides))
    return c.json({ error: "Body must carry an overrides object." }, 400);
  const entries = Object.entries(body.overrides as Record<string, unknown>).map(
    ([key, level]) => [key, String(level)] as const,
  );
  const badKey = entries.find(([key]) => !isValidOverrideKey(key));
  if (badKey) return c.json({ error: `Unknown SCM page key: ${badKey[0]}` }, 400);
  const badLevel = entries.find(([, level]) => !isValidOverrideLevel(level));
  if (badLevel)
    return c.json({ error: `Invalid level "${badLevel[1]}" — use none/view/edit/full.` }, 400);

  const position = await c.env.DB.prepare(
    `SELECT id, name, slug FROM positions WHERE id = ?`,
  )
    .bind(positionId)
    .first<{ id: number; name: string; slug: string }>();
  if (!position) return c.json({ error: "Position not found." }, 404);
  if (positionGrantsWildcard(position.name))
    return c.json({ error: "Owner-tier positions always pass — nothing to override." }, 400);

  const before = await c.env.DB.prepare(
    `SELECT page_key, level FROM position_page_overrides WHERE position_id = ? ORDER BY page_key`,
  )
    .bind(positionId)
    .all<{ page_key: string; level: string }>();
  const beforeMap = Object.fromEntries(before.results.map((r) => [r.page_key, r.level]));

  const statements = [
    c.env.DB.prepare(`DELETE FROM position_page_overrides WHERE position_id = ?`).bind(
      positionId,
    ),
    ...entries.map(([key, level]) =>
      c.env.DB.prepare(
        `INSERT INTO position_page_overrides (position_id, page_key, level, updated_by) VALUES (?, ?, ?, ?)`,
      ).bind(positionId, key, level, c.get("user").id),
    ),
  ];
  await c.env.DB.batch(statements);

  const afterMap = Object.fromEntries(entries);
  await audit(c, {
    action: "position.page_overrides.update",
    entityType: "position",
    entityId: positionId,
    summary: `${position.name}: ${Object.keys(beforeMap).length} → ${entries.length} SCM override(s)`,
    meta: { before: beforeMap, after: afterMap },
  });

  return c.json({ position_id: positionId, overrides: afterMap });
});

export default app;
