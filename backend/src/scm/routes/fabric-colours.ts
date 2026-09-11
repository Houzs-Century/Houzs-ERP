// ----------------------------------------------------------------------------
// fabric-colours — selling-side fabric COLOUR library (scm.fabric_colours).
// Ported READ from 2990's apps/backend/src/lib/fabric-queries.ts
// (useFabricColoursActive), which in 2990's reads `fabric_colours` DIRECTLY via
// the supabase client (the colour vocabulary the POS/SO line editor offers).
// Houzs has no client-side supabase, so the vendored useFabricColoursActive
// routes through this GET.
//
// GET /fabric-colours — list ACTIVE colour rows (the SoLineCard Fabrics dropdown
//                       source). Degrades to [] when the table is missing.
//                       Response camelCased to the FabricColourRow shape the
//                       frontend expects (fabric-queries.ts).
//
//   Scaling (owner #1 pain 2026-07-14): the SoLineCard Fabrics picker used to
//   pull EVERY active colour on every line card. An OPTIONAL `?q=` turns this
//   into a server typeahead — ilike over colour_id + label, capped at `limit`
//   (default 50). WITHOUT `q` the response is UNCHANGED (full ordered list) so
//   the existing full-list callers (mobile SO, scan matching) keep working.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { scopeToCompany } from "../lib/companyScope";
import { escapeForOr } from "../lib/postgrest-search";
import type { Env, Variables } from "../env";

export const fabricColours = new Hono<{ Bindings: Env; Variables: Variables }>();

/* THE TRIM LIVES IN THE BUILDER, so neither side can be forgotten.
   `fabric_library` carries BOTH `GARFIELD` (active) and `GARFIELD `
   (discontinued, trailing space) on production, and the colour `GARFIELD-03`
   points at the padded one - so a compare that trims only one side calls a live
   fabric retired, or a retired one live, depending which row it met. An earlier
   draft trimmed only the value and left the SET to the caller; that is the
   "optional discipline the caller must remember" shape this repo keeps paying
   for, so the pair below is the whole contract. */

/** The retired-series lookup, built from EVERY `fabric_library` row and its
 *  `active` flag. A trimmed code counts as retired only when NO active row
 *  trims to it.
 *
 *  THE ROW-BY-ROW VERSION OF THIS SHIPPED A REGRESSION AND HID A LIVE FABRIC.
 *  It was built from the inactive rows alone and trimmed them, so the retired
 *  row `GARFIELD ` trimmed to `GARFIELD` and switched off the LIVE `GARFIELD`
 *  beside it - nine colours a customer buys, gone from the picker, measured
 *  within minutes of the deploy. The padded twin must resolve to the same code
 *  (that is why the trim is here at all) AND the live row must win, so the
 *  question is per CODE, not per row. */
export const retiredSeriesSet = (
  rows: readonly { id?: unknown; active?: unknown }[],
): Set<string> => {
  const seen = new Set<string>();
  const live = new Set<string>();
  for (const r of rows) {
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    seen.add(id);
    if (r.active === true) live.add(id);
  }
  for (const id of live) seen.delete(id);
  return seen;
};

/** Is this colour's SERIES switched off in the fabric library?
 *
 *  A missing or blank series is NOT retired: it cannot be proven to be, and the
 *  honest default on this route is to keep offering the colour. */
export const seriesIsRetired = (retired: ReadonlySet<string>, series: unknown): boolean => {
  const s = String(series ?? "").trim();
  return s !== "" && retired.has(s);
};

fabricColours.use("*", supabaseAuth);

// GET / — active colour rows ordered by sort_order (mirrors 2990's
// useFabricColoursActive: .eq('active', true).order('sort_order')).
// Optional ?q= (typeahead) + ?limit= (cap, only applied when q is present).
fabricColours.get("/", async (c) => {
  const supabase = c.get("supabase");
  const rawQ = (c.req.query("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  let q = supabase
    .from("fabric_colours")
    .select("fabric_id, colour_id, label, swatch_hex, active, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  // Typeahead mode — ilike over the code (colour_id) + label, capped. The
  // no-`q` branch stays byte-for-byte the old full-list behaviour.
  if (rawQ) {
    const s = escapeForOr(rawQ);
    if (s) q = q.or(`colour_id.ilike.%${s}%,label.ilike.%${s}%`);
    q = q.limit(limit);
  }
  const { data, error } = await q;
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return c.json({ colours: [] });
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }

  /* A COLOUR OF A DISCONTINUED FABRIC IS NOT ON OFFER. Owner 2026-09-11, asked
     whether the fabrics a Model does not list should be opened up:
     「inactive的就不需要了」.

     `fabric_colours.active` is the COLOUR's own flag and this route has always
     honoured it. Nothing on the selling path read the SERIES' flag
     (`fabric_library.active`), so a fabric switched off in the library kept
     offering every one of its shades. MEASURED on production 2026-09-11,
     company 1: 32 active colours belong to a discontinued series - FG66151 (17),
     J9226 (14) and `GARFIELD ` (1). They were invisible only because no sofa
     Model happened to list those series, which is luck, not a rule: ticking a
     new Model or clearing a pool would have leaked them straight back in.

     THE SET IS BUILT PER CODE, NOT PER ROW - see retiredSeriesSet. Reading only
     the inactive rows is what shipped a regression: a retired padded twin
     trimmed onto its live sibling and switched the live one off.

     A SEPARATE QUERY, not a PostgREST embed. An `!inner` join on
     fabric_library would be fewer round trips, and the embed name / FK shape
     cannot be verified from this machine (PostgREST needs the Worker's
     credentials). Getting it wrong empties the fabric picker, which is worse
     than the defect being fixed - so the set is loaded plainly and the filter
     is a pure function with a test. One small extra read on a debounced,
     50-capped typeahead.

     A SAVED line is unaffected: the picker renders its stored colour verbatim
     and never blanks a selection, and the allowed-options gate reads the
     Model's pool, not this flag. 26 live sales-order lines already carry a
     discontinued series and keep displaying it. docs/bugs/0816. */
  let retiredSeries = new Set<string>();
  {
    let lib = supabase.from("fabric_library").select("id, active");
    lib = scopeToCompany(lib, c);
    const { data: libRows, error: libErr } = await lib;
    /* A failure here must NOT empty the picker. The colour list is the product;
       the series filter is a refinement, so an unreadable library degrades to
       the old behaviour (every active colour) rather than to nothing. */
    if (!libErr) retiredSeries = retiredSeriesSet(libRows ?? []);
  }

  // Dual-read camelCase ?? snake_case — cover the PostgREST casing either way.
  const colours = (data ?? [])
    .filter((r: Record<string, unknown>) => !seriesIsRetired(retiredSeries, r.fabricId ?? r.fabric_id))
    .map((r: Record<string, unknown>) => ({
    fabricId: r.fabricId ?? r.fabric_id ?? "",
    colourId: r.colourId ?? r.colour_id ?? "",
    label: r.label ?? null,
    swatchHex: r.swatchHex ?? r.swatch_hex ?? null,
    // POS filters on `active` (FabricColourRow.active); the list is active-only
    // (server .eq('active', true)), so surface it or the POS drops every row and
    // the colour picker renders empty.
    active: (r.active ?? true) as boolean,
    sortOrder: r.sortOrder ?? r.sort_order ?? 0,
  }));
  return c.json({ colours });
});

export default fabricColours;
