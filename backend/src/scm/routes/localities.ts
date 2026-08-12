// ----------------------------------------------------------------------------
// localities — MY State→City→Postcode reference (my_localities).
// Ported from 2990's apps/api/src/routes/localities.ts (POST/PATCH/DELETE),
// PLUS a GET list added for Houzs.
//
// Commander 2026-05-27: "也需要进行维护: State, City, Postcode".
//
// GET /localities      — list all my_localities rows (state→city→postcode
//                        cascade source for SupplierDetail + SO delivery cards).
// POST /localities     — create a row.
// PATCH /localities/:id — update a row (incl. city-level warehouse override).
// DELETE /localities/:id — drop a row.
//
// HOUZS VENDOR: in 2990's the READ is done client-side via a direct supabase
// select (localities-queries.ts). Houzs has no client-side supabase, so the
// vendored useLocalities hook routes through this GET. scm.my_localities (cols
// id/postcode/city/state/state_code/country/warehouse_id) now carries the
// seeded MY postcode dataset — 5,870 rows @ 2026-07-16. It is still allowed to
// be missing or empty: the GET then returns [] and the frontend StateSelect
// falls back to a free-text State input (the verbatim no-data behaviour the
// source already handles), so keep that path intact.
//
// Shared reference data — NOT company-scoped. Postcodes are the same for every
// caller, which is what lets the GET below cache per-browser without a Vary.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { supabaseAuth } from "../middleware/auth";
import type { Env, Variables } from "../env";

export const localities = new Hono<{ Bindings: Env; Variables: Variables }>();

localities.use("*", supabaseAuth);

/* Validator for the GET below, derived from the bytes actually served. It has
   to be content-derived: my_localities has no updated_at, and a row COUNT alone
   would miss a PATCH (rename a city, count unchanged) and hand the editor a
   stale 304. Weak (`W/`) on purpose — Cloudflare downgrades a strong ETag to
   weak when it compresses, so the browser would echo `W/"…"` and a strong
   compare would never match: the 304 would silently never fire. */
async function bodyEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `W/"${Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}"`;
}

/* If-None-Match is a comma-separated LIST, and either side may carry the W/
   prefix (see above) — compare on the bare tag. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === bare);
}

// GET / — list all rows (the state→city→postcode cascade source). Degrades to
// [] when the table is missing or empty.
localities.get("/", async (c) => {
  const sb = c.get("supabase");
  // PostgREST caps a single response at max-rows (1000), so `.limit(20000)` was
  // silently truncating the MY dataset to the first 1000 (≈7 states). Page
  // through with .range() (each request ≤1000) and concatenate the lot.
  const PAGE = 1000;
  // Fan-out ceiling, carried over from the earlier serial walk.
  const MAX_ROWS = 50000;

  const selectPage = (from: number, opts?: { count: "exact" }) =>
    sb
      .from("my_localities")
      .select("id, postcode, city, state, state_code, country, warehouse_id", opts)
      .order("state", { ascending: true })
      .order("city", { ascending: true })
      .order("postcode", { ascending: true })
      // Tiebreaker makes the sort TOTAL. (state, city, postcode) is not unique —
      // SO Maintenance seeds '—/—/—' placeholder rows per country/state — and
      // Postgres does not promise a stable sort across separate LIMIT/OFFSET
      // windows, so without this paging can repeat one row and drop another.
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

  // Page 1 carries the exact total too, so pages 2..N fan out CONCURRENTLY —
  // the serial walk paid a full round-trip per 1000 rows.
  const first = await selectPage(0, { count: "exact" });
  if (first.error) {
    if (/relation .* does not exist/i.test(first.error.message)) return c.json({ localities: [] });
    return c.json({ error: "load_failed", reason: first.error.message }, 500);
  }
  const data = (first.data ?? []) as Record<string, unknown>[];
  const total = first.count;

  if (typeof total === "number") {
    const rest: ReturnType<typeof selectPage>[] = [];
    for (let from = PAGE; from < Math.min(total, MAX_ROWS); from += PAGE) rest.push(selectPage(from));
    for (const chunk of await Promise.all(rest)) {
      if (chunk.error) return c.json({ error: "load_failed", reason: chunk.error.message }, 500);
      data.push(...((chunk.data ?? []) as Record<string, unknown>[]));
    }
  } else if (data.length === PAGE) {
    // No Content-Range count came back — walk serially rather than guess the
    // page span. A short read here is INVISIBLE (the cascade just quietly loses
    // states), so never infer the end from anything but a short page.
    for (let from = PAGE; from <= MAX_ROWS; from += PAGE) {
      const chunk = await selectPage(from);
      if (chunk.error) return c.json({ error: "load_failed", reason: chunk.error.message }, 500);
      const rows = (chunk.data ?? []) as Record<string, unknown>[];
      data.push(...rows);
      if (rows.length < PAGE) break; // last page
    }
  }

  // Dual-read camelCase ?? snake_case — cover the PostgREST casing either way.
  const localitiesRows = data.map((r: Record<string, unknown>) => ({
    id: r.id,
    postcode: r.postcode,
    city: r.city,
    state: r.state,
    stateCode: r.stateCode ?? r.state_code ?? "",
    country: r.country ?? "Malaysia",
    warehouseId: r.warehouseId ?? r.warehouse_id ?? null,
  }));

  /* ~925 KB of near-static reference data re-sent on every cold page load
     (useLocalities holds it 24h in-memory, so this is a per-page-load cost, not
     a per-click one). Revalidate rather than expire: `no-cache` re-asks every
     time and a 304 costs only the round-trip, whereas ANY max-age would let the
     POST/PATCH/DELETE mutations' invalidateQueries(['my_localities']) refetch
     be answered from the browser's own still-fresh entry — hiding the editor's
     own edit from them. The tag is derived from the rows we just read, so an
     edit always re-tags and a 304 can never be stale. */
  const body = JSON.stringify({ localities: localitiesRows });
  const etag = await bodyEtag(body);
  const validators = { "cache-control": "private, no-cache", etag };
  if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, validators);
  return c.body(body, 200, { ...validators, "content-type": "application/json; charset=UTF-8" });
});

