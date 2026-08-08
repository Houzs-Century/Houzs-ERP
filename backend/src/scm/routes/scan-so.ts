// ---------------------------------------------------------------------------
// /scan-so — Claude-powered OCR for HANDWRITTEN showroom sale-order slips
// (phone photos of Zanotti / AKEMI-style carbon-copy forms) → structured JSON
// the Backend "Scan Order" modal turns into a prefilled New SO.
//
// Ported from HOOKKA's scan-po.ts (typed customer-PO PDFs) and adapted:
//   • input is image(s) (jpeg/png/webp) or a PDF, not PDF-only;
//   • catalog injection pulls live from Supabase Postgres (mfg_products,
//     fabric_trackings, maintenance config sofa sizes/leg heights);
//   • few-shot pool = the 5 most recent operator-REVIEWED so_scan_samples
//     rows, filtered to the slip's SALESPERSON first (fall back to global),
//     and RANKED corrected-before-accepted-as-is (see the SAMPLE_* header:
//     both outcomes are ground truth here, but only corrected rows carry a
//     diff, so only they feed the distillers);
//   • per-SALESPERSON learning (vs HOOKKA's per-customer): each rep has
//     their own handwriting/notation habits that differ per product
//     category, so a distilled rules block (so_scan_rules, organized by
//     SOFA / MATTRESS / BEDFRAME / ACCESSORY / SERVICE sections) is
//     regenerated from that rep's corrected samples after every confirm;
//   • PLUS a GLOBAL shared alias layer (reserved so_scan_rules row
//     '__GLOBAL__'): a product-name/fabric-code alias dictionary distilled
//     from the latest corrected samples ACROSS ALL reps ("Bamboo Cruise" /
//     "Cruise" / "B.Cruise" → one SKU), injected into EVERY scan so one
//     rep's corrections teach all reps. Refreshed on every confirm
//     (fire-and-forget) and weekly (before the per-rep pass).
//
// Endpoints:
//   POST /scan-so/extract                     — multipart image(s)/pdf (+ salesperson field) → JSON + sampleId
//   POST /scan-so/enqueue                     — same inputs; queue a BACKGROUND job that OCRs + creates a DRAFT SO
//   GET  /scan-so/jobs/:id                    — poll a background job (status / soDocNo / error)
//   GET  /scan-so/jobs?salesperson=           — latest 20 background jobs (optionally one rep's)
//   POST /scan-so/jobs/clear-failed           — delete the caller's failed (status=error) jobs ('*' clears all reps')
//   POST /scan-so/samples/:id/confirm         — store operator-reviewed JSON (+ salesperson, + accepted); auto-distills rep rules
//   GET  /scan-so/salespeople                 — distinct reps seen across samples + rules (modal datalist)
//   GET  /scan-so/rules/:salesperson          — view a rep's distilled rules
//   POST /scan-so/rules/:salesperson/distill  — manually regenerate a rep's rules
//
// Setup:
//   npx wrangler secret put ANTHROPIC_API_KEY
//
// Prompt caching: the SYSTEM_PROMPT + catalog block is sent as a
// cache_control:ephemeral prefix — identical across calls until the catalog
// changes, so repeat scans within 5 min get the ~90% cached-input discount.
//
// Auth: same as mfg-sales-orders write routes — supabaseAuth on every
// endpoint (any signed-in staff member; RLS scopes what the user client can
// read). Sample rows are written via the service-role client so extraction
// works even before migration 0164's RLS policy lands.
//
// Houzs adaptation: same plumbing as the sibling SCM routes. The 2990's
// original built its own service client via createClient(...) defaulting to
// the `public` schema; in Houzs the so_scan_samples / so_scan_rules /
// mfg_products / fabric_trackings / maintenance_config_history /
// so_dropdown_options tables live in the dedicated `scm` Postgres schema, so
// serviceClient() here returns getSupabaseService(env) (db:{schema:'scm'}) —
// every sb.from('...') resolves to scm.*, never public.*. The catalog read
// uses c.get('supabase') (also scm-scoped, attached by supabaseAuth).
// ANTHROPIC_API_KEY is OPTIONAL on the Houzs Env: when absent /extract returns
// 503 anthropic_key_missing — it must not break the worker or tsc.
// Crons (wired in backend/src/index.ts scheduled()): the keep-warm cron
// (warmCatalogCacheForCron) fires during showroom hours so the catalog prompt
// cache rarely goes cold, and the weekly distill cron (distillAllSalespersonRules,
// Sunday-gated in the 02:00 UTC slot) re-distills every rep's rules plus the
// cross-rep __GLOBAL__ alias dictionary AND __GLOBAL_RULES__ shared rules. The
// per-confirm fire-and-forget distill remains the primary fast learning path.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { paginateAll } from '../lib/paginate-all';
import { getBranding } from '../../services/branding';
import { postPersonalNotice } from '../../services/personalNotice';
// Background scan job — the DRAFT SO is created through mfg-sales-orders'
// factored create core (PRICING-CRITICAL; never reimplemented here), and each
// scanned payment RECEIPT becomes a payments-ledger row through the same
// factored insert+audit core the interactive POST /:docNo/payments route uses.
import { createDraftSalesOrder, recordSoPaymentRow } from './mfg-sales-orders';
import { todayMyt } from '../lib/my-time';
import { activeCompanyId } from '../lib/companyScope';
import { normalizePhone } from '../shared/phone';
import { resolveCallerStaffId } from '../lib/salesScope';
import {
  planReceiptPayments,
  installmentPlanToMonths,
  type ExtractedPayment,
} from '../lib/scan-receipt-plan';

// The scm-scoped service client (getSupabaseService, db:{schema:'scm'}) and the
// middleware-attached c.get('supabase') are both schema-parameterised clients.
// Use the loosely-typed form (matches scm/env.ts Variables.supabase) so the
// scm-schema client is assignable wherever the ported code expects a client.
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const scanSo = new Hono<{ Bindings: Env; Variables: Variables }>();
scanSo.use('*', supabaseAuth);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Anthropic (and gateways in front of it) return transient 429 rate-limits and
// 529 "Overloaded" / 5xx spikes that clear on a retry; a single hit otherwise
// fails the whole scan/distill with a hard error. Retry those a few times with
// an exponential-ish backoff. Non-retryable statuses (4xx other than 429) and
// the final attempt fall straight through to the caller's existing !resp.ok
// handling, so the response shape is unchanged. Only the transport is retried —
// the prompt/body and response parsing are untouched.
const RETRYABLE_ANTHROPIC_STATUS = new Set([429, 500, 502, 503, 529]);

async function anthropicFetchWithRetry(
  init: RequestInit,
  tries = 3,
): Promise<Response> {
  let resp: Response | null = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    resp = await fetch(ANTHROPIC_URL, init);
    if (resp.ok) return resp;
    // Peek the body for an explicit overloaded_error without consuming the
    // Response the caller reads — clone so the returned body survives. Some
    // gateways surface an overloaded body under a status outside the set.
    let overloaded = false;
    try {
      const peek = await resp.clone().text();
      if (/overloaded/i.test(peek)) overloaded = true;
    } catch { /* body peek is best-effort */ }
    const retryable = RETRYABLE_ANTHROPIC_STATUS.has(resp.status) || overloaded;
    if (!retryable || attempt === tries - 1) return resp;
    // 400ms, 800ms, 1600ms … keeps the whole retry window well under the
    // per-call AbortSignal.timeout budget.
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  return resp as Response;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ArrayBuffer -> base64. Workers don't expose Node's Buffer; the chunked loop
// keeps stack usage bounded for large files. (Ported from HOOKKA scan-po.)
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Phone normalisation for an extracted slip — E.164, via the SAME normalizePhone
// every other write path uses.
//
// This used to be a local normalizeMyPhone() that returned the bare national
// part "under the +60 prefix" and stripped a leading 60/0. It DESTROYED any
// number that was not Malaysian. A slip reading "+65 6123 4567" became the
// digits "6561234567" — which starts with neither 60 nor 0, so it fell through
// untouched — and every consumer then treated it as a Malaysian national part
// and put +60 in front of it: +606561234567. The number was corrupted
// server-side, so no amount of UI work could have saved it, and there is no way
// to recover the original from the stored value.
//
// normalizePhone keeps an explicit +xx country code and assumes Malaysia only
// for a bare local form, which is exactly the rule the slip needs: the operator
// writes "012-345 6789" for a local customer and "+65 …" when they mean
// Singapore. Returning E.164 also removes the "+60" + digits concatenation from
// every consumer — the value that comes out of the scan is now the value that
// gets stored.
// ---------------------------------------------------------------------------
function normalizeSlipPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return normalizePhone(raw);
}

