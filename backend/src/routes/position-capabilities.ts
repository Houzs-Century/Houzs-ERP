import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { audit } from "../services/audit";
import {
  POSITION_CAPABILITY_DEFS,
  isValidPositionCapability,
} from "../services/positionCapabilities";
import {
  resolvePositionPolicy,
  positionGrantsWildcard,
} from "../services/positionPolicy";
import {
  loadAllPositionPolicyRows,
  loadPositionPolicyRow,
} from "../services/positionPolicyRows";

/* The Actions matrix on Roles & Permissions (owner 2026-08-22: "要界面可编辑"):
 * operational capabilities per Title → position_capabilities (mig 0322/150).
 * The catalogue of valid keys is code; the grants are data. The SCM page
 * override axis that used to share this router was removed on 2026-09-16
 * (never used; the Titles cohort answers page access).
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
  const [capRows, positionRows, policyRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT position_id, capability
         FROM position_capabilities
        ORDER BY position_id, capability`,
    ).all<{ position_id: number; capability: string }>(),
    c.env.DB.prepare(
      `SELECT p.id, p.name, d.name AS department_name
         FROM positions p
         LEFT JOIN departments d ON d.id = p.department_id`,
    ).all<{ id: number; name: string; department_name: string | null }>(),
    loadAllPositionPolicyRows(c.env),
  ]);


  // The owner-tier answer per Title (by its policy row, then by name for a
  // Title with no row) so the matrix can lock those rows on.
  const god = Object.fromEntries(
    positionRows.results.map((p) => [p.id, positionGrantsWildcard(p.name, policyRows.get(p.id) ?? null)]),
  );
  return c.json({
    capabilities: POSITION_CAPABILITY_DEFS,
    grants: capRows.results,
    god,
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

export default app;
