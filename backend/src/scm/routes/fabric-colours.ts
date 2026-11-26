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
import { activeCompanyId, scopeToCompany } from "../lib/companyScope";
import { escapeForOr } from "../lib/postgrest-search";
import { loadProductAndModel } from "../lib/allowed-options-check";
import { fabricAllowedByPool } from "../shared/fabric-pool";
import type { Env, Variables } from "../env";

export const fabricColours = new Hono<{ Bindings: Env; Variables: Variables }>();


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
export const retiredByCode = (
  rows: readonly Record<string, unknown>[],
  codeField: string,
  activeField: string,
): Set<string> => {
  const seen = new Set<string>();
  const live = new Set<string>();
  for (const r of rows) {
    const code = String(r[codeField] ?? "").trim();
    if (!code) continue;
    seen.add(code);
    if (r[activeField] === true) live.add(code);
  }
  for (const code of live) seen.delete(code);
  return seen;
};

/** The fabric_library flavour: `id` + `active`. */
export const retiredSeriesSet = (
  rows: readonly { id?: unknown; active?: unknown }[],
): Set<string> => retiredByCode(rows as readonly Record<string, unknown>[], "id", "active");

/* EVERY "is this on offer" rule runs BEFORE the typeahead cap — docs/bugs/0893
   (the fabric-search entry). The cap used to sit in the query and the rules ran
   on what it let through: a search whose first 50 matches were retired, or
   outside the Model's pool, came back short or empty while matching colours
   further down were never read. A picker that answers "nothing" for a fabric the
   floor sells is the exact complaint behind 0816, 0818 and 0814.
   `cap` is required: null is the full list, a number is the typeahead. */
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export function coloursOnOffer<T extends Record<string, unknown>>(
  rows: readonly T[],
  rules: {
    retiredSeries: ReadonlySet<string>;
    retiredCodes: ReadonlySet<string>;
    pool: readonly string[] | null;
  },
  cap: number | null,
): T[] {
  const kept = rows
    .filter((r) => !seriesIsRetired(rules.retiredSeries, r.fabricId ?? r.fabric_id))
    .filter((r) => !seriesIsRetired(rules.retiredCodes, r.colourId ?? r.colour_id))
    .filter((r) => {
      const colour = text(r.colourId ?? r.colour_id);
      const series = text(r.fabricId ?? r.fabric_id);
      return fabricAllowedByPool(rules.pool, colour || null, series || null);
    });
  return cap == null ? kept : kept.slice(0, cap);
}

/** Rows a typeahead READS before the rules and the cap: the PostgREST edge's own
 *  page (`db-max-rows`, 1000 — lib/paginate-all.ts), so asking for more would be
 *  silently cut to it anyway. Company 1 carried 851 ACTIVE colours in total when
 *  this was set (2026-09-11), so every match of any search fits. A company that
 *  outgrows 1000 matching colours for one search would lose the tail again. */
export const OFFER_SCAN_ROWS = 1000;

export const seriesIsRetired = (retired: ReadonlySet<string>, series: unknown): boolean => {
  const s = String(series ?? "").trim();
  return s !== "" && retired.has(s);
};

fabricColours.use("*", supabaseAuth);

fabricColours.get("/", async (c) => {
  const supabase = c.get("supabase");
  const rawQ = (c.req.query("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const itemCode = (c.req.query("itemCode") ?? "").trim();
  let q = supabase
    .from("fabric_colours")
    .select("fabric_id, colour_id, label, swatch_hex, active, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  q = scopeToCompany(q, c);
  if (rawQ) {
    const s = escapeForOr(rawQ);
    if (s) q = q.or(`colour_id.ilike.%${s}%,label.ilike.%${s}%`);
    q = q.limit(OFFER_SCAN_ROWS);
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
  /* A RETIRED FABRIC CODE, asked per CODE and not per ROW. `fabric_trackings`
     is keyed by `id`, not by `fabric_code`, and 21 codes on production carry TWO
     rows for the same code - one active beside one retired, usually a plain id
     next to a `FABRIC_`-prefixed twin (`HR805-90` retired alongside
     `FABRIC_HR805-90` active; same for HR805-10 and AVANI-01..12).

     THE DESKTOP PICKER USED TO DO THIS CLIENT-SIDE, row by row, and the dead
     twin hid the live one: MEASURED 2026-09-11 it hid 21 active colours and ALL
     21 were hidden WRONGLY. Mobile did not filter at all, so the same fabric was
     pickable on a phone and missing on a computer - which is how the owner found
     it ("HR805-90 找不到").

     It lives HERE, not in the two clients, for the reason the owner gave:
     one rule. The desktop no longer filters and the mobile sheet gets the rule
     for free, with no extra fetch on a phone. Owner 2026-09-11:
     「它只要有启用，就有打开」. docs/bugs/0818. */
  let retiredCodes = new Set<string>();
  {
    let trk = supabase.from("fabric_trackings").select("fabric_code, is_active");
    trk = scopeToCompany(trk, c);
    const { data: trkRows, error: trkErr } = await trk;
    if (!trkErr) retiredCodes = retiredByCode(trkRows ?? [], "fabric_code", "is_active");
  }

  let retiredSeries = new Set<string>();
  {
    let lib = supabase.from("fabric_library").select("id, active");
    lib = scopeToCompany(lib, c);
    const { data: libRows, error: libErr } = await lib;
    if (!libErr) retiredSeries = retiredSeriesSet(libRows ?? []);
  }

  let pool: readonly string[] | null = null;
  if (rawQ && itemCode) {
    const { model, lookupError } = await loadProductAndModel(supabase, itemCode, activeCompanyId(c));
    if (!lookupError) pool = model?.allowed_options?.fabrics ?? null;
  }

  const colours = coloursOnOffer(
    (data ?? []) as Record<string, unknown>[],
    { retiredSeries, retiredCodes, pool },
    rawQ ? limit : null,
  )
    .map((r: Record<string, unknown>) => ({
    fabricId: r.fabricId ?? r.fabric_id ?? "",
    colourId: r.colourId ?? r.colour_id ?? "",
    label: r.label ?? null,
    swatchHex: r.swatchHex ?? r.swatch_hex ?? null,
    active: (r.active ?? true) as boolean,
    sortOrder: r.sortOrder ?? r.sort_order ?? 0,
  }));
  return c.json({ colours });
});

export default fabricColours;