const createSchema = z.object({
  state: z.string().trim().min(1),
  stateCode: z.string().trim().min(1),
  city: z.string().trim().min(1),
  postcode: z.string().trim().min(1),
  /* Task #121 — optional, defaults to Malaysia. */
  country: z.string().trim().min(1).optional(),
});

const updateSchema = z.object({
  state: z.string().trim().min(1).optional(),
  stateCode: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  postcode: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  /* Commander 2026-05-27 — city-level warehouse override.
     '' or null explicitly clears the override (falls back to state-level). */
  warehouseId: z.union([z.string().uuid(), z.literal(""), z.null()]).optional(),
});

// POST / — create a new row.
localities.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const sb = c.get("supabase");
  const { data, error } = await sb
    .from("my_localities")
    .insert({
      state: parsed.data.state,
      state_code: parsed.data.stateCode.toUpperCase(),
      city: parsed.data.city,
      postcode: parsed.data.postcode,
      country: parsed.data.country ?? "Malaysia",
    })
    .select("id, state, state_code, city, postcode, country")
    .single();
  if (error) return c.json({ error: "insert_failed", reason: error.message }, 500);
  return c.json({ locality: data });
});

// PATCH /:id — update a row.
localities.patch("/:id", async (c) => {
  // company-scope: my_localities is a GLOBAL address master (postcode -> city ->
  // state -> warehouse). Verified 2026-08-13 against its CREATE TABLE in
  // scm-schema/2990s-full-schema.sql:786 — it has NO company_id column, and
  // migration 0083 (which added company_id to 30-odd scm tables) deliberately
  // skipped it. Both companies share one Malaysian postcode map; adding a
  // company predicate here would filter against a column that does not exist.
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const patch: Record<string, string | null> = {};
  if (parsed.data.state) patch.state = parsed.data.state;
  if (parsed.data.stateCode) patch.state_code = parsed.data.stateCode.toUpperCase();
  if (parsed.data.city) patch.city = parsed.data.city;
  if (parsed.data.postcode) patch.postcode = parsed.data.postcode;
  if (parsed.data.country) patch.country = parsed.data.country;
  /* warehouseId: empty string or null clears the override; uuid sets it. */
  if (parsed.data.warehouseId !== undefined) {
    patch.warehouse_id =
      parsed.data.warehouseId === "" || parsed.data.warehouseId === null
        ? null
        : parsed.data.warehouseId;
  }
  if (Object.keys(patch).length === 0) return c.json({ ok: true, changed: 0 });

  const sb = c.get("supabase");
  const { data, error } = await sb
    .from("my_localities")
    .update(patch)
    .eq("id", id)
    .select("id, state, state_code, city, postcode, country, warehouse_id")
    .maybeSingle();
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ locality: data });
});

// DELETE /:id — drop a row.
localities.delete("/:id", async (c) => {
  // company-scope: my_localities is a GLOBAL address master (postcode -> city ->
  // state -> warehouse). Verified 2026-08-13 against its CREATE TABLE in
  // scm-schema/2990s-full-schema.sql:786 — it has NO company_id column, and
  // migration 0083 (which added company_id to 30-odd scm tables) deliberately
  // skipped it. Both companies share one Malaysian postcode map; adding a
  // company predicate here would filter against a column that does not exist.
  const id = c.req.param("id");
  const sb = c.get("supabase");
  const { error } = await sb.from("my_localities").delete().eq("id", id);
  if (error) return c.json({ error: "delete_failed", reason: error.message }, 500);
  return c.json({ ok: true });
});

export default localities;
