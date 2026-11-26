
import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { activeCompanyId, activeCompanySql } from "../lib/companyScope";
import { canonicalizeMyState } from "../lib/canonical-state";
import type { Env, Variables } from "../env";

export const venues = new Hono<{ Bindings: Env; Variables: Variables }>();
venues.use("*", supabaseAuth);

type VenueRow = {
  id: string;
  name: string;
  address: string | null;
  state: string | null;
  country: string | null;
  postcode: string | null;
  city: string | null;
  active: boolean;
  created_at: string;
};

function mapVenue(r: Record<string, unknown>): VenueRow {
  const idVal = (r.id ?? null) as number | string | null;
  const activeVal = (r.active ?? 1) as number | boolean;
  return {
    id: idVal != null ? String(idVal) : "",
    name: String(r.name ?? ""),
    address: (r.notes as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    postcode: (r.postcode as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    active: activeVal === 1 || activeVal === true,
    created_at: (r.created_at as string | null) ?? "",
  };
}

venues.get("/", async (c) => {
  const includeInactiveParam = c.req.query("includeInactive");
  const includeInactive =
    includeInactiveParam === "1" || includeInactiveParam === "true" ||
    c.req.query("active") === "false";
  const companyPred = activeCompanySql(c);
  const where = includeInactive
    ? `WHERE 1=1${companyPred}`
    : `WHERE active = 1${companyPred}`;
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, name, state, country, postcode, city, notes, active, created_at FROM project_venues
        ${where} ORDER BY name`,
    ).all<Record<string, unknown>>();
    const list = (rows.results ?? []).map(mapVenue);
    return c.json({ venues: list, data: list });
  } catch (e) {
    return c.json(
      { error: "load_failed", reason: (e as Error).message },
      500,
    );
  }
});

venues.post("/", async (c) => {
  /* company-scope: the reactivate branch UPDATEs by the id of a row found by the
     lookup above, which carries activeCompanySql(c); the INSERT branch stamps
     company_id explicitly. Both scoped — the checker anchors its window at the
     .prepare( line and cannot see a predicate composed above it.
     Verified 2026-08-13. */
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const name = String(body.name ?? "").trim();
  if (!name) return c.json({ error: "name_required" }, 400);
  const notes =
    (body.notes as string | null | undefined) ??
    (body.address as string | null | undefined) ??
    null;
  const state = canonicalizeMyState((body.state as string | null | undefined) ?? null);
  const country = typeof body.country === 'string' && body.country.trim()
    ? body.country.trim() : null;
  const postcode = typeof body.postcode === 'string' && body.postcode.trim()
    ? body.postcode.trim() : null;
  const city = typeof body.city === 'string' && body.city.trim()
    ? body.city.trim() : null;

  const companyPred = activeCompanySql(c);
  const existing = await c.env.DB.prepare(
    `SELECT id, name, state, country, postcode, city, notes, active, created_at FROM project_venues
      WHERE LOWER(name) = LOWER(?)${companyPred} LIMIT 1`,
  )
    .bind(name)
    .first<Record<string, unknown>>();

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE project_venues
          SET active   = 1,
              state    = COALESCE(?, state),
              country  = COALESCE(?, country),
              postcode = COALESCE(?, postcode),
              city     = COALESCE(?, city),
              notes    = COALESCE(?, notes)
        WHERE id = ?`,
    )
      .bind(state, country, postcode, city, notes, existing.id as number)
      .run();
    const v = mapVenue({
      ...existing,
      active: 1,
      state: state ?? existing.state,
      country: country ?? existing.country,
      postcode: postcode ?? existing.postcode,
      city: city ?? existing.city,
      notes: notes ?? existing.notes,
    });
    return c.json({ venue: v, id: v.id, name: v.name, state: v.state }, 200);
  }

  const houzsUser = c.get("houzsUser");
  const createdBy = houzsUser?.id != null ? Number(houzsUser.id) : null;
  const companyId = activeCompanyId(c) ?? null;
  const r = await c.env.DB.prepare(
    companyId != null
      ? `INSERT INTO project_venues (name, state, country, postcode, city, notes, created_by, company_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO project_venues (name, state, country, postcode, city, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(...(companyId != null
      ? [name, state, country, postcode, city, notes, createdBy, companyId]
      : [name, state, country, postcode, city, notes, createdBy]))
    .run();
  const newId = r.meta.last_row_id;
  const v = mapVenue({
    id: newId,
    name,
    state,
    country,
    postcode,
    notes,
    active: 1,
    created_at: "",
  });
  return c.json({ venue: v, id: v.id, name: v.name, state: v.state }, 201);
});

venues.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "invalid_id" }, 400);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("name" in body) {
    const next = String(body.name ?? "").trim();
    if (!next) return c.json({ error: "name_required" }, 400);
    sets.push("name = ?");
    binds.push(next);
  }
  if ("address" in body || "notes" in body) {
    const notes =
      (body.notes as string | null | undefined) ??
      (body.address as string | null | undefined) ??
      null;
    sets.push("notes = ?");
    binds.push(notes);
  }
  if ("state" in body) {
    sets.push("state = ?");
    binds.push(canonicalizeMyState((body.state as string | null | undefined) ?? null));
  }
  if ("country" in body) {
    const cv = typeof body.country === 'string' ? body.country.trim() : '';
    sets.push("country = ?");
    binds.push(cv || null);
  }
  if ("postcode" in body) {
    const pv = typeof body.postcode === 'string' ? body.postcode.trim() : '';
    sets.push("postcode = ?");
    binds.push(pv || null);
  }
  if ("city" in body) {
    const cy = typeof body.city === 'string' ? body.city.trim() : '';
    sets.push("city = ?");
    binds.push(cy || null);
  }
  if ("active" in body) {
    sets.push("active = ?");
    binds.push(body.active === false || body.active === 0 ? 0 : 1);
  }
  if (sets.length === 0) return c.json({ ok: true, changed: 0 });

  const companyPred = activeCompanySql(c);
  await c.env.DB.prepare(
    `UPDATE project_venues SET ${sets.join(", ")} WHERE id = ?${companyPred}`,
  )
    .bind(...binds, id)
    .run();
  return c.json({ ok: true });
});

venues.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "invalid_id" }, 400);
  const companyPred = activeCompanySql(c);
  await c.env.DB.prepare(
    `UPDATE project_venues SET active = 0 WHERE id = ?${companyPred}`,
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

export default venues;