// ---------------------------------------------------------------------------
// Google Geocoding — turn the raw handwritten address text into accurate
// state / city / postcode. The LLM frequently mis-parses Malaysian areas
// (e.g. "Melawati" sits in KL/Setapak ~53100, not Ampang/Selangor 68000), so
// when GOOGLE_MAPS_API_KEY is present we geocode the raw address and prefer the
// returned components over the LLM guess. Fail-soft: missing key / network
// error / no confident result → return null and keep the LLM parse.
// ---------------------------------------------------------------------------
type GeocodeParts = { state: string | null; city: string | null; postcode: string | null };
async function geocodeAddress(
  rawAddress: string | null | undefined,
  apiKey: string | undefined,
): Promise<GeocodeParts | null> {
  const addr = (rawAddress ?? '').trim();
  if (!apiKey || addr === '') return null;
  try {
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json' +
      `?address=${encodeURIComponent(addr)}&region=my&components=country:MY&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return null;
    const body = (await resp.json()) as {
      status?: string;
      results?: Array<{
        address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>;
      }>;
    };
    if (body.status !== 'OK' || !body.results?.length) return null;
    const comps = body.results[0].address_components ?? [];
    const pick = (type: string): string | null => {
      const c = comps.find((x) => (x.types ?? []).includes(type));
      return (c?.long_name ?? '').trim() || null;
    };
    const state = pick('administrative_area_level_1');
    // City: prefer locality, fall back to the postal town / admin level 2.
    const city = pick('locality') ?? pick('postal_town') ?? pick('administrative_area_level_2');
    const postcode = pick('postal_code');
    if (!state && !city && !postcode) return null;
    return { state, city, postcode };
  } catch {
    return null;
  }
}

// Postcode IS the driver (spec section 4): once the geocoder resolves a precise
// 5-digit postcode, the city + state must come from the SAME my_localities row
// the New SO form's cascade fills from that postcode — NOT from Google's own
// (sometimes divergent) admin-area components. This snaps the seeded city/state
// to the catalog's own postcode→city→state mapping so the form's dropdowns can
// actually select them. Fail-soft: no postcode / no matching row / query error
// → return null and let the Google components stand.
async function localityForPostcode(
  sb: SupabaseClient,
  postcode: string | null | undefined,
): Promise<{ city: string | null; state: string | null } | null> {
  const pc = (postcode ?? '').replace(/[^\d]/g, '');
  if (pc.length !== 5) return null;
  try {
    const { data, error } = await sb
      .from('my_localities')
      .select('city, state')
      .eq('postcode', pc)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    const city = typeof row.city === 'string' && row.city.trim() !== '' ? row.city : null;
    const state = typeof row.state === 'string' && row.state.trim() !== '' ? row.state : null;
    if (!city && !state) return null;
    return { city, state };
  } catch {
    return null;
  }
}

// JSON-coercion recovery (ported verbatim from HOOKKA scan-po.ts) — Claude
// sometimes wraps the result in fences, sometimes adds a "Looking at the
// image…" preamble, sometimes both. Parse a best-effort substring rather
// than fail the whole extraction.
function stripJsonFences(text: string): string {
  let trimmed = text.trim();

  // 1) ```json … ``` or ``` … ```
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const fenceMatch = trimmed.match(fenceRe);
  if (fenceMatch?.[1]) trimmed = fenceMatch[1].trim();

  // 2) Strip any chain-of-thought preamble. The valid payload always starts
  //    with `{` — take from the first `{` to the last `}`.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

// ===========================================================================
// Catalog — pulled live from Supabase on every /extract call.
// ===========================================================================
type CatalogSku = {
  code: string;
  name: string;
  category: string;       // SOFA | BEDFRAME | MATTRESS | ACCESSORY | SERVICE
  baseModel: string | null;
};
type CatalogFabric = { code: string; description: string | null };
// SOFA Special Add-ons (scm.special_addons, migration 0134) — the configured
// specials the SO line editor's accordion offers. ACTIVE rows only; injected
// into the cached prompt prefix so the OCR can map a slip remark ("change nylon
// cover") to a configured special CODE and mark it on the line instead of
// dumping it in notes. allowedModels = the SOFA model_codes whose
// allowed_options.specials includes this code (validateSlip uses it to keep a
// matched special only when the line's resolved model actually offers it).
type CatalogSpecial = {
  code: string;
  label: string;
  soDescription: string | null;
  categories: string[];
};

// SO Maintenance vocabularies (so_dropdown_options, migration 0081) — the
// option groups the SO Maintenance page edits. ACTIVE rows only; injected
// into the cached prompt prefix as allowed-values lists so the OCR can map
// handwritten payment notes ("mbb 12 EPP") to exact maintenance values.
//
// VENUE IS NOT HERE — deliberately (owner 2026-07-16: "看我的maintenance SO 的
// venue是真理"). so_dropdown_options carries a `venue` category, but it is NOT
// the venue master any picker binds to: the SO form's Venue dropdown, the SO
// Maintenance VENUES section and the venue-by-active-project autofill all read
// public.project_venues (see Catalog.venues below). This list validated against
// the WRONG vocabulary, which is exactly the drift the 2026-07-04 audit
// predicted — "if they drift, a scan could seed a venue the picker can't
// select". The `venue` category rows are left in the table and still served by
// /so-dropdown-options; the scan simply no longer reads them.
const OPTION_CATEGORIES = [
  'payment_method',     // L1 method — locked three: Merchant / Online / Cash
  'payment_merchant',   // L2 merchant banks (MBB / CIMB / Public / …)
  'online_type',        // L2 online sub-types (Bank Transfer / TNG / Cheque / DuitNow)
  'installment_plan',   // L2 plans (One Shot / 3 / 6 / 12 / 24 / 36 months)
  'customer_type',      // New / Existing
  'building_type',      // Condo / Landed / …
] as const;
type OptionCategory = (typeof OPTION_CATEGORIES)[number];
type CatalogOption = { value: string; label: string };
type CatalogOptions = Record<OptionCategory, CatalogOption[]>;

const emptyOptions = (): CatalogOptions => ({
  payment_method:   [],
  payment_merchant: [],
  online_type:      [],
  installment_plan: [],
  customer_type:    [],
  building_type:    [],
});

type Catalog = {
  skus: CatalogSku[];
  fabrics: CatalogFabric[];
  // Configured SOFA Special Add-ons (active special_addons rows) — feeds the
  // OCR's specialsMatch so a slip remark resolves to a configured special code.
  specials: CatalogSpecial[];
  // SKU code → the special CODES its Model offers (allowed_options.specials).
  // validateSlip resolves a line's model from skuMatch.code and keeps only a
  // matched special the model actually allows (else it would render "retired").
  specialsByModelSku: Map<string, Set<string>>;
  sofaSizes: string[];
  sofaLegHeights: string[];
  // BEDFRAME variant pools from the SAME Products -> Maintenance master the SO
  // line editor's dropdowns render (ACTIVE entries only). The OCR reads these
  // axes as bare INCH NUMBERS off the slip, so they are NOT injected into the
  // prompt (formatCatalog deliberately omits them — adding them would change
  // buildCachedPrefix and bust the 1h prompt cache for zero benefit). They exist
  // purely so buildDraftSoBodyFromSlip can VALIDATE an OCR-read number against
  // the live config before writing it onto a draft line.
  legHeights: string[];
  divanHeights: string[];
  gaps: string[];
  options: CatalogOptions;
  /* ACTIVE venue NAMES from public.project_venues — the ONE venue master
     (owner ruling 2026-07-16: "看我的maintenance SO 的venue是真理", i.e. the list
     SO Maintenance shows is the authority). That page's VENUES section is a
     read-only view of useVenues() → GET /api/projects/venues → project_venues,
     and the New-SO Venue dropdown renders the SAME useVenues() master. The scan
     used to validate against scm.so_dropdown_options.venue instead — a SECOND
     vocabulary nothing binds to — so a scan could seed a venue the picker
     cannot select and the operator cannot clear from the dropdown.

     Unlike the variant / city / postcode pools this one IS injected into
     formatCatalog: the prompt's locationMatch rule needs the list in front of
     the model to match against, and VENUES was already in the prompt (sourced
     from the wrong table). Swapping the source therefore changes
     buildCachedPrefix — a ONE-TIME prompt-cache re-create, not a regression.

     Names only: mfg_sales_orders.venue_id is a uuid FK to the empty scm.venues
     table and the create core nulls a project_venues integer id (see the
     venueIdUuid guard in mfg-sales-orders.ts), so the venue TEXT column is what
     actually carries the value. */
  venues: string[];
  // Distinct delivery STATES from scm.my_localities — the same vocabulary the
  // New SO form's State <select> renders. Injected as an allowed-values list so
  // the OCR's address parse snaps STATE to a real catalog state (never a free
  // text string the form's dropdown can't select).
  states: string[];
  // The rest of the SAME my_localities master, keyed by the step ABOVE it in
  // the form's cascade (State -> City -> Postcode):
  //   citiesByState        : STATE(upper)             -> CITY(upper)     -> canonical city
  //   postcodesByStateCity : STATE(upper)|CITY(upper) -> the 5-digit postcodes
  // City/postcode used to be treated as free text here on the theory that "the
  // frontend reconciles them against the live my_localities list" — true for the
  // interactive form, FALSE for the background scan job, which persists the draft
  // with no form in the loop (owner 2026-07-16). Like the variant pools above
  // these are deliberately NOT injected into the prompt (formatCatalog omits
  // them): the model already gets STATES, and ~2.9k city/postcode rows would
  // change buildCachedPrefix and bust the 1h prompt cache. They exist purely so
  // validateSlip can VALIDATE the OCR/geocoder's city+postcode against the live
  // master before either reaches a draft.
  citiesByState: Map<string, Map<string, string>>;
  postcodesByStateCity: Map<string, Set<string>>;
};

/* Cascade key for postcodesByStateCity — STATE|CITY, case/whitespace-normalised
   on both the build and the lookup side. */
function localityKey(state: string, city: string): string {
  return `${state.trim().toUpperCase()}|${city.trim().toUpperCase()}`;
}

// MaintenanceConfig option entries are either plain strings or
// { value, priceSen?, active? } objects — accept both (mirrors @2990s/shared
// mfg-pricing MfgPricedOption / maintenance-pools MaintPoolEntry).
// ACTIVE only (owner spec 2026-06-12): the scan-SO catalog feeds the OCR
// prompt for NEW orders, so options toggled inactive in Products →
// Maintenance must never re-enter via a scan. Plain strings = active;
// objects are active unless `active === false`.
function optionValues(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object' && 'value' in x) {
        if ((x as { active?: unknown }).active === false) return '';
        const v = (x as { value?: unknown }).value;
        return typeof v === 'string' ? v : '';
      }
      return '';
    })
    .filter(Boolean);
}

/* ACTIVE venue names from public.project_venues — the venue master (see
   Catalog.venues). Reads through env.DB, NOT the supabase client: project_venues
   lives in the PUBLIC schema, which the scm-scoped client cannot reach (the same
   reason /api/scm/venues and the venue-by-project autofill both use env.DB).

   Deliberately NOT company-scoped, matching every other read in loadCatalog (see
   the mig-0089 note there): this feeds buildCachedPrefix, which must stay
   byte-identical across /extract, /warm and the headless cron + queue job — none
   of which carry a request scope. Per-company OCR catalogs need their own
   cached-prefix design first.

   FAILS SOFT to an empty pool rather than throwing, mirroring the create core's
   "non-fatal — leave venue NULL if the project lookup fails" precedent. env.DB is
   Hyperdrive-backed and can cold-start (see BUG-HISTORY "DB cold-start 503"); a
   blip must not turn a scan into a hard failure. An empty pool clears the venue
   axis, and a null venue is the SELF-HEALING state — the create core's
   venue-by-active-project autofill resolves it from the salesperson's current
   exhibition project. */
async function loadVenueNames(db: D1Database): Promise<string[]> {
  try {
    const rows = await db
      .prepare(`SELECT name FROM project_venues WHERE active = 1 ORDER BY name`)
      .all<{ name?: string | null }>();
    const seen = new Set<string>();
    const names: string[] = [];
    for (const r of rows.results ?? []) {
      const n = (r.name ?? '').trim();
      if (!n || seen.has(n.toUpperCase())) continue;
      seen.add(n.toUpperCase());
      names.push(n);
    }
    return names;
  } catch (e) {
    console.error('[scan-so] project_venues load failed', e);
    return [];
  }
}

async function loadCatalog(sb: SupabaseClient, db: D1Database, companyId?: number | null): Promise<Catalog> {
  // PostgREST's default 1000-row cap silently truncates the OCR validation
  // catalogue (mfg_products is 1141 ACTIVE SKUs live, my_localities 2933) — a
  // truncated catalogue makes the OCR reject valid SKUs/states as "unknown".
  // Page each list read with .range(); cfgRes stays a single .maybeSingle().
  const [prodRes, fabRes, cfgRes, optRes, locRes, spcRes, modRes, venueNames] = await Promise.all([
    // Company-scoped: the OCR matcher resolves a scanned SKU string against
    // this list, so the other company's catalogue would let a foreign code onto
    // a draft SO — which the (now scoped) pricing read then cannot price.
    paginateAll((from, to) => {
      let q = sb
        .from('mfg_products')
        .select('code, name, category, base_model')
        .eq('status', 'ACTIVE');
      if (companyId != null) q = q.eq('company_id', companyId);
      return q.order('category').order('code').range(from, to);
    }),
    // Migration 0167 — ACTIVE fabrics only: a deactivated fabric must not
    // re-enter on NEW scanned orders (existing docs keep their stored code).
    paginateAll((from, to) => sb
      .from('fabric_trackings')
      .select('fabric_code, fabric_description')
      .eq('is_active', true)
      .order('fabric_code')
      .range(from, to)),
    sb
      .from('maintenance_config_history')
      .select('config')
      .eq('scope', 'master')
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // SO Maintenance vocab — ACTIVE rows only (the maintenance page's
    // soft-deleted options must never re-enter via OCR).
    // Multi-company note (mig 0089): deliberately NOT company-scoped. This
    // catalog feeds buildCachedPrefix, which must stay BYTE-IDENTICAL across
    // the request path, /warm and the headless cron/scan-job (no request scope
    // there) — scoping only the request path would bust the prompt cache on
    // every scan. Same treatment as this loader's other 0083-stamped tables
    // (mfg_products / fabric_trackings / special_addons). Per-company OCR
    // catalogs need their own cached-prefix design first.
    paginateAll((from, to) => sb
      .from('so_dropdown_options')
      .select('category, value, label')
      .eq('active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true })
      .range(from, to)),
    // Delivery STATE / CITY / POSTCODE — the same scm.my_localities master the
    // New SO form's cascading State -> City -> Postcode selects render. Only the
    // distinct state names reach the OCR's allowed-values list; city + postcode
    // are loaded so validateSlip can snap them to the master too (the background
    // scan job persists a draft with no form in the loop, so "the frontend
    // reconciles them" never happens on that path).
    paginateAll((from, to) => sb
      .from('my_localities')
      .select('state, city, postcode')
      .order('state', { ascending: true })
      .range(from, to)),
    // Configured Special Add-ons (migration 0134) — ACTIVE rows only (a
    // deactivated special must never re-enter on a NEW scanned order). The OCR
    // maps a slip remark to one of these CODES via specialsMatch.
    paginateAll((from, to) => sb
      .from('special_addons')
      .select('code, label, so_description, categories')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('code', { ascending: true })
      .range(from, to)),
    // SOFA Models — allowed_options.specials is the per-model ON/OFF authority
    // for which specials each model offers. Used to build the SKU→allowed-codes
    // map so validateSlip keeps only a special the line's model actually allows.
    paginateAll((from, to) => sb
      .from('product_models')
      .select('model_code, allowed_options')
      .eq('category', 'SOFA')
      .range(from, to)),
    // The venue master (public.project_venues, ACTIVE) — env.DB, not `sb`.
    loadVenueNames(db),
  ]);

  const skus: CatalogSku[] = ((prodRes.data as Array<{
    code: string; name: string; category: string; base_model: string | null;
  }> | null) ?? []).map((p) => ({
    code: p.code,
    name: p.name,
    category: p.category,
    baseModel: p.base_model ?? null,
  }));

  const fabrics: CatalogFabric[] = ((fabRes.data as Array<{
    fabric_code: string; fabric_description: string | null;
  }> | null) ?? []).map((f) => ({
    code: f.fabric_code,
    description: f.fabric_description ?? null,
  }));

  let sofaSizes: string[] = [];
  let sofaLegHeights: string[] = [];
  let legHeights: string[] = [];
  let divanHeights: string[] = [];
  let gaps: string[] = [];
  const cfg = (cfgRes.data as { config?: Record<string, unknown> } | null)?.config;
  if (cfg && typeof cfg === 'object') {
    // optionValues filters inactive entries (plain strings = active).
    sofaSizes = optionValues(cfg.sofaSizes);
    sofaLegHeights = optionValues(cfg.sofaLegHeights);
    legHeights = optionValues(cfg.legHeights);
    divanHeights = optionValues(cfg.divanHeights);
    gaps = optionValues(cfg.gaps);
  }

  const options = emptyOptions();
  for (const row of (optRes.data as Array<{
    category: string; value: string; label: string;
  }> | null) ?? []) {
    if ((OPTION_CATEGORIES as readonly string[]).includes(row.category)) {
      options[row.category as OptionCategory].push({ value: row.value, label: row.label });
    }
  }

  // Distinct, de-duped state names (the my_localities table has one row per
  // postcode, so the same state repeats thousands of times) + the city /
  // postcode pools hanging off each cascade step.
  const stateSeen = new Set<string>();
  const states: string[] = [];
  const citiesByState = new Map<string, Map<string, string>>();
  const postcodesByStateCity = new Map<string, Set<string>>();
  for (const row of (locRes.data as Array<{
    state: string | null; city: string | null; postcode: string | null;
  }> | null) ?? []) {
    const st = (row.state ?? '').trim();
    if (!st) continue;
    const stKey = st.toUpperCase();
    if (!stateSeen.has(stKey)) {
      stateSeen.add(stKey);
      states.push(st);
    }
    const ct = (row.city ?? '').trim();
    if (!ct) continue;
    let cityPool = citiesByState.get(stKey);
    if (!cityPool) { cityPool = new Map(); citiesByState.set(stKey, cityPool); }
    // First spelling in wins — the read is ordered, and a duplicate city row
    // only differs by postcode.
    if (!cityPool.has(ct.toUpperCase())) cityPool.set(ct.toUpperCase(), ct);
    // Postcodes are stored as 5 digits; strip any stray separator so the
    // membership test matches what validateSlip normalises the OCR read to.
    const pc = (row.postcode ?? '').replace(/[^\d]/g, '');
    if (pc.length !== 5) continue;
    const lk = localityKey(st, ct);
    let pcPool = postcodesByStateCity.get(lk);
    if (!pcPool) { pcPool = new Set(); postcodesByStateCity.set(lk, pcPool); }
    pcPool.add(pc);
  }
  states.sort((a, b) => a.localeCompare(b));

  const specials: CatalogSpecial[] = ((spcRes.data as Array<{
    code: string; label: string; so_description: string | null; categories: string[] | null;
  }> | null) ?? []).map((s) => ({
    code: s.code,
    label: s.label,
    soDescription: s.so_description ?? null,
    categories: Array.isArray(s.categories) ? s.categories : [],
  }));

  // model_code → the special CODES that model's allowed_options.specials lists
  // (uppercased for case-insensitive lookup). allowed_options is jsonb; PostgREST
  // may return it camelCased — dual-read either casing.
  const specialsByModelCode = new Map<string, Set<string>>();
  for (const row of (modRes.data as Array<Record<string, unknown>> | null) ?? []) {
    const modelCode = (row.modelCode ?? row.model_code) as string | undefined;
    if (!modelCode) continue;
    const opts = (row.allowedOptions ?? row.allowed_options) as { specials?: unknown } | null;
    const list = Array.isArray(opts?.specials) ? (opts!.specials as unknown[]) : [];
    const set = new Set<string>();
    for (const v of list) if (typeof v === 'string' && v.trim() !== '') set.add(v.toUpperCase());
    specialsByModelCode.set(modelCode.toUpperCase(), set);
  }
  // SKU code → its Model's allowed special codes. SOFA SKUs are
  // `{model_code}-{compartment}` with base_model = model_code; resolve each
  // SKU's allowed set off base_model so validateSlip can gate per line.
  const specialsByModelSku = new Map<string, Set<string>>();
  for (const s of skus) {
    if (!s.baseModel) continue;
    const allowed = specialsByModelCode.get(s.baseModel.toUpperCase());
    if (allowed) specialsByModelSku.set(s.code.toUpperCase(), allowed);
  }

  return {
    skus, fabrics, specials, specialsByModelSku,
    sofaSizes, sofaLegHeights, legHeights, divanHeights, gaps,
    options, venues: venueNames, states, citiesByState, postcodesByStateCity,
  };
}

function formatCatalog(c: Catalog): string {
  const lines: string[] = [];
  const byCategory = new Map<string, CatalogSku[]>();
  for (const s of c.skus) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  // SERVICE gets its own labelled section (delivery / lift / dispose fees),
  // the goods categories follow.
  for (const cat of ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE']) {
    const list = byCategory.get(cat);
    if (!list || list.length === 0) continue;
    // Slim: code | name only (base_model dropped 2026-06-23). The model name in
    // `name` is enough for fuzzy matching; dropping base_model shrinks the cached
    // prefix (1141 SKUs) so the first/warm call is faster and the cache cheaper.
    lines.push(`=== ${cat} SKUS (code | name) ===`);
    for (const s of list) {
      lines.push(`${s.code} | ${s.name}`);
    }
    lines.push('');
  }

  lines.push('=== FABRICS (code | description) ===');
  for (const f of c.fabrics) lines.push(`${f.code} | ${f.description ?? ''}`);
  lines.push('');

  // Configured SOFA Special Add-ons — the specialsMatch rule (LINE ITEMS) maps a
  // slip remark to one of these CODES (left side), copied character-for-character.
  lines.push('=== SOFA SPECIAL ADD-ONS (code | label) ===');
  if (c.specials.length === 0) lines.push('—');
  for (const s of c.specials) lines.push(`${s.code} | ${s.label}`);
  lines.push('');

  lines.push('=== SOFA SIZES (seat sizes) ===');
  lines.push(c.sofaSizes.join(', ') || '—');
  lines.push('');
  lines.push('=== SOFA LEG HEIGHTS ===');
  lines.push(c.sofaLegHeights.join(', ') || '—');
  lines.push('');

  // Delivery STATES allowed-values list — the addressStateMatch in the system
  // prompt must return one of these EXACTLY (the form's State <select> only
  // accepts a real my_localities state).
  lines.push('=== DELIVERY STATES (allowed values) ===');
  lines.push(c.states.join(', ') || '—');
  lines.push('');

  // SO Maintenance allowed-values lists — the OPTION MATCHING rules in the
  // system prompt reference these section names. value | label per row;
  // the VALUE (left side) is what option matches must return.
  const optionSection = (title: string, cat: OptionCategory) => {
    lines.push(`=== ${title} (allowed values: value | label) ===`);
    const rows = c.options[cat];
    if (rows.length === 0) lines.push('—');
    for (const o of rows) lines.push(`${o.value} | ${o.label}`);
    lines.push('');
  };
  optionSection('PAYMENT METHODS',   'payment_method');
  optionSection('MERCHANT BANKS',    'payment_merchant');
  optionSection('ONLINE TYPES',      'online_type');
  optionSection('INSTALLMENT PLANS', 'installment_plan');
  optionSection('CUSTOMER TYPES',    'customer_type');
  optionSection('BUILDING TYPES',    'building_type');

  /* VENUES allowed-values list — the venue MASTER (public.project_venues), the
     same list SO Maintenance shows and the New-SO Venue dropdown renders (owner
     ruling 2026-07-16). This section used to be emitted by optionSection over
     so_dropdown_options.venue; re-sourcing it is a ONE-TIME cached-prefix change
     (see Catalog.venues). Kept under the SAME "VENUES" heading the prompt's
     locationMatch rule already names, so no prompt rule moves.

     One name per line, not comma-joined like DELIVERY STATES: a venue name is
     free text from Project Maintenance and may itself contain a comma. */
  lines.push('=== VENUES (allowed values) ===');
  if (c.venues.length === 0) lines.push('—');
  for (const v of c.venues) lines.push(v);
  lines.push('');

  return lines.join('\n').trimEnd();
}

// Cached prefix = SYSTEM_PROMPT + catalog. Identical across calls until the
// catalog changes → Anthropic prompt-cache hit (~90% discount). The cache is
// shared per-API-key + per-identical-prefix across all users, so /warm and
// /extract MUST build this BYTE-IDENTICALLY (same function, same inputs) or
// they warm/read different caches. SINGLE SOURCE OF TRUTH — never inline this
// string anywhere else. Few-shot/rep-rule/alias blocks stay OUTSIDE this prefix
// (after the cache boundary) so a new sample doesn't invalidate the cache.
export function buildCachedPrefix(catalog: Catalog, companyName: string): string {
  return `${buildSystemPrompt(companyName)}\n\nCATALOG\n=======\n${formatCatalog(catalog)}`;
}

// Warm the Anthropic prompt cache with the catalog prefix so the next real
// /extract reads a hot cache instead of paying full price on a cold catalog.
// ONE minimal Claude call: the IDENTICAL cachedPrefix (same model, same
// cache_control ttl, same beta header as /extract) plus a tiny 'warm' tail,
// max_tokens:1. Shared by the /scan-so/warm endpoint AND the keep-warm cron so
// neither can drift from /extract. Graceful: no key → { ok:false, reason }; any
// fetch failure is caught and returned, never thrown.
type WarmResult = { ok: boolean; reason?: string; cacheCreated?: boolean; cacheRead?: boolean };
async function warmCatalogCache(
  sb: SupabaseClient,
  db: D1Database,
  apiKey: string | undefined,
  companyName: string,
  companyId?: number | null,
): Promise<WarmResult> {
  if (!apiKey) return { ok: false, reason: 'no_key' };
  let catalog: Catalog;
  try {
    catalog = await loadCatalog(sb, db, companyId);
  } catch (e) {
    return { ok: false, reason: `catalog_load_failed: ${(e as Error).message}` };
  }
  const cachedPrefix = buildCachedPrefix(catalog, companyName);
  try {
    const resp = await anthropicFetchWithRetry({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // MUST match /extract — same beta header or the cache is a different
        // bucket and warming is pointless.
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              // BYTE-IDENTICAL cached block to /extract (same text, same
              // cache_control ttl) so this writes the cache /extract then reads.
              { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } },
              { type: 'text', text: 'warm' },
            ],
          },
        ],
      }),
    });
    const bodyText = await resp.text();
    if (!resp.ok) {
      return { ok: false, reason: `Anthropic ${resp.status}: ${bodyText.slice(0, 300)}` };
    }
    let parsedResp: AnthropicResponse;
    try {
      parsedResp = JSON.parse(bodyText) as AnthropicResponse;
    } catch {
      return { ok: false, reason: `Anthropic returned non-JSON: ${bodyText.slice(0, 200)}` };
    }
    if (parsedResp.error) {
      return { ok: false, reason: `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}` };
    }
    return {
      ok: true,
      cacheCreated: (parsedResp.usage?.cache_creation_input_tokens ?? 0) > 0,
      cacheRead: (parsedResp.usage?.cache_read_input_tokens ?? 0) > 0,
    };
  } catch (e) {
    return { ok: false, reason: `Network/fetch error: ${(e as Error).message}` };
  }
}

// Cron-callable warm: same logic as the /warm endpoint but takes an Env
// (cron has no Hono context). getSupabaseService is the same scm-scoped service
// client scan-so uses internally — RLS-bypass is fine for a read-only catalog
// load. Exported for index.ts's scheduled handler so the cron and the endpoint
// share ONE Claude call.
//
// env.DB carries the venue master read (project_venues). The scheduled handler
// wraps its env in withPgDb() before calling this, so DB points at Postgres here
// exactly as it does on the request path — the cached prefix stays byte-identical.
export async function warmCatalogCacheForCron(env: Env): Promise<WarmResult> {
  const branding = await getBranding(env);
  /* The keep-warm CRON has no request and so no active company: it warms the
     UNSCOPED catalogue. That is a prompt-cache HIT-RATE concern only (/extract
     and the job now send a company-scoped catalogue, so the warmed prefix stops
     matching once the two companies' catalogues diverge) — never a correctness
     one. Fixing it needs a per-company warm loop; flagged, not done here.  */
  return warmCatalogCache(getSupabaseService(env), env.DB, env.ANTHROPIC_API_KEY, branding.companyName, null);
}

// ===========================================================================
// Prompt
// ===========================================================================
// The OCR system prompt anchors itself to the company name. It used to be a
// hardcoded "Houzs Century"; it now comes from the central Branding config
// (getBranding) so the literal lives in ONE place. The company name is STABLE
// (seeded, rarely edited), so injecting it keeps buildCachedPrefix() byte-
// identical across /warm + /extract + the cron — the prompt cache still holds.
const buildSystemPrompt = (companyName: string) => `You extract structured data from photos of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. The slips are carbon-copy order forms (Zanotti / AKEMI style): a printed header block (customer name, contact, address, delivery date) filled in by hand, a handwritten line-item table (description, qty, price), and a footer with totals, deposit, payment method, and the salesperson's name.

The handwriting is often rushed, slanted, abbreviated, and mixed-case. Phone photos may be skewed, shadowed, or low-contrast. Read carefully; prefer extracting a raw transcription over guessing.

AMBIGUITY — FLAG, DO NOT GUESS. When a field is genuinely ambiguous (two equally-plausible readings, a smudged or half-formed digit, an unclear size, a model that could be one of several), do NOT pick one at random and report it confidently. Return your single best guess at a LOWER confidence (below 0.6) and state the ambiguity in that field's "reason" (and/or the line's "notes") so the operator reviews it. A flagged ambiguity the operator catches beats a confident wrong value that survives review — wrong-but-confident is the value that slips through unchecked.

NUMBERS — read the FULL numeric token; never truncate a multi-digit number to its first digit. A digit immediately followed by another digit (before any non-digit) is ONE multi-digit number: "12" is 12 (NEVER 1), "RM1,250" is 1250, "x10" is qty 10 (NEVER 1). The inch / quote mark (" or ') and trailing unit words ("ft", "pcs", "mm") are unit/spec text, NOT digit separators — do not let them split or truncate the number.

MULTIPLE IMAGES
===============
You may receive ONE HANDWRITTEN order slip (a carbon-copy form with the customer, line items, handwriting, and payment checkboxes) and ZERO, ONE, OR MORE PRINTED card-terminal payment RECEIPTS (each a thermal print: a bank name e.g. Maybank / Public Bank / CIMB, VISA / Mastercard, an APPROVAL CODE, a TOTAL amount, and often a TENURE / number of months for an EPP plan). One order can be paid across SEVERAL receipts (a deposit now + a balance, or split across two card terminals) — treat EACH printed receipt as ONE separate payment. Decide what each input image is:
- Read the ORDER fields (customerName, address, phones, line items, deliveryDate, processingDate, salesRep) from the HANDWRITTEN slip.
- Read the PAYMENT fields (paymentMethodMatch / bankMatch / installmentPlanMatch / approvalCode / depositRm or the receipt's amount) PREFERENTIALLY from a PRINTED receipt when one is present — the printed thermal receipt is far more accurate than the handwritten payment note. Still keep the handwritten payment note verbatim in paymentMethod. When NO receipt is present, fall back to the handwritten slip's payment note exactly as before. When a receipt and the handwriting DISAGREE (a different bank, a different amount, a different approval code), the PRINTED receipt wins for the structured fields — but you MUST state the disagreement in that field's reason (e.g. "slip writes PBB but receipt terminal is Maybank — using receipt") so the operator sees the conflict.
- The SINGULAR payment fields (paymentMethodMatch / bankMatch / installmentPlanMatch / approvalCode / depositRm) describe the PRIMARY (first) receipt, exactly as before. In ADDITION, emit the OUTPUT "payments" array with ONE entry PER payment-receipt image (see below) — each entry carries THAT receipt's own amount, bank, method, tenure, approval code and date. When there is exactly one receipt, "payments" has one entry that matches the singular fields. When there is no receipt, "payments" is [].
You MUST also classify every input image in the OUTPUT "images" array (see below).

A reference CATALOG follows this prompt (live product SKUs, fabrics, sofa sizes, leg heights). It is the FULL master (≈1100+ SKUs) — every catalog row is "code | name". Use it for AGGRESSIVE fuzzy / keyword / substring / abbreviation matching: a slip token should resolve to the SKU whose NAME contains that token's keyword, even when the rep wrote only a fragment. Search the WHOLE catalog before giving up.

EXTRACTION RULES
================
1. customerName — the customer's name from the header block (NOT the salesperson).
2. address — full delivery address as one string, exactly as written (keep unit numbers, taman names, postcode, state). ALSO break the same address into its parts (see ADDRESS PARTS below) so the form can fill State / City / Postcode.
3. phones — ALL phone numbers on the slip, as raw strings exactly as written (e.g. "012-345 6789", "+6017 888 9999"). Multiple numbers are common (customer + spouse). Do NOT normalize or reformat. A phone is CRITICAL — transcribe EVERY digit, including REPEATED / doubled digits: read "01137166720" as 0-1-1-3-7-1-6-6-7-2-0 (eleven digits), NEVER collapse a doubled "66" into a single "6". A Malaysian number is 10-11 digits INCLUDING the leading trunk 0 (011-XXXX XXXX = 11 digits; 01X-XXX XXXX = 10). If your reading has FEWER than 10 digits, you almost certainly dropped or merged a digit — re-examine the handwriting (look for a doubled digit) before returning it. If a single digit is genuinely unclear, return your best reading at confidence < 0.6 and say so in the field's reason so the operator double-checks.
4. location — the showroom / venue / branch the order was taken at, if written (often a header checkbox or stamp).
5. deliveryDate — as written. If it is a real date, convert to YYYY-MM-DD (slips write DD/MM or DD/MM/YYYY — Malaysian day-first). If it says "TBC", "call first", "after CNY" or any non-date text, return that text verbatim.
6. processingDate — the order/slip date if present, YYYY-MM-DD when parseable, else verbatim text, else null. The year is often omitted or scrawled: when the year is missing/unreadable, take it from the PRINTED payment receipt's date when one is present, else assume the CURRENT year — NEVER invent a distant past year (a slip is days old, not years). If even the day/month is unclear, return the verbatim text instead of a made-up date.
7. salesRep — the salesperson's name from the footer/header.
8. paymentMethod — as written ("cash", "TNG", "bank transfer", "CC", deposit slips etc.). null if absent.
9. depositRm / totalRm — RM amounts as NUMBERS (e.g. "RM 1,500" → 1500, "550.50" → 550.5). null when blank. When a PRINTED receipt is present, depositRm = the receipt's printed TOTAL/AMOUNT (the money actually charged); if the handwritten deposit differs from the receipt amount, use the RECEIPT amount and flag the mismatch (state both figures in paymentMethodMatch's reason). Never swap depositRm and totalRm — the deposit is the smaller paid-now figure, the total is the whole order.
10. remarks — ONLY the genuine ORDER REMARK: a handwritten free-text note that is not a line item and does not already belong to a dedicated field — e.g. a promo note, a special handling instruction like "FOC dispose, not dismantle", "lift access", "self collect", floor info. Do NOT copy the venue/location, the phone numbers, the payment method/bank/EPP term, the deposit/total amounts, the delivery date, or the salesperson into remarks — those each have their own output fields and must NOT be duplicated here. Return null when there is no such standalone remark.
11. approvalCode — the approval / reference number of the card payment. When a PRINTED receipt is present, read it from the receipt's "APPROVAL CODE" / "APPR CODE" / "AUTH CODE" line — the PRINTED code wins over any handwritten parenthesised number (the rep often copies it wrong); the handwritten note still rides verbatim in paymentMethod. With no receipt, use the handwritten payment-line code (e.g. "(001586)" → "001586", "Appr 028471" → "028471"). Strip surrounding brackets/labels and return the bare digits/alphanumerics as a string. null when neither carries one.
12. customerSoRef — the CUSTOMER'S OWN reference number for this order: the slip's / docket's OWN serial, usually in the TOP-RIGHT corner. On a showroom / supplier slip this is the PRE-PRINTED coloured serial — typically a LETTER-prefixed code (letters + digits, e.g. "HC14032", "ZNT5329"). PREFER that pre-printed letter-prefixed serial. A hand-written "SO ####" jotting (or a bare "SO 1234" scrawled by the rep) is NOT the docket — do NOT return it as customerSoRef; the printed serial wins over any handwritten "SO…" note. It is the SLIP's own number, NOT a phone number, NOT a price, NOT the salesperson code, NOT the delivery date. Return the bare reference string exactly as written (keep its letter prefix, e.g. "HC14032", "ZNT5329"). null when no such number is on the slip.
    Example: a slip with a printed top-right serial "ZNT5329" AND a handwritten "SO 88" in the body → customerSoRef = "ZNT5329" (the pre-printed letter-prefixed docket), NOT "SO 88".
    Example: a slip whose only top-right reference is the pre-printed "HC14032" → customerSoRef = "HC14032".

ADDRESS PARTS
=============
Besides the full "address" string, break the SAME delivery address into structured parts so the form can fill its State / City / Postcode dropdowns. Read carefully — a Malaysian address ends "..., <postcode> <city>, <state>" (e.g. "..., 81100 Johor Bahru, Johor").
- addressLine1 — the street portion: unit/house no., street, taman/area. Everything BEFORE the postcode. Verbatim. null when unreadable.
- postcode — the 5-digit Malaysian postcode (e.g. "81100"). Digits only. null when absent.
- city — the town / city (e.g. "Johor Bahru", "Petaling Jaya"). Verbatim as written. null when absent.
- addressStateMatch — the STATE, matched to the DELIVERY STATES allowed-values list at the end of the catalog. Return the state VALUE copied character-for-character from that list (handle handwriting: "JB"/"Johor Bahru area" still belongs to state "Johor"; "PJ"/"KL area" → "Selangor"/"Kuala Lumpur" per the list; "N.Sembilan" → "Negeri Sembilan"; "P.Pinang"/"Penang" → the list's Penang value). Same shape + same never-invent rule as the OPTION MATCHING below: { "value": <exact state from the list>, "confidence": 0-1, "reason": <short why> }. When you cannot confidently map to a listed state, return null and keep the raw text in "address" so nothing is lost.

LINE ITEMS
==========
For EVERY handwritten row in the item table output one lines[] entry:
- rawText — the row's text VERBATIM, exactly as written, including misspellings and abbreviations. This is the source of truth for the operator; never clean it up.
- rawSpec — when the row (or its margin / continuation text) carries a SPECIFICATION string for the item — the variant text such as "Col: PC151-01 + front / Side Divan 8\"+0\"", "divan10+4/gap12", "8\" + no leg" — copy the row's specification text verbatim into rawSpec; do not rephrase, reorder or normalise it (keep punctuation, slashes and inch marks exactly). null when the row has no spec text. rawSpec may overlap rawText — that is fine: rawText is the whole row, rawSpec is just the specification portion.
- divanHeightInches / legHeightInches / gapInches / noLeg — BEDFRAME variant NUMBERS read from the spec text: the divan/drawer height in inches, the leg height in inches, the mattress gap in inches, and noLeg = true when the spec says no legs ("no leg", "noleg"). Read the FULL numeric token (12" is 12, NEVER 1). Use null (and noLeg = false) when absent or when the row is not a bedframe.
- seatHeightInches — SOFA seat-height in inches. A sofa row's seat size is usually written as a parenthesised inch figure right after the model / sections, e.g. "8030 (2R+1R)(28\")" → 28, or "seat 30\"" / "H30" → 30. Read the FULL numeric token as a plain NUMBER (28" is 28, NEVER 2). The seat size applies to EVERY compartment of that sofa, so repeat the SAME seatHeightInches on each compartment line you emit for the sofa. Use null when the row is not a sofa or no seat size is written (do NOT guess a seat height).
- qtyGuess — quantity (default 1 when blank or unreadable).
- priceRmGuess — the row's unit price in RM as a number; null when blank. If only a line total is written and qty > 1, still report the written figure and say so in notes. SET / PACKAGE TOTALS: when ONE written amount covers SEVERAL lines (a multi-compartment sofa set, a bundle where only the first row carries a figure), attach that amount as priceRmGuess on the FIRST emitted line of the set ONLY — every other line of the set gets priceRmGuess = null — and write "set/package total" in the first line's notes. Never attach the same set total to more than one line, and never attach it to a later compartment.
- skuMatch — your best FUZZY match against the catalog SKUS:
    { "code": <exact catalog code>, "confidence": 0-1, "reason": <short why> }
  Handwriting mangles model names AND reps write heavy shorthand — match AGGRESSIVELY against the FULL catalog. Try HARD before returning null; a slip token almost always corresponds to some catalog row whose NAME contains that keyword:
    • misspellings: "Ultimatee" / "Ultmate" → the ULTIMATE model's SKU.
    • partial names: "Hilton K" → the HILTON bedframe King-size SKU.
    • base-model + size: a written size (King/Queen/K/Q/SS/S.S/SP/6FT/5FT) picks the size variant within the base model.
    • KEYWORD / SUBSTRING tokens: a single descriptive word maps to the SKU whose name CONTAINS that word — "holes" → the SKU whose name contains "HOLES" (e.g. "… 7 HOLES PILLOW"); "bolster" → the SKU whose name contains "BOLSTER"; "Shamplo pillow" / "hole pillow" → the matching pillow SKU by its distinctive keyword; "square pillow" / "sq pillow" → the ACCESSORY SKU whose name contains "SQUARE PILLOW" (do NOT leave it null — search the ACCESSORY rows for the SQUARE PILLOW SKU and return that code).
    • ABBREVIATION expansion: expand the rep's shorthand to the full catalog wording before matching — "W. Protector" / "W.Protector" → "WATERPROOF PROTECTOR"; "MP" → "MATTRESS PROTECTOR"; "Guardian" → the GUARDIAN model. Then apply the size token: "W. Protector (King)" → the WATERPROOF PROTECTOR King SKU; "W. Protector (S.S)" → the Super-Single one; "MP (Q)" → the MATTRESS PROTECTOR Queen SKU; "Guardian (King)" / "Guardian (Super Single)" → the GUARDIAN bedframe at King / Super-Single.
    • SIZE TOKEN MAP — the parenthesised/trailing size on a slip maps to the catalog size grid: K = King, Q = Queen, SS / S.S / S/S = Super Single, S = Single, SP = Special/custom, 6FT ≈ Queen, 5FT ≈ Queen/King per the model's grid. Pick the SKU row whose name carries that size.
  VARIANT / DESCRIPTION-STYLE LINES (especially BEDFRAME). A row is often written as a base model PLUS variant options and a fabric code rather than a clean model name, e.g. "Col: PC151-01 + front / Side Divan 8\"+0\"". Read it as: a FABRIC/colour code (here "PC151-01" — match it in fabricMatch, see below), plus VARIANT options (a divan/side build, a divan height like 8", a leg/gap like 0"). These variant phrases are NOT part of the model name — strip them when looking for the model:
    • Identify the catalog MODEL from the remaining model words on the row (or the row above, since reps often write the model once and list fabrics/variants beneath). Match THAT to the BEDFRAME (or SOFA) SKUS.
    • If the catalog encodes size/variant as distinct SKU rows for that model, pick the SKU whose name matches the written size/variant; the divan-height / side / leg / gap details that the catalog does NOT encode as a SKU stay in "notes" for the operator to set in the form's variant picker.
    • A bare fabric code with NO model word on the row (or above it) is NOT enough to choose a model — set skuMatch = null, put the fabric in fabricMatch, and let rawText + notes carry the variant text. Never guess a model from a fabric code alone.
  Rules:
    • PREFER THE PLAIN / GENERIC ROW over a branded variant. When several catalog SKUs match a slip token, choose the most generic catalog match — the row WITHOUT a brand prefix (e.g. "JM", "AKEMI", a maker name) — UNLESS the slip explicitly writes that brand. Example: "W. Protector (King)" → the plain "MATTRESS PROTECTOR (KING)" / "WATERPROOF PROTECTOR (KING)", NOT a "JM …" branded protector, because the slip names no brand. Only pick the branded SKU when the slip itself writes the brand token. EXCEPTION — the FORM'S OWN PRINTED BRAND counts as a written brand: on a brand-headed order form (e.g. an AKEMI carbon-copy form), an unbranded accessory row prefers THAT brand's SKU when one exists ("W. Protector (King)" on an AKEMI form → the AKEMI waterproof protector King), falling back to the generic row only when the form's brand has no such SKU. Apply this consistently — do not alternate between the branded and generic row across lines of the same slip.
    • The code MUST be copied character-for-character from the catalog. NEVER invent, modify, or extrapolate a code that is not in the catalog. NEVER assemble a code out of a fabric code + a size; the code must already exist verbatim in the SKUS list.
    • Only AFTER genuinely searching the whole catalog by keyword/substring/abbreviation and finding nothing defensible, set skuMatch = null and let rawText speak. A null with good rawText is worth more than a wrong code — but a real catalog row keyworded in the slip token must NOT be returned as null.
    • confidence: 0.9+ only when the written text clearly identifies one specific catalog row; 0.5-0.8 when the model matches but the size/variant is ambiguous; below 0.5 prefer null.
  MULTI-COMPARTMENT SOFA — ONE LINE PER COMPARTMENT. A sofa is often written as a base model PLUS several seat sections in one row, e.g. "8030 (2R+1R)(28\")" or "2A+1A", or drawn as a multi-box layout (the hand-drawn box+TV sketch shows the seating arrangement). When a sofa line names MORE THAN ONE seat section, EMIT ONE lines[] ENTRY PER COMPARTMENT (do NOT collapse them into a single line). For each compartment:
    • skuMatch = the catalog SKU {base_model}-{compartment} where compartment carries the arm direction, e.g. "8030-2A(LHF)" for the 2-seater and "8030-1A(RHF)" for the 1-seater. These per-compartment SKUs EXIST verbatim in the SOFA SKUS — copy the matching row character-for-character; never assemble one that is not in the catalog (if no per-compartment row exists, fall back to the base-model SKU + a notes flag).
    • The seat size (e.g. 28") and the fabric colour (e.g. "Col BO315-22") apply to EVERY compartment line — repeat them on each (qtyGuess per compartment is usually 1).
    • DIRECTION (LHF = left-hand-facing / RHF = right-hand-facing) — decide it per compartment PRIMARILY from the drawn "TV" marker: the hand sketch draws the sofa boxes facing a box labelled "TV" (the television / feature wall), and the compartment that sits to the VIEWER'S LEFT of the layout as it faces the TV is LHF, the one to the VIEWER'S RIGHT is RHF. Use the TV marker's position to orient the whole layout, then read each compartment's side off that orientation; also cross-check "左/右" or "X left Y right" notes. BE CONSERVATIVE: if there is NO TV marker and the side is genuinely ambiguous, emit the compartment WITHOUT forcing a wrong direction — pick the {base_model}-{compartment} SKU without the (LHF/RHF) suffix (or set skuMatch=null with the compartment in notes) and lower confidence so the operator picks the side. Never guess a side confidently without the TV marker or an explicit left/right note.
    Example: "8030 (2R+1R)(28\") Col BO315-22" → TWO lines: line 1 skuMatch="8030-2A(LHF)", line 2 skuMatch="8030-1A(RHF)"; BOTH carry seatHeightInches=28 and fabricMatch.code="BO315-22"; rawText on each line is the verbatim row.
- fabricMatch — match against the FABRICS catalog whenever the row (or a margin note, or a "Col:" / "Color" / "Fabric" prefix) names a fabric/colour code (e.g. "PC151-01", "Col: PC151-01"). The fabric code is frequently the FIRST token on a bedframe/sofa variant line; always look for it there. null when the row names no fabric. Same never-invent rule — the code must be copied character-for-character from the FABRICS list.
- specialsMatch — an array of CONFIGURED SOFA SPECIAL ADD-ONS the row's free-text descriptor asks for. The catalog has a "SOFA SPECIAL ADD-ONS (code | label)" section; when a phrase on the row (or a margin note attached to the row) DESCRIBES one of those add-ons, emit it here as { "code": <exact catalog special code>, "confidence": 0-1, "reason": <short why> } INSTEAD of dumping that phrase into notes/remarks. Map by MEANING against each special's label:
    • "change nylon cover" / "nylon bottom" / "nylon fabric" / "尼龙布底" → the NYLON-fabric special.
    • "short backrest" / "lower backrest" / "矮靠背" / "短靠背" → the short/low-backrest special.
    • "extend 5\"" / "lengthen seat" / "加长" → the seat-extension special.
    • "no bracket" / "remove bracket" / "免支架" → the no-bracket special.
  Match AGGRESSIVELY by keyword against the special LABELS, the same way skuMatch fuzzes the SKU names. A row may carry MORE THAN ONE special (emit one array entry each); most rows carry none (emit []). KEEP the original phrase verbatim in rawText regardless — specialsMatch is in ADDITION to rawText, and the matched phrase must NOT also be copied into notes/remarks. Same never-invent rule as skuMatch: the code MUST be copied character-for-character from the SOFA SPECIAL ADD-ONS list; when no add-on label defensibly matches the phrase, leave it OUT of specialsMatch (do not invent a code) and let rawText/notes carry it. Only SOFA lines carry specials; for non-sofa rows return [].
- notes — anything else on the row the operator should see (free gifts, "FOC", sizes that don't match the catalog, unreadable words flagged as "[illegible]"). Do NOT put a phrase here that you already emitted in specialsMatch.

Delivery fees, disposal fees and lift/stair-carry charges written as rows ARE line items — match them against the SERVICE SKUS section.

OPTION MATCHING (SO Maintenance vocabularies)
=============================================
The catalog ends with ALLOWED VALUES lists (PAYMENT METHODS, MERCHANT BANKS, ONLINE TYPES, INSTALLMENT PLANS, CUSTOMER TYPES, BUILDING TYPES, VENUES). Each list row is "value | label" — a match must return the VALUE (left side), copied character-for-character. NEVER invent a value outside the list; when you cannot find a defensible match, return null for that field and keep the raw handwriting in paymentMethod / location / remarks so nothing is lost. Use the same confidence scale as skuMatch.

Map the slip's handwritten notes to these fields:
- paymentMethodMatch — the top-level method, one of PAYMENT METHODS. The ONLY valid values are "Merchant", "Online", and "Cash"; never return any other method. A CREDIT CARD paid through a BANK — a card machine / credit-card terminal / a bank name with a card swipe, WITH OR WITHOUT an EPP/installment term → "Merchant" (a bank EPP is a Merchant card payment plus an installment term carried in installmentPlanMatch). Bank transfer / TNG / DuitNow / cheque → "Online". Cash → "Cash".
- bankMatch — one of MERCHANT BANKS when a bank is named ("mbb"/"maybank" → the Maybank value (MBB), "pbb"/"public bank" → the Public-bank value, "cimb" → CIMB, "hlb"/"hong leong" → HLB, "rhb" → RHB, "aeon"/"aeon credit" → the AEON value, "hsbc" → the HSBC value). On a CREDIT card / EPP payment the named bank is the merchant bank — always populate bankMatch alongside paymentMethodMatch = "Merchant". WHICH BANK on a printed receipt: bankMatch is the bank/company OPERATING THE TERMINAL (the receipt's own letterhead / logo / "Host" line — a Maybank-headed receipt → MBB, a Public Bank receipt → Public, an AEON Credit Service receipt → AEON). It is NOT the "Card Issuer:" line — the issuer is the customer's own card bank and must be IGNORED for bankMatch (an AEON EPP receipt showing "Card Issuer: HSBC Bank" → AEON, never HSBC). Only when the receipt letterhead itself is HSBC does bankMatch = HSBC. When receipt and handwriting disagree, the receipt's terminal bank wins (say so in reason).
- onlineTypeMatch — one of ONLINE TYPES when the transfer channel is named (TNG / DuitNow / cheque / bank transfer). Only meaningful when the method is Online.
- installmentPlanMatch — one of INSTALLMENT PLANS. This is the plan UNDER a Merchant card payment. Rule: only return an N-month value when the receipt/slip ACTUALLY shows a tenure / month count ("12 EPP", "x12", "12 bln", "12个月", "12 months", "Tenure: 12 Months") → the matching N-month value (e.g. the 12-month value). For ANY card paid through a bank with NO month/tenure written — including a plain swipe AND an EPP/installment note that omits the month count — return the "One Shot" value from the INSTALLMENT PLANS list (a Maybank receipt with no tenure = One Shot). NEVER default to 12 months when no tenure is written. When a PRINTED receipt is present you MUST actively scan the WHOLE receipt for a tenure line ("TENURE", "EPP", "INSTAL", "MONTHS", "BLN") BEFORE answering One Shot — an EPP receipt prints its tenure in small type near the bottom; your reason must say either the tenure you found or that you searched the receipt and no tenure line exists.
- customerTypeMatch — one of CUSTOMER TYPES when the slip marks new/existing (header checkbox or note).
- buildingTypeMatch — one of BUILDING TYPES when the slip notes condo / landed / apartment etc.
- locationMatch — one of VENUES when the written showroom/venue/branch clearly matches a list entry. Still report the raw text in the location field.
Example: a payment note "[x]CREDIT : MBB EPP (12m) (001586) dep 1500" → paymentMethodMatch.value = the Merchant value (credit card via a bank = Merchant), bankMatch.value = the MBB/Maybank value, installmentPlanMatch.value = the 12-month value (the receipt shows a 12-month tenure), approvalCode = "001586" (the parenthesized number on the payment line), depositRm = 1500, paymentMethod = "CREDIT : MBB EPP (12m) (001586) dep 1500".
Example: a payment note "CREDIT MBB EPP (001586)" with NO month count → paymentMethodMatch.value = Merchant, bankMatch.value = the MBB value, installmentPlanMatch.value = the "One Shot" value (no tenure written → One Shot, NOT a 12-month default), approvalCode = "001586".
Example: a plain "CREDIT MBB (001586)" swipe with no EPP/term → paymentMethodMatch.value = Merchant, bankMatch.value = the MBB value, installmentPlanMatch.value = the "One Shot" value (a Maybank card paid through the bank with no tenure = One Shot), approvalCode = "001586".
Example: an AEON Credit receipt "Tenure: 12 Months APPR 046501" → paymentMethodMatch.value = Merchant, bankMatch.value = the AEON value, installmentPlanMatch.value = the 12-month value (the receipt shows a 12-month tenure), approvalCode = "046501".

- payments — ONE entry PER payment-receipt IMAGE, in image order, each describing THAT receipt on its OWN. imageIndex = the receipt image's "index" (the SAME index used in "images"). amountRm = the money charged on THAT receipt (its printed TOTAL / AMOUNT), as a NUMBER, null when unreadable. approvalCode / processingDate = that receipt's own approval code and printed date. paymentMethodMatch / bankMatch / onlineTypeMatch / installmentPlanMatch = that receipt's own option matches, resolved with the SAME rules and ALLOWED VALUES lists as the singular fields above (a card terminal → Merchant + its bank; a tenure line → the N-month plan, else One Shot). Do NOT sum or merge receipts: two RM 2,000 receipts are two entries of amountRm = 2000, never one of 4000. Every entry's imageIndex MUST be one of the images you classified as "payment_receipt"; NEVER emit a payments entry for the order-slip image. When there is no payment receipt, payments = [].
Example: an order paid by TWO card receipts — a Maybank deposit "TOTAL 1,500.00 APPR 001586" on image 1 and a Public Bank balance "TOTAL 3,200.00 APPR 778210" on image 2 → images = [{index:0,kind:"order_slip"},{index:1,kind:"payment_receipt"},{index:2,kind:"payment_receipt"}], payments = [{imageIndex:1, amountRm:1500, approvalCode:"001586", paymentMethodMatch.value = Merchant, bankMatch.value = the MBB value, installmentPlanMatch.value = the One Shot value}, {imageIndex:2, amountRm:3200, approvalCode:"778210", paymentMethodMatch.value = Merchant, bankMatch.value = the Public value, installmentPlanMatch.value = the One Shot value}]; the singular depositRm/bankMatch/approvalCode describe the FIRST receipt (image 1).

OUTPUT
======
Return STRICT JSON, no markdown fences, no prose:
{
  "images": [{ "index": number, "kind": "order_slip" | "payment_receipt" }],
  "customerName": string | null,
  "address": string | null,
  "addressLine1": string | null,
  "city": string | null,
  "postcode": string | null,
  "addressStateMatch": { "value": string, "confidence": number, "reason": string } | null,
  "phones": string[],
  "location": string | null,
  "deliveryDate": string | null,
  "processingDate": string | null,
  "salesRep": string | null,
  "customerSoRef": string | null,
  "paymentMethod": string | null,
  "depositRm": number | null,
  "totalRm": number | null,
  "remarks": string | null,
  "approvalCode": string | null,
  "paymentMethodMatch": { "value": string, "confidence": number, "reason": string } | null,
  "bankMatch": { "value": string, "confidence": number, "reason": string } | null,
  "onlineTypeMatch": { "value": string, "confidence": number, "reason": string } | null,
  "installmentPlanMatch": { "value": string, "confidence": number, "reason": string } | null,
  "payments": [{
    "imageIndex": number,
    "amountRm": number | null,
    "approvalCode": string | null,
    "processingDate": string | null,
    "paymentMethodMatch": { "value": string, "confidence": number, "reason": string } | null,
    "bankMatch": { "value": string, "confidence": number, "reason": string } | null,
    "onlineTypeMatch": { "value": string, "confidence": number, "reason": string } | null,
    "installmentPlanMatch": { "value": string, "confidence": number, "reason": string } | null
  }],
  "customerTypeMatch": { "value": string, "confidence": number, "reason": string } | null,
  "buildingTypeMatch": { "value": string, "confidence": number, "reason": string } | null,
  "locationMatch": { "value": string, "confidence": number, "reason": string } | null,
  "lines": [{
    "rawText": string,
    "rawSpec": string | null,
    "divanHeightInches": number | null,
    "legHeightInches": number | null,
    "gapInches": number | null,
    "noLeg": boolean,
    "seatHeightInches": number | null,
    "qtyGuess": number,
    "priceRmGuess": number | null,
    "skuMatch": { "code": string, "confidence": number, "reason": string } | null,
    "fabricMatch": { "code": string, "confidence": number, "reason": string } | null,
    "specialsMatch": [{ "code": string, "confidence": number, "reason": string }],
    "notes": string | null
  }]
}`;

// ===========================================================================
// Types
// ===========================================================================
type SkuMatch = { code: string; confidence: number; reason: string };
// SO-Maintenance option match — value is the so_dropdown_options row VALUE.
type OptionMatch = { value: string; confidence: number; reason: string };
// Per-input-image classification — which uploaded image is the handwritten
// order slip vs the printed card-terminal payment receipt. Drives which buffer
// gets stored under image_key (`scan-slips/{id}`) vs receipt_image_key
// (`scan-slips/{id}-receipt`) in the /extract handler.
type ImageKind = 'order_slip' | 'payment_receipt';
type ImageClass = { index: number; kind: ImageKind };
type ExtractedLine = {
  rawText: string;
  // Verbatim SPECIFICATION text for the row (bedframe/sofa variant string such
  // as "divan10+4/gap12") — mirrors HOOKKA scan-po.ts's rawSpec. Feeds the
  // server-side reparseSpec regex pass that overrules the model's numbers
  // (LLMs occasionally truncate 12" to 1 even at temperature 0).
  rawSpec: string | null;
  // BEDFRAME variant numbers. Model-reported first, then OVERRULED by
  // reparseSpec(rawSpec) in validateSlip for non-SOFA/ACCESSORY lines.
  // These are HINTS, not authority: buildDraftSoBodyFromSlip snaps each one to
  // the live Maintenance pool and leaves the axis UNSET when the pool has no
  // such option (owner 2026-07-16 — a slip misread seeded an 8" leg that was
  // never configured).
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  noLeg: boolean;
  // SOFA seat-height in inches read from the slip (e.g. "(28")"). Applies to
  // EVERY compartment of the sofa. buildDraftSoBodyFromSlip snaps it to the
  // sofaSizes pool and maps it to variants.seatHeight, so a scanned sofa seeds
  // the seat axis the same way a hand-keyed one does. null when absent or not a
  // sofa row. PRICING NOTE: itemGroup='sofa' reprices from seat height in the
  // create core — an OCR'd seat height therefore MOVES the sofa price. Verify
  // against real slips before trusting the read.
  seatHeightInches: number | null;
  qtyGuess: number;
  priceRmGuess: number | null;
  skuMatch: SkuMatch | null;
  fabricMatch: SkuMatch | null;
  // Configured SOFA special add-ons the row asks for (active special_addons
  // codes; validateSlip drops any not in the catalog or not allowed by the
  // line's resolved model). [] when none.
  specialsMatch: SkuMatch[];
  notes: string | null;
};
type ExtractedSlip = {
  customerName: string | null;
  address: string | null;
  // Structured address parts (the form fills State / City / Postcode from
  // these). addressLine1 is the street portion; addressStateMatch is snapped to
  // the live my_localities state list (validateSlip clears a non-listed state).
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  addressStateMatch: OptionMatch | null;
  phones: string[];
  location: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  salesRep: string | null;
  // The customer's own reference number for this order (usually top-right of the
  // slip, e.g. "HC14032") — seeds the form's "Customer SO Ref" field.
  customerSoRef: string | null;
  paymentMethod: string | null;
  depositRm: number | null;
  totalRm: number | null;
  remarks: string | null;
  // Card-terminal approval / reference number on the payment line (e.g. the
  // parenthesized "(001586)") — seeds the Payments-panel draft's approvalCode.
  approvalCode: string | null;
  // SO Maintenance vocab matches (active so_dropdown_options values only —
  // validateSlip clears anything outside the live lists).
  paymentMethodMatch: OptionMatch | null;
  bankMatch: OptionMatch | null;
  onlineTypeMatch: OptionMatch | null;
  installmentPlanMatch: OptionMatch | null;
  customerTypeMatch: OptionMatch | null;
  buildingTypeMatch: OptionMatch | null;
  // NOT a so_dropdown_options value — validateSlip snaps this to an ACTIVE
  // public.project_venues NAME (the venue master the pickers bind to; owner
  // ruling 2026-07-16) and clears it when the slip's venue isn't on that list.
  locationMatch: OptionMatch | null;
  // Per-input-image classification (order_slip vs payment_receipt). Used only
  // by /extract to decide which uploaded buffer to store under image_key vs
  // receipt_image_key — not surfaced in the modal's review form.
  images: ImageClass[];
  // MULTI-RECEIPT — one entry per PAYMENT-RECEIPT image the model read, each
  // with its OWN amount / bank / method / approval / date, keyed by the image's
  // `index`. The background job books ONE ledger row per entry (deposit +
  // balance, split card terminals). Empty when the scan carried no receipt, OR
  // for a legacy parse that only filled the singular payment fields above — the
  // planner then falls the FIRST receipt back to those singulars, so the
  // pre-multi behaviour is preserved byte-for-byte.
  payments: ExtractedPayment[];
  lines: ExtractedLine[];
};

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
  usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

type Warning = { field: string; value: string; message: string; lineIdx?: number };

// Defensive normalisation — Claude occasionally omits fields or returns the
// wrong primitive type. Coerce into the ExtractedSlip shape so the frontend
// never sees undefined where it expects an array.
function normalizeSlip(raw: unknown): ExtractedSlip {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const match = (v: unknown): SkuMatch | null => {
    if (!v || typeof v !== 'object') return null;
    const m = v as Record<string, unknown>;
    if (typeof m.code !== 'string' || m.code.trim() === '') return null;
    return {
      code: m.code,
      confidence: typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)) : 0,
      reason: typeof m.reason === 'string' ? m.reason : '',
    };
  };
  // Option matches use { value } instead of { code } — tolerate Claude
  // returning either key.
  const optionMatch = (v: unknown): OptionMatch | null => {
    if (!v || typeof v !== 'object') return null;
    const m = v as Record<string, unknown>;
    const value = typeof m.value === 'string' && m.value.trim() !== ''
      ? m.value
      : typeof m.code === 'string' && m.code.trim() !== '' ? m.code : null;
    if (value === null) return null;
    return {
      value,
      confidence: typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)) : 0,
      reason: typeof m.reason === 'string' ? m.reason : '',
    };
  };
  const lines: ExtractedLine[] = Array.isArray(r.lines)
    ? (r.lines as unknown[]).map((l) => {
        const li = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
        return {
          rawText: typeof li.rawText === 'string' ? li.rawText : '',
          rawSpec: str(li.rawSpec),
          divanHeightInches: num(li.divanHeightInches),
          legHeightInches: num(li.legHeightInches),
          gapInches: num(li.gapInches),
          noLeg: li.noLeg === true,
          seatHeightInches: num(li.seatHeightInches),
          qtyGuess:
            typeof li.qtyGuess === 'number' && Number.isFinite(li.qtyGuess) && li.qtyGuess > 0
              ? li.qtyGuess
              : 1,
          priceRmGuess: num(li.priceRmGuess),
          skuMatch: match(li.skuMatch),
          fabricMatch: match(li.fabricMatch),
          // specialsMatch — keep only well-formed { code, confidence, reason }
          // entries (same shape/coercion as skuMatch); a missing/garbled array
          // normalises to []. validateSlip then enforces never-invent + the
          // line's model allowed_options.specials gate.
          specialsMatch: Array.isArray(li.specialsMatch)
            ? (li.specialsMatch as unknown[])
                .map((s) => match(s))
                .filter((s): s is SkuMatch => s !== null)
            : [],
          notes: str(li.notes),
        };
      })
    : [];
  // Image classification — keep only well-formed { index:number, kind } entries
  // (kind one of the two known values). Anything else is dropped; the /extract
  // handler's positional fallback covers a missing/garbled array.
  const images: ImageClass[] = Array.isArray(r.images)
    ? (r.images as unknown[])
        .map((x) => {
          const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
          const index = typeof o.index === 'number' && Number.isFinite(o.index) ? o.index : null;
          const kind = o.kind === 'order_slip' || o.kind === 'payment_receipt' ? o.kind : null;
          return index === null || kind === null ? null : { index, kind };
        })
        .filter((x): x is ImageClass => x !== null)
    : [];
  // Per-receipt payments — keep only entries with a numeric imageIndex; each
  // carries its own amount / matches (option VALUES). Option matches ride as
  // { value } like the singular fields; store the VALUE string (validateSlip
  // enforces never-invent on the singulars; the per-receipt values are the
  // model's read of the SAME catalog-bound vocabulary).
  const optionValueOf = (v: unknown): string | null => optionMatch(v)?.value ?? null;
  const payments: ExtractedPayment[] = Array.isArray(r.payments)
    ? (r.payments as unknown[])
        .map((p) => {
          const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
          const imageIndex =
            typeof o.imageIndex === 'number' && Number.isFinite(o.imageIndex) ? o.imageIndex : null;
          if (imageIndex === null) return null;
          return {
            imageIndex,
            amountRm: num(o.amountRm),
            approvalCode: str(o.approvalCode),
            processingDate: str(o.processingDate),
            paymentMethodValue: optionValueOf(o.paymentMethodMatch),
            bankValue: optionValueOf(o.bankMatch),
            onlineTypeValue: optionValueOf(o.onlineTypeMatch),
            installmentPlanValue: optionValueOf(o.installmentPlanMatch),
          } satisfies ExtractedPayment;
        })
        .filter((p): p is ExtractedPayment => p !== null)
    : [];
  // BACK-FILL the SINGULAR payment fields from the FIRST receipt when the model
  // filled only payments[] — so the header deposit + the modal review form (both
  // read the singulars) still reflect the primary receipt, and a legacy single-
  // receipt read is unchanged (payments[0] equals the singulars there).
  const primaryPay = payments[0] ?? null;
  const depositRm = num(r.depositRm) ?? (primaryPay ? primaryPay.amountRm : null);
  const approvalCode = str(r.approvalCode) ?? (primaryPay ? primaryPay.approvalCode : null);
  const singularPaymentMatch = (own: unknown, val: string | null | undefined): OptionMatch | null => {
    const mine = optionMatch(own);
    if (mine) return mine;
    return val ? { value: val, confidence: 0, reason: 'from payment receipt' } : null;
  };
  return {
    images,
    payments,
    customerName: str(r.customerName),
    address: str(r.address),
    addressLine1: str(r.addressLine1),
    city: str(r.city),
    postcode: str(r.postcode),
    addressStateMatch: optionMatch(r.addressStateMatch),
    phones: Array.isArray(r.phones)
      ? (r.phones as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : [],
    location: str(r.location),
    deliveryDate: str(r.deliveryDate),
    processingDate: str(r.processingDate),
    salesRep: str(r.salesRep),
    customerSoRef: str(r.customerSoRef),
    paymentMethod: str(r.paymentMethod),
    depositRm,
    totalRm: num(r.totalRm),
    remarks: str(r.remarks),
    approvalCode,
    paymentMethodMatch:   singularPaymentMatch(r.paymentMethodMatch, primaryPay?.paymentMethodValue),
    bankMatch:            singularPaymentMatch(r.bankMatch, primaryPay?.bankValue),
    onlineTypeMatch:      singularPaymentMatch(r.onlineTypeMatch, primaryPay?.onlineTypeValue),
    installmentPlanMatch: singularPaymentMatch(r.installmentPlanMatch, primaryPay?.installmentPlanValue),
    customerTypeMatch:    optionMatch(r.customerTypeMatch),
    buildingTypeMatch:    optionMatch(r.buildingTypeMatch),
    locationMatch:        optionMatch(r.locationMatch),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Server-side spec re-parser — overrules Claude on BEDFRAME number extraction.
// Ported from HOOKKA scan-po.ts reparseSpec (their BUG class: LLMs
// occasionally truncate "10" to 1 or 12" to 1 even at temperature 0; regex on
// the verbatim rawSpec line is bulletproof for these patterns).
// ---------------------------------------------------------------------------
function reparseSpec(line: ExtractedLine): void {
  if (!line.rawSpec) return;
  const spec = line.rawSpec;

  // No-leg first — many specs read "8inch + No Legs" or "no leg" or "NOLEG".
  // If matched, leg is null regardless of any number.
  const noLegRe = /\b(no\s*leg(?:s)?|noleg(?:s)?)\b/i;
  const noLegMatch = noLegRe.test(spec);

  // Divan height: number that follows "divan" / "drawer" keyword.
  // Examples: "Divan10+4" -> 10. "Divan:8inch" -> 8. "DRAWER:12"" -> 12.
  const divanRe = /(?:divan|drawer)[\s:.-]*(\d+(?:\.\d+)?)/i;
  const divanMatch = spec.match(divanRe);

  // Leg height: number that follows the "+" or "leg" keyword. Skip when
  // noLeg is true. Patterns: "Divan10+4" -> 4. "8"DIVAN+2"LEG" -> 2.
  let legMatch: RegExpMatchArray | null = null;
  if (!noLegMatch) {
    legMatch =
      spec.match(/\+\s*(\d+(?:\.\d+)?)\s*(?:"|inch|in|leg)/i) ??
      spec.match(/(\d+(?:\.\d+)?)\s*"?\s*leg/i);
  }

  // Gap: number after gap-family keywords.
  const gapRe =
    /(?:m['.\s]*gap|m\s*gap|mattress\s*gap|mattressgap|gap)[\s:.-]*(\d+(?:\.\d+)?)/i;
  const gapMatch = spec.match(gapRe);

  if (divanMatch) {
    const v = Number(divanMatch[1]);
    if (Number.isFinite(v)) line.divanHeightInches = v;
  }
  if (noLegMatch) {
    line.noLeg = true;
    line.legHeightInches = null;
  } else if (legMatch) {
    const v = Number(legMatch[1]);
    if (Number.isFinite(v)) {
      line.legHeightInches = v;
      line.noLeg = false;
    }
  }
  if (gapMatch) {
    const v = Number(gapMatch[1]);
    if (Number.isFinite(v)) line.gapInches = v;
  }
}

// Normalize a code for tolerant matching: uppercase, drop every
// non-alphanumeric separator, then strip leading zeros from each numeric run.
// Examples (all collapse to the same key):
//   "KN-390-01" -> "KN3901"
//   "KN.390-001" -> "KN3901"
//   "KN 390-1" -> "KN3901"
// Used as a fallback when the exact-uppercase lookup misses (ported from
// HOOKKA scan-po.ts normalizeForMatch).
function normalizeForMatch(s: string): string {
  return s
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((seg) => seg.replace(/(?:^|(?<=\D))0+(?=\d)/g, ''))
    .join('');
}

// Catalog-bound validation: a skuMatch/fabricMatch whose code is NOT in the
// live catalog is cleared to null (never-invent rule, enforced server-side —
// same belt-and-braces as HOOKKA's validateAndEnrichPO). Case-insensitive
// snap to the canonical catalog casing on hit; TOLERANT fallbacks (ported
// from HOOKKA scan-po.ts) before clearing:
//   SKU:    exact-upper → drop a "1" before a trailing letter group
//           ("8030-1L(LHF)" → "8030-L(LHF)") → add one ("8030-L(LHF)" →
//           "8030-1L(LHF)") → separator/leading-zero-stripped lookup.
//   Fabric: exact-upper → separator/leading-zero-stripped lookup
//           ("KN.390-001" / "KN 390-1" → the canonical "KN-390-01").
// Every hit snaps the code to the catalog's canonical casing.
function validateSlip(slip: ExtractedSlip, catalog: Catalog): Warning[] {
  const warnings: Warning[] = [];
  const skuCanon = new Map(catalog.skus.map((s) => [s.code.toUpperCase(), s.code]));
  const fabricCanon = new Map(catalog.fabrics.map((f) => [f.code.toUpperCase(), f.code]));
  const specialCanon = new Map(catalog.specials.map((s) => [s.code.toUpperCase(), s.code]));
  // Tolerant lookup tables — separator-stripped + leading-zero-stripped key →
  // canonical catalog code. Built AFTER the exact maps so an exact hit always
  // wins (the norm key can collide across near-identical codes; first in wins).
  const skuCanonByNorm = new Map<string, string>();
  for (const s of catalog.skus) {
    const k = normalizeForMatch(s.code);
    if (!skuCanonByNorm.has(k)) skuCanonByNorm.set(k, s.code);
  }
  const fabricCanonByNorm = new Map<string, string>();
  for (const f of catalog.fabrics) {
    const k = normalizeForMatch(f.code);
    if (!fabricCanonByNorm.has(k)) fabricCanonByNorm.set(k, f.code);
  }
  // Category by canonical code — gates the bedframe reparseSpec pass below.
  const categoryByCode = new Map(catalog.skus.map((s) => [s.code.toUpperCase(), s.category]));

  slip.lines.forEach((line, i) => {
    if (line.skuMatch) {
      const upper = line.skuMatch.code.toUpperCase();
      let canon = skuCanon.get(upper);
      if (!canon) {
        // "8030-1L(LHF)" → "8030-L(LHF)"
        const dropOne = upper.replace(/-1([A-Z])/, '-$1');
        if (dropOne !== upper) canon = skuCanon.get(dropOne);
      }
      if (!canon) {
        // "8030-L(LHF)" → "8030-1L(LHF)"
        const addOne = upper.replace(/-([A-Z])(\(|$)/, '-1$1$2');
        if (addOne !== upper) canon = skuCanon.get(addOne);
      }
      if (!canon) canon = skuCanonByNorm.get(normalizeForMatch(line.skuMatch.code));
      if (canon) {
        line.skuMatch.code = canon;
      } else {
        warnings.push({
          field: 'skuMatch',
          value: line.skuMatch.code,
          message: `Line ${i + 1}: suggested SKU not in catalog — cleared; pick manually.`,
          lineIdx: i,
        });
        line.skuMatch = null;
      }
    }
    // Regex re-parse the verbatim spec to overrule any Claude truncation
    // mistakes (12" read as 1). Bedframe-family only — skipped for SOFA /
    // ACCESSORY where the spec format is different (same gate as HOOKKA).
    // Runs AFTER the SKU snap so the category gate reads the canonical code;
    // lines with no resolved SKU still reparse (the divan/leg/gap regexes
    // only fire on bedframe spec keywords, so non-bedframe text is inert).
    {
      const cat = line.skuMatch ? categoryByCode.get(line.skuMatch.code.toUpperCase()) ?? '' : '';
      if (cat !== 'SOFA' && cat !== 'ACCESSORY') reparseSpec(line);
    }
    if (line.fabricMatch) {
      const upper = line.fabricMatch.code.toUpperCase();
      let canon = fabricCanon.get(upper);
      if (!canon) canon = fabricCanonByNorm.get(normalizeForMatch(line.fabricMatch.code));
      if (canon) {
        // Snap to the catalog's canonical casing (HOOKKA fabric-casing rule).
        line.fabricMatch.code = canon;
      } else {
        warnings.push({
          field: 'fabricMatch',
          value: line.fabricMatch.code,
          message: `Line ${i + 1}: suggested fabric not in catalog — cleared.`,
          lineIdx: i,
        });
        line.fabricMatch = null;
      }
    }
    // specialsMatch — same never-invent enforcement as skuMatch, PLUS a model
    // gate. Drop any special whose code is not in catalog.specials (case-
    // insensitive snap on hit), then keep only specials the line's resolved
    // Model actually offers (allowed_options.specials). The model is resolved
    // off the line's skuMatch.code via catalog.specialsByModelSku; with no
    // resolved SKU there is no model authority, so all matched specials are
    // dropped (a special can't render checked on a line with no product).
    if (Array.isArray(line.specialsMatch) && line.specialsMatch.length > 0) {
      const allowedForModel = line.skuMatch
        ? catalog.specialsByModelSku.get(line.skuMatch.code.toUpperCase()) ?? null
        : null;
      const kept: SkuMatch[] = [];
      for (const sp of line.specialsMatch) {
        const canon = specialCanon.get(sp.code.toUpperCase());
        if (!canon) {
          warnings.push({
            field: 'specialsMatch',
            value: sp.code,
            message: `Line ${i + 1}: suggested special not in catalog — dropped.`,
            lineIdx: i,
          });
          continue;
        }
        if (!allowedForModel || !allowedForModel.has(canon.toUpperCase())) {
          warnings.push({
            field: 'specialsMatch',
            value: canon,
            message: `Line ${i + 1}: special "${canon}" not offered by this line's model — dropped.`,
            lineIdx: i,
          });
          continue;
        }
        sp.code = canon;
        kept.push(sp);
      }
      line.specialsMatch = kept;
    }
  });

  // SO-Maintenance option matches — same never-invent enforcement: a value
  // outside the ACTIVE allowed list is cleared (case-insensitive snap to the
  // canonical casing on hit).
  const optionFields: Array<{
    field: keyof Pick<ExtractedSlip,
      'paymentMethodMatch' | 'bankMatch' | 'onlineTypeMatch' | 'installmentPlanMatch' |
      'customerTypeMatch' | 'buildingTypeMatch'>;
    category: OptionCategory;
  }> = [
    { field: 'paymentMethodMatch',   category: 'payment_method' },
    { field: 'bankMatch',            category: 'payment_merchant' },
    { field: 'onlineTypeMatch',      category: 'online_type' },
    { field: 'installmentPlanMatch', category: 'installment_plan' },
    { field: 'customerTypeMatch',    category: 'customer_type' },
    { field: 'buildingTypeMatch',    category: 'building_type' },
    // locationMatch is NOT here — it validates against the venue MASTER
    // (project_venues), not so_dropdown_options. See the block below.
  ];
  for (const { field, category } of optionFields) {
    const m = slip[field];
    if (!m) continue;
    const canon = new Map(catalog.options[category].map((o) => [o.value.toUpperCase(), o.value]));
    const hit = canon.get(m.value.toUpperCase());
    if (hit) {
      m.value = hit;
    } else {
      warnings.push({
        field,
        value: m.value,
        message: `Suggested ${category.replace(/_/g, ' ')} not in the SO Maintenance list — cleared; pick manually.`,
      });
      slip[field] = null;
    }
  }

  // Per-receipt payment option values (multi-receipt) — the SAME never-invent
  // snap as the singular payment matches above, so every booked receipt row
  // carries only catalog-valid vocabulary (and the first receipt's values match
  // the validated singulars). A value outside the ACTIVE list is CLEARED to
  // null (deriveLedgerMethod then treats a null method as an assumed card
  // terminal), never invented.
  if (slip.payments.length > 0) {
    const canonFor = (category: OptionCategory): Map<string, string> =>
      new Map(catalog.options[category].map((o) => [o.value.toUpperCase(), o.value]));
    const methodCanon = canonFor('payment_method');
    const bankCanon = canonFor('payment_merchant');
    const onlineCanon = canonFor('online_type');
    const planCanon = canonFor('installment_plan');
    const snap = (v: string | null, canon: Map<string, string>): string | null =>
      v ? (canon.get(v.toUpperCase()) ?? null) : null;
    for (const p of slip.payments) {
      p.paymentMethodValue = snap(p.paymentMethodValue, methodCanon);
      p.bankValue = snap(p.bankValue, bankCanon);
      p.onlineTypeValue = snap(p.onlineTypeValue, onlineCanon);
      p.installmentPlanValue = snap(p.installmentPlanValue, planCanon);
    }
  }

  /* VENUE — same never-invent enforcement, against the venue MASTER
     (public.project_venues, ACTIVE) rather than so_dropdown_options.venue.

     Owner ruling 2026-07-16 ("看我的maintenance SO 的venue是真理"): the list SO
     Maintenance shows IS the authority, and that section is a read-only view of
     the same useVenues() master the New-SO Venue dropdown renders. Validating
     against so_dropdown_options.venue — a second vocabulary nothing binds to —
     is the drift the 2026-07-04 audit predicted: "a scan could seed a venue the
     picker can't select".

     No match ⇒ CLEARED, never snapped to a near neighbour (the #615 rule — the
     venue is where the sale is booked, and a guessed venue is a wrong one). A
     null venue is the SELF-HEALING state, not a hole: the create core's
     venue-by-active-project autofill (owner 2026-06-25) fills it from the
     salesperson's current exhibition project, and that autofill only fires when
     the venue is null. The raw written text still rides on `location`, which the
     interactive modal's resolveVenueId falls back to and which the operator
     reviews against the slip photo either way. */
  if (slip.locationMatch) {
    const venueCanon = new Map(catalog.venues.map((v) => [v.toUpperCase(), v]));
    const hit = venueCanon.get(slip.locationMatch.value.trim().toUpperCase());
    if (hit) {
      slip.locationMatch.value = hit;
    } else {
      warnings.push({
        field: 'locationMatch',
        value: slip.locationMatch.value,
        message: 'Suggested venue not in the venue list — cleared; pick manually.',
      });
      slip.locationMatch = null;
    }
  }

  // Delivery STATE — same never-invent enforcement against the live
  // my_localities state list. A state outside the catalog (or empty list) is
  // cleared so the form never seeds a State the dropdown can't select.
  if (slip.addressStateMatch) {
    const stateCanon = new Map(catalog.states.map((s) => [s.toUpperCase(), s]));
    const hit = stateCanon.get(slip.addressStateMatch.value.toUpperCase());
    if (hit) {
      slip.addressStateMatch.value = hit;
    } else {
      warnings.push({
        field: 'addressStateMatch',
        value: slip.addressStateMatch.value,
        message: 'Suggested delivery state not in the localities list — cleared; pick manually.',
      });
      slip.addressStateMatch = null;
    }
  }

  /* Delivery CITY + POSTCODE — the same never-invent enforcement, walked down
     the form's own cascade (State -> City -> Postcode, every step sourced from
     scm.my_localities).

     Owner 2026-07-16 ("其他的OCR 都不是跟著維護裏面去做篩選"): STATE was snapped
     here but city/postcode rode through as free text on the theory that the
     frontend reconciles them against the live list. That holds for the
     INTERACTIVE modal — it does not hold for the BACKGROUND scan job, which
     builds the draft and persists it with no form in the loop. postProcessSlip
     only reconciles the pair when the GEOCODER returned a postcode; on a geocode
     miss (no API key, network error, no result, an address Google can't place)
     the model's own city/postcode landed on the draft unchecked. Both columns
     then FREEZE on the SO header under SO_IDENTITY_LOCK_COLS once a DO/SI
     exists, and the form's cascading City/Postcode selects cannot even render a
     value the master doesn't hold — the same class as the 8" leg #615 closed.

     No nearest-value coercion (the #615 rule): a value the master doesn't hold
     is CLEARED so the operator picks it against the slip photo. City is scoped
     to the RESOLVED state — an unresolved state means the form's city select has
     nothing to cascade from, so the city cannot be validated OR selected and is
     cleared too. address1 still carries the full street address either way, and
     the slip photo rides on the SO detail. */
  const cascadeState = slip.addressStateMatch?.value ?? null;
  if (slip.city) {
    const cityPool = cascadeState
      ? catalog.citiesByState.get(cascadeState.toUpperCase())
      : undefined;
    const hit = cityPool?.get(slip.city.trim().toUpperCase()) ?? null;
    if (hit) {
      slip.city = hit;
    } else {
      warnings.push({
        field: 'city',
        value: slip.city,
        message: cascadeState
          ? `Suggested city is not in the localities list for ${cascadeState} — cleared; pick manually.`
          : 'Suggested city could not be checked without a delivery state — cleared; pick manually.',
      });
      slip.city = null;
    }
  }
  if (slip.postcode) {
    // Only a postcode the master actually files under the resolved state+city
    // survives; anything else (including a plausible-looking 5-digit misread)
    // is cleared rather than guessed onto the draft.
    const pcPool = cascadeState && slip.city
      ? catalog.postcodesByStateCity.get(localityKey(cascadeState, slip.city))
      : undefined;
    const pc = slip.postcode.replace(/[^\d]/g, '');
    if (pcPool && pc.length === 5 && pcPool.has(pc)) {
      slip.postcode = pc;
    } else {
      warnings.push({
        field: 'postcode',
        value: slip.postcode,
        message: slip.city
          ? `Suggested postcode is not in the localities list for ${slip.city} — cleared; pick manually.`
          : 'Suggested postcode could not be checked without a delivery city — cleared; pick manually.',
      });
      slip.postcode = null;
    }
  }
  return warnings;
}

