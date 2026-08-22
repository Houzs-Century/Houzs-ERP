import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { audit } from "../services/audit";
import {
  POSITION_CAPABILITY_DEFS,
  isValidPositionCapability,
} from "../services/positionCapabilities";

/* The editable Roles & Permissions matrix (owner 2026-08-22: "要界面可编辑").
 * Grants live in position_capabilities (PG mig 0318 / D1 150); the catalogue
 * of valid keys is code (services/positionCapabilities.ts). Page/menu access
 * is NOT edited here — that stays in positionPolicy.
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
  const rows = await c.env.DB.prepare(
    `SELECT position_id, capability
       FROM position_capabilities
      ORDER BY position_id, capability`,
  ).all<{ position_id: number; capability: string }>();
  return c.json({
    capabilities: POSITION_CAPABILITY_DEFS,
    grants: rows.results,
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
