// ----------------------------------------------------------------------------
// brandShare — the OFFICE side of a brand's public calendar link: generate
// (get-or-create) or revoke the unguessable token behind /b/<token>
// (routes/publicBrandCalendar.ts). Mounted at /api/brand-share, behind `auth`.
//
// Lives in its own file rather than beside the brands routes in
// routes/projects.ts because that file is at its size ceiling
// (scripts/file-size-ceilings.json) — same permissions as the contractor
// twin there (`projects.write` to copy, `projects.manage` to revoke).
//
// Minted against the brand NAME — the value projects.brand stores and the
// public route filters on — so a rename would need a fresh link, which is
// correct: the old link would otherwise keep showing the old name's events.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { activeCompanySql } from "../scm/lib/companyScope";
import { issueBrandShareToken, revokeBrandShareTokens } from "../services/brandShare";

export const brandShare = new Hono<{ Bindings: Env }>();

/** The brand row, scoped to the caller's company the way GET /brands is
 *  (activeCompanySql degrades to no predicate when unresolved). */
async function brandName(c: Context<{ Bindings: Env }>, id: number): Promise<string | null> {
  const coSql = activeCompanySql(c);
  const row = await c.env.DB.prepare(
    `SELECT name FROM project_brands WHERE id = ?${coSql}`
  )
    .bind(id)
    .first<{ name: string }>();
  return row?.name ?? null;
}

brandShare.post("/:id/share-link", requirePermission("projects.write"), async (c) => {
  const user = c.get("user");
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const name = await brandName(c, id);
  if (!name) return c.json({ error: "Brand not found" }, 404);
  const token = await issueBrandShareToken(c.env, name, user?.id ?? null);
  return c.json({ token });
});

brandShare.delete("/:id/share-link", requirePermission("projects.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const name = await brandName(c, id);
  if (!name) return c.json({ error: "Brand not found" }, 404);
  await revokeBrandShareTokens(c.env, name);
  return c.json({ ok: true });
});