// Service-role client — sample-row reads/writes bypass RLS so extraction
// works regardless of policy state (same pattern as mfg-sales-orders.ts's
// admin client). Auth is already enforced by supabaseAuth on the router.
//
// Houzs CRITICAL fix: getSupabaseService(env) returns a client scoped to the
// `scm` schema (db:{schema:'scm'}), so every sb.from('so_scan_samples' /
// 'so_scan_rules' / 'mfg_products' / …) resolves to scm.*, NOT public.*. The
// 2990's original used createClient(...) defaulting to public.
function serviceClient(env: Env): SupabaseClient {
  return getSupabaseService(env);
}

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return (
    err?.code === '42P01' ||
    // PostgREST reports an unknown relation as PGRST205 ("Could not find the
    // table '…' in the schema cache"), not the raw Postgres 42P01.
    err?.code === 'PGRST205' ||
    /so_scan_samples.*does not exist|relation .* does not exist|could not find the table/i.test(err?.message ?? '')
  );
}

const TABLE_MISSING_MSG =
  'scan-so tables missing — apply src/db/migrations-pg/0023_so_scan_samples.sql to this database.';

// ===========================================================================
// Sample review outcomes (so_scan_samples.status — free-text, NO check
// constraint, so this vocabulary needs no migration).
//
//   EXTRACTED — the AI read it; no human has reviewed it yet.
//   CONFIRMED — the operator reviewed AND CHANGED something. `corrected` and
//               `extracted` DIFFER, so the pair carries a teachable diff.
//   ACCEPTED  — the operator reviewed and took the extraction AS-IS. Ground
//               truth, but the pair has NO diff.
//   FAILED    — the extraction itself errored.
//
// Why the split matters: the two consumers of this pool want OPPOSITE things.
// The distillers MINE THE DIFF ("wherever they differ, the AI misread") — a
// zero-diff pair teaches them nothing and, inside their LIMIT window, would
// push a real correction out of the pool. The few-shot pool shows the model
// GOOD OUTPUT — there both outcomes are equally true, and corrected-only was
// a biased sample of the AI's own failures. So: distill on CONFIRMED, few-shot
// on both (CONFIRMED first — HOOKKA ae0f7e6d's `ORDER BY isGold DESC` shape).
//
// Back-compat: every pre-existing CONFIRMED row was written through the
// `if (!changed) return` edit-gate, so it IS diff-bearing by construction.
// The vocabulary classifies history correctly with no backfill.
// ===========================================================================
const SAMPLE_CORRECTED = 'CONFIRMED';
const SAMPLE_ACCEPTED = 'ACCEPTED';

