// ----------------------------------------------------------------------------
// /venues — venue master CRUD for the cutover 2990 POS (GitHub #389).
//
// CONTRACT GAP: the 2990 POS (apps/pos queries.ts) calls /api/scm/venues
// (GET/POST/PATCH/DELETE) as a venue master. Houzs never mounted that route, so
// the direct call 404'd.
//
// SOURCE OF TRUTH — public.project_venues (NOT scm.so_dropdown_options, NOT the
// empty scm.venues uuid table). The Houzs frontend already re-sourced its venue
// picker to the Project Maintenance master (see
// frontend/src/vendor/scm/lib/venues-queries.ts: "Venues are maintained
// CENTRALLY in Houzs's Project Maintenance / PMS, not in the SCM"), and the SO
// venue auto-fill (mfg-sales-orders active-venue) reads project_venues too.
// Adapting /api/scm/venues over the SAME master gives the POS the identical
// venue list the Houzs UI + PMS see — genuine ONE source of truth. It also
// mirrors the proven /api/projects/venues handlers (routes/projects.ts).
//
// This is the task's "closest faithful version" escape hatch: the 2990 venues
// table has an `address` column that so_dropdown_options can't hold, and
// project_venues (INTEGER ids) — not so_dropdown_options — is the actual Houzs
// venue master the SO flow binds to.
//
// SHAPE — mapped onto the 2990 SCM VenueRow contract the vendored consumers
// expect: { id:string, name, address(=notes), state, active, created_at }.
//
// project_venues lives in the PUBLIC schema (unreachable by the scm supabase
// client), so all queries go through c.env.DB — exactly like the active-venue
// lookup in mfg-sales-orders.ts. company_2 scoping uses the raw-SQL helpers
// (activeCompanySql / activeCompanyId) since env.DB can't use scopeToCompany.
//
// Mounted at '/venues' in scm/index.ts.
// ----------------------------------------------------------------------------

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
  /* Mig 0178 — Country + Postcode. Optional so older callers still parse. */
  country: string | null;
  postcode: string | null;
  /* Mig 0182 — City. Optional so older callers still parse. */
  city: string | null;
  active: boolean;
  created_at: string;
};

// Raw project_venues row → the 2990 SCM VenueRow contract. `notes` is the
// nearest free-text column to 2990's `address`; id is stringified because the
// SO pickers compare venue.id === staff.venueId with `===` (venueId is a string).
function mapVenue(r: Record<string, unknown>): VenueRow {
  const idVal = (r.id ?? null) as number | string | null;
  const activeVal = (r.active ?? 1) as number | boolean;
  return {
    id: idVal != null ? String(idVal) : "",
    name: String(r.name ?? ""),
    address: (r.notes as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    /* Mig 0178 — Country + Postcode. Mig 0182 — City. */
    country: (r.country as string | null) ?? null,
    postcode: (r.postcode as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    active: activeVal === 1 || activeVal === true,
    created_at: (r.created_at as string | null) ?? "",
  };
}

// GET / — list venues. Active-only by default; ?includeInactive=1|true for all.
// Returns the array under both `venues` (2990 SCM route convention) and `data`
// (Houzs /api/projects/venues convention) so either consumer contract resolves.
venues.get("/", async (c) => {
  // POS sends ?active=false to include inactive (2990 contract); the Houzs admin
  // sends ?includeInactive=1|true. Accept both so the POS can list/reactivate.
  const includeInactiveParam = c.req.query("includeInactive");
  const includeInactive =
    includeInactiveParam === "1" || includeInactiveParam === "true" ||
    c.req.query("active") === "false";
  // company_2 scope: ` AND company_id = <active>`, or "" (no-op) pre-activation.
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

// POST / — create a venue. Reactivate-or-insert by case-insensitive name
// (project_venues.name is UNIQUE COLLATE NOCASE), mirroring /api/projects/venues
// so the POS's inline "add venue" never trips the unique constraint. Accepts the
// 2990 `address` field (mapped to `notes`) as well as native `notes`/`state`.
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
  /* Mig 0175 — canonicalize MY state at write so venues stop landing as
     'PENANG' / 'KL' while SCM stores 'Pulau Pinang' / 'Kuala Lumpur'. */
  const state = canonicalizeMyState((body.state as string | null | undefined) ?? null);
  /* Mig 0178 — structured address on venue. Country is optional and
     back-derives from state via frontend cascade; postcode is optional too.
     Mig 0182 — City (dropdown from my_localities filtered by state). */
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
    // Reactivate + fill state/country/postcode/city/notes when supplied (COALESCE keeps existing).
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
  const companyId = activeCompanyId(c) ?? null; // else the column DEFAULT (HOUZS) applies
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

// PATCH /:id — update name/address(=notes)/state/active.
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
  // Accept 2990 `address` or native `notes` for the free-text column.
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
    /* Mig 0175 — canonicalize on PATCH too. */
    binds.push(canonicalizeMyState((body.state as string | null | undefined) ?? null));
  }
  /* Mig 0178 — country + postcode. Trim empty to NULL so clearing works.
     Mig 0182 — city (same clear-on-empty rule). */
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

  // company_2 scope: only touch a row in the active company (no-op pre-activation).
  const companyPred = activeCompanySql(c);
  await c.env.DB.prepare(
    `UPDATE project_venues SET ${sets.join(", ")} WHERE id = ?${companyPred}`,
  )
    .bind(...binds, id)
    .run();
  return c.json({ ok: true });
});

// DELETE /:id — soft delete (active = 0), mirroring /api/projects/venues so a
// venue name still referenced by historical SOs keeps rendering.
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