// ===========================================================================
// Per-SALESPERSON rule distillation — ported from HOOKKA's ocr-distill.ts
// (per-customer, D1) and adapted to per-salesperson on Supabase, with the
// rules ORGANIZED BY PRODUCT CATEGORY (each rep's notation differs between
// sofa / mattress / bedframe slips).
// ===========================================================================

// `ilike` with no wildcards = case-insensitive exact match, BUT % and _ in
// the value would still act as wildcards — escape them so a rep literally
// named "A_B" can't match "AXB".
function ilikeExact(v: string): string {
  return v.replace(/([\\%_])/g, '\\$1');
}

// Salesperson KEY normalization — applied on EVERY write and read of the
// so_scan_samples / so_scan_rules / scan_jobs salesperson column so that
// case / whitespace variants of one rep's name share ONE learning pool
// (" aaron " / "Aaron" / "aaron  tan" vs "Aaron Tan"). HOOKKA
// BUG-2026-06-07-012 class: their exact-name mismatch wasted 92% of gold
// samples. Trim + collapse internal whitespace; CASE is handled on the read
// side (every lookup goes through ilikeExact, which is case-insensitive) and
// on the rules-write side (the distill upserts onto the existing row's
// canonical casing), so the display casing the rep typed is preserved.
function normalizeRepKey(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
}

// Reserved so_scan_rules key for the GLOBAL shared product-alias dictionary
// (cross-rep: "Bamboo Cruise" vs "Cruise" → one SKU). Just a row — no
// migration. The /salespeople listing filters it out; the weekly cron and
// rep enumeration must never treat it as a salesperson.
const GLOBAL_ALIAS_KEY = '__GLOBAL__';
// Reserved so_scan_rules key for the CROSS-REP SHARED RULES blob — common,
// NON-rep-specific extraction patterns distilled from CONFIRMED corrections
// across ALL salespeople ("one rep's learnings benefit every rep"). Sibling to
// __GLOBAL__ (which is aliases only); this layer is the shared GENERAL/category
// rules every scan — including a brand-new rep's first scan — benefits from.
// Same table/shape (just another reserved row), so NO migration.
const GLOBAL_RULES_KEY = '__GLOBAL_RULES__';
// Either reserved row must be kept out of the salesperson datalist / per-rep
// enumeration / weekly per-rep pass.
const isGlobalKey = (v: string): boolean => {
  const k = v.trim().toUpperCase();
  return k === GLOBAL_ALIAS_KEY || k === GLOBAL_RULES_KEY;
};

const buildDistillMetaPrompt = (companyName: string) => `You are reviewing extraction sessions of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. ALL the examples below were written by ONE salesperson. Each example is a PAIR: what the AI initially extracted, followed by what the human operator corrected it to (the confirmed truth). Each salesperson has their own handwriting and notation habits, and those habits DIFFER per product category. Write a concise salesperson-specific OCR rule block so future extractions of this rep's slips apply their conventions automatically.

DERIVE THE RULES FROM THE DIFFS: compare each "AI extracted" JSON against its "Operator corrected" JSON. Wherever they differ, the AI misread this rep's notation and the human fixed it — that diff is exactly how this rep's shorthand maps to catalog truth (e.g. AI read "BO315-2", operator corrected to "BO315-02" → this rep drops leading zeros in suffixes). Fields that the AI already got right need no rule. Prioritize recurring corrections across multiple pairs over one-off fixes.

ORGANIZE the rules into CATEGORY SECTIONS, in this order, skipping a section only when the rep has no examples in that category:
SOFA:
MATTRESS:
BEDFRAME:
ACCESSORY:
SERVICE:
You may end with a GENERAL: section for habits that span categories (header fields, dates, phone formats, deposit/total notation, salesperson signature style).

Within each category section capture what is BESPOKE TO THIS REP:
  • Shorthand patterns for that category's line items.
  • How they write model names (repeated abbreviations, habitual misspellings, casing).
  • How they write sizes (K/Q/King/Queen/6FT/5FT, sofa seat sizes, dimension notation).
  • Fabric / colour code conventions and where on the row they write them.
  • Price habits (unit price vs line total, "RM" omitted, thousands separators, rounding).
  • Qty habits ("x2" vs "2pcs" vs a bare digit, what a blank qty means for this rep).

In the GENERAL: section ALSO capture this rep's HEADER / non-line-item habits whenever the diffs reveal them:
  • customerSoRef format — the prefix, length, and letter/digit pattern of the slip's own reference number they habitually use (e.g. always "HC#####", or "No. <5 digits>" top-right). Teach the pattern, not a one-off value.
  • Address-part splitting — how they lay out the address and where the postcode / city / state sit, so addressLine1 / postcode / city / addressStateMatch split correctly (e.g. they write state as "JB" meaning Johor, or omit the postcode and only write the taman).
  • Phone / date / deposit notation quirks for this rep (day-first vs written-out dates, "dep" markers, how they sign off salesRep).
  • QUIRKS THAT CONFLICT with the universal rules — when this rep consistently writes something that the universal rules would read differently, call it out explicitly as an override for THIS rep only (e.g. "this rep's 'K' on accessory rows means a colour code, NOT King size").

DO NOT restate universal extraction rules that apply to every salesperson.
DO NOT enumerate every line item from the examples.
DO NOT write a generic OCR primer.
DO write 100-400 words total: each section label exactly as above ("SOFA:", "MATTRESS:", …) on its own line, with short bullet points (•, -, *) underneath. No markdown headers, no fences, no preamble, no closing remarks.

Output ONLY the rule text. The very first characters of your response must be a section label (e.g. "SOFA:"). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

type DistillResult = {
  status: 'distilled' | 'skipped' | 'error';
  reason?: string;
  rulesGenerated?: string;
  sampleCount?: number;
};

// Feed extracted→corrected PAIRS so the model learns from the DIFFS (what
// the AI got wrong vs what the human fixed). Each side is truncated to keep
// the worst case token-bounded; typical slip JSON is ~1-2k chars so
// truncation rarely fires. Shared by per-rep rules + global alias distills.
const PAIR_SIDE_MAX = 4_000;
function pairExamplesText(samples: Array<{ extracted: unknown; corrected: unknown }>): string {
  const sideText = (v: unknown): string => {
    if (v === null || v === undefined) return '(not recorded)';
    const s = JSON.stringify(v);
    return s.length > PAIR_SIDE_MAX ? `${s.slice(0, PAIR_SIDE_MAX)}…(truncated)` : s;
  };
  return samples
    .map(
      (r, i) =>
        `Example ${i + 1}:\nAI extracted: ${sideText(r.extracted)}\nOperator corrected: ${sideText(r.corrected)}`,
    )
    .join('\n\n');
}

// One prose-distill Claude call (temperature 0, fences stripped). Returns
// the cleaned text or an error string — never throws.
async function claudeDistillCall(
  apiKey: string,
  system: string,
  userPayload: string,
): Promise<{ text: string; error: string | null }> {
  try {
    const resp = await anthropicFetchWithRetry({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        // Determinism: same sample pool → same distilled output.
        temperature: 0,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPayload }] }],
      }),
    });
    const bodyText = await resp.text();
    if (!resp.ok) {
      return { text: '', error: `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}` };
    }
    let parsedResp: AnthropicResponse;
    try {
      parsedResp = JSON.parse(bodyText) as AnthropicResponse;
    } catch {
      return { text: '', error: `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}` };
    }
    if (parsedResp.error) {
      return { text: '', error: `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}` };
    }
    const firstText = parsedResp.content?.find((b) => b.type === 'text')?.text ?? '';
    // Distill output is plain prose, not JSON — strip fences only.
    // (Do NOT slice to first/last brace — that would truncate prose.)
    let cleaned = firstText.trim();
    const m = cleaned.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (m?.[1]) cleaned = m[1].trim();
    return { text: cleaned, error: null };
  } catch (e) {
    return { text: '', error: `Network/fetch error: ${(e as Error).message}` };
  }
}

/**
 * Regenerate so_scan_rules for one salesperson from their latest ≤50
 * corrected samples. REPLACES any existing rules row (regenerate-from-pool,
 * not merge — same contract as HOOKKA's distillCustomerRules).
 *
 * Cheap-skip: fewer than 2 corrected samples → skip WITHOUT an Anthropic
 * call, so the fire-and-forget trigger on /confirm is always safe.
 */
async function distillSalespersonRules(
  svc: SupabaseClient,
  apiKey: string | undefined,
  salesperson: string,
  companyName: string,
): Promise<DistillResult> {
  const rep = normalizeRepKey(salesperson);
  if (!rep) return { status: 'error', reason: 'Missing salesperson.' };
  // Reserved keys route to their own cross-rep distillers, never a per-rep
  // rules pass: '__GLOBAL__' → shared alias dictionary,
  // '__GLOBAL_RULES__' → shared cross-rep rules blob.
  if (rep.toUpperCase() === GLOBAL_RULES_KEY) return distillGlobalRules(svc, apiKey, companyName);
  if (isGlobalKey(rep)) return distillGlobalAliases(svc, apiKey, companyName);
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  // DIFF-BEARING only. This prompt derives rules from extracted→corrected
  // diffs, so an ACCEPTED (zero-diff) row contributes nothing and would only
  // consume a slot in the 50-row window. `corrected IS NOT NULL` is kept for
  // the partial index (idx_so_scan_samples_salesperson).
  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .eq('status', SAMPLE_CORRECTED)
    .ilike('salesperson', ilikeExact(rep))
    .order('created_at', { ascending: false })
    .limit(50);
  if (selErr) {
    return { status: 'error', reason: isMissingTable(selErr) ? TABLE_MISSING_MSG : selErr.message };
  }
  const samples = (rows as Array<{ extracted: unknown; corrected: unknown }> | null) ?? [];
  if (samples.length < 2) {
    return {
      status: 'skipped',
      reason: `Need at least 2 corrected samples to distill rules; "${rep}" has ${samples.length}.`,
      sampleCount: samples.length,
    };
  }

  const userPayload =
    `Salesperson: ${rep}\n\n` +
    `Here are ${samples.length} extraction sessions for this salesperson's slips (newest first), ` +
    `each as an AI-extracted → operator-corrected pair. Derive their per-category notation habits ` +
    `from the diffs and write the rule block:\n\n` +
    pairExamplesText(samples);

  const call = await claudeDistillCall(apiKey, buildDistillMetaPrompt(companyName), userPayload);
  let distilledText = call.text;
  const errorMsg = call.error;

  if (errorMsg || !distilledText) {
    return { status: 'error', reason: errorMsg ?? 'Claude returned empty rules.' };
  }
  // Soft cap — keep the injected prompt block bounded (same 32k ceiling as
  // HOOKKA's distill).
  if (distilledText.length > 32_000) distilledText = distilledText.slice(0, 32_000);

  // Canonical PK casing: if a rules row already exists under a different
  // casing ("aaron" vs "Aaron"), upsert onto THAT key instead of creating a
  // case-variant duplicate.
  let key = rep;
  const { data: existing } = await svc
    .from('so_scan_rules')
    .select('salesperson')
    .ilike('salesperson', ilikeExact(rep))
    .limit(1)
    .maybeSingle();
  const existingKey = (existing as { salesperson: string } | null)?.salesperson;
  if (existingKey) key = existingKey;

  const { error: upErr } = await svc
    .from('so_scan_rules')
    .upsert(
      {
        salesperson: key,
        rules: distilledText,
        sample_count: samples.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'salesperson' },
    );
  if (upErr) {
    return { status: 'error', reason: isMissingTable(upErr) ? TABLE_MISSING_MSG : upErr.message };
  }

  return { status: 'distilled', rulesGenerated: distilledText, sampleCount: samples.length };
}

// ===========================================================================
// GLOBAL shared product-alias dictionary — stored under the reserved
// '__GLOBAL__' so_scan_rules row. Cross-rep learning: the SAME product gets
// written differently by different reps ("Bamboo Cruise" / "Cruise" /
// "B.Cruise" → one SKU), so one rep's corrections should teach everyone.
// Per-rep STYLE notes stay in the per-rep rule rows; this is aliases only.
// ===========================================================================
const buildGlobalAliasMetaPrompt = (companyName: string) => `You are reviewing extraction sessions of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. The examples below were written by MANY DIFFERENT salespeople. Each example is a PAIR: what the AI initially extracted, followed by what the human operator corrected it to (the confirmed truth).

Your ONLY job is to build a SHARED PRODUCT-NAME ALIAS DICTIONARY that benefits every salesperson. The same product gets written many different ways across reps ("Bamboo Cruise", "Cruise", "B.Cruise" all mean one SKU). DERIVE THE ALIASES FROM THE DIFFS: wherever the operator corrected a line's skuMatch or fabricMatch, that line's rawText shows how the product was written and the corrected code is the catalog truth — record that variant → code mapping. rawText spellings the AI already matched correctly also confirm aliases worth recording when they differ from the catalog name.

ORGANIZE the dictionary into CATEGORY SECTIONS, in this order, skipping a section only when there are no aliases for it:
SOFA:
MATTRESS:
BEDFRAME:
ACCESSORY:
SERVICE:
You may end with a FABRICS: section for fabric/colour-code shorthand aliases (how reps abbreviate fabric codes → the exact fabric code).

Within each section write one bullet per alias group:
  • "<variant 1>", "<variant 2>", … → <exact catalog code or base model> (short qualifier only when needed, e.g. "size variant still required")
Use ONLY codes / base models that appear in the operator-corrected JSON — NEVER invent a code.
KNOWN ACCESSORY ALIASES — when a corrected sample resolves a "square pillow" / "sq pillow" row to a SQUARE PILLOW accessory code, ALWAYS record it as one ACCESSORY alias group: "Square Pillow", "Sq Pillow" → <the corrected SQUARE PILLOW accessory code> (still only use a code that appears in the corrected JSON; never invent one).

DO NOT write per-salesperson style notes (handwriting habits, qty/price/date/phone notation, signature styles) — those live in separate per-rep rule files.
DO NOT restate universal extraction rules.
DO NOT enumerate every line item from the examples.
DO write 100-400 words total: each section label exactly as above ("SOFA:", "MATTRESS:", …) on its own line, with short bullet points (•, -, *) underneath. No markdown headers, no fences, no preamble, no closing remarks.

Output ONLY the dictionary text. The very first characters of your response must be a section label (e.g. "SOFA:"). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

/**
 * Regenerate the '__GLOBAL__' shared alias dictionary from the latest ≤80
 * corrected samples ACROSS ALL salespeople. REPLACES the existing row
 * (regenerate-from-pool, not merge — same contract as the per-rep distill).
 *
 * Cheap-skip: fewer than 2 corrected samples total → skip WITHOUT an
 * Anthropic call, so the fire-and-forget trigger on /confirm is always safe.
 */
async function distillGlobalAliases(
  svc: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
): Promise<DistillResult> {
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  // DIFF-BEARING only — same reason as the per-rep pass: the alias dictionary
  // is derived from lines the operator RE-CODED, which a zero-diff row has
  // none of.
  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .eq('status', SAMPLE_CORRECTED)
    .order('created_at', { ascending: false })
    .limit(80);
  if (selErr) {
    return { status: 'error', reason: isMissingTable(selErr) ? TABLE_MISSING_MSG : selErr.message };
  }
  const samples = (rows as Array<{ extracted: unknown; corrected: unknown }> | null) ?? [];
  if (samples.length < 2) {
    return {
      status: 'skipped',
      reason: `Need at least 2 corrected samples to distill the shared alias dictionary; have ${samples.length}.`,
      sampleCount: samples.length,
    };
  }

  const userPayload =
    `Here are ${samples.length} extraction sessions across ALL salespeople (newest first), ` +
    `each as an AI-extracted → operator-corrected pair. Build the shared product-name alias ` +
    `dictionary from the diffs:\n\n` +
    pairExamplesText(samples);

  const call = await claudeDistillCall(apiKey, buildGlobalAliasMetaPrompt(companyName), userPayload);
  let distilledText = call.text;
  if (call.error || !distilledText) {
    return { status: 'error', reason: call.error ?? 'Claude returned empty aliases.' };
  }
  // Soft cap — keep the injected prompt block bounded (same ceiling as the
  // per-rep distill).
  if (distilledText.length > 32_000) distilledText = distilledText.slice(0, 32_000);

  const { error: upErr } = await svc
    .from('so_scan_rules')
    .upsert(
      {
        salesperson: GLOBAL_ALIAS_KEY,
        rules: distilledText,
        sample_count: samples.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'salesperson' },
    );
  if (upErr) {
    return { status: 'error', reason: isMissingTable(upErr) ? TABLE_MISSING_MSG : upErr.message };
  }

  return { status: 'distilled', rulesGenerated: distilledText, sampleCount: samples.length };
}

// ===========================================================================
// CROSS-REP SHARED RULES — stored under the reserved '__GLOBAL_RULES__'
// so_scan_rules row. Where __GLOBAL__ holds product-name ALIASES, this holds
// the COMMON, NON-rep-specific EXTRACTION PATTERNS distilled from CONFIRMED
// corrections across ALL salespeople: how the operator consistently fixes
// sizes, fabric-code casing, payment-note → option mapping, address splitting,
// customerSoRef shape, etc. — patterns that recur regardless of who wrote the
// slip. Injected into EVERY /extract so one rep's corrections raise the
// baseline for everyone, INCLUDING brand-new reps with no rules of their own.
// Per-rep STYLE (handwriting habits) stays in the per-rep rows; this is the
// shared, universal-improvement layer.
// ===========================================================================
const buildGlobalRulesMetaPrompt = (companyName: string) => `You are reviewing extraction sessions of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. The examples below were written by MANY DIFFERENT salespeople. Each example is a PAIR: what the AI initially extracted, followed by what the human operator corrected it to (the confirmed truth).

Your job is to distill SHARED EXTRACTION RULES that apply to EVERY salesperson — the COMMON, RECURRING ways the operator corrects the AI that are NOT specific to one rep's handwriting. These rules raise the baseline accuracy for all reps, including brand-new ones. DERIVE THEM FROM THE DIFFS: wherever the operator repeatedly corrected the same KIND of field the same way across DIFFERENT reps, that is a shared pattern worth a rule (e.g. a size token consistently re-mapped, a fabric-code casing normalisation, a payment-note phrase that should map to a specific option value, an address part that's habitually mis-split, a customerSoRef shape that's commonly misread).

ONLY capture a rule when the SAME correction pattern shows up across MULTIPLE different salespeople (or is clearly rep-independent). If a correction is unique to one rep's handwriting/notation, DO NOT include it here — that belongs in the per-rep rules. Skip product-name aliases (those live in a separate shared alias dictionary); focus on EXTRACTION-LOGIC patterns: sizes, options/payment mapping, dates, phones, address parts, customerSoRef, qty/price reading.

ORGANIZE into these sections, in this order, skipping a section only when you have no shared rule for it:
LINE ITEMS:
PAYMENT & OPTIONS:
ADDRESS:
HEADER & DATES:
You may end with a GENERAL: section for anything cross-cutting.

Within each section write short bullet rules phrased as universal instructions (not "rep X does…", but "a slip token written as … should map to …"). Each rule must be defensible from the diffs below.

DO NOT restate the universal extraction rules the model already follows by default (never-invent codes, day-first dates, drop trunk 0 on phones) UNLESS the diffs show those defaults are being corrected in a specific consistent direction.
DO NOT write per-salesperson style notes.
DO NOT enumerate every line item from the examples.
DO write 80-350 words total: each section label exactly as above ("LINE ITEMS:", …) on its own line, with short bullet points (•, -, *) underneath. No markdown headers, no fences, no preamble, no closing remarks.

Output ONLY the rule text. The very first characters of your response must be a section label (e.g. "LINE ITEMS:"). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

/**
 * Regenerate the '__GLOBAL_RULES__' shared cross-rep rules blob from the
 * latest ≤80 corrected samples ACROSS ALL salespeople. REPLACES the existing
 * row (regenerate-from-pool, same contract as the alias + per-rep distills).
 *
 * Cheap-skip: fewer than 3 corrected samples total → skip WITHOUT an
 * Anthropic call (shared rules need a few reps' worth of signal to be
 * meaningful; keeps the fire-and-forget trigger on /confirm cheap + safe).
 * Fail-soft: every error path returns a DistillResult, never throws.
 */
async function distillGlobalRules(
  svc: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
): Promise<DistillResult> {
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  // DIFF-BEARING only — this pass looks for "the same KIND of field corrected
  // the same way across DIFFERENT reps", which requires a correction to exist.
  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .eq('status', SAMPLE_CORRECTED)
    .order('created_at', { ascending: false })
    .limit(80);
  if (selErr) {
    return { status: 'error', reason: isMissingTable(selErr) ? TABLE_MISSING_MSG : selErr.message };
  }
  const samples = (rows as Array<{ extracted: unknown; corrected: unknown }> | null) ?? [];
  if (samples.length < 3) {
    return {
      status: 'skipped',
      reason: `Need at least 3 corrected samples to distill cross-rep shared rules; have ${samples.length}.`,
      sampleCount: samples.length,
    };
  }

  const userPayload =
    `Here are ${samples.length} extraction sessions across ALL salespeople (newest first), ` +
    `each as an AI-extracted → operator-corrected pair. Distill the SHARED, rep-independent ` +
    `extraction rules from the recurring diffs:\n\n` +
    pairExamplesText(samples);

  const call = await claudeDistillCall(apiKey, buildGlobalRulesMetaPrompt(companyName), userPayload);
  let distilledText = call.text;
  if (call.error || !distilledText) {
    return { status: 'error', reason: call.error ?? 'Claude returned empty shared rules.' };
  }
  // Soft cap — keep the injected prompt block bounded (same ceiling as the
  // alias + per-rep distills).
  if (distilledText.length > 32_000) distilledText = distilledText.slice(0, 32_000);

  const { error: upErr } = await svc
    .from('so_scan_rules')
    .upsert(
      {
        salesperson: GLOBAL_RULES_KEY,
        rules: distilledText,
        sample_count: samples.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'salesperson' },
    );
  if (upErr) {
    return { status: 'error', reason: isMissingTable(upErr) ? TABLE_MISSING_MSG : upErr.message };
  }

  return { status: 'distilled', rulesGenerated: distilledText, sampleCount: samples.length };
}

/**
 * Weekly cron entry point — refresh the '__GLOBAL__' shared alias dictionary
 * and the '__GLOBAL_RULES__' cross-rep rules blob FIRST, then regenerate
 * rules for EVERY salesperson with ≥2
 * corrected samples. Sequential (one Anthropic call at a time) and
 * error-isolated per rep: one rep failing never blocks the rest. The
 * per-confirm fire-and-forget distill remains the fast path; this weekly
 * pass is the safety net that consolidates (e.g. confirms whose distill
 * fetch died mid-flight).
 *
 * WIRED: backend/src/index.ts scheduled() calls this on Sundays in the daily
 * 02:00 UTC slot; the per-confirm fire-and-forget distill is the primary live
 * path and this weekly pass is the consolidating safety net.
 */
export async function distillAllSalespersonRules(
  svc: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
): Promise<{ distilled: number; skipped: number; errors: number; reps: number }> {
  const summary = { distilled: 0, skipped: 0, errors: 0, reps: 0 };

  // Shared alias dictionary first — it benefits every rep's scans and its
  // sample pool (all corrected rows) is a superset of any rep's.
  try {
    const g = await distillGlobalAliases(svc, apiKey, companyName);
    if (g.status === 'distilled') summary.distilled += 1;
    else if (g.status === 'skipped') summary.skipped += 1;
    else {
      summary.errors += 1;
      console.error(`[scan-so weekly distill] __GLOBAL__ aliases failed: ${g.reason}`);
    }
  } catch (e) {
    summary.errors += 1;
    console.error(`[scan-so weekly distill] __GLOBAL__ aliases threw: ${(e as Error).message}`);
  }

  // Cross-rep shared RULES blob — also benefits every rep (and brand-new
  // reps), distilled from the same all-reps corrected pool. Error-isolated
  // like the alias pass so it can never block the per-rep loop below.
  try {
    const gr = await distillGlobalRules(svc, apiKey, companyName);
    if (gr.status === 'distilled') summary.distilled += 1;
    else if (gr.status === 'skipped') summary.skipped += 1;
    else {
      summary.errors += 1;
      console.error(`[scan-so weekly distill] __GLOBAL_RULES__ failed: ${gr.reason}`);
    }
  } catch (e) {
    summary.errors += 1;
    console.error(`[scan-so weekly distill] __GLOBAL_RULES__ threw: ${(e as Error).message}`);
  }

  // Distinct salespeople with ≥2 corrected rows. Supabase has no DISTINCT
  // aggregate over the REST API, so pull the (small) salesperson column and
  // count client-side, case-insensitively (matching the ilike used by
  // distillSalespersonRules).
  // Counts DIFF-BEARING rows only, so the ≥2 gate below stays the same
  // question distillSalespersonRules asks. Without this a rep whose only
  // samples were ACCEPTED (zero-diff) would be enumerated here and then
  // cheap-skipped there — work scheduled for a rep with nothing to learn.
  const { data, error } = await paginateAll((from, to) => svc
    .from('so_scan_samples')
    .select('salesperson')
    .not('corrected', 'is', null)
    .eq('status', SAMPLE_CORRECTED)
    .not('salesperson', 'is', null)
    .order('created_at', { ascending: false })
    .range(from, to));
  if (error) {
    console.error('[scan-so weekly distill] sample scan failed:', error.message);
    summary.errors += 1;
    return summary;
  }

  const counts = new Map<string, { display: string; n: number }>();
  for (const row of (data as Array<{ salesperson: string | null }> | null) ?? []) {
    const t = normalizeRepKey(row.salesperson);
    if (!t) continue;
    // Belt-and-braces: the reserved global key is never a salesperson.
    if (isGlobalKey(t)) continue;
    const key = t.toUpperCase();
    const cur = counts.get(key);
    if (cur) cur.n += 1;
    else counts.set(key, { display: t, n: 1 });
  }
  const reps = Array.from(counts.values())
    .filter((r) => r.n >= 2)
    .map((r) => r.display)
    .sort((a, b) => a.localeCompare(b));
  summary.reps = reps.length;

  for (const rep of reps) {
    try {
      const res = await distillSalespersonRules(svc, apiKey, rep, companyName);
      if (res.status === 'distilled') summary.distilled += 1;
      else if (res.status === 'skipped') summary.skipped += 1;
      else {
        summary.errors += 1;
        console.error(`[scan-so weekly distill] "${rep}" failed: ${res.reason}`);
      }
    } catch (e) {
      summary.errors += 1;
      console.error(`[scan-so weekly distill] "${rep}" threw: ${(e as Error).message}`);
    }
  }
  return summary;
}

// ===========================================================================
// GET /scan-so/salespeople — distinct reps seen across samples + rules.
// Feeds the modal's Salesperson datalist. Best-effort: tables missing →
// empty list (the field is free-text anyway).
// ===========================================================================
scanSo.get('/salespeople', async (c) => {
  const svc = serviceClient(c.env);
  const seen = new Map<string, string>(); // UPPER(name) -> display casing
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    // The reserved '__GLOBAL__' alias row lives in so_scan_rules but is NOT
    // a salesperson — keep it out of the modal datalist.
    if (!t || isGlobalKey(t)) return;
    if (!seen.has(t.toUpperCase())) seen.set(t.toUpperCase(), t);
  };
  try {
    const [rulesRes, samplesRes] = await Promise.all([
      svc.from('so_scan_rules').select('salesperson').limit(500),
      svc
        .from('so_scan_samples')
        .select('salesperson')
        .not('salesperson', 'is', null)
        .order('created_at', { ascending: false })
        .limit(500),
    ]);
    for (const r of (rulesRes.data as Array<{ salesperson: string | null }> | null) ?? []) add(r.salesperson);
    for (const r of (samplesRes.data as Array<{ salesperson: string | null }> | null) ?? []) add(r.salesperson);
  } catch {
    /* best-effort */
  }
  const salespeople = Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  return c.json({ success: true, data: { salespeople } });
});

// ===========================================================================
// GET /scan-so/rules/:salesperson — view a rep's distilled rules.
// ===========================================================================
scanSo.get('/rules/:salesperson', async (c) => {
  const rep = normalizeRepKey(c.req.param('salesperson'));
  if (!rep) return c.json({ error: 'bad_request', reason: 'Missing salesperson.' }, 400);
  const svc = serviceClient(c.env);
  const { data, error } = await svc
    .from('so_scan_rules')
    .select('salesperson, rules, sample_count, updated_at')
    .ilike('salesperson', ilikeExact(rep))
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: TABLE_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: error.message }, 500);
  }
  if (!data) {
    return c.json({ error: 'not_found', reason: `No distilled rules for "${rep}" yet.` }, 404);
  }
  return c.json({ success: true, data });
});

// ===========================================================================
// POST /scan-so/rules/:salesperson/distill — manual regeneration.
// ===========================================================================
scanSo.post('/rules/:salesperson/distill', async (c) => {
  const rep = normalizeRepKey(c.req.param('salesperson'));
  if (!rep) return c.json({ error: 'bad_request', reason: 'Missing salesperson.' }, 400);
  const branding = await getBranding(c.env);
  const res = await distillSalespersonRules(serviceClient(c.env), c.env.ANTHROPIC_API_KEY, rep, branding.companyName);
  if (res.status === 'error') {
    return c.json({ error: 'distill_failed', reason: res.reason }, 500);
  }
  return c.json({ success: true, data: res });
});

// ===========================================================================
// GET /scan-so/slip-image?key=scan-slips/<sampleId> — serve the stored slip
// image back as "Original Slip" proof on the SO detail page.
//
// Authed (supabaseAuth runs on the whole router). Mirrors the item-photo GET
// proxy in mfg-sales-orders.ts: validate the key prefix, stream the R2 object
// with its stored content-type, 404 when missing. The `scan-slips/` prefix
// guard stops an attacker-supplied key from reaching an unrelated R2 object.
// ===========================================================================
scanSo.get('/slip-image', async (c) => {
  const key = c.req.query('key') ?? '';
  if (!key.startsWith('scan-slips/')) {
    return c.json({ error: 'bad_request', reason: 'key must start with scan-slips/' }, 400);
  }
  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }
  const obj = await c.env.SO_ITEM_PHOTOS.get(key);
  if (!obj) return c.json({ error: 'slip_image_not_found' }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // Immutable per sample (key is the sampleId), so a long browser cache
      // is safe — matches the item-photo proxy cache policy.
      'cache-control': 'private, max-age=3600',
    },
  });
});

// ===========================================================================
// POST /scan-so/warm — pre-warm the Anthropic catalog prompt-cache.
//
// The modal fires this on open (fire-and-forget) so the cache heats while the
// operator readies their photo; the keep-warm cron fires the same logic during
// business hours so the shared cache rarely goes cold. ONE minimal Claude call
// sending the BYTE-IDENTICAL cachedPrefix /extract uses (same model, same
// cache_control ttl, same beta header) — warms exactly the bucket /extract
// reads. Returns fast. Graceful: no key → { ok:false, reason:'no_key' } (200);
// any failure is caught and returned, never thrown.
// ===========================================================================
scanSo.post('/warm', async (c) => {
  const sb = c.get('supabase');
  const branding = await getBranding(c.env);
  const result = await warmCatalogCache(sb, c.env.DB, c.env.ANTHROPIC_API_KEY, branding.companyName, activeCompanyId(c));
  return c.json(result);
});

// ===========================================================================
// Shared OCR pipeline pieces — used by BOTH POST /scan-so/extract (the
// client-driven flow, kept as the mobile fallback) and the background scan
// job (POST /scan-so/enqueue → waitUntil pipeline). Factored MECHANICALLY out
// of the /extract handler — same code, same order — so the two paths can
// never drift. /extract's endpoint contract is unchanged.
// ===========================================================================
type ContentBlock = Record<string, unknown>;
// Per-IMAGE provenance, indexed by the SAME `index` Claude classifies in the
// OUTPUT "images" array — fileBlocks is built in file order, so image #N in
// the model's view is uploadedImages[N]. PDFs are NOT displayable inline on
// the SO detail page so they are never stored under image_key (they still
// ride into the prompt as document blocks).
type UploadedImage = { index: number; buffer: ArrayBuffer; mime: string };
type ScanFileParse = {
  // Claude content blocks (image or document per file), in upload order.
  fileBlocks: ContentBlock[];
  // Image files only (buffer + mime), for R2 provenance storage.
  uploadedImages: UploadedImage[];
  // EVERY accepted file's raw bytes (images AND pdfs) — the enqueue path
  // persists these to R2 for durability before the job runs.
  allFiles: Array<{ buffer: ArrayBuffer; mime: string }>;
  firstBuffer: ArrayBuffer | null;
  fileCount: number;
};

// Accept files under any field name ("file", "files", repeated) — the modal
// sends `file` repeatedly but be liberal in what we accept. Returns a plain
// bad-request reason string on any rejected input (the caller maps it to its
// own 400), or the parsed blocks/buffers.
async function parseScanFiles(
  formData: FormData,
): Promise<{ ok: true; parsed: ScanFileParse } | { ok: false; reason: string }> {
  // (entries cast to unknown: @cloudflare/workers-types narrows
  // FormDataEntryValue to string, which breaks the instanceof check.)
  const files: File[] = [];
  for (const [, v] of formData.entries() as Iterable<[string, unknown]>) {
    if (v instanceof File && v.size > 0) files.push(v);
  }
  if (files.length === 0) return { ok: false, reason: 'No file uploaded.' };

  const fileBlocks: ContentBlock[] = [];
  const uploadedImages: UploadedImage[] = [];
  const allFiles: Array<{ buffer: ArrayBuffer; mime: string }> = [];
  let firstBuffer: ArrayBuffer | null = null;
  let blockIndex = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, reason: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 20MB.` };
    }
    const mime = file.type || '';
    const name = (file.name || '').toLowerCase();
    const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
    const isImage =
      IMAGE_MIMES.has(mime) ||
      name.endsWith('.jpg') || name.endsWith('.jpeg') ||
      name.endsWith('.png') || name.endsWith('.webp');
    if (!isPdf && !isImage) {
      return { ok: false, reason: `Unsupported file type "${mime || name}". Use JPEG / PNG / WEBP / PDF.` };
    }
    const buf = await file.arrayBuffer();
    if (!firstBuffer) firstBuffer = buf;
    const data = toBase64(buf);
    if (isPdf) {
      allFiles.push({ buffer: buf, mime: 'application/pdf' });
      fileBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      });
    } else {
      const mediaType = IMAGE_MIMES.has(mime)
        ? mime
        : name.endsWith('.png') ? 'image/png'
        : name.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';
      allFiles.push({ buffer: buf, mime: mediaType });
      uploadedImages.push({ index: blockIndex, buffer: buf, mime: mediaType });
      fileBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
    }
    blockIndex += 1;
  }
  return {
    ok: true,
    parsed: { fileBlocks, uploadedImages, allFiles, firstBuffer, fileCount: files.length },
  };
}

// Dynamic (post-cache-boundary) prompt blocks: shared alias dictionary,
// cross-rep shared rules, the rep's own distilled rules, and the few-shot
// pool. All best-effort — a missing row/table just skips that block.
type PromptInjections = {
  globalAliasText: string;
  globalAliasApplied: boolean;
  globalRulesText: string;
  globalRulesApplied: boolean;
  repRulesText: string;
  repRulesMeta: { salesperson: string; sampleCount: number } | null;
  fewShotText: string;
};
async function loadPromptInjections(svc: SupabaseClient, repGiven: string): Promise<PromptInjections> {
  // GLOBAL shared product-alias dictionary ('__GLOBAL__' so_scan_rules row)
  // — injected for EVERY scan regardless of salesperson, AFTER the cache
  // boundary and BEFORE the per-rep rules block.
  let globalAliasText = '';
  let globalAliasApplied = false;
  try {
    const { data: gRow } = await svc
      .from('so_scan_rules')
      .select('rules')
      .eq('salesperson', GLOBAL_ALIAS_KEY)
      .limit(1)
      .maybeSingle();
    const g = gRow as { rules: string } | null;
    if (g && g.rules.trim() !== '') {
      globalAliasText =
        `SHARED PRODUCT ALIASES (all salespeople) — distilled from every rep's previously ` +
        `corrected slips: common handwritten product-name variants and fabric-code shorthands ` +
        `mapped to exact catalog codes. Use them to resolve ambiguous handwriting (they ` +
        `complement, never override, the catalog and the never-invent-codes rule):\n\n` +
        g.rules;
      globalAliasApplied = true;
    }
  } catch {
    /* best-effort */
  }

  // CROSS-REP SHARED RULES ('__GLOBAL_RULES__' so_scan_rules row) — common,
  // rep-independent extraction patterns distilled from CONFIRMED corrections
  // across ALL reps. Injected for EVERY scan (including a brand-new rep's
  // first one), alongside the shared aliases and BEFORE the per-rep rules so
  // a rep's own rules can still refine on top.
  let globalRulesText = '';
  let globalRulesApplied = false;
  try {
    const { data: grRow } = await svc
      .from('so_scan_rules')
      .select('rules')
      .eq('salesperson', GLOBAL_RULES_KEY)
      .limit(1)
      .maybeSingle();
    const gr = grRow as { rules: string } | null;
    if (gr && gr.rules.trim() !== '') {
      globalRulesText =
        `SHARED EXTRACTION RULES (all salespeople) — distilled from every rep's previously ` +
        `corrected slips: the common, rep-independent ways the operator fixes sizes, payment / ` +
        `option mapping, address parts, dates and customer references. Apply them to every slip ` +
        `(they complement, never override, the universal extraction rules, the catalog and the ` +
        `never-invent-codes rule):\n\n` +
        gr.rules;
      globalRulesApplied = true;
    }
  } catch {
    /* best-effort */
  }

  // Per-rep distilled rules block (so_scan_rules). Injected AFTER the
  // cache_control boundary so the catalog prefix stays cache-stable across
  // reps.
  let repRulesText = '';
  let repRulesMeta: { salesperson: string; sampleCount: number } | null = null;
  if (repGiven) {
    try {
      const { data: ruleRow } = await svc
        .from('so_scan_rules')
        .select('salesperson, rules, sample_count')
        .ilike('salesperson', ilikeExact(repGiven))
        .limit(1)
        .maybeSingle();
      const row = ruleRow as { salesperson: string; rules: string; sample_count: number | null } | null;
      if (row && row.rules.trim() !== '') {
        repRulesText =
          `SALESPERSON-SPECIFIC RULES — this slip was written by ${row.salesperson}. ` +
          `These rules were distilled from this rep's previously confirmed slips and are organized by ` +
          `product category; apply the matching category section's conventions when reading their handwriting ` +
          `(they complement, never override, the universal extraction rules and the never-invent-codes rule):\n\n` +
          row.rules;
        repRulesMeta = { salesperson: row.salesperson, sampleCount: row.sample_count ?? 0 };
      }
    } catch {
      /* best-effort */
    }
  }

  // Few-shot pool: 5 most recent operator-REVIEWED samples — THIS REP's first,
  // topped up with global recents (deduped by id).
  //
  // Both review outcomes qualify here. A CONFIRMED (corrected) blob and an
  // ACCEPTED (as-is) blob are equally operator-verified ground truth, and this
  // prompt uses them as GOOD-OUTPUT exemplars, never as diffs — so nothing here
  // needs the pair to differ. Including ACCEPTED also removes a survivorship
  // bias baked in while the edit-gate was the only writer: the pool could only
  // ever contain slips the AI got WRONG, so every example of "a slip like
  // yours" was drawn exclusively from its own failures.
  //
  // RANKED, not flattened (HOOKKA ae0f7e6d's `ORDER BY isGold DESC` shape):
  // rep before global, then CONFIRMED before ACCEPTED, then recency. A
  // corrected exemplar encodes a resolution the model could NOT reach on its
  // own, so it carries strictly more information than one it already produces
  // correctly — it must never be displaced by an as-is sample that is merely
  // newer.
  //
  // STATUS RANKS, IT DOES NOT FILTER (2026-08-05). This pool used to be gated on
  // `status IN (CONFIRMED, ACCEPTED)`. `so_scan_samples.status` is free text with
  // NO check constraint, so any row whose status is missing, legacy or merely
  // spelled differently was silently deleted from the model's memory — with
  // nothing anywhere to say so. Production had exactly that: 2 rows carrying a
  // real `corrected` payload and 0 rows at CONFIRMED, so the only two examples in
  // the system taught nothing. The pool's actual requirement is a corrected
  // payload to SHOW the model; that is what is filtered on now, and status is
  // used only to rank CONFIRMED ahead of the rest. A free-text column must never
  // be the thing that decides whether the scanner can learn.
  let fewShotText = '';
  try {
    type FewShotRow = { id: string; corrected: unknown; status: string | null };
    const picked: Array<{ corrected: unknown; mine: boolean; gold: boolean }> = [];
    const pickedIds = new Set<string>();
    // Ranked within a fetched page rather than in SQL: PostgREST cannot express
    // a conditional ORDER BY, and over-fetching a few rows is cheaper on this
    // hot path than the extra round-trip a status-scoped second query costs.
    // Stable sort (ES2019+) keeps created_at DESC inside each tier.
    const goldFirst = (rows: FewShotRow[]): FewShotRow[] =>
      [...rows].sort(
        (a, b) =>
          Number(b.status === SAMPLE_CORRECTED) - Number(a.status === SAMPLE_CORRECTED),
      );
    if (repGiven) {
      const { data: repRows } = await svc
        .from('so_scan_samples')
        .select('id, corrected, status')
        .not('corrected', 'is', null)
        .ilike('salesperson', ilikeExact(repGiven))
        .order('created_at', { ascending: false })
        .limit(15);
      for (const r of goldFirst((repRows as FewShotRow[] | null) ?? [])) {
        if (picked.length >= 5) break;
        picked.push({ corrected: r.corrected, mine: true, gold: r.status === SAMPLE_CORRECTED });
        pickedIds.add(r.id);
      }
    }
    if (picked.length < 5) {
      const { data: rows } = await svc
        .from('so_scan_samples')
        .select('id, corrected, status')
        .not('corrected', 'is', null)
        .order('created_at', { ascending: false })
        .limit(15);
      for (const r of goldFirst((rows as FewShotRow[] | null) ?? [])) {
        if (picked.length >= 5) break;
        if (pickedIds.has(r.id)) continue;
        picked.push({ corrected: r.corrected, mine: false, gold: r.status === SAMPLE_CORRECTED });
        pickedIds.add(r.id);
      }
    }
    if (picked.length > 0) {
      const blocks = picked
        .map((r, i) => {
          const who = repGiven ? (r.mine ? ` — written by ${repGiven}, weigh heavily` : ' — another rep') : '';
          // Name the outcome: "corrected" tells the model a human had to fix
          // this reading; "accepted as-is" that the AI's own reading stood.
          const how = r.gold ? 'operator-corrected' : 'operator-accepted as-is';
          return `Example ${i + 1} (${how}${who}):\n${JSON.stringify(r.corrected)}`;
        })
        .join('\n\n');
      fewShotText =
        `FEW-SHOT EXAMPLES from previous slips, each reviewed by the operator — ` +
        `either corrected by them, or accepted exactly as the AI read it. Both are ` +
        `confirmed truth. Apply the same field conventions, transcription style, and ` +
        `matching judgement:\n\n${blocks}`;
    }
  } catch {
    /* best-effort */
  }

  return {
    globalAliasText, globalAliasApplied,
    globalRulesText, globalRulesApplied,
    repRulesText, repRulesMeta,
    fewShotText,
  };
}

// The ONE Claude vision call + JSON coercion. Timeout / retry / cache /
// parse behaviour identical for /extract and the background job.
type SlipExtractCall = {
  parsed: ExtractedSlip | null;
  errorMsg: string | null;
  timedOut: boolean;
  claudeText: string;
  cacheHit: boolean;
  cacheCreated: boolean;
};
async function callClaudeSlipExtract(
  apiKey: string,
  cachedPrefix: string,
  inj: PromptInjections,
  fileBlocks: ContentBlock[],
): Promise<SlipExtractCall> {
  let errorMsg: string | null = null;
  let timedOut = false;
  let parsed: ExtractedSlip | null = null;
  let claudeText = '';
  let cacheHit = false;
  let cacheCreated = false;

  try {
    const resp = await anthropicFetchWithRetry({
      method: 'POST',
      // Outbound timeout (110s, under the Worker's wall-clock budget) so a hung
      // Anthropic call fails fast into the graceful 503 below instead of the
      // request dangling until the platform kills it with an opaque error. The
      // timeout bounds the whole retry window, not each attempt.
      signal: AbortSignal.timeout(110_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Houzs 2026-06-23 — Houzs is a RETAILER (1141 SKUs + 705 fabrics in the
        // injected catalog vs HOOKKA's small maker catalog), so the cached prefix
        // is large and the default 5-min ephemeral cache expires between scans
        // spaced apart. Extend the cache to 1h so back-to-back and
        // within-the-hour scans reuse the catalog prefix and stay fast.
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        // temperature=0 — deterministic OCR. Same slip + same prompt must
        // produce identical output so wrong fields are reproducible bugs,
        // not a flaky lottery (lesson from the HOOKKA scan-po rollout).
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } },
              // Shared aliases + shared rules + rep rules + few-shot live AFTER
              // the cache boundary — they vary per distill/salesperson/sample and
              // must not bust the prefix. Order: shared aliases → shared rules →
              // rep rules → few-shot examples (rep-specific refines on the shared
              // baseline; concrete examples come last).
              ...(inj.globalAliasText ? [{ type: 'text', text: inj.globalAliasText }] : []),
              ...(inj.globalRulesText ? [{ type: 'text', text: inj.globalRulesText }] : []),
              ...(inj.repRulesText ? [{ type: 'text', text: inj.repRulesText }] : []),
              ...(inj.fewShotText ? [{ type: 'text', text: inj.fewShotText }] : []),
              ...fileBlocks,
              {
                type: 'text',
                text:
                  'Extract the sale-order slip above using the rules + catalog. ' +
                  "OUTPUT FORMAT: Your response must be VALID JSON ONLY. Do NOT write any preamble, explanation, analysis, or chain-of-thought. Do NOT start with phrases like 'Looking at the image…'. Do NOT wrap in markdown fences. The very first character of your response must be '{' and the very last must be '}'.",
              },
            ],
          },
        ],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
    } else {
      let parsedResp: AnthropicResponse;
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
        parsedResp = {};
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else {
        cacheHit = (parsedResp.usage?.cache_read_input_tokens ?? 0) > 0;
        cacheCreated = (parsedResp.usage?.cache_creation_input_tokens ?? 0) > 0;
        const firstText = parsedResp.content?.find((b) => b.type === 'text')?.text ?? '';
        claudeText = stripJsonFences(firstText);
        try {
          parsed = normalizeSlip(JSON.parse(claudeText));
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    // AbortSignal.timeout fires a TimeoutError (older runtimes: AbortError).
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      timedOut = true;
      errorMsg = 'OCR timed out — the slip took too long to read. Please try again.';
    } else {
      errorMsg = `Network/fetch error: ${(e as Error).message}`;
    }
  }

  return { parsed, errorMsg, timedOut, claudeText, cacheHit, cacheCreated };
}

// Persist the sample row (status EXTRACTED, or FAILED with the error blob) —
// the learning pool grows on every scan, background or interactive.
async function insertScanSample(
  svc: SupabaseClient,
  args: {
    imageSha256: string | null;
    salesperson: string | null;
    parsed: ExtractedSlip | null;
    errorMsg: string | null;
    claudeText: string;
  },
): Promise<{ sampleId: string | null; sampleInsertError: string | null }> {
  let sampleId: string | null = null;
  let sampleInsertError: string | null = null;
  try {
    const { data: inserted, error: insErr } = await svc
      .from('so_scan_samples')
      .insert({
        image_sha256: args.imageSha256,
        salesperson: args.salesperson,
        extracted: args.parsed ?? { error: args.errorMsg, claudeText: args.claudeText },
        status: args.parsed ? 'EXTRACTED' : 'FAILED',
      })
      .select('id')
      .single();
    if (insErr) {
      sampleInsertError = isMissingTable(insErr) ? TABLE_MISSING_MSG : insErr.message;
      console.error('so_scan_samples insert failed:', insErr.message);
    } else {
      sampleId = (inserted as { id: string } | null)?.id ?? null;
    }
  } catch (e) {
    sampleInsertError = (e as Error).message;
    console.error('so_scan_samples insert failed:', sampleInsertError);
  }
  return { sampleId, sampleInsertError };
}

// Original-image persistence (best-effort). The scan can carry TWO photos —
// a HANDWRITTEN order slip and a PRINTED card-terminal payment receipt. Pick
// which uploaded IMAGE is which from Claude's `images` classification, then
// store up to two raw buffers in the SO_ITEM_PHOTOS R2 bucket:
//   order slip    -> `scan-slips/${sampleId}`          (image_key, mig 0033)
//   payment recpt -> `scan-slips/${sampleId}-receipt`  (receipt_image_key, mig 0034)
// Both keys ride onto the created SO so the SO Detail page can serve them back
// as "Order Slip" / "Payment Receipt" proof. CLASSIFICATION FALLBACK: when the
// model's tags are missing/ambiguous, the first image = order slip and a
// second image (if any) = receipt. PDFs are never stored (not inline-viewable)
// and are excluded from uploadedImages. An R2/classify/DB failure must NEVER
// fail the extraction — it's pure provenance.
async function storeScanImages(
  bucket: R2Bucket | undefined,
  svc: SupabaseClient,
  sampleId: string | null,
  uploadedImages: UploadedImage[],
  parsed: ExtractedSlip | null,
): Promise<{ imageKey: string | null; receiptImageKey: string | null }> {
  let imageKey: string | null = null;
  let receiptImageKey: string | null = null;
  // const alias — narrowing on a `const` survives into the putImage closure
  // below (a plain parameter's narrowing would not).
  const store = bucket;
  if (sampleId && uploadedImages.length > 0 && store) {
    // Resolve order-slip + receipt images from the classification, falling back
    // to positional order (1st = slip, 2nd = receipt) when tags don't cover it.
    const tagByIndex = new Map<number, ImageKind>();
    for (const img of parsed?.images ?? []) {
      if (!tagByIndex.has(img.index)) tagByIndex.set(img.index, img.kind);
    }
    let slipImg: UploadedImage | null =
      uploadedImages.find((u) => tagByIndex.get(u.index) === 'order_slip') ?? null;
    let receiptImg: UploadedImage | null =
      uploadedImages.find((u) => tagByIndex.get(u.index) === 'payment_receipt') ?? null;
    // Guard against the model tagging the same image as both.
    if (slipImg && receiptImg && slipImg.index === receiptImg.index) receiptImg = null;
    if (!slipImg) {
      // Positional fallback: first image not already taken as the receipt.
      slipImg = uploadedImages.find((u) => u.index !== receiptImg?.index) ?? null;
    }
    if (!receiptImg && uploadedImages.length > 1) {
      receiptImg = uploadedImages.find((u) => u.index !== slipImg?.index) ?? null;
    }

    const putImage = async (
      img: UploadedImage | null,
      key: string,
      column: 'image_key' | 'receipt_image_key',
      label: string,
    ): Promise<string | null> => {
      if (!img) return null;
      try {
        await store.put(key, img.buffer, {
          httpMetadata: { contentType: img.mime },
        });
        const { error: keyErr } = await svc
          .from('so_scan_samples')
          .update({ [column]: key })
          .eq('id', sampleId);
        if (keyErr) {
          console.warn(`[scan-so ${label}] ${column} update failed:`, keyErr.message);
          return null;
        }
        return key;
      } catch (e) {
        console.warn(`[scan-so ${label}] R2 put failed:`, (e as Error).message);
        return null;
      }
    };

    imageKey = await putImage(slipImg, `scan-slips/${sampleId}`, 'image_key', 'slip-image');
    receiptImageKey = await putImage(
      receiptImg,
      `scan-slips/${sampleId}-receipt`,
      'receipt_image_key',
      'receipt-image',
    );
  }
  return { imageKey, receiptImageKey };
}

// Post-extraction enrichment + catalog-bound validation, IN PLACE on `parsed`:
// phone normalisation, Google-geocode address correction (postcode-driven
// city/state snap via my_localities), then validateSlip (never-invent
// enforcement + tolerant SKU/fabric snapping + the bedframe reparseSpec
// override). Returns the operator-facing warnings.
async function postProcessSlip(
  parsed: ExtractedSlip,
  sb: SupabaseClient,
  googleMapsApiKey: string | undefined,
  catalog: Catalog,
): Promise<Warning[]> {
  // Phone normalisation — E.164, the same form every write path stores and the
  // form's PhoneInput consumes. Applies to every extracted phone (main +
  // spouse/emergency). phones[0] is the primary; the rest ride along for the
  // edit-gate.
  parsed.phones = parsed.phones
    .map((p) => normalizeSlipPhone(p))
    .filter((p): p is string => p !== null);

  // Address via Google Geocoding (GOOGLE_MAPS_API_KEY). The LLM mis-parses
  // Malaysian areas (it put Melawati at Ampang/Selangor 68000 — it's KL/Setapak
  // ~53100), so when geocoding succeeds we PREFER its state/city/postcode over
  // the LLM guess. Fail-soft: no key / network error / no result -> keep the LLM
  // parse untouched. The geocoded STATE is seeded into addressStateMatch so the
  // validateSlip pass below still snaps it to the catalog states list (and
  // clears it if the geocoder ever returns a non-catalog state).
  try {
    const geo = await geocodeAddress(parsed.address, googleMapsApiKey);
    if (geo) {
      // Postcode is the driver: seed it first, then resolve city/state from the
      // SAME my_localities row that postcode maps to (the cascade the form uses),
      // so the seeded city/state are consistent with the postcode and selectable
      // in the form's dropdowns. Fall back to Google's components only when no
      // localities row matches the resolved postcode.
      let city = geo.city;
      let state = geo.state;
      if (geo.postcode) {
        parsed.postcode = geo.postcode;
        const loc = await localityForPostcode(sb, geo.postcode);
        if (loc) {
          if (loc.city) city = loc.city;
          if (loc.state) state = loc.state;
        }
      }
      if (state) {
        parsed.addressStateMatch = { value: state, confidence: 0.95, reason: 'Google geocode' };
      }
      if (city) parsed.city = city;
    }
  } catch {
    /* fail-soft — keep the LLM address parse */
  }

  const warnings = validateSlip(parsed, catalog);

  // Phone plausibility (evidence 2026-07: the OCR dropped a doubled digit —
  // "01137166720" read as "0113716720"): a Malaysian national-significant
  // number (after the trunk 0 strip above) is 9-10 digits for mobiles and
  // 8-9 for landlines. Anything under 9 or over 10 very likely lost/gained a
  // digit — warn the operator so the form gets a second look.
  for (const p of parsed.phones) {
    if (p.length < 9 || p.length > 10) {
      warnings.push({
        field: 'phones',
        value: p,
        message: `Phone "+60${p}" has an unusual digit count — the scan may have dropped or doubled a digit; please verify against the slip.`,
      });
    }
  }
  return warnings;
}

// ===========================================================================
// POST /scan-so/extract
// ===========================================================================
scanSo.post('/extract', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      { error: 'anthropic_key_missing', reason: 'Run: npx wrangler secret put ANTHROPIC_API_KEY' },
      503,
    );
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return c.json({ error: 'bad_request', reason: `Invalid multipart body: ${(e as Error).message}` }, 400);
  }

  // Build Claude content blocks (image or document per file) — shared with
  // the background /enqueue path (parseScanFiles).
  const filesRes = await parseScanFiles(formData);
  if (!filesRes.ok) {
    return c.json({ error: 'bad_request', reason: filesRes.reason }, 400);
  }
  const { fileBlocks, uploadedImages, firstBuffer, fileCount } = filesRes.parsed;

  const imageSha256 = firstBuffer ? await sha256Hex(firstBuffer) : null;

  // Salesperson — operator-set in the modal BEFORE extract (free-text).
  // When given, that rep's distilled rules + their own confirmed samples are
  // injected; when blank, the AI's salesRep extraction backfills the sample
  // row so the pool still grows per rep. Normalized (trim + single-space) so
  // case/whitespace variants share one learning pool.
  const repGiven = normalizeRepKey(formData.get('salesperson'));

  // Catalog via the user-scoped client (RLS applies, same visibility the
  // operator already has on the SKU master screens). env.DB carries the venue
  // master read (public.project_venues — unreachable by the scm client).
  const sb = c.get('supabase');
  const catalog = await loadCatalog(sb, c.env.DB, activeCompanyId(c));

  // Company name for the prompt anchor comes from the central Branding config
  // (stable → the cached prefix below stays byte-identical to /warm + cron).
  const branding = await getBranding(c.env);

  // Cached prefix = SYSTEM_PROMPT + catalog (shared builder — BYTE-IDENTICAL to
  // what /scan-so/warm and the keep-warm cron send, so they warm the SAME cache
  // /extract reads). Identical across calls until the catalog changes →
  // Anthropic prompt-cache hit (~90% discount). Few-shot examples stay OUTSIDE
  // the cache boundary so a new confirmed sample doesn't invalidate the cache.
  const cachedPrefix = buildCachedPrefix(catalog, branding.companyName);

  const svc = serviceClient(c.env);

  // Dynamic prompt blocks (shared aliases / cross-rep shared rules / per-rep
  // rules / few-shot) — loadPromptInjections, shared with the background job.
  const inj = await loadPromptInjections(svc, repGiven);

  // ONE Claude vision call + JSON coercion — callClaudeSlipExtract, shared
  // with the background job (timeout / retry / cache semantics inside).
  const { parsed, errorMsg, timedOut, claudeText, cacheHit, cacheCreated } =
    await callClaudeSlipExtract(apiKey, cachedPrefix, inj, fileBlocks);

  // Persist the sample row (learning pool) — insertScanSample, shared with
  // the background job. salesperson = operator's pick, else the AI's salesRep
  // detection — keeps the per-rep pool growing even when the operator forgets
  // the field.
  const sampleSalesperson = repGiven || normalizeRepKey(parsed?.salesRep) || null;
  const { sampleId, sampleInsertError } = await insertScanSample(svc, {
    imageSha256, salesperson: sampleSalesperson, parsed, errorMsg, claudeText,
  });

  // Original slip / receipt R2 persistence — storeScanImages, shared with the
  // background job (Claude image-classification fallback semantics inside).
  const { imageKey, receiptImageKey } = await storeScanImages(
    c.env.SO_ITEM_PHOTOS, svc, sampleId, uploadedImages, parsed,
  );

  if (!parsed) {
    // A hung Anthropic call (caught by the 110s AbortSignal.timeout) maps to the
    // graceful 503 {error, reason} so the modal shows "try again", not a 502.
    if (timedOut) {
      return c.json(
        { error: 'ocr_timeout', reason: errorMsg ?? 'OCR timed out. Please try again.', sampleId, imageKey, receiptImageKey },
        503,
      );
    }
    return c.json(
      { error: 'extract_failed', reason: errorMsg ?? 'Extraction failed.', sampleId, imageKey, receiptImageKey },
      502,
    );
  }

  // Phone normalisation + geocode enrichment + catalog-bound validation —
  // postProcessSlip, shared with the background job.
  const warnings = await postProcessSlip(parsed, sb, c.env.GOOGLE_MAPS_API_KEY, catalog);

  // Duplicate-upload warning — shared findDuplicateSo (same rules as the
  // background job: recent same-photo sha256, or same phone + same slip
  // ref / same slip date+total). Cheap indexed lookups; fail-soft null.
  const duplicate = await findDuplicateSo(svc, { imageSha256, excludeSampleId: sampleId, parsed }, activeCompanyId(c));

  return c.json({
    success: true,
    data: {
      sampleId,
      // Suspected re-upload: { docNo, rule: 'image' | 'content' } of the SO
      // this slip already became, else null. The modal can warn the operator
      // before they create a second order.
      duplicate,
      // Original-slip R2 key (null when the upload was a PDF or the put
      // failed). The modal carries it onto the New SO create body.
      imageKey,
      // Payment-receipt R2 key (null when no receipt was uploaded / classified
      // or the put failed). Carried onto the New SO create body alongside.
      receiptImageKey,
      extracted: parsed,
      warnings,
      // Slim catalog so the modal's SKU/fabric pickers work without a second
      // round-trip. `options` = the SO Maintenance allowed-values lists the
      // matches were validated against (feeds the modal's review selects).
      // `states` = the my_localities state list the addressStateMatch was
      // validated against (the modal carries the matched state to the form).
      catalog: {
        skus: catalog.skus,
        fabrics: catalog.fabrics,
        options: catalog.options,
        states: catalog.states,
      },
      meta: {
        cacheHit,
        cacheCreated,
        files: fileCount,
        sampleInsertError,
        repRules: inj.repRulesMeta,
        sharedAliases: inj.globalAliasApplied,
        sharedRules: inj.globalRulesApplied,
      },
    },
  });
});

// ===========================================================================
// TRUE BACKGROUND SCAN JOB (owner 2026-07-04): the rep photographs the slip,
// POSTs /scan-so/enqueue, and can CLOSE THE APP — the OCR + DRAFT-SO create
// finish server-side inside ctx.waitUntil and the result lands in
// scm.scan_jobs (migration 0067) for the mobile Scan screen to poll.
//
//   POST /scan-so/enqueue        — same multipart inputs as /extract (image
//                                  file(s) + salesperson). Persists the photos
//                                  (R2, scan-jobs/{jobId}/{n}) + the job row,
//                                  responds { job_id, status: "queued" }
//                                  IMMEDIATELY, then runs the pipeline in
//                                  waitUntil (single Claude vision call — fits
//                                  Workers' waitUntil budget; no extra retries
//                                  beyond anthropicFetchWithRetry).
//   GET  /scan-so/jobs/:id       — poll one job (status / soDocNo / error).
//   GET  /scan-so/jobs?salesperson= — latest 20 jobs (optionally one rep's).
//   POST /scan-so/jobs/clear-failed — delete the caller's failed jobs (mobile
//                                  "Clear" button; self-scoped by normalized
//                                  rep name, wildcard '*' clears all).
//
// Both poll endpoints also run the stale-job reaper: a job stuck
// queued/running >10 min (a Worker deploy kills in-flight waitUntil work) is
// RE-RUN once from its durable R2 photos (retry_count 0 → 1, migration 0070)
// and only errored once that single retry is spent.
//
// The pipeline calls the EXACT machinery /extract uses (loadCatalog,
// buildCachedPrefix, loadPromptInjections, callClaudeSlipExtract,
// insertScanSample, storeScanImages, postProcessSlip) — shared functions, not
// copies — then creates the DRAFT SO through mfg-sales-orders'
// createDraftSalesOrder (the factored PRICING-CRITICAL create core; never
// reimplemented here). /extract stays untouched as the client-driven fallback.
// ===========================================================================
const SCAN_JOBS_MISSING_MSG =
  'scan-jobs table missing — apply src/db/migrations-pg/0067_scm_scan_jobs.sql to this database.';

// Plain-language job failures (standing rule: user-facing error = one plain
// sentence, never a raw exception / status code — those go to console.error).
const JOB_MSG = {
  fallback: 'Something went wrong while processing the scan. Please enter this order manually.',
  noKey: 'Scanning is not set up on the server yet. Please enter this order manually.',
  timeout: 'Reading the slip took too long. Please try scanning again.',
  unreadable: 'The slip photo could not be read. Please retake the photo and try again.',
  createFallback: 'The draft order could not be created. Please enter this order manually.',
} as const;

// Snake/camel-tolerant job row -> API shape (dual-read both casings — the #1
// recurring result-column bug class).
function jobToJson(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    salesperson: r.salesperson ?? null,
    soDocNo: r.soDocNo ?? r.so_doc_no ?? null,
    error: r.error ?? null,
    sampleId: r.sampleId ?? r.sample_id ?? null,
    // Duplicate-upload warning (migration 0068) — doc_no of the suspected
    // original SO; the mobile Scan screen surfaces it on the job card.
    duplicateOf: r.duplicateOf ?? r.duplicate_of ?? null,
    imageKeys: r.imageKeys ?? r.image_keys ?? [],
    // Multi-receipt (migration 0141) — the R2 keys of the uploads the OCR
    // classified as payment receipts (one payment booked per key). [] for a
    // draft-only scan or a row predating the column.
    receiptImageKeys: r.receiptImageKeys ?? r.receipt_image_keys ?? [],
    createdAt: r.createdAt ?? r.created_at ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Duplicate-upload detection (owner 2026-07-04: 重复上传预警 / "已经开过单").
// Runs BEFORE the DRAFT create in the background pipeline (and in /extract for
// the interactive path). Two rules, cheapest first:
//   A) IMAGE  — the first uploaded photo's sha256 matches a so_scan_samples
//      row from the last 30 days whose background scan job already minted an
//      SO (so_scan_samples.image_sha256 -> scan_jobs.sample_id/so_doc_no; both
//      indexed by migration 0068).
//   B) CONTENT — an existing non-cancelled SO carries the SAME normalized
//      customer phone AND (the same customer SO ref [slip serial,
//      case-insensitive] OR the same slip date [so_date] + the same grand
//      total). Phone equality uses the exact E.164 form the create path
//      stores (normalizePhone), the same probe the cross-category auto-match
//      runs on every customer change (mfg-sales-orders ~4196).
// A suspected duplicate NEVER blocks the draft — the owner reviews. Callers
// prefix the SO note with "POSSIBLE DUPLICATE of <doc_no>" and stamp
// scan_jobs.duplicate_of (migration 0068). Fail-soft: any query error just
// skips the warning.
// ---------------------------------------------------------------------------
const DUP_LOOKBACK_DAYS = 30;

// Rule A core — the ONE image-hash lookup, shared by findDuplicateSo (the
// soft warning inside /extract and the background job) AND the synchronous
// hard reject in POST /enqueue (owner 2026-07-04 policy change: an exact slip
// re-upload is refused at upload time, before anything is queued). "Has this
// exact photo (sha256) already been scanned into an SO within the last
// DUP_LOOKBACK_DAYS?" — two indexed queries (so_scan_samples.image_sha256 ->
// scan_jobs.sample_id/so_doc_no, both indexed by migration 0068). THROWS on a
// query error so each caller picks its own fail-open behaviour: the soft path
// warns + skips the flag, the /enqueue path queues normally.
async function findRecentSoForSlipSha(
  svc: SupabaseClient,
  imageSha256: string,
  // The sample the CURRENT scan just inserted — excluded or every scan would
  // "duplicate" itself. null when nothing has been inserted yet (/enqueue).
  excludeSampleId: string | null,
): Promise<string | null> {
  const since = new Date(Date.now() - DUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let q = svc
    .from('so_scan_samples')
    .select('id')
    .eq('image_sha256', imageSha256)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10);
  if (excludeSampleId) q = q.neq('id', excludeSampleId);
  const { data: sampleRows, error: sampleErr } = await q;
  if (sampleErr) throw new Error(sampleErr.message);
  const sampleIds = (((sampleRows as Array<Record<string, unknown>> | null) ?? [])
    .map((r) => r.id)
    .filter((v): v is string => typeof v === 'string' && v !== ''));
  if (sampleIds.length === 0) return null;
  const { data: jobRows, error: jobErr } = await svc
    .from('scan_jobs')
    .select('so_doc_no, created_at')
    .in('sample_id', sampleIds)
    .not('so_doc_no', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (jobErr) throw new Error(jobErr.message);
  const row = ((jobRows as Array<Record<string, unknown>> | null) ?? [])[0];
  const doc = (row?.soDocNo ?? row?.so_doc_no) as string | undefined;
  return typeof doc === 'string' && doc !== '' ? doc : null;
}

async function findDuplicateSo(
  svc: SupabaseClient,
  args: {
    imageSha256: string | null;
    // The sample THIS scan just inserted — excluded or every scan would
    // "duplicate" itself.
    excludeSampleId: string | null;
    parsed: ExtractedSlip | null;
  },
  companyId?: number,
): Promise<{ docNo: string; rule: 'image' | 'content' } | null> {
  // A) Same slip photo already processed into an SO recently — the shared
  //    findRecentSoForSlipSha core (also the /enqueue hard-reject probe).
  try {
    if (args.imageSha256) {
      const doc = await findRecentSoForSlipSha(svc, args.imageSha256, args.excludeSampleId);
      if (doc) return { docNo: doc, rule: 'image' };
    }
  } catch (e) {
    console.warn('[scan-so dup] image check failed:', (e as Error).message);
  }

  // B) Same phone + (same slip serial OR same slip date + same total).
  try {
    const parsed = args.parsed;
    // parsed.phones are already E.164 (postProcessSlip). They used to be bare
    // national digits, which is why this line hardcoded a +60 in front — the
    // one place a Singapore slip was guaranteed to be looked up as a Malaysian
    // number, so its duplicate check could never match.
    const storedPhone = (parsed?.phones?.[0] ?? '').replace(/\s+/g, '');
    if (parsed && storedPhone) {
      const ref = (parsed.customerSoRef ?? '').trim().toUpperCase();
      const slipDate = /^\d{4}-\d{2}-\d{2}$/.test((parsed.processingDate ?? '').trim())
        ? (parsed.processingDate as string).trim()
        : null;
      const totalCenti = typeof parsed.totalRm === 'number' && parsed.totalRm > 0
        ? Math.round(parsed.totalRm * 100)
        : null;
      // Nothing comparable beyond the phone alone → phone-only would be far
      // too noisy (repeat customers are normal); skip.
      if (ref || (slipDate && totalCenti != null)) {
        let dupQ = svc
          .from('mfg_sales_orders')
          .select('doc_no, customer_so_no, so_date, total_revenue_centi')
          .eq('phone', storedPhone)
          .neq('status', 'CANCELLED');
        // Multi-company: never link a scan to the OTHER company's SO by phone.
        if (companyId != null) dupQ = dupQ.eq('company_id', companyId);
        const { data } = await dupQ
          .order('created_at', { ascending: false })
          .limit(25);
        for (const r of ((data as Array<Record<string, unknown>> | null) ?? [])) {
          const doc = (r.docNo ?? r.doc_no) as string | undefined;
          if (typeof doc !== 'string' || doc === '') continue;
          const candRef = String(r.customerSoNo ?? r.customer_so_no ?? '').trim().toUpperCase();
          if (ref && candRef && candRef === ref) return { docNo: doc, rule: 'content' };
          const candDate = String(r.soDate ?? r.so_date ?? '').slice(0, 10);
          const candTotal = Number(r.totalRevenueCenti ?? r.total_revenue_centi ?? NaN);
          if (slipDate && totalCenti != null && candDate === slipDate && candTotal === totalCenti) {
            return { docNo: doc, rule: 'content' };
          }
        }
      }
    }
  } catch (e) {
    console.warn('[scan-so dup] content check failed:', (e as Error).message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payment rows from receipt OCR (owner 2026-07-04: "OCR Payment detect 不到").
// The background draft used to carry only the payment HEADER fields, so the
// operator opened the draft and saw NO payment. After the DRAFT SO is created,
// every uploaded image Claude classified `payment_receipt` now becomes a
// payments-ledger row through mfg-sales-orders' recordSoPaymentRow — the SAME
// factored insert+audit core the interactive POST /:docNo/payments route uses
// (payment field derivation / Account Sheet auto-fill never reimplemented
// here). Amounts are CONSERVATIVE: the OCR extracts ONE payment field set per
// scan (not one per receipt), so the FIRST receipt carries the slip/receipt
// deposit (depositRm — read preferentially from the printed receipt) and any
// further receipt books at 0 with a "please verify" note. The receipt's
// existing R2 object (scan-jobs/{jobId}/{n} — SO_ITEM_PHOTOS, the same
// physical houzs-erp bucket the payment slip presigner serves) is REFERENCED
// as the payment slip; no copy. Never fails the job: the caller logs + notes.
// ---------------------------------------------------------------------------

// Slip payment header -> ledger method vocabulary. Mirrors the interactive
// client's mapping (MobileNewSO PAY_METHOD_CODE + its scan prefill, which
// folds a legacy 'Installment' L1 into Merchant): Merchant -> 'merchant' (+
// bank + plan months), Online -> 'transfer' (+ online type), Cash -> 'cash'.
// No/unknown method match -> 'merchant' (a printed card-terminal receipt IS a
// Merchant transaction), flagged `guessed` so the row's note says so.
// The uploaded-image indices the model classified as payment RECEIPTS, in
// image order, deduped, filtered to indices that were actually uploaded. The
// storeScanImages positional fallback is intentionally NOT applied — booking
// money off an UNCLASSIFIED photo would be a guess; the operator can still add
// the payment on the draft.
function classifiedReceiptIndices(parsed: ExtractedSlip, uploadedImages: UploadedImage[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const img of parsed.images) {
    if (img.kind !== 'payment_receipt' || seen.has(img.index)) continue;
    seen.add(img.index);
    if (uploadedImages.some((u) => u.index === img.index)) out.push(img.index);
  }
  return out;
}

async function recordScanReceiptPayments(
  svc: SupabaseClient,
  args: {
    docNo: string;
    jobId: string;
    parsed: ExtractedSlip;
    uploadedImages: UploadedImage[];
    // scan-jobs/{jobId}/{n} keys whose R2 put SUCCEEDED at enqueue time.
    storedImageKeys: string[];
    // storeScanImages' receipt copy (scan-slips/{sampleId}-receipt) — the
    // fallback slip reference when the enqueue-time put failed.
    receiptImageKey: string | null;
    salespersonId: string;
    salespersonName: string | null;
  },
): Promise<{ recorded: number; failed: number; skippedDuplicate: number }> {
  const { parsed } = args;
  const receiptIdxs = classifiedReceiptIndices(parsed, args.uploadedImages);
  if (receiptIdxs.length === 0) return { recorded: 0, failed: 0, skippedDuplicate: 0 };

  // Double-book guard. The create core books its own is_deposit ledger row
  // for the POS vocabulary (lowercase methods) — the scan draft's header
  // method is a dropdown VALUE ('Merchant'/'Online'/'Cash') so it never
  // matches today, but if the SO somehow already carries a payment row,
  // recording again would double count. Skip + surface a plain note (owner
  // 2026-07-04: "A matching payment was already recorded") instead.
  const { data: existingRows, error: existingErr } = await svc
    .from('mfg_sales_order_payments')
    .select('id')
    .eq('so_doc_no', args.docNo)
    .limit(1);
  if (existingErr) {
    console.error('[scan-job] payment pre-check failed:', args.docNo, existingErr.message);
    return { recorded: 0, failed: receiptIdxs.length, skippedDuplicate: 0 };
  }
  if (((existingRows as unknown[] | null) ?? []).length > 0) {
    console.warn('[scan-job] SO already has payment rows — skipping receipt payments:', args.docNo);
    return { recorded: 0, failed: 0, skippedDuplicate: receiptIdxs.length };
  }

  // MULTI-RECEIPT — the pure planner decides the rows to book (one per receipt
  // that carries a real amount), each with its OWN amount / method / approval /
  // slip proof / deposit flag / date. 0 receipts → []; 1 receipt → the single
  // pre-multi row; N receipts → N rows. See scan-receipt-plan.ts.
  const planned = planReceiptPayments({
    jobId: args.jobId,
    receiptIndices: receiptIdxs,
    storedImageKeys: args.storedImageKeys,
    receiptImageKey: args.receiptImageKey,
    payments: parsed.payments,
    legacy: {
      depositRm: parsed.depositRm,
      approvalCode: parsed.approvalCode,
      paymentMethodValue: parsed.paymentMethodMatch?.value ?? null,
      bankValue: parsed.bankMatch?.value ?? null,
      onlineTypeValue: parsed.onlineTypeMatch?.value ?? null,
      installmentPlanValue: parsed.installmentPlanMatch?.value ?? null,
    },
    slipProcessingDate: parsed.processingDate,
    nowMs: Date.now(),
    todayStr: todayMyt(),
  });
  if (planned.length === 0) return { recorded: 0, failed: 0, skippedDuplicate: 0 };

  // Receipt dedup ACROSS SOs (owner 2026-07-04: never book money off a receipt
  // that already backs a payment row on ANY order). Receipt sha256s are not
  // stored, so a true image-hash match would mean re-hashing every prior job's
  // R2 objects inside waitUntil — too heavy. Two CHEAP probes instead, both
  // fail-OPEN (a query error just books normally):
  //   1) R2 key lineage — a payment row already references this job's
  //      scan-jobs/{jobId}/{idx} object (a re-run of the same job). Checked per
  //      PLANNED row's own slip key.
  //   2) Transaction fingerprint — a payment row on ANY SO already carries a
  //      receipt's approval code AND the same amount. Now checked PER RECEIPT
  //      (each receipt has its own approval code + amount), not just the first —
  //      a re-photographed receipt gets a new R2 key + sha256, but the PRINTED
  //      approval code is per-transaction, the cheapest honest image-match.
  const candidateKeys = planned.map((p) => p.slipKey).filter((k): k is string => typeof k === 'string' && k !== '');
  const alreadyBookedKeys = new Set<string>();
  if (candidateKeys.length > 0) {
    try {
      const { data: lineageRows, error: lineageErr } = await svc
        .from('mfg_sales_order_payments')
        .select('slip_key')
        .in('slip_key', candidateKeys);
      if (lineageErr) {
        console.warn('[scan-job] payment key-lineage check failed:', lineageErr.message);
      } else {
        for (const r of ((lineageRows as Array<Record<string, unknown>> | null) ?? [])) {
          const k = (r.slipKey ?? r.slip_key) as string | undefined;
          if (typeof k === 'string' && k !== '') alreadyBookedKeys.add(k);
        }
      }
    } catch (e) {
      console.warn('[scan-job] payment key-lineage check threw:', (e as Error).message);
    }
  }
  // Fingerprint set — one batched query over every approval code the planned
  // rows carry, keyed "approvalCode|amountCenti".
  const bookedFingerprints = new Set<string>();
  const approvalCodes = [...new Set(planned.map((p) => p.approvalCode).filter((a): a is string => !!a))];
  if (approvalCodes.length > 0) {
    try {
      const { data: fpRows, error: fpErr } = await svc
        .from('mfg_sales_order_payments')
        .select('approval_code, amount_centi')
        .in('approval_code', approvalCodes);
      if (fpErr) console.warn('[scan-job] payment fingerprint check failed:', fpErr.message);
      else {
        for (const r of ((fpRows as Array<Record<string, unknown>> | null) ?? [])) {
          const code = (r.approvalCode ?? r.approval_code) as string | undefined;
          const amt = Number(r.amountCenti ?? r.amount_centi ?? NaN);
          if (typeof code === 'string' && code !== '' && Number.isFinite(amt)) {
            bookedFingerprints.add(`${code}|${amt}`);
          }
        }
      }
    } catch (e) {
      console.warn('[scan-job] payment fingerprint check threw:', (e as Error).message);
    }
  }

  let recorded = 0;
  let failed = 0;
  let skippedDuplicate = 0;
  for (const row of planned) {
    // A receipt that already backs a payment row books NOTHING — the caller
    // appends the plain "matching payment already recorded" note instead.
    const keyDup = row.slipKey != null && alreadyBookedKeys.has(row.slipKey);
    const fpDup = row.approvalCode != null && bookedFingerprints.has(`${row.approvalCode}|${row.amountCenti}`);
    if (keyDup || fpDup) {
      skippedDuplicate += 1;
      console.warn('[scan-job] receipt already booked — skipped:', args.docNo, row.slipKey ?? `img#${row.imageIndex}`);
      continue;
    }
    const noteParts = ['Recorded from scanned payment receipt'];
    if (row.methodGuessed) noteParts.push('method not read — assumed card terminal (Merchant)');
    try {
      const { errorMessage } = await recordSoPaymentRow(svc, {
        docNo: args.docNo,
        paidAt: row.paidAt,
        method: row.method,
        merchantProvider: row.merchantProvider,
        installmentMonths: row.installmentMonths,
        onlineType: row.onlineType,
        approvalCode: row.approvalCode,
        amountCenti: row.amountCenti,
        slipKey: row.slipKey,
        collectedBy: args.salespersonId,
        note: noteParts.join('; '),
        createdBy: args.salespersonId,
        actorName: args.salespersonName,
        // The first receipt row IS the header deposit — is_deposit stops the
        // list/detail paid-rollup adding the header deposit_centi on top of
        // this ledger row (double count).
        isDeposit: row.isDeposit,
        auditSource: 'automation',
        auditNote: 'Auto: payment recorded from scanned receipt (background scan job)',
      });
      if (errorMessage) {
        failed += 1;
        console.error('[scan-job] receipt payment insert failed:', args.docNo, errorMessage);
      } else {
        recorded += 1;
      }
    } catch (e) {
      failed += 1;
      console.error('[scan-job] receipt payment threw:', args.docNo, (e as Error).message);
    }
  }
  return { recorded, failed, skippedDuplicate };
}

// Extracted slip -> DRAFT SO create body. Mirrors the SHIPPED headless client
// mapping (MobileScan buildPrefill + MobileNewSO createDraftFromPrefill):
// same header fields, same "+60" phone re-attachment, same named-line filter,
// same itemGroup 'others' + null dates (the operator finishes category /
// variants / payments when reviewing the draft). Additions the client flow
// showed on screen instead: the verbatim slip row / fabric code / OCR notes
// ride in the line remark, and the reparseSpec-hardened bedframe numbers seed
// the divanHeight/legHeight/gap variant keys so nothing OCR'd is lost.
// Validated option values (customerType / buildingType / state / venue /
// payment fields) come straight from validateSlip's catalog-bound matches, so
// the create handler's own dropdown re-validation accepts them.
// Placeholder values a scan SHELL draft carries in the required fields the OCR
// could not read. Clearly provisional so the rep knows to overwrite them; the
// create core skips customer-identity resolution for _scanShell bodies so these
// never spawn a phantom customer.
const SHELL_NAME = 'Scan — please complete';
const SHELL_PHONE = 'To be confirmed';

/* A fully blank scan shell — used when the OCR produced NOTHING at all (blank
   or unreadable photo). Still lands a draft carrying the slip photo so the rep
   opens it and keys the order in by hand. */
function buildEmptyShellBody(
  keys: { imageKey: string | null; receiptImageKey: string | null },
): Record<string, unknown> {
  return {
    customerName: SHELL_NAME,
    debtorName: SHELL_NAME,
    phone: SHELL_PHONE,
    note: null,
    depositCenti: 0,
    slipImageKey: keys.imageKey,
    receiptImageKey: keys.receiptImageKey,
    asDraft: true,
    _scanShell: true,
    items: [],
  };
}

/* Owner 2026-07-04: "就用 announcement 的功能,只有自己看到,像 notification 那样."
   Each finished scan posts a PRIVATE announcement to the one salesperson who
   scanned it (target_type USER_IDS = [that user]) so it rides the announcements
   machinery they already have — the unread dot + banner + Announcements screen —
   as a personal notification. `source='scan'` keeps these out of the office
   composer list (GET /api/announcements filters them; /banner still shows them).
   7-day expiry so the banner self-clears; written to public.announcements via
   env.DB (the D1-compat Postgres shim, same handle the announcements route uses).
   Fail-soft: a notice insert must NEVER fail the scan job. Skipped when we have
   no houzsUserId (a private notice needs a target user). */
async function postScanNotice(
  env: Env,
  opts: {
    houzsUserId: number | null;
    category: 'GENERAL' | 'WARNING';
    title: string;
    body: string;
  },
): Promise<void> {
  if (opts.houzsUserId == null) return;
  // Delegates to the shared personal-notice path (services/personalNotice.ts)
  // so there is ONE announcements-insert path for system notices. Behaviour is
  // unchanged: single-user USER_IDS notice, source='scan', 7-day self-clear.
  await postPersonalNotice(env, {
    userIds: [opts.houzsUserId],
    category: opts.category,
    title: opts.title,
    body: opts.body,
    source: 'scan',
    expiresDays: 7,
  });
}

/* The sofa Leg Height "Default" option (RM 0.00) from the maintenance
   sofaLegHeights pool, matched case-insensitively by name (owner 2026-07-13).
   Used to seed a drafted sofa line's Leg Height when the slip named no specific
   leg, so it is never an empty required field. null when the pool has none. */
const DEFAULT_SOFA_LEG_RE = /^\s*default\s*$/i;
function resolveDefaultSofaLeg(catalog: Catalog): string | null {
  return catalog.sofaLegHeights.find((v) => DEFAULT_SOFA_LEG_RE.test(v)) ?? null;
}

/* The pool's "No Leg" option, matched by NAME (same posture as
   resolveDefaultSofaLeg). The maintenance value is the words "No Leg", NOT a
   0" measurement — resolving it from the pool keeps a genuine no-leg read
   instead of inventing an option that was never configured. */
const NO_LEG_RE = /^\s*no\s*-?\s*leg\s*$/i;
function resolveNoLeg(pool: string[]): string | null {
  return pool.find((v) => NO_LEG_RE.test(v)) ?? null;
}

/* Snap an OCR-derived variant value to the live Maintenance pool.
   Owner rule (2026-07-16, the "8\" leg" report): the handwritten slip is a
   HINT, not authority. The OCR reads these axes as bare inch NUMBERS, so a
   misread (or a number belonging to another axis) trivially produces a value
   that was never configured — the reported draft carried legHeight 8" when the
   BEDFRAME Leg Heights pool only holds No Leg / 1" / 2" / 4" / 5" / 6" / 7".

   Returns the pool's CANONICAL value on a hit (trim + case-insensitive, so a
   pool value carrying data-entry whitespace still matches — same defensive
   posture as the specials gate in allowed-options-check), or null when the pool
   has no such option. null means the caller LEAVES THE AXIS UNSET so the
   operator picks it against the slip photo. Deliberately NO nearest-value
   coercion: silently rounding 8" to 7" would invent a price and a spec nobody
   wrote.

   An EMPTY pool means the config never configured that axis at all — not "allow
   anything". Return null there too, matching the "never invent" rule the SKU /
   fabric / specials matches already follow. */
function snapToMaintPool(value: string, pool: string[]): string | null {
  const v = value.trim();
  if (v === '' || pool.length === 0) return null;
  const exact = pool.find((o) => o.trim() === v);
  if (exact) return exact;
  const ci = pool.find((o) => o.trim().toLowerCase() === v.toLowerCase());
  return ci ?? null;
}

/* Snap an OCR inch NUMBER to its pool value. The pools are not spelled
   consistently — legHeights / divanHeights / gaps carry the inch mark (`4"`)
   while sofaSizes carries the bare number (`28`) — so try BOTH spellings and
   return whichever the pool actually holds. This is a spelling reconciliation,
   never a value change: only an exact member of the pool is ever returned, and
   a number the pool doesn't hold still yields null (axis left unset). */
function snapInchesToMaintPool(inches: number, pool: string[]): string | null {
  return snapToMaintPool(`${inches}"`, pool) ?? snapToMaintPool(`${inches}`, pool);
}

function buildDraftSoBodyFromSlip(
  parsed: ExtractedSlip,
  catalog: Catalog,
  keys: { imageKey: string | null; receiptImageKey: string | null },
  opts?: { allowShell?: boolean },
): { body: Record<string, unknown> | null; missing: string[] } {
  const missing: string[] = [];
  let customerName = (parsed.customerName ?? '').trim();
  if (!customerName) missing.push('customer name');
  // parsed.phones are already national-significant digits (postProcessSlip).
  let mainPhone = (parsed.phones[0] ?? '').trim();
  if (!mainPhone) missing.push('phone number');
  // Owner 2026-07-04: a scan missing the required name/phone must STILL land a
  // draft the rep opens and completes from the photo — not just an error. In
  // shell mode we substitute clearly-provisional placeholders for the missing
  // required fields, keep everything that WAS read (address, lines...), and tag
  // the body `_scanShell` so the create core skips the customer upsert.
  if (missing.length > 0 && !opts?.allowShell) return { body: null, missing };
  const isShell = missing.length > 0;
  if (!customerName) customerName = SHELL_NAME;

  const skuByCode = new Map(catalog.skus.map((s) => [s.code.toUpperCase(), s]));
  const items: Array<Record<string, unknown>> = [];
  for (const l of parsed.lines ?? []) {
    const code = l.skuMatch?.code ?? '';
    const sku = code ? skuByCode.get(code.toUpperCase()) : undefined;
    const rawText = (l.rawText ?? '').trim();
    // A line counts once it has a matched SKU or some raw slip text (drops blank
    // rows). Owner 2026-07-13: an UNMATCHED line must NOT borrow the raw slip
    // transcription as its product name/itemCode — it lands as a CLEAN empty
    // general-item line (no product, blank description) so the editor shows
    // "Pick a product…" for the operator to resolve against the slip photo. A
    // MATCHED line keeps its resolved SKU name + variants (scan-parity). The raw
    // text is intentionally NOT carried onto the line (standing clean-remark
    // rule); the slip photo on the SO detail is the operator's reference.
    if (!sku && !rawText) continue;
    const name = sku ? (sku.name ?? '').trim() : '';
    // Owner (said many times): the line REMARK must stay CLEAN -- do NOT stuff
    // the raw slip text / fabric code / specials / OCR notes into it. The
    // operator reviews the draft against the order-slip photo (shown on the SO
    // detail). Only genuine structured variant numbers ride along below.
    const variants: Record<string, unknown> = {};
    const cat = (sku?.category ?? 'OTHERS').toLowerCase();
    // Bedframe numbers (reparseSpec-overruled) -> the same inch-string variant
    // keys the New SO form writes, so the draft's line editor seeds correctly.
    // Only seeded for a MATCHED line — an unmatched line stays a CLEAN empty
    // general item (no product, no attributes) for the operator to fill in.
    //
    // EVERY axis is snapped to the live Maintenance pool first (owner
    // 2026-07-16): an OCR number the config doesn't offer leaves the axis UNSET
    // for the operator rather than seeding an option that does not exist. PR
    // #580 closed this hole for the manual selectors (which intersect the master
    // pool with the Model's allowed_options); the OCR path wrote the raw read
    // straight through, so it stayed open. The per-Model gate in
    // allowed-options-check does NOT cover this: an empty allowed_options pool
    // reads as "no restriction", so an unrestricted Model accepted 8" happily.
    //
    // The sofa leg picker renders sofaLegHeights while the bedframe one renders
    // legHeights, but BOTH write the same `legHeight` key (SoLineCard) — so the
    // pool is chosen by the line's category, not by the key.
    if (sku) {
      const legPool = cat === 'sofa' ? catalog.sofaLegHeights : catalog.legHeights;
      if (l.divanHeightInches != null) {
        const snapped = snapInchesToMaintPool(l.divanHeightInches, catalog.divanHeights);
        if (snapped) variants.divanHeight = snapped;
      }
      if (l.noLeg) {
        // "No Leg" is a configured pool WORD, not a 0" measurement. The old
        // literal '0"' was itself an un-configured value on every pool.
        const noLeg = resolveNoLeg(legPool);
        if (noLeg) variants.legHeight = noLeg;
      } else if (l.legHeightInches != null) {
        const snapped = snapInchesToMaintPool(l.legHeightInches, legPool);
        if (snapped) variants.legHeight = snapped;
      }
      if (l.gapInches != null) {
        const snapped = snapInchesToMaintPool(l.gapInches, catalog.gaps);
        if (snapped) variants.gap = snapped;
      }
    }
    // Owner 2026-07-04: a scan line must equal a DESKTOP manual line — itemGroup =
    // the SKU's REAL category (not 'others'), and bedframe/sofa carry the fabric
    // COLOUR + special-order add-ons the OCR read, keyed exactly as the New SO form
    // writes them (fabricCode = fabric_colours colourId; specials = addon codes).
    // The create core then validates + REPRICES the line through the SAME engine
    // the desktop form uses, so a scanned bedframe prices identically to a hand-
    // keyed one. Fields the OCR can't read (sofa seat/leg height) are left for the
    // operator to pick on review — same as desktop. If the stricter category
    // validation rejects a line (an OCR fabric not allowed on that model, an
    // incomplete sofa), runScanJob degrades it to a loose 'others' line so an
    // imperfect read NEVER loses the whole scanned order.
    if (cat === 'bedframe' || cat === 'sofa') {
      if (l.fabricMatch?.code) variants.fabricCode = l.fabricMatch.code;
      const specialCodes = (l.specialsMatch ?? []).map((s) => s.code).filter(Boolean);
      if (specialCodes.length > 0) variants.specials = specialCodes;
    }
    // SOFA seat height — the same key the New SO form's sofa panel writes
    // (draft.variants.seatHeight), snapped to the live sofaSizes pool.
    // PRICING NOTE: the create core reprices itemGroup='sofa' from the seat
    // height, so this OCR figure MOVES the sofa price — an unconfigured read
    // must never reach the line. Snapping also fixes the SPELLING: sofaSizes is
    // seeded as bare numbers ("28"), but this seeded `28"` with an inch mark —
    // a value no sofa pool holds, so it both pinned as `28" (current)` in the
    // picker and missed the seat-height price lookup. If the stricter category
    // validation later rejects the sofa line, runScanJob degrades it to a loose
    // 'others' line (seat height dropped there), so an imperfect read never
    // loses the row.
    if (cat === 'sofa' && l.seatHeightInches != null) {
      const snapped = snapInchesToMaintPool(l.seatHeightInches, catalog.sofaSizes);
      if (snapped) variants.seatHeight = snapped;
    }
    // SOFA leg height — owner 2026-07-13: the sofa Leg Height carries a standing
    // "Default" option (RM 0.00). When the slip didn't spell out a specific leg
    // (No Leg / 4" / 6" …), seed the "Default" option so the drafted sofa line
    // comes out pre-filled (never an empty leg field) and never blocks Confirm.
    // A scanned specific leg (set above via noLeg / legHeightInches) is kept.
    if (cat === 'sofa' && variants.legHeight == null) {
      const defLeg = resolveDefaultSofaLeg(catalog);
      if (defLeg) variants.legHeight = defLeg;
    }
    items.push({
      itemCode: sku?.code ?? '',
      itemGroup: cat,
      description: name,
      qty: l.qtyGuess > 0 ? l.qtyGuess : 1,
      unitPriceCenti: Math.round(Math.max(0, l.priceRmGuess ?? 0) * 100),
      lineDeliveryDate: null,
      ...(Object.keys(variants).length > 0 ? { variants } : {}),
    });
  }

  // 'One Shot' -> null (no installment term); 'N months' -> N (the client's
  // planToMonths rule).
  const planMonths = installmentPlanToMonths(parsed.installmentPlanMatch?.value);
  const paymentMethod = parsed.paymentMethodMatch?.value ?? null;

  // NOTHING OCR'D IS LOST: fields the model extracted but the draft has no
  // dedicated column for ride in the header note (the draft intentionally
  // nulls the delivery-date columns — "1 month notice" isn't a date — and the
  // slip's written grand total is the operator's cross-check against the line
  // prices, which mostly arrive unpriced).
  // Owner (said many times): the note carries ONLY the customer's genuine
  // handwritten order remark -- NOT slip delivery text / grand total / any
  // other OCR meta. Those each have their own place or are the operator's
  // review-against-the-photo job.
  const noteParts: string[] = [];
  const remarkNote = (parsed.remarks ?? '').trim();
  if (remarkNote) noteParts.push(remarkNote);

  // Owner 2026-08-08 (2990-SO-2608-007, addendum #3) — a DRAFT never carries a
  // Processing Date. The previous rule here (owner 2026-07-04: slip delivery
  // date ⇒ pin processing to TODAY) silently stamped internal_expected_dd on
  // scan drafts, which is wrong twice over: semantically a draft has not
  // started processing, and the date rode in WITHOUT the deposit / variant /
  // completeness gates every explicit Processing-Date write runs. Both dates
  // land NULL now — the create core's pairing rule (both-or-none) forbids
  // carrying the slip's delivery date alone, so the operator keys the pair at
  // review against the slip photo, exactly like the mobile headless scan
  // draft (createDraftFromPrefill) has always done. This is also the shape
  // runScanJob's TIER-1 dateless retry already produced whenever the old
  // default tripped a gate.
  const scanDelivDate: string | null = null;
  const scanProcDate: string | null = null;

  const body: Record<string, unknown> = {
    customerName,
    debtorName: customerName,
    customerSoNo: (parsed.customerSoRef ?? '').trim() || null,
    phone: mainPhone ? `+60${mainPhone.replace(/\s+/g, '')}` : SHELL_PHONE,
    customerType: parsed.customerTypeMatch?.value ?? null,
    buildingType: parsed.buildingTypeMatch?.value ?? null,
    note: noteParts.length > 0 ? noteParts.join(' | ') : null,
    address1: (parsed.addressLine1 ?? parsed.address ?? '').trim() || null,
    customerState: parsed.addressStateMatch?.value ?? null,
    city: (parsed.city ?? '').trim() || null,
    postcode: (parsed.postcode ?? '').trim() || null,
    // Delivery from the slip (today-or-later only); processing pinned to today.
    internalExpectedDd: scanProcDate,
    customerDeliveryDate: scanDelivDate,
    emergencyContactPhone: (parsed.phones[1] ?? '').trim()
      ? `+60${(parsed.phones[1] ?? '').replace(/\s+/g, '')}`
      : null,
    /* Validated venue only — free-text slip location would bypass the venue
       master. validateSlip has already snapped this to an ACTIVE
       public.project_venues NAME (the master SO Maintenance shows and the
       New-SO Venue dropdown renders, per the owner ruling 2026-07-16) or
       cleared it. When null the create core's venue-by-active-project autofill
       resolves it from the salesperson's current exhibition project — which is
       why a no-match must stay null rather than be coerced. */
    venue: parsed.locationMatch?.value ?? null,
    // Payment header fields (validated matches; the operator reviews the
    // draft before it becomes a real order). No payments[] in the create
    // body — the ledger rows are booked AFTER the create by
    // recordScanReceiptPayments (one per classified payment receipt),
    // through the same recordSoPaymentRow core the interactive
    // POST /:docNo/payments route uses.
    paymentMethod,
    merchantProvider: paymentMethod === 'Merchant' ? (parsed.bankMatch?.value ?? null) : null,
    // Method ⇒ sub-field mapping (owner 2026-07-16). The PLAN value itself is
    // already pool-validated (installment_plan), but it was written to the
    // header UNGATED while the bank next to it was gated on 'Merchant' — so a
    // slip read as Cash/Online with an instalment note anywhere on it seeded an
    // SO header carrying "12 months" against a method that cannot instalment,
    // and contradicted the ledger row booked from the SAME parse
    // (deriveLedgerMethod only carries the plan on a merchant-like method,
    // and recordSoPaymentRow nulls it otherwise). One rule, both writers.
    installmentMonths: paymentMethod === 'Merchant' ? planMonths : null,
    approvalCode: (parsed.approvalCode ?? '').trim() || null,
    depositCenti: parsed.depositRm && parsed.depositRm > 0 ? Math.round(parsed.depositRm * 100) : 0,
    // Provenance — the SO detail page serves these back as Order Slip /
    // Payment Receipt proof (same keys the interactive flow carries).
    slipImageKey: keys.imageKey,
    receiptImageKey: keys.receiptImageKey,
    // The whole point: land as DRAFT for the operator to review.
    asDraft: true,
    // Shell = required fields were placeholdered; the create core skips the
    // customer-identity upsert so placeholders never spawn a phantom customer.
    _scanShell: isShell,
    items,
  };
  return { body, missing };
}

// The waitUntil pipeline — runs AFTER /enqueue has responded. Every failure
// path marks the job 'error' with a SHORT plain-language message (raw details
// go to console.error only). Single Claude vision call; no retries beyond the
// shared anthropicFetchWithRetry, keeping the whole run inside Workers'
// waitUntil budget.
async function runScanJob(
  env: Env,
  job: {
    id: string;
    salesperson: string;
    salespersonId: string;
    salespersonName: string | null;
    houzsUserId: number | null;
    /** Multi-company: the ACTIVE company captured on the scan_jobs row at
     *  enqueue time — replayed onto the draft SO create. null = legacy row. */
    companyId: number | null;
    fileBlocks: ContentBlock[];
    uploadedImages: UploadedImage[];
    firstBuffer: ArrayBuffer | null;
    // scan-jobs/{jobId}/{n} keys whose enqueue-time R2 put succeeded — the
    // receipt-payment rows reference these as their slip proof.
    imageKeys: string[];
  },
): Promise<void> {
  const svc = serviceClient(env);
  const touch = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      const { error } = await svc
        .from('scan_jobs')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', job.id);
      if (error) console.error('[scan-job] job update failed:', job.id, error.message);
    } catch (e) {
      console.error('[scan-job] job update threw:', job.id, (e as Error).message);
    }
  };
  const fail = async (plainMsg: string): Promise<void> => {
    await touch({ status: 'error', error: plainMsg });
    // A hard failure produced no draft — tell the rep privately so they know to
    // scan again (system faults only now; unreadable slips land a shell draft).
    await postScanNotice(env, {
      houzsUserId: job.houzsUserId,
      category: 'WARNING',
      title: 'Scan could not be processed',
      body: `${plainMsg} Please scan again.`,
    });
  };

  try {
    await touch({ status: 'running' });
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('[scan-job] ANTHROPIC_API_KEY missing');
      return await fail(JOB_MSG.noKey);
    }

    // EXACT /extract machinery, service-client flavoured (no request scope in
    // waitUntil; catalog reads are the same data RLS shows any signed-in
    // operator — same precedent as warmCatalogCacheForCron).
    const catalog = await loadCatalog(svc, env.DB, job.companyId);
    const branding = await getBranding(env);
    const cachedPrefix = buildCachedPrefix(catalog, branding.companyName);
    const inj = await loadPromptInjections(svc, job.salesperson);
    const call = await callClaudeSlipExtract(apiKey, cachedPrefix, inj, job.fileBlocks);
    const parsed = call.parsed;

    // Learning pool + slip/receipt provenance — identical to /extract.
    const imageSha256 = job.firstBuffer ? await sha256Hex(job.firstBuffer) : null;
    const sampleSalesperson = job.salesperson || normalizeRepKey(parsed?.salesRep) || null;
    const { sampleId } = await insertScanSample(svc, {
      imageSha256,
      salesperson: sampleSalesperson,
      parsed,
      errorMsg: call.errorMsg,
      claudeText: call.claudeText,
    });
    if (sampleId) await touch({ sample_id: sampleId });
    const { imageKey, receiptImageKey } = await storeScanImages(
      env.SO_ITEM_PHOTOS, svc, sampleId, job.uploadedImages, parsed,
    );

    // Owner 2026-07-04: EVERY scan ends as a draft the rep can open — success,
    // duplicate, OR unreadable. A scan that could not be turned into a full
    // order still lands a SHELL draft carrying the slip photo (with a plain
    // "please complete this from the photo" note the Orders-open toast shows),
    // so the rep never has to hunt a lost scan or re-shoot just to key it in.
    let body: Record<string, unknown>;
    let shellNote: string | null = null;
    let dupDocNo: string | null = null;

    if (!parsed) {
      // Nothing parsed at all (blank/unreadable photo, or the model timed out).
      console.error('[scan-job] extraction failed, creating blank draft:', job.id, call.errorMsg);
      const slipKey = imageKey ?? (job.imageKeys[0] ?? null);
      body = buildEmptyShellBody({ imageKey: slipKey, receiptImageKey });
      shellNote = 'The scan could not read this slip, so this draft is blank. Please open it and fill in the order from the photo.';
    } else {
      await postProcessSlip(parsed, svc, env.GOOGLE_MAPS_API_KEY, catalog);

      // Multi-receipt manifest (migration 0141) — record WHICH uploads the OCR
      // classified as payment receipts (the durable audit trail of "the
      // receipts this scan turned into payments"). Keys are the enqueue-time R2
      // objects (scan-jobs/{jobId}/{idx}) that survived; best-effort, never
      // blocks the draft.
      const receiptKeys = classifiedReceiptIndices(parsed, job.uploadedImages)
        .map((idx) => `scan-jobs/${job.id}/${idx}`)
        .filter((k) => job.imageKeys.includes(k));
      if (receiptKeys.length > 0) await touch({ receipt_image_keys: receiptKeys });

      // Duplicate-upload warning (owner: 重复上传预警) — same photo scanned
      // again recently, or the same customer/slip already has an SO. The DRAFT
      // is STILL created for review; the flag rides on the job row (mobile
      // surfaces it in the toast) and the SO note is prefixed below.
      const dup = await findDuplicateSo(svc, { imageSha256, excludeSampleId: sampleId, parsed }, job.companyId ?? undefined);
      if (dup) { dupDocNo = dup.docNo; await touch({ duplicate_of: dup.docNo }); }

      // allowShell → always returns a body; missing required fields become
      // placeholders and the body is tagged `_scanShell`.
      const draft = buildDraftSoBodyFromSlip(parsed, catalog, { imageKey, receiptImageKey }, { allowShell: true });
      if (!draft.body) {
        // Defensive — allowShell should never return null.
        return await fail(
          `The scan could not read the ${draft.missing.join(' and ')} on the slip. Please enter this order manually.`,
        );
      }
      body = draft.body;
      if (body._scanShell === true) {
        shellNote = `The scan could not read the ${draft.missing.join(' and ')} on this slip. Please open this draft and complete it from the photo.`;
      }
      // Owner (standing rule): the SO NOTE holds ONLY the customer's genuine
      // handwritten remark — never the "possible duplicate" warning. The
      // duplicate signal already rides its OWN channels: the scan_jobs
      // duplicate_of flag (touched above → the mobile Scan card's "Duplicate of
      // <doc>" pill) AND the private scan Announcement posted below. So do NOT
      // prefix body.note here; dupDocNo is carried into that notice instead.
    }

    // PRICING-CRITICAL create — the factored mfg-sales-orders core, replayed
    // with the identities captured at enqueue time. Never reimplemented here.
    let outcome = await createDraftSalesOrder(env, {
      salespersonId: job.salespersonId,
      salespersonName: job.salespersonName,
      houzsUserId: job.houzsUserId,
      companyId: job.companyId,
      body,
    });
    // Belt-and-suspenders TIER 1: if the create rejects AND we set slip dates,
    // the date/variant pairing rules are the likely cause (a Processing Date
    // needs complete line variants) — retry WITHOUT dates, KEEPING the full
    // category lines (itemGroup/fabric/specials). The operator sets dates on
    // review. This is what recovers a sofa with a delivery date but no seat
    // height while preserving desktop-parity lines.
    const replay = (b: Record<string, unknown>) => createDraftSalesOrder(env, {
      salespersonId: job.salespersonId,
      salespersonName: job.salespersonName,
      houzsUserId: job.houzsUserId,
      companyId: job.companyId,
      body: b,
    });
    if (
      outcome.status !== 201 &&
      (body.internalExpectedDd != null || body.customerDeliveryDate != null)
    ) {
      console.warn('[scan-job] create rejected with dates, retrying dateless:', job.id, outcome.status);
      body.internalExpectedDd = null;
      body.customerDeliveryDate = null;
      outcome = await replay(body);
    }
    // TIER 2 last resort: the category-strict lines still reject (an OCR fabric
    // not allowed on that model, a special not on the model, an incomplete sofa).
    // Degrade EVERY line to a loose 'others' line (description + qty + price only,
    // no variants) so the scanned order STILL lands as a draft — the operator
    // re-picks the category variants against the slip photo. Never lose the scan.
    if (outcome.status !== 201 && Array.isArray(body.items) && (body.items as unknown[]).length > 0) {
      console.warn('[scan-job] category lines rejected, retrying as loose lines:', job.id, outcome.status);
      body.internalExpectedDd = null;
      body.customerDeliveryDate = null;
      body.items = (body.items as Array<Record<string, unknown>>).map((it) => ({
        itemCode: it.itemCode,
        itemGroup: 'others',
        description: it.description,
        qty: it.qty,
        unitPriceCenti: it.unitPriceCenti,
        lineDeliveryDate: null,
      }));
      outcome = await replay(body);
    }
    const docNo = (outcome.body as { docNo?: unknown }).docNo;
    if (outcome.status === 201 && typeof docNo === 'string' && docNo !== '') {
      // Shell/blank draft — there is no reliable OCR payment to book. Record the
      // plain "please complete" note so the Orders-open toast tells the rep, and
      // stop here (no receipt-payment pass on a draft the model couldn't read).
      if (shellNote) {
        await touch({ status: 'done', so_doc_no: docNo, error: shellNote });
        await postScanNotice(env, {
          houzsUserId: job.houzsUserId,
          category: 'WARNING',
          title: `Scan saved as a draft — ${docNo}`,
          body: shellNote,
        });
        return;
      }
      // Past the shell paths, a null parse has already returned above — narrow
      // `parsed` to non-null for the receipt-payment pass (defensive fallback).
      if (!parsed) { await touch({ status: 'done', so_doc_no: docNo }); return; }
      // Payments from receipt OCR — one ledger row per classified payment
      // receipt, via the SAME recordSoPaymentRow core the interactive route
      // uses. GUARD: never fail the job — the DRAFT stands; a failure only
      // appends a plain note (job stays done with so_doc_no).
      let paymentNote: string | null = null;
      try {
        const pay = await recordScanReceiptPayments(svc, {
          docNo,
          jobId: job.id,
          parsed,
          uploadedImages: job.uploadedImages,
          storedImageKeys: job.imageKeys,
          receiptImageKey,
          salespersonId: job.salespersonId,
          salespersonName: job.salespersonName,
        });
        if (pay.failed > 0) {
          paymentNote = 'Draft created; the payment could not be recorded — please add it on the order.';
        } else if (pay.skippedDuplicate > 0) {
          // Receipt dedup fired — the money row already exists somewhere, so
          // nothing was booked twice. Plain note per the standing rule.
          paymentNote = 'A matching payment was already recorded, so it was not added again.';
        }
      } catch (e) {
        console.error('[scan-job] receipt payment recording threw:', job.id, (e as Error).message);
        paymentNote = 'Draft created; the payment could not be recorded — please add it on the order.';
      }
      await touch({
        status: 'done',
        so_doc_no: docNo,
        ...(paymentNote ? { error: paymentNote } : {}),
      });
      // Private "your scan is a draft now" notice. Duplicate/payment caveats
      // ride in the body + bump it to WARNING so it stands out.
      const noticeExtras = [
        dupDocNo ? `This looks like a possible duplicate of ${dupDocNo}.` : null,
        paymentNote,
      ].filter(Boolean);
      await postScanNotice(env, {
        houzsUserId: job.houzsUserId,
        category: dupDocNo || paymentNote ? 'WARNING' : 'GENERAL',
        title: `Sales order saved — ${docNo}`,
        body: [`Your scan was saved as a draft. Open it from your Orders to review.`, ...noticeExtras].join(' '),
      });
      return;
    }
    console.error(
      '[scan-job] draft create rejected:', job.id, outcome.status,
      JSON.stringify(outcome.body).slice(0, 600),
    );
    // The create core's rejection reasons are already plain sentences (the
    // plain-language-errors standard); fall back to a generic one otherwise.
    const reason =
      typeof outcome.body.reason === 'string' ? outcome.body.reason
      : typeof outcome.body.message === 'string' ? outcome.body.message
      : JOB_MSG.createFallback;
    await fail(reason);
  } catch (e) {
    console.error('[scan-job] pipeline threw:', job.id, e);
    await fail(JOB_MSG.fallback);
  }
}

// ---------------------------------------------------------------------------
// Resolve the UPLOADER's own scm.staff id so the scanned draft's salesperson
// defaults to whoever scanned it (standing rule: salesperson default-by-
// uploader). The SCM auth bridge pins c.get('user').id to ONE shared SYSTEM
// staff row (middleware/auth.ts), so that id can't attribute the SO — the real
// person is the Houzs user behind houzsUser. Resolve their scm.staff row the
// same way the interactive create does (mig 0066 user_id link), then fall back
// to matching by email for a staff row that was never linked by user_id. When
// nothing resolves we return null and the caller keeps the system id (today's
// behaviour) — no regression, just correct attribution whenever it's knowable.
// ---------------------------------------------------------------------------
async function resolveScanUploaderStaffId(
  svc: SupabaseClient,
  houzsUserId: number | null,
  email: string | null | undefined,
): Promise<string | null> {
  const byUserId = await resolveCallerStaffId(svc, houzsUserId);
  if (byUserId) return byUserId;
  const e = (email ?? '').trim();
  if (!e) return null;
  try {
    const { data } = await svc
      .from('staff')
      .select('id')
      .ilike('email', e)
      .limit(1)
      .maybeSingle();
    return ((data as { id?: string } | null)?.id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /scan-so/enqueue — persist photos + job row, respond FAST, run the
// pipeline in waitUntil. Same multipart contract as /extract.
// ---------------------------------------------------------------------------
scanSo.post('/enqueue', async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    // Plain-language rule: the raw parser exception goes to the log, the
    // operator sees one plain sentence naming the likely cause (a bad/partial
    // upload) so they know to retake and retry rather than read internals.
    console.error('[scan-so enqueue] multipart parse failed:', (e as Error).message);
    return c.json(
      { error: 'bad_request', reason: 'The photos could not be uploaded — please retake them and try again.' },
      400,
    );
  }
  const filesRes = await parseScanFiles(formData);
  if (!filesRes.ok) {
    return c.json({ error: 'bad_request', reason: filesRes.reason }, 400);
  }
  const { fileBlocks, uploadedImages, allFiles, firstBuffer } = filesRes.parsed;
  const repGiven = normalizeRepKey(formData.get('salesperson'));
  // Duplicate-slip = WARN, not BLOCK (owner 2026-07-15: "this was already
  // opened; whether to open again is the person's decision — don't be too
  // strict"). The client re-sends the SAME upload with force=1 after the
  // operator confirms "create anyway", which skips the hard reject below and
  // lets the order queue (the background job's soft duplicate warning still
  // marks it so nobody loses the trail).
  const forceCreate = ((): boolean => {
    const v = formData.get('force');
    if (typeof v !== 'string') return false;
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  })();

  // Identities captured while the request is still authed — replayed into the
  // headless SO create. user.id = scm.staff UUID (the SCM bridge identity);
  // houzsUser.id = public users bigint (venue-by-project autofill). Never mix
  // the two (staff-UUID vs bigint trap).
  const user = c.get('user');
  const houzsUser = c.get('houzsUser');
  const houzsUserId =
    houzsUser?.id != null && Number.isFinite(Number(houzsUser.id)) ? Number(houzsUser.id) : null;
  const salespersonName =
    ((user.user_metadata as { name?: string } | undefined)?.name ?? '').trim() || repGiven || null;

  const svc = serviceClient(c.env);

  // Salesperson default-by-uploader: attribute the draft SO to the scanning
  // user's OWN scm.staff row (resolved here while the request is still authed),
  // NOT the shared SYSTEM bridge id. Falls back to user.id (system) only when
  // the uploader has no resolvable staff row — same as before.
  const uploaderStaffId =
    (await resolveScanUploaderStaffId(svc, houzsUserId, houzsUser?.email)) ?? user.id;

  // 0) HARD REJECT on an exact re-upload (owner 2026-07-04 policy change:
  //    image-hash duplicate = refuse AT UPLOAD, nothing queued). sha256 the
  //    FIRST file (the order slip — the mobile client appends it first) and
  //    run the same 30-day slip-hash -> SO lookup findDuplicateSo rule A uses
  //    (findRecentSoForSlipSha — shared core, not a copy). Synchronous so the
  //    rep hears "already uploaded" on the spot instead of finding a second
  //    draft later. Fail-OPEN: if the lookup itself errors we queue normally
  //    and the background job's soft duplicate warning still applies. Rule B
  //    (same phone + same slip serial / date+total) intentionally STAYS a
  //    soft warning inside the job — a genuine repeat order is legal.
  //    force=1 (operator confirmed "create anyway") skips this reject entirely.
  if (firstBuffer && !forceCreate) {
    try {
      const dupDocNo = await findRecentSoForSlipSha(svc, await sha256Hex(firstBuffer), null);
      if (dupDocNo) {
        return c.json(
          { error: 'duplicate_slip', reason: `This slip was already uploaded — it created ${dupDocNo}.` },
          409,
        );
      }
    } catch (e) {
      console.warn('[scan-so enqueue] duplicate check failed (queuing anyway):', (e as Error).message);
    }
  }

  // 1) Job row FIRST — the durable record the phone can poll even if it
  //    disconnects the instant this response is sent.
  const { data: jobRow, error: jobErr } = await svc
    .from('scan_jobs')
    .insert({
      status: 'queued',
      salesperson: repGiven || null,
      // The uploader's own staff id (see resolveScanUploaderStaffId) so the
      // headless create attributes the SO to whoever scanned it. The queue
      // consumer + reaper both replay this column as the create identity.
      salesperson_id: uploaderStaffId,
      houzs_user_id: houzsUserId,
      image_keys: [],
      // company_id is NOT NULL since 0083; an unstamped insert 500s (prod
      // incident 2026-07-13). 0091 adds a HOUZS default as the safety net.
      company_id: activeCompanyId(c),
    })
    .select('id')
    .single();
  const jobId = (jobRow as { id?: string } | null)?.id ?? null;
  if (jobErr || !jobId) {
    if (jobErr && isMissingTable(jobErr)) {
      // Plain-language rule: the migration instruction (SCAN_JOBS_MISSING_MSG)
      // is internal — log it, tell the operator scanning isn't set up here.
      console.error('[scan-so enqueue]', SCAN_JOBS_MISSING_MSG);
      return c.json(
        { error: 'table_missing', reason: 'Scanning is not set up on the server yet. Please enter this order manually.' },
        503,
      );
    }
    console.error('[scan-so enqueue] job insert failed:', jobErr?.message);
    return c.json({ error: 'enqueue_failed', reason: 'Could not queue the scan. Please try again.' }, 500);
  }

  // 2) Persist the uploaded photos to R2 (durability/audit) BEFORE responding
  //    — small puts, still fast. Best-effort: the pipeline runs off the
  //    in-memory buffers, so a failed put never blocks the job.
  const imageKeys: string[] = [];
  if (c.env.SO_ITEM_PHOTOS) {
    for (let i = 0; i < allFiles.length; i += 1) {
      const key = `scan-jobs/${jobId}/${i}`;
      try {
        await c.env.SO_ITEM_PHOTOS.put(key, allFiles[i].buffer, {
          httpMetadata: { contentType: allFiles[i].mime },
        });
        imageKeys.push(key);
      } catch (e) {
        console.warn('[scan-so enqueue] R2 put failed:', key, (e as Error).message);
      }
    }
    if (imageKeys.length > 0) {
      await svc
        .from('scan_jobs')
        .update({ image_keys: imageKeys, updated_at: new Date().toISOString() })
        .eq('id', jobId);
    }
  }

  // 3) Hand the job to the Cloudflare Queue. The consumer (index.ts `queue()`)
  //    rebuilds EVERYTHING from the scan_jobs row + R2 photos, so the message
  //    carries only the job id. A queue-owned attempt survives a mid-run deploy
  //    / isolate eviction (retried up to max_retries, then DLQ) — the whole
  //    reason we moved off waitUntil, which Cloudflare evicts on the 60-110s
  //    real-slip OCR calls, leaving jobs stuck 'running' forever.
  //
  //    FALLBACK: if SCAN_QUEUE is unbound (older deploy / test runtime), run the
  //    pipeline in waitUntil exactly as before so nothing regresses.
  if (c.env.SCAN_QUEUE) {
    try {
      await c.env.SCAN_QUEUE.send({ jobId });
    } catch (e) {
      // Send failed AFTER the row + photos are durable — the reaper will pick
      // the job up (stale queued → one re-run). Log and still 202 so the phone
      // shows a queued job it can poll.
      console.error('[scan-so enqueue] SCAN_QUEUE.send failed:', jobId, (e as Error).message);
    }
  } else {
    const pipeline = runScanJob(c.env, {
      id: jobId,
      salesperson: repGiven,
      salespersonId: uploaderStaffId,
      salespersonName,
      houzsUserId,
      companyId: activeCompanyId(c) ?? null,
      fileBlocks,
      uploadedImages,
      firstBuffer,
      imageKeys,
    });
    try {
      c.executionCtx.waitUntil(pipeline);
    } catch {
      /* non-Workers runtime (tests) — let the floating promise run */
    }
  }

  return c.json({ job_id: jobId, status: 'queued' }, 202);
});

// ---------------------------------------------------------------------------
// Stale-job reaper — a scan job stuck in queued/running for >3 minutes is
// dead (isolate evicted / Worker DEPLOY killed the waitUntil, pipeline crashed
// without reaching its own error-update). Deploys are the common cause, so a
// stale job is NOT errored on first sight: it gets ONE automatic re-run
// (retry_count 0 → 1, migration 0070) rebuilt from the R2 photo copies the
// enqueue path already persisted (scan-jobs/{jobId}/{n}, image_keys on the
// row). Only a job whose single retry is spent (retry_count >= 1) — or whose
// photos never made it to R2 — is flipped to the terminal error.
//
// Staleness clock = updated_at (NOT created_at): the retry claim stamps
// updated_at = now, giving the re-run its own fresh 3-minute window instead
// of being re-reaped on the next poll. (First attempts are equivalent either
// way — a job's updated_at only moves when the pipeline is actually alive.)
//
// Piggybacked on the two poll endpoints (no cron on this worker); the re-run
// itself rides the poll's executionCtx.waitUntil. Fail-soft — a reaper error
// must never break the poll itself. The claim update is conditional
// (retry_count = 0 AND still queued/running), so two concurrent polls can
// never double-run one job.
// ---------------------------------------------------------------------------
// 3 min (was 10): /extract carries a 110s AbortSignal.timeout, so a job still
// queued/running past 3 minutes is a deploy/isolate-killed zombie, not a
// slow-but-alive call — safe to retry (first pass) / error (terminal pass) at
// 3 min. Both the RETRY-claim pass and the TERMINAL pass derive their cutoff
// from this one constant, so this single change tightens both.
const SCAN_JOB_STALE_MINUTES = 3;
const STALE_JOB_ERROR = 'The scan took too long and was stopped. Please scan this slip again.';

// Rebuild runScanJob's file inputs from the durable R2 copies — the inverse of
// parseScanFiles for a retry (the original in-memory buffers died with the
// isolate). Block order matches upload order because image_keys was appended
// in file order; the stored contentType decides image vs document block, same
// mapping as parseScanFiles. Returns null (caller errors the job) if the
// bucket is unbound or ANY key is missing.
async function loadScanJobFilesFromR2(
  bucket: Env['SO_ITEM_PHOTOS'] | undefined,
  keys: string[],
): Promise<{
  fileBlocks: ContentBlock[];
  uploadedImages: UploadedImage[];
  firstBuffer: ArrayBuffer | null;
} | null> {
  if (!bucket || keys.length === 0) return null;
  const fileBlocks: ContentBlock[] = [];
  const uploadedImages: UploadedImage[] = [];
  let firstBuffer: ArrayBuffer | null = null;
  let blockIndex = 0;
  for (const key of keys) {
    const obj = await bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    if (!firstBuffer) firstBuffer = buf;
    const mime = obj.httpMetadata?.contentType || 'image/jpeg';
    const data = toBase64(buf);
    if (mime === 'application/pdf') {
      fileBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      });
    } else {
      uploadedImages.push({ index: blockIndex, buffer: buf, mime });
      fileBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data },
      });
    }
    blockIndex += 1;
  }
  return { fileBlocks, uploadedImages, firstBuffer };
}

// ---------------------------------------------------------------------------
// Cloudflare Queue consumer entry point (called from index.ts `queue()`). The
// message carries ONLY { jobId } — everything else is rebuilt from the durable
// scan_jobs row + the R2 photo copies the enqueue path persisted. This is the
// reliable replacement for the old waitUntil pipeline: a queue-owned attempt
// survives isolate eviction (Cloudflare retries up to max_retries, then DLQ).
//
// IDEMPOTENCY: a queue redelivery must NOT create a second draft. If the row is
// already status='done' (the pipeline finished and wrote so_doc_no), return
// without re-running so the caller acks. A missing row also acks (nothing to
// do). Any other status re-runs runScanJob, whose own status writes stand — a
// job stuck 'running' from an evicted attempt is safe to replay because the
// draft-create only happened at the very end (a mid-run eviction means no draft
// was written). runScanJob is otherwise unchanged from the enqueue path.
export async function processScanQueueMessage(env: Env, jobId: string): Promise<void> {
  const id = String(jobId ?? '');
  if (!id) return;
  const svc = serviceClient(env);

  const { data: row, error } = await svc
    .from('scan_jobs')
    .select('id, status, salesperson, salesperson_id, houzs_user_id, image_keys, company_id')
    .eq('id', id)
    .single();
  if (error) {
    // Missing row (deleted / never inserted) — ack, nothing to run. Any other
    // read error: throw so the message retries (transient DB blip).
    if ((error as { code?: string }).code === 'PGRST116') {
      console.warn('[scan-queue] job row not found, acking:', id);
      return;
    }
    throw new Error(`scan_jobs read failed for ${id}: ${error.message}`);
  }

  const r = row as Record<string, unknown>;
  const status = typeof r.status === 'string' ? r.status : '';
  // IDEMPOTENT ACK — the draft already exists; a redelivery must not make a 2nd.
  if (status === 'done') {
    console.warn('[scan-queue] job already done, skipping:', id);
    return;
  }

  // Dual-read both casings (postgres.js / PostgREST camelCases result cols —
  // the #1 recurring result-column bug class).
  const rawKeys = r.imageKeys ?? r.image_keys;
  const imageKeys = Array.isArray(rawKeys) ? rawKeys.map(String) : [];
  const salesperson = typeof r.salesperson === 'string' ? r.salesperson : '';
  const salespersonId = String(r.salespersonId ?? r.salesperson_id ?? '');
  const huRaw = r.houzsUserId ?? r.houzs_user_id;
  const houzsUserId = huRaw != null && Number.isFinite(Number(huRaw)) ? Number(huRaw) : null;
  const coRaw = r.companyId ?? r.company_id;
  const companyId = coRaw != null && Number.isFinite(Number(coRaw)) ? Number(coRaw) : null;

  const files = salespersonId ? await loadScanJobFilesFromR2(env.SO_ITEM_PHOTOS, imageKeys) : null;
  if (!files) {
    // No durable photos (enqueue-time R2 put failed / bucket unbound) or no
    // replayable identity — the job can never run. Terminal error, then ack
    // (retrying would loop to the DLQ for the same unrecoverable reason).
    console.warn('[scan-queue] job not replayable, erroring:', id);
    await svc
      .from('scan_jobs')
      .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: new Date().toISOString() })
      .eq('id', id);
    return;
  }

  await runScanJob(env, {
    id,
    salesperson,
    // The enqueue-time user_metadata name is not on the row; the normalized rep
    // display name is the closest replay identity (same as the reaper).
    salespersonName: salesperson || null,
    salespersonId,
    houzsUserId,
    companyId,
    fileBlocks: files.fileBlocks,
    uploadedImages: files.uploadedImages,
    firstBuffer: files.firstBuffer,
    imageKeys,
  });
}

async function reapStaleScanJobs(
  env: Env,
  svc: ReturnType<typeof serviceClient>,
  // The calling poll handler's executionCtx.waitUntil (try/catch-wrapped for
  // non-Workers test runtimes) — the retry pipeline must outlive the poll
  // response, exactly like the enqueue path.
  runInBackground: (p: Promise<unknown>) => void,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - SCAN_JOB_STALE_MINUTES * 60 * 1000).toISOString();

    // 1) RETRY pass — stale first-attempt jobs get one re-run. limit(5) bounds
    //    the work a single poll can pick up; anything left is caught by the
    //    next poll (the screen polls every 4s while jobs are active).
    const { data: retryRows, error: retryErr } = await svc
      .from('scan_jobs')
      .select('id, salesperson, salesperson_id, houzs_user_id, image_keys, retry_count, company_id')
      .in('status', ['queued', 'running'])
      .lt('updated_at', cutoff)
      .eq('retry_count', 0)
      .limit(5);
    if (retryErr) {
      // retry_count likely missing (migration 0070 not applied yet) — fall
      // back to the pre-retry blanket reap so stale jobs still terminate
      // instead of spinning forever.
      console.warn('[scan-so jobs] retry pass failed (blanket reap fallback):', retryErr.message);
      await svc
        .from('scan_jobs')
        .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
        .in('status', ['queued', 'running'])
        .lt('updated_at', cutoff);
      return;
    }

    for (const r of (retryRows ?? []) as Array<Record<string, unknown>>) {
      const id = String(r.id ?? '');
      if (!id) continue;
      // CLAIM — conditional update; under concurrent polls Postgres row
      // locking makes exactly one caller see a non-empty result.
      const { data: claimed, error: claimErr } = await svc
        .from('scan_jobs')
        .update({ status: 'queued', retry_count: 1, updated_at: nowIso })
        .eq('id', id)
        .eq('retry_count', 0)
        .in('status', ['queued', 'running'])
        .select('id');
      if (claimErr || !claimed || claimed.length === 0) continue;

      // Dual-read both casings (the #1 recurring result-column bug class).
      const rawKeys = r.imageKeys ?? r.image_keys;
      const imageKeys = Array.isArray(rawKeys) ? rawKeys.map(String) : [];
      const salesperson = typeof r.salesperson === 'string' ? r.salesperson : '';
      const salespersonId = String(r.salespersonId ?? r.salesperson_id ?? '');
      const huRaw = r.houzsUserId ?? r.houzs_user_id;
      const houzsUserId = huRaw != null && Number.isFinite(Number(huRaw)) ? Number(huRaw) : null;
      const coRaw = r.companyId ?? r.company_id;
      const companyId = coRaw != null && Number.isFinite(Number(coRaw)) ? Number(coRaw) : null;

      // Heavy part (R2 reads + the whole pipeline) runs AFTER the poll
      // responds — never inline in the GET.
      runInBackground((async () => {
        const files = salespersonId ? await loadScanJobFilesFromR2(env.SO_ITEM_PHOTOS, imageKeys) : null;
        if (!files) {
          // No durable photos (enqueue-time R2 put failed / bucket unbound) or
          // no replayable identity — the retry cannot run; terminal error now.
          console.warn('[scan-so jobs] retry not replayable, erroring:', id);
          await svc
            .from('scan_jobs')
            .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: new Date().toISOString() })
            .eq('id', id);
          return;
        }
        console.warn('[scan-so jobs] re-running stale job (retry 1/1):', id);
        await runScanJob(env, {
          id,
          salesperson,
          salespersonId,
          // The enqueue-time user_metadata name is not on the row; the
          // normalized rep display name is the closest replay identity.
          salespersonName: salesperson || null,
          houzsUserId,
          companyId,
          fileBlocks: files.fileBlocks,
          uploadedImages: files.uploadedImages,
          firstBuffer: files.firstBuffer,
          imageKeys,
        });
      })());
    }

    // 2) TERMINAL pass — stale jobs whose single retry is already spent.
    await svc
      .from('scan_jobs')
      .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
      .in('status', ['queued', 'running'])
      .lt('updated_at', cutoff)
      .gte('retry_count', 1);
  } catch (e) {
    console.warn('[scan-so jobs] stale-job reaper failed:', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// GET /scan-so/jobs?salesperson= — latest 20 jobs, optionally one rep's
// (normalized + case-insensitive match, same pool rule as the samples).
// ---------------------------------------------------------------------------
scanSo.get('/jobs', async (c) => {
  const rep = normalizeRepKey(c.req.query('salesperson'));
  const svc = serviceClient(c.env);
  await reapStaleScanJobs(c.env, svc, (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      /* non-Workers runtime (tests) — let the floating promise run */
    }
  });
  let q = svc
    .from('scan_jobs')
    .select('id, status, salesperson, so_doc_no, error, sample_id, duplicate_of, image_keys, created_at, updated_at')
    .eq('company_id', activeCompanyId(c))
    .order('created_at', { ascending: false })
    .limit(20);
  if (rep) q = q.ilike('salesperson', ilikeExact(rep));
  const { data, error } = await q;
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load scan jobs. Please try again.' }, 500);
  }
  const jobs = ((data as Array<Record<string, unknown>> | null) ?? []).map(jobToJson);
  return c.json({ success: true, data: { jobs } });
});

// ---------------------------------------------------------------------------
// GET /scan-so/jobs/:id — poll one job (status / soDocNo / error).
// ---------------------------------------------------------------------------
scanSo.get('/jobs/:id', async (c) => {
  const id = (c.req.param('id') ?? '').trim();
  if (!id) return c.json({ error: 'bad_request', reason: 'Missing job id.' }, 400);
  const svc = serviceClient(c.env);
  await reapStaleScanJobs(c.env, svc, (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      /* non-Workers runtime (tests) — let the floating promise run */
    }
  });
  const { data, error } = await svc
    .from('scan_jobs')
    .select('id, status, salesperson, so_doc_no, error, sample_id, duplicate_of, image_keys, created_at, updated_at')
    .eq('id', id)
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load the scan job. Please try again.' }, 500);
  }
  if (!data) return c.json({ error: 'not_found', reason: 'Scan job not found.' }, 404);
  return c.json({ success: true, data: { job: jobToJson(data as Record<string, unknown>) } });
});

// ---------------------------------------------------------------------------
// POST /scan-so/jobs/clear-failed — the mobile "Clear" button on Recent scans.
// Deletes terminal status='error' rows (sticky failure cards the rep has read
// and dealt with). SELF-SCOPED: a normal caller only clears rows whose
// salesperson matches their OWN normalized name (the same identity the mobile
// screen scopes its list with — auth.ts stamps user_metadata.name = real name
// ?? email, mirroring the frontend's user.name || user.email); a wildcard-'*'
// caller (owner/admin, checked against houzsUser — NEVER scm.staff.role,
// which is the pinned system row) clears every rep's failed rows. Done rows
// carrying a warning note / duplicateOf are NOT touched — they point at a
// real SO. No in-app confirm needed client-side: plain cleanup of already
// terminal rows; nothing about the drafts themselves changes.
// ---------------------------------------------------------------------------
scanSo.post('/jobs/clear-failed', async (c) => {
  const svc = serviceClient(c.env);
  const houzsUser = c.get('houzsUser');
  const clearsAll =
    houzsUser?.permissions_set?.has('*') || houzsUser?.permissions?.includes('*') || false;
  const caller = normalizeRepKey(
    (c.get('user').user_metadata as { name?: string } | undefined)?.name,
  );
  if (!clearsAll && !caller) {
    return c.json(
      { error: 'bad_request', reason: 'Could not work out which salesperson you are.' },
      400,
    );
  }
  let q = svc.from('scan_jobs').delete().eq('status', 'error').eq('company_id', activeCompanyId(c));
  if (!clearsAll) q = q.ilike('salesperson', ilikeExact(caller));
  const { error } = await q;
  if (error) {
    if (isMissingTable(error)) {
      return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    }
    console.error('[scan-so jobs] clear-failed failed:', error.message);
    return c.json(
      { error: 'delete_failed', reason: 'Could not clear the failed scans. Please try again.' },
      500,
    );
  }
  return c.json({ success: true });
});

// ===========================================================================
// POST /scan-so/samples/:id/confirm — store the operator-reviewed JSON.
// Called on save by the form the operator reviewed the scan in; the reviewed
// blob becomes a few-shot example for future extractions.
//
// `accepted: true` means the operator changed NOTHING — the blob is the AI's
// own reading, confirmed. It lands as ACCEPTED: a positive example for the
// few-shot pool, but deliberately OUT of the diff-mining distill pools (see
// the SAMPLE_* header). Absent/false ⇒ CONFIRMED (operator corrected
// something), which is also what every pre-existing caller means.
// ===========================================================================
scanSo.post('/samples/:id/confirm', async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'bad_request', reason: 'Missing sample id.' }, 400);

  let body: { corrected?: unknown; salesperson?: unknown; accepted?: unknown };
  try {
    body = (await c.req.json()) as { corrected?: unknown; salesperson?: unknown; accepted?: unknown };
  } catch {
    return c.json({ error: 'bad_request', reason: 'Invalid JSON body.' }, 400);
  }
  if (body.corrected === undefined || body.corrected === null) {
    return c.json({ error: 'bad_request', reason: 'Missing `corrected`.' }, 400);
  }
  const acceptedAsIs = body.accepted === true;
  const sampleStatus = acceptedAsIs ? SAMPLE_ACCEPTED : SAMPLE_CORRECTED;
  // Normalized rep key (trim + single-space) — case/whitespace variants must
  // share one learning pool on write, same as /extract's stamp.
  const repGiven = normalizeRepKey(body.salesperson);

  const svc = serviceClient(c.env);
  let q = svc
    .from('so_scan_samples')
    .update({
      corrected: body.corrected,
      status: sampleStatus,
      // Operator-reviewed rep wins over whatever /extract stamped; blank
      // leaves the extract-time value (operator pick or AI detection) alone.
      ...(repGiven ? { salesperson: repGiven } : {}),
    })
    .eq('id', id);
  // No-downgrade: an ACCEPTED write must never bury a sample already CONFIRMED
  // — that would relabel a real correction as "the AI got it right" and drop it
  // out of the distill pool. The reverse (ACCEPTED then later CORRECTED, e.g.
  // the operator saves a draft and edits it on a second pass) is an UPGRADE and
  // rides through.
  if (acceptedAsIs) q = q.neq('status', SAMPLE_CORRECTED);
  const { data: updated, error } = await q.select('id, salesperson');

  if (error) {
    if (isMissingTable(error)) {
      return c.json({ error: 'table_missing', reason: TABLE_MISSING_MSG }, 503);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!updated || updated.length === 0) {
    // Either the sample is gone, or the no-downgrade guard held. The latter is
    // a legitimate no-op, not an error — the correction already on file wins.
    if (acceptedAsIs) return c.json({ success: true, skipped: 'already_corrected' });
    return c.json({ error: 'not_found', reason: 'Sample not found.' }, 404);
  }

  // An accepted-as-is sample carries no diff, so it is NOT in any distill
  // pool — re-distilling here would spend Anthropic calls to regenerate the
  // identical rules from an unchanged pool. It reaches the few-shot pool
  // directly (read live at extract time), so it still takes effect at once.
  if (acceptedAsIs) return c.json({ success: true });

  // Fire-and-forget rule distillation — REGENERATES so_scan_rules for this
  // rep (latest ≤50 of their corrected samples) AND the '__GLOBAL__' shared
  // alias dictionary (latest ≤80 corrected samples across ALL reps). Both
  // cheap-skip (<2 samples) without an API call, so firing on every confirm
  // is safe. Sequential to keep it to one Anthropic call at a time. Never
  // blocks/fails the confirm.
  const rep = repGiven || normalizeRepKey((updated[0] as { salesperson?: string | null }).salesperson);
  const distillCompanyName = (await getBranding(c.env)).companyName;
  const distillPromise = (async () => {
    if (rep && !isGlobalKey(rep)) {
      try {
        const r = await distillSalespersonRules(svc, c.env.ANTHROPIC_API_KEY, rep, distillCompanyName);
        if (r.status === 'error') console.warn(`[scan-so distill] ${rep}: ${r.reason}`);
      } catch (e) {
        console.warn(`[scan-so distill] ${rep} threw:`, (e as Error).message);
      }
    }
    try {
      const g = await distillGlobalAliases(svc, c.env.ANTHROPIC_API_KEY, distillCompanyName);
      if (g.status === 'error') console.warn(`[scan-so distill] __GLOBAL__ aliases: ${g.reason}`);
    } catch (e) {
      console.warn('[scan-so distill] __GLOBAL__ aliases threw:', (e as Error).message);
    }
    // Cross-rep shared RULES — regenerated on every confirm too (cheap-skips
    // <3 samples without an API call) so each rep's correction lifts the
    // shared baseline for everyone. Sequential; never blocks the confirm.
    try {
      const gr = await distillGlobalRules(svc, c.env.ANTHROPIC_API_KEY, distillCompanyName);
      if (gr.status === 'error') console.warn(`[scan-so distill] __GLOBAL_RULES__: ${gr.reason}`);
    } catch (e) {
      console.warn('[scan-so distill] __GLOBAL_RULES__ threw:', (e as Error).message);
    }
  })();
  try {
    c.executionCtx.waitUntil(distillPromise);
  } catch {
    /* non-Workers runtime (tests) — let the floating promise run */
  }

  return c.json({ success: true });
});
