// ---------------------------------------------------------------------------
// /scan-so — Claude-powered OCR for HANDWRITTEN showroom sale-order slips
// (phone photos of Zanotti / AKEMI-style carbon-copy forms) → structured JSON
// the Backend "Scan Order" modal turns into a prefilled New SO.
//
// READ docs/modules/scan-to-so.md FIRST — the endpoint table, the learning loop,
// the rule layers and their injection order, the read-scope gaps, and this
// module's provenance + Houzs `scm`-schema adaptation all live there, kept in
// one place so they cannot drift against a comment nobody re-reads.
//
// The few-shot pool is the 5 most recent operator-REVIEWED so_scan_samples rows,
// filtered to the slip's SALESPERSON first (fall back to global), and RANKED
// corrected-before-accepted-as-is — see the SAMPLE_* header below: both outcomes
// are ground truth here, but only corrected rows carry a diff, so only they feed
// the distillers.
//
// Prompt caching: the SYSTEM_PROMPT + catalog block is sent as a
// cache_control:ephemeral prefix — identical across calls until the catalog
// changes, so repeat scans within 5 min get the ~90% cached-input discount.
//
// Auth: same as mfg-sales-orders write routes — supabaseAuth on every endpoint.
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
import { recordAi, requestAiTag, type AiUsageTag } from '../../services/aiUsage';
import { createDraftSalesOrder, recordSoPaymentRow } from './mfg-sales-orders';
import { todayMyt } from '../lib/my-time';
import { activeCompanyId, scopeToCompany, scopeToCompanyIdOrOpen } from '../lib/companyScope';
import { type ScanDocumentType, DEFAULT_SCAN_DOCUMENT_TYPE, coerceScanDocumentType } from '../lib/scan-document-type';
import { jobToJson } from './scan-so-serialize';
import { normalizePhone, fmtSen } from '../shared';
import { resolveCallerStaffId } from '../lib/salesScope';
import {
  planReceiptPayments,
  installmentPlanToMonths,
  type ExtractedPayment,
} from '../lib/scan-receipt-plan';
import { depositSenAfterReceiptPass, safeScanDepositSen } from '../lib/scan-header-deposit';
import { applySlipTotalToUnpricedLines } from '../lib/scan-slip-total';
import { scanTimer } from '../lib/scan-timing';
import { scanCatalogSkus, scanCatalogCategoryOrder, type CatalogSku, type ScanCatalogRow } from '../lib/scan-catalog-skus';
import { buildScanLineVariants } from '../lib/scan-line-variants';
import { resolveSlipAddress } from '../lib/scan-address-lookup';
import { localityForPostcode } from '../lib/postcode-from-address';
import { hasUnexpectedDigitCount, phoneDigitCountWarnings } from '../lib/scan-phone-check';
import { readSlipWithAliases } from '../lib/scan-field-aliases';
import { snapshotDraftBaseline, LEARNING_POOL_BASELINE_FILTER } from '../lib/scan-sample-review';
import { isDroppedBlankLine } from '../lib/scan-slip-fields';
import { ttlCached } from '../lib/ttl-cache';
import { keepScanFile, linkScanFiles } from '../lib/scan-files';
import { variantNotAllowedSentence } from '../lib/allowed-options-check';
import {
  CLAUDE_MODEL,
  modelRequestFields,
  scanSoModel,
  anthropicFetchWithRetry,
  sha256Hex,
  stripJsonFences,
  parseScanFiles,
  loadScanJobFilesFromR2,
  type AnthropicResponse,
  type ContentBlock,
  type UploadedImage,
} from '../lib/scan-ocr';
import { processGrnScanQueueMessage } from './scan-gr';
import { processPiScanQueueMessage } from './scan-pi';

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const scanSo = new Hono<{ Bindings: Env; Variables: Variables }>();
scanSo.use('*', supabaseAuth);

function normalizeSlipPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return normalizePhone(raw);
}

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
    const city = pick('locality') ?? pick('postal_town') ?? pick('administrative_area_level_2');
    const postcode = pick('postal_code');
    if (!state && !city && !postcode) return null;
    return { state, city, postcode };
  } catch {
    return null;
  }
}

type CatalogFabric = { code: string; description: string | null };
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
  'payment_method',
  'payment_merchant',
  'online_type',
  'installment_plan',
  'customer_type',
  'building_type',
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
  specials: CatalogSpecial[];
  specialsByModelSku: Map<string, Set<string>>;
  totalHeightsByModelSku: Map<string, string[] | null>;
  sofaSizes: string[];
  sofaLegHeights: string[];
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

/* HC-0006 speed: the catalogue is ~10 paginated reads and changes rarely, so one
   isolate keeps it for a minute. Scans in that window skip the reads and reuse
   the same object, which also keeps the cached prompt prefix byte-identical.
   A failed or empty load is not kept. */
const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map<string, { at: number; v: Catalog }>();
function loadCatalog(sb: SupabaseClient, db: D1Database, companyId: number | null): Promise<Catalog> {
  return ttlCached(catalogCache, String(companyId ?? 'all'), CATALOG_TTL_MS, () => loadCatalogFresh(sb, db, companyId),
    (cat) => cat.skus.length > 0 && cat.venues.length > 0);
}
async function loadCatalogFresh(sb: SupabaseClient, db: D1Database, companyId?: number | null): Promise<Catalog> {
  const [prodRes, fabRes, cfgRes, optRes, locRes, spcRes, modRes, venueNames] = await Promise.all([
    paginateAll((from, to) => {
      let q = sb
        .from('mfg_products')
        .select('code, name, category, base_model, model:product_models(active)')
        .eq('status', 'ACTIVE');
      if (companyId != null) q = q.eq('company_id', companyId);
      return q.order('category').order('code').range(from, to);
    }),
    paginateAll((from, to) => sb
      .from('fabric_trackings')
      .select('fabric_code, fabric_description')
      .eq('is_active', true)
      .order('fabric_code')
      .range(from, to)),
    scopeToCompanyIdOrOpen(sb.from('maintenance_config_history').select('config'), companyId)
      .eq('scope', 'master')
      .lte('effective_from', todayMyt())
      .order('effective_from', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    paginateAll((from, to) => sb
      .from('so_dropdown_options')
      .select('category, value, label')
      .eq('active', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true })
      .range(from, to)),
    paginateAll((from, to) => sb
      .from('my_localities')
      .select('state, city, postcode')
      .order('state', { ascending: true })
      .range(from, to)),
    paginateAll((from, to) => sb
      .from('special_addons')
      .select('code, label, so_description, categories')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('code', { ascending: true })
      .range(from, to)),
    paginateAll((from, to) => {
      let q = sb
        .from('product_models')
        .select('model_code, category, allowed_options')
        .in('category', ['SOFA', 'BEDFRAME']);
      if (companyId != null) q = q.eq('company_id', companyId);
      return q.order('model_code').range(from, to);
    }),
    loadVenueNames(db),
  ]);

  const skus = scanCatalogSkus(prodRes.data as ScanCatalogRow[] | null);

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
    if (!cityPool.has(ct.toUpperCase())) cityPool.set(ct.toUpperCase(), ct);
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

  const specialsByModelCode = new Map<string, Set<string>>();
  const totalHeightsByModelCode = new Map<string, string[] | null>();
  for (const row of (modRes.data as Array<Record<string, unknown>> | null) ?? []) {
    const modelCode = (row.modelCode ?? row.model_code) as string | undefined;
    if (!modelCode) continue;
    const opts = (row.allowedOptions ?? row.allowed_options) as
      { specials?: unknown; total_heights?: unknown; totalHeights?: unknown } | null;
    if (row.category === 'BEDFRAME') {
      const pool = opts?.totalHeights ?? opts?.total_heights;
      totalHeightsByModelCode.set(
        modelCode.toUpperCase(),
        Array.isArray(pool) ? pool.filter((v): v is string => typeof v === 'string') : null,
      );
      continue;
    }
    const list = Array.isArray(opts?.specials) ? (opts!.specials as unknown[]) : [];
    const set = new Set<string>();
    for (const v of list) if (typeof v === 'string' && v.trim() !== '') set.add(v.toUpperCase());
    specialsByModelCode.set(modelCode.toUpperCase(), set);
  }
  const specialsByModelSku = new Map<string, Set<string>>();
  for (const s of skus) {
    if (!s.baseModel) continue;
    const allowed = specialsByModelCode.get(s.baseModel.toUpperCase());
    if (allowed) specialsByModelSku.set(s.code.toUpperCase(), allowed);
  }
  const totalHeightsByModelSku = new Map<string, string[] | null>();
  for (const s of skus) {
    if (!s.baseModel) continue;
    const pool = totalHeightsByModelCode.get(s.baseModel.toUpperCase());
    if (pool !== undefined) totalHeightsByModelSku.set(s.code.toUpperCase(), pool);
  }

  return {
    skus, fabrics, specials, specialsByModelSku, totalHeightsByModelSku,
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
  for (const cat of scanCatalogCategoryOrder(c.skus)) {
    const list = byCategory.get(cat);
    if (!list || list.length === 0) continue;
    lines.push(`=== ${cat} SKUS (code | name) ===`);
    for (const s of list) {
      lines.push(`${s.code} | ${s.name}`);
    }
    lines.push('');
  }

  lines.push('=== FABRICS (code | description) ===');
  for (const f of c.fabrics) lines.push(`${f.code} | ${f.description ?? ''}`);
  lines.push('');

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

  lines.push('=== DELIVERY STATES (allowed values) ===');
  lines.push(c.states.join(', ') || '—');
  lines.push('');

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

  lines.push('=== VENUES (allowed values) ===');
  if (c.venues.length === 0) lines.push('—');
  for (const v of c.venues) lines.push(v);
  lines.push('');

  return lines.join('\n').trimEnd();
}

export function buildCachedPrefix(catalog: Catalog, companyName: string): string {
  return `${buildSystemPrompt(companyName)}\n\nCATALOG\n=======\n${formatCatalog(catalog)}`;
}

type WarmResult = { ok: boolean; reason?: string; cacheCreated?: boolean; cacheRead?: boolean };
async function warmCatalogCache(
  sb: SupabaseClient,
  db: D1Database,
  apiKey: string | undefined,
  companyName: string,
  companyId: number | null | undefined,
  usage: AiUsageTag,
): Promise<WarmResult> {
  if (!apiKey) return { ok: false, reason: 'no_key' };
  let catalog: Catalog;
  try {
    catalog = await loadCatalog(sb, db, companyId ?? null);
  } catch (e) {
    return { ok: false, reason: `catalog_load_failed: ${(e as Error).message}` };
  }
  const cachedPrefix = buildCachedPrefix(catalog, companyName);
  try {
    const resp = await recordAi(usage, anthropicFetchWithRetry({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      body: JSON.stringify({
        model: usage.model,
        max_tokens: 1,
        ...modelRequestFields(usage.model),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } },
              { type: 'text', text: 'warm' },
            ],
          },
        ],
      }),
    }));
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

export async function warmCatalogCacheForCron(env: Env): Promise<WarmResult> {
  const branding = await getBranding(env);
  return warmCatalogCache(getSupabaseService(env), env.DB, env.ANTHROPIC_API_KEY, branding.companyName, null,
    { env, feature: 'cache_warm', model: scanSoModel(env), companyId: null, userId: null, waitUntil: null });
}

const buildSystemPrompt = (companyName: string) => `You extract structured data from photos of HANDWRITTEN showroom sale-order slips at ${companyName}, a Malaysian furniture retailer. The slips are carbon-copy order forms (Zanotti / AKEMI style): a printed header block (customer name, contact, address, delivery date) filled in by hand, a handwritten line-item table (description, qty, price), and a footer with totals, deposit, payment method, and the salesperson's name.

The handwriting is often rushed, slanted, abbreviated, and mixed-case. Phone photos may be skewed, shadowed, or low-contrast. Read carefully; prefer extracting a raw transcription over guessing.

AMBIGUITY — FLAG, DO NOT GUESS. When a field is genuinely ambiguous (two equally-plausible readings, a smudged or half-formed digit, an unclear size, a model that could be one of several), do NOT pick one at random and report it confidently. Return your single best guess at a LOWER confidence (below 0.6) and state the ambiguity in that field's "reason" (and/or the line's "notes") so the operator reviews it. A flagged ambiguity the operator catches beats a confident wrong value that survives review — wrong-but-confident is the value that slips through unchecked.

NUMBERS — read the FULL numeric token; never truncate a multi-digit number to its first digit. A digit immediately followed by another digit (before any non-digit) is ONE multi-digit number: "12" is 12 (NEVER 1), "RM1,250" is 1250, "x10" is qty 10 (NEVER 1). The inch / quote mark (" or ') and trailing unit words ("ft", "pcs", "mm") are unit/spec text, NOT digit separators — do not let them split or truncate the number.

MULTIPLE IMAGES
===============
You may receive ONE HANDWRITTEN order slip (a carbon-copy form with the customer, line items, handwriting, and payment checkboxes) and ZERO, ONE, OR MORE PRINTED card-terminal payment RECEIPTS (each a thermal print: a bank name e.g. Maybank / Public Bank / CIMB, VISA / Mastercard, an APPROVAL CODE, a TOTAL amount, and often a TENURE / number of months for an EPP plan). One order can be paid across SEVERAL receipts (a deposit now + a balance, or split across two card terminals) — treat EACH printed receipt as ONE separate payment. Decide what each input image is:
- Read the ORDER fields (customerName, address, phones, line items, deliveryDate, slipDate, salesRep) from the HANDWRITTEN slip.
- Read the PAYMENT fields (paymentMethodMatch / bankMatch / installmentPlanMatch / approvalCode / depositRm or the receipt's amount) PREFERENTIALLY from a PRINTED receipt when one is present — the printed thermal receipt is far more accurate than the handwritten payment note. Still keep the handwritten payment note verbatim in paymentMethod. When NO receipt is present, fall back to the handwritten slip's payment note exactly as before. When a receipt and the handwriting DISAGREE (a different bank, a different amount, a different approval code), the PRINTED receipt wins for the structured fields — but you MUST state the disagreement in that field's reason (e.g. "slip writes PBB but receipt terminal is Maybank — using receipt") so the operator sees the conflict.
- The SINGULAR payment fields (paymentMethodMatch / bankMatch / installmentPlanMatch / approvalCode / depositRm) describe the PRIMARY (first) receipt, exactly as before. In ADDITION, emit the OUTPUT "payments" array with ONE entry PER payment-receipt image (see below) — each entry carries THAT receipt's own amount, bank, method, tenure, approval code and transaction date. When there is exactly one receipt, "payments" has one entry that matches the singular fields. When there is no receipt, "payments" is [].
You MUST also classify every input image in the OUTPUT "images" array (see below).

A reference CATALOG follows this prompt (live product SKUs, fabrics, sofa sizes, leg heights). It is the FULL master (≈1100+ SKUs) — every catalog row is "code | name". Use it for AGGRESSIVE fuzzy / keyword / substring / abbreviation matching: a slip token should resolve to the SKU whose NAME contains that token's keyword, even when the rep wrote only a fragment. Search the WHOLE catalog before giving up.

EXTRACTION RULES
================
1. customerName — the customer's name from the header block (NOT the salesperson).
2. address — full delivery address as one string, exactly as written (keep unit numbers, taman names, postcode, state). ALSO break the same address into its parts (see ADDRESS PARTS below) so the form can fill State / City / Postcode.
3. phones — ALL phone numbers on the slip, as raw strings exactly as written (e.g. "012-345 6789", "+6017 888 9999"). Multiple numbers are common (customer + spouse). Do NOT normalize or reformat. A phone is CRITICAL — transcribe EVERY digit, including REPEATED / doubled digits: read "01137166720" as 0-1-1-3-7-1-6-6-7-2-0 (eleven digits), NEVER collapse a doubled "66" into a single "6". A Malaysian number is 10-11 digits INCLUDING the leading trunk 0 (011-XXXX XXXX = 11 digits; 01X-XXX XXXX = 10). If your reading has FEWER than 10 digits, you almost certainly dropped or merged a digit — re-examine the handwriting (look for a doubled digit) before returning it. If a single digit is genuinely unclear, return your best reading at confidence < 0.6 and say so in the field's reason so the operator double-checks.
4. location — the showroom / venue / branch the order was taken at, if written (often a header checkbox or stamp).
5. deliveryDate — as written. If it is a real date, convert to YYYY-MM-DD (slips write DD/MM or DD/MM/YYYY — Malaysian day-first). If it says "TBC", "call first", "after CNY" or any non-date text, return that text verbatim.
6. slipDate — THE DATE WRITTEN ON THE SLIP ITSELF (the day the rep wrote the order), if present. This is the slip's own date and NOTHING else: it is NOT a delivery date, and it is NOT any internal factory / processing schedule date. YYYY-MM-DD when parseable, else verbatim text, else null. The year is often omitted or scrawled: when the year is missing/unreadable, take it from the PRINTED payment receipt's date when one is present, else assume the CURRENT year — NEVER invent a distant past year (a slip is days old, not years). If even the day/month is unclear, return the verbatim text instead of a made-up date.
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
- SPEC NOTES BESIDE OR BETWEEN ROWS — a BEDFRAME spec note written in the margin, to the right of the table, or squeezed between two rows (e.g. "no leg", "divan 12", "gap 14", "+4") belongs to the nearest BEDFRAME row ABOVE it, never to a pillow, mattress, protector or other accessory row. Put its numbers on that bedframe line (rawSpec, divanHeightInches / legHeightInches / gapInches / noLeg), not on the row printed next to it.
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

- payments — ONE entry PER payment-receipt IMAGE, in image order, each describing THAT receipt on its OWN. imageIndex = the receipt image's "index" (the SAME index used in "images"). amountRm = the money charged on THAT receipt (its printed TOTAL / AMOUNT), as a NUMBER, null when unreadable. approvalCode / receiptTxnDate = that receipt's own approval code and its OWN PRINTED TRANSACTION DATE (the date the card terminal printed on THAT receipt — not the slip's date, and not any internal factory / processing schedule date). paymentMethodMatch / bankMatch / onlineTypeMatch / installmentPlanMatch = that receipt's own option matches, resolved with the SAME rules and ALLOWED VALUES lists as the singular fields above (a card terminal → Merchant + its bank; a tenure line → the N-month plan, else One Shot). Do NOT sum or merge receipts: two RM 2,000 receipts are two entries of amountRm = 2000, never one of 4000. Every entry's imageIndex MUST be one of the images you classified as "payment_receipt"; NEVER emit a payments entry for the order-slip image. When there is no payment receipt, payments = [].
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
  "slipDate": string | null,
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
    "receiptTxnDate": string | null,
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

type SkuMatch = { code: string; confidence: number; reason: string };
type OptionMatch = { value: string; confidence: number; reason: string };
type ImageKind = 'order_slip' | 'payment_receipt';
type ImageClass = { index: number; kind: ImageKind };
type ExtractedLine = {
  rawText: string;
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
  seatHeightInches: number | null;
  qtyGuess: number;
  priceRmGuess: number | null;
  skuMatch: SkuMatch | null;
  fabricMatch: SkuMatch | null;
  specialsMatch: SkuMatch[];
  notes: string | null;
};
type ExtractedSlip = {
  customerName: string | null;
  address: string | null;
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  addressStateMatch: OptionMatch | null;
  phones: string[];
  location: string | null;
  deliveryDate: string | null;
  slipDate: string | null;
  salesRep: string | null;
  customerSoRef: string | null;
  paymentMethod: string | null;
  depositRm: number | null;
  totalRm: number | null;
  remarks: string | null;
  approvalCode: string | null;
  paymentMethodMatch: OptionMatch | null;
  bankMatch: OptionMatch | null;
  onlineTypeMatch: OptionMatch | null;
  installmentPlanMatch: OptionMatch | null;
  customerTypeMatch: OptionMatch | null;
  buildingTypeMatch: OptionMatch | null;
  locationMatch: OptionMatch | null;
  images: ImageClass[];
  payments: ExtractedPayment[];
  lines: ExtractedLine[];
};

type Warning = { field: string; value: string; message: string; lineIdx?: number };

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
          specialsMatch: Array.isArray(li.specialsMatch)
            ? (li.specialsMatch as unknown[])
                .map((s) => match(s))
                .filter((s): s is SkuMatch => s !== null)
            : [],
          notes: str(li.notes),
        };
      })
    : [];
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
            receiptTxnDate: str(o.receiptTxnDate) ?? str(o.processingDate),
            paymentMethodValue: optionValueOf(o.paymentMethodMatch),
            bankValue: optionValueOf(o.bankMatch),
            onlineTypeValue: optionValueOf(o.onlineTypeMatch),
            installmentPlanValue: optionValueOf(o.installmentPlanMatch),
          } satisfies ExtractedPayment;
        })
        .filter((p): p is ExtractedPayment => p !== null)
    : [];
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
    slipDate: str(r.slipDate) ?? str(r.processingDate),
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

function reparseSpec(line: ExtractedLine): void {
  if (!line.rawSpec) return;
  const spec = line.rawSpec;

  const noLegRe = /\b(no\s*leg(?:s)?|noleg(?:s)?)\b/i;
  const noLegMatch = noLegRe.test(spec);

  const divanRe = /(?:divan|drawer)[\s:.-]*(\d+(?:\.\d+)?)/i;
  const divanMatch = spec.match(divanRe);

  let legMatch: RegExpMatchArray | null = null;
  if (!noLegMatch) {
    legMatch =
      spec.match(/\+\s*(\d+(?:\.\d+)?)\s*(?:"|inch|in|leg)/i) ??
      spec.match(/(\d+(?:\.\d+)?)\s*"?\s*leg/i);
  }

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

function normalizeForMatch(s: string): string {
  return s
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((seg) => seg.replace(/(?:^|(?<=\D))0+(?=\d)/g, ''))
    .join('');
}

function validateSlip(slip: ExtractedSlip, catalog: Catalog): Warning[] {
  const warnings: Warning[] = [];
  const skuCanon = new Map(catalog.skus.map((s) => [s.code.toUpperCase(), s.code]));
  const fabricCanon = new Map(catalog.fabrics.map((f) => [f.code.toUpperCase(), f.code]));
  const specialCanon = new Map(catalog.specials.map((s) => [s.code.toUpperCase(), s.code]));
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
  const categoryByCode = new Map(catalog.skus.map((s) => [s.code.toUpperCase(), s.category]));

  slip.lines.forEach((line, i) => {
    if (line.skuMatch) {
      const upper = line.skuMatch.code.toUpperCase();
      let canon = skuCanon.get(upper);
      if (!canon) {
        const dropOne = upper.replace(/-1([A-Z])/, '-$1');
        if (dropOne !== upper) canon = skuCanon.get(dropOne);
      }
      if (!canon) {
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
    {
      const cat = line.skuMatch ? categoryByCode.get(line.skuMatch.code.toUpperCase()) ?? '' : '';
      if (cat !== 'SOFA' && cat !== 'ACCESSORY') reparseSpec(line);
    }
    if (line.fabricMatch) {
      const upper = line.fabricMatch.code.toUpperCase();
      let canon = fabricCanon.get(upper);
      if (!canon) canon = fabricCanonByNorm.get(normalizeForMatch(line.fabricMatch.code));
      if (canon) {
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

function serviceClient(env: Env): SupabaseClient {
  return getSupabaseService(env);
}

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return (
    err?.code === '42P01' ||
    err?.code === 'PGRST205' ||
    /so_scan_samples.*does not exist|relation .* does not exist|could not find the table/i.test(err?.message ?? '')
  );
}

const TABLE_MISSING_MSG =
  'scan-so tables missing — apply src/db/migrations-pg/0023_so_scan_samples.sql to this database.';

const SAMPLE_CORRECTED = 'CONFIRMED';
const SAMPLE_ACCEPTED = 'ACCEPTED';


function ilikeExact(v: string): string {
  return v.replace(/([\\%_])/g, '\\$1');
}

function normalizeRepKey(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
}

const GLOBAL_ALIAS_KEY = '__GLOBAL__';
const GLOBAL_RULES_KEY = '__GLOBAL_RULES__';
const GLOBAL_MANUAL_KEY = '__GLOBAL_MANUAL__';
const isGlobalKey = (v: string): boolean => {
  const k = v.trim().toUpperCase();
  return k === GLOBAL_ALIAS_KEY || k === GLOBAL_RULES_KEY || k === GLOBAL_MANUAL_KEY;
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

async function claudeDistillCall(
  apiKey: string,
  system: string,
  userPayload: string,
  usage: AiUsageTag,
): Promise<{ text: string; error: string | null }> {
  try {
    const resp = await recordAi(usage, anthropicFetchWithRetry({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPayload }] }],
      }),
    }));
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
    let cleaned = firstText.trim();
    const m = cleaned.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (m?.[1]) cleaned = m[1].trim();
    return { text: cleaned, error: null };
  } catch (e) {
    return { text: '', error: `Network/fetch error: ${(e as Error).message}` };
  }
}

async function distillSalespersonRules(
  svc: SupabaseClient,
  apiKey: string | undefined,
  salesperson: string,
  companyName: string,
  usage: AiUsageTag,
): Promise<DistillResult> {
  const rep = normalizeRepKey(salesperson);
  if (!rep) return { status: 'error', reason: 'Missing salesperson.' };
  if (rep.toUpperCase() === GLOBAL_RULES_KEY) return distillGlobalRules(svc, apiKey, companyName, usage);
  if (isGlobalKey(rep)) return distillGlobalAliases(svc, apiKey, companyName, usage);
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .eq('status', SAMPLE_CORRECTED)
    .or(LEARNING_POOL_BASELINE_FILTER)
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

  const call = await claudeDistillCall(apiKey, buildDistillMetaPrompt(companyName), userPayload, usage);
  let distilledText = call.text;
  const errorMsg = call.error;

  if (errorMsg || !distilledText) {
    return { status: 'error', reason: errorMsg ?? 'Claude returned empty rules.' };
  }
  if (distilledText.length > 32_000) distilledText = distilledText.slice(0, 32_000);

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

async function distillGlobalAliases(
  svc: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
  usage: AiUsageTag,
): Promise<DistillResult> {
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .eq('status', SAMPLE_CORRECTED)
    .or(LEARNING_POOL_BASELINE_FILTER)
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

  const call = await claudeDistillCall(apiKey, buildGlobalAliasMetaPrompt(companyName), userPayload, usage);
  let distilledText = call.text;
  if (call.error || !distilledText) {
    return { status: 'error', reason: call.error ?? 'Claude returned empty aliases.' };
  }
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

async function distillGlobalRules(
  svc: SupabaseClient,
  apiKey: string | undefined,
  companyName: string,
  usage: AiUsageTag,
): Promise<DistillResult> {
  if (!apiKey) {
    return {
      status: 'error',
      reason: 'ANTHROPIC_API_KEY not configured. Run: npx wrangler secret put ANTHROPIC_API_KEY',
    };
  }

  const { data: rows, error: selErr } = await svc
    .from('so_scan_samples')
    .select('extracted, corrected')
    .not('corrected', 'is', null)
    .eq('status', SAMPLE_CORRECTED)
    .or(LEARNING_POOL_BASELINE_FILTER)
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

  const call = await claudeDistillCall(apiKey, buildGlobalRulesMetaPrompt(companyName), userPayload, usage);
  let distilledText = call.text;
  if (call.error || !distilledText) {
    return { status: 'error', reason: call.error ?? 'Claude returned empty shared rules.' };
  }
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
  usage: AiUsageTag,
): Promise<{ distilled: number; skipped: number; errors: number; reps: number }> {
  const summary = { distilled: 0, skipped: 0, errors: 0, reps: 0 };

  try {
    const g = await distillGlobalAliases(svc, apiKey, companyName, usage);
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

  try {
    const gr = await distillGlobalRules(svc, apiKey, companyName, usage);
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

  const { data, error } = await paginateAll((from, to) => svc
    .from('so_scan_samples')
    .select('salesperson')
    .not('corrected', 'is', null)
    .eq('status', SAMPLE_CORRECTED)
    .or(LEARNING_POOL_BASELINE_FILTER)
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
      const res = await distillSalespersonRules(svc, apiKey, rep, companyName, usage);
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

scanSo.get('/salespeople', async (c) => {
  const svc = serviceClient(c.env);
  const seen = new Map<string, string>();
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
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
  }
  const salespeople = Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  return c.json({ success: true, data: { salespeople } });
});

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

scanSo.post('/rules/:salesperson/distill', async (c) => {
  const rep = normalizeRepKey(c.req.param('salesperson'));
  if (!rep) return c.json({ error: 'bad_request', reason: 'Missing salesperson.' }, 400);
  const branding = await getBranding(c.env);
  const res = await distillSalespersonRules(serviceClient(c.env), c.env.ANTHROPIC_API_KEY, rep, branding.companyName, requestAiTag(c, 'scan_so_distill', CLAUDE_MODEL));
  if (res.status === 'error') {
    return c.json({ error: 'distill_failed', reason: res.reason }, 500);
  }
  return c.json({ success: true, data: res });
});

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
      'cache-control': 'private, max-age=3600',
    },
  });
});

scanSo.post('/warm', async (c) => {
  const sb = c.get('supabase');
  const branding = await getBranding(c.env);
  const result = await warmCatalogCache(sb, c.env.DB, c.env.ANTHROPIC_API_KEY, branding.companyName, activeCompanyId(c), requestAiTag(c, 'cache_warm', scanSoModel(c.env)));
  return c.json(result);
});

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
  }

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
  }

  try {
    const { data: gmRow } = await svc
      .from('so_scan_rules')
      .select('rules')
      .eq('salesperson', GLOBAL_MANUAL_KEY)
      .limit(1)
      .maybeSingle();
    const gm = gmRow as { rules: string } | null;
    if (gm && gm.rules.trim() !== '') {
      const gap = globalRulesText ? `${globalRulesText}\n\n` : '';
      globalRulesText =
        `${gap}HOW TO READ THE DRAWING ON A SLIP (hand-written, authored by the owner — ` +
        `reading techniques, not distilled patterns; they never override the catalog ` +
        `or the never-invent-codes rule):\n\n` +
        gm.rules;
      globalRulesApplied = true;
    }
  } catch {
  }

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
    }
  }

  let fewShotText = '';
  try {
    type FewShotRow = { id: string; corrected: unknown; status: string | null };
    const picked: Array<{ corrected: unknown; mine: boolean; gold: boolean }> = [];
    const pickedIds = new Set<string>();
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
  }

  return {
    globalAliasText, globalAliasApplied,
    globalRulesText, globalRulesApplied,
    repRulesText, repRulesMeta,
    fewShotText,
  };
}

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
  usage: AiUsageTag,
): Promise<SlipExtractCall> {
  let errorMsg: string | null = null;
  let timedOut = false;
  let parsed: ExtractedSlip | null = null;
  let claudeText = '';
  let cacheHit = false;
  let cacheCreated = false;

  try {
    const resp = await recordAi(usage, anthropicFetchWithRetry({
      method: 'POST',
      signal: AbortSignal.timeout(110_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      },
      body: JSON.stringify({
        model: usage.model,
        max_tokens: 8192,
        ...modelRequestFields(usage.model),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } },
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
    }));

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
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      timedOut = true;
      errorMsg = 'OCR timed out — the slip took too long to read. Please try again.';
    } else {
      errorMsg = `Network/fetch error: ${(e as Error).message}`;
    }
  }

  return { parsed, errorMsg, timedOut, claudeText, cacheHit, cacheCreated };
}

async function insertScanSample(
  svc: SupabaseClient,
  args: {
    imageSha256: string | null;
    salesperson: string | null;
    parsed: ExtractedSlip | null;
    errorMsg: string | null;
    claudeText: string;
    documentType: ScanDocumentType;
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
        document_type: args.documentType,
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

async function storeScanImages(
  bucket: R2Bucket | undefined,
  svc: SupabaseClient,
  sampleId: string | null,
  uploadedImages: UploadedImage[],
  parsed: ExtractedSlip | null,
): Promise<{ imageKey: string | null; receiptImageKey: string | null }> {
  let imageKey: string | null = null;
  let receiptImageKey: string | null = null;
  const store = bucket;
  if (sampleId && uploadedImages.length > 0 && store) {
    const tagByIndex = new Map<number, ImageKind>();
    for (const img of parsed?.images ?? []) {
      if (!tagByIndex.has(img.index)) tagByIndex.set(img.index, img.kind);
    }
    let slipImg: UploadedImage | null =
      uploadedImages.find((u) => tagByIndex.get(u.index) === 'order_slip') ?? null;
    let receiptImg: UploadedImage | null =
      uploadedImages.find((u) => tagByIndex.get(u.index) === 'payment_receipt') ?? null;
    if (slipImg && receiptImg && slipImg.index === receiptImg.index) receiptImg = null;
    if (!slipImg) {
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

async function postProcessSlip(
  parsed: ExtractedSlip,
  sb: SupabaseClient,
  googleMapsApiKey: string | undefined,
  catalog: Catalog,
): Promise<Warning[]> {
  parsed.phones = parsed.phones
    .map((p) => normalizeSlipPhone(p))
    .filter((p): p is string => p !== null);

  // Postcode is the driver. A postcode written on the slip that the localities
  // master knows wins, and its city/state come from that master row (HC-0190:
  // the map lookup put orders in the wrong town, e.g. Bukit Tunku KL vs Kulim).
  // Google Geocoding (GOOGLE_MAPS_API_KEY) only fills in when the slip has no
  // usable postcode. The seeded STATE still goes through validateSlip below.
  // Fail-soft: no key / network error / no result -> keep the LLM parse.
  try {
    await resolveSlipAddress(parsed, {
      findLocality: (postcode) => localityForPostcode(sb, postcode),
      geocode: (address) => geocodeAddress(address, googleMapsApiKey),
    });
  } catch {
  }

  const warnings = validateSlip(parsed, catalog);

  for (const p of parsed.phones) {
    if (hasUnexpectedDigitCount(p)) {
      warnings.push({
        field: 'phones',
        value: p,
        message: `Phone "${p}" has an unusual digit count — the scan may have dropped or doubled a digit; please verify against the slip.`,
      });
    }
  }
  return warnings;
}

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

  const filesRes = await parseScanFiles(formData);
  if (!filesRes.ok) {
    return c.json({ error: 'bad_request', reason: filesRes.reason }, 400);
  }
  const { fileBlocks, uploadedImages, firstBuffer, fileCount } = filesRes.parsed;

  const imageSha256 = firstBuffer ? await sha256Hex(firstBuffer) : null;

  const repGiven = normalizeRepKey(formData.get('salesperson'));

  const sb = c.get('supabase');
  const catalog = await loadCatalog(sb, c.env.DB, activeCompanyId(c) ?? null);

  const branding = await getBranding(c.env);

  const cachedPrefix = buildCachedPrefix(catalog, branding.companyName);

  const svc = serviceClient(c.env);

  const inj = await loadPromptInjections(svc, repGiven);

  const { parsed, errorMsg, timedOut, claudeText, cacheHit, cacheCreated } =
    await callClaudeSlipExtract(apiKey, cachedPrefix, inj, fileBlocks, requestAiTag(c, 'scan_so', scanSoModel(c.env)));

  const sampleSalesperson = repGiven || normalizeRepKey(parsed?.salesRep) || null;
  const { sampleId, sampleInsertError } = await insertScanSample(svc, {
    imageSha256, salesperson: sampleSalesperson, parsed, errorMsg, claudeText,
    documentType: DEFAULT_SCAN_DOCUMENT_TYPE,
  });

  const { imageKey, receiptImageKey } = await storeScanImages(
    c.env.SO_ITEM_PHOTOS, svc, sampleId, uploadedImages, parsed,
  );

  if (!parsed) {
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

  const warnings = await postProcessSlip(parsed, sb, c.env.GOOGLE_MAPS_API_KEY, catalog);

  const duplicate = await findDuplicateSo(svc, { imageSha256, excludeSampleId: sampleId, parsed }, activeCompanyId(c));

  return c.json({
    success: true,
    data: {
      sampleId,
      duplicate,
      imageKey,
      receiptImageKey,
      extracted: parsed,
      warnings,
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

const JOB_MSG = {
  fallback: 'Something went wrong while processing the scan. Please enter this order manually.',
  noKey: 'Scanning is not set up on the server yet. Please enter this order manually.',
  timeout: 'Reading the slip took too long. Please try scanning again.',
  unreadable: 'The slip photo could not be read. Please retake the photo and try again.',
  createFallback: 'The draft order could not be created. Please enter this order manually.',
} as const;

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
export async function findRecentSoForSlipSha(
  svc: SupabaseClient,
  imageSha256: string,
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
    .limit(10);
  if (jobErr) throw new Error(jobErr.message);
  const jobDocs = (((jobRows as Array<Record<string, unknown>> | null) ?? [])
    .map((r) => (r.soDocNo ?? r.so_doc_no) as unknown)
    .filter((v): v is string => typeof v === 'string' && v !== ''));
  if (jobDocs.length === 0) return null;
  // HC-0117: "Discard draft" hard-deletes the SO but scan_jobs.so_doc_no keeps
  // pointing at it, so a re-scan of the same photo was refused as "already
  // created HC-SO-2610-210" for an order nobody could open. Only an SO that
  // still exists counts as the original. A CANCELLED one does not either: the
  // content rule below already skips it, and staff re-scan a cancelled order's
  // slip precisely to raise it again.
  const { data: soRows, error: soErr } = await svc
    .from('mfg_sales_orders')
    .select('doc_no')
    .in('doc_no', [...new Set(jobDocs)])
    .neq('status', 'CANCELLED');
  if (soErr) throw new Error(soErr.message);
  const alive = new Set(((soRows as Array<Record<string, unknown>> | null) ?? [])
    .map((r) => (r.docNo ?? r.doc_no) as unknown));
  return jobDocs.find((d) => alive.has(d)) ?? null;
}

async function findDuplicateSo(
  svc: SupabaseClient,
  args: {
    imageSha256: string | null;
    excludeSampleId: string | null;
    parsed: ExtractedSlip | null;
  },
  companyId?: number,
): Promise<{ docNo: string; rule: 'image' | 'content' } | null> {
  try {
    if (args.imageSha256) {
      const doc = await findRecentSoForSlipSha(svc, args.imageSha256, args.excludeSampleId);
      if (doc) return { docNo: doc, rule: 'image' };
    }
  } catch (e) {
    console.warn('[scan-so dup] image check failed:', (e as Error).message);
  }

  try {
    const parsed = args.parsed;
    const storedPhone = (parsed?.phones?.[0] ?? '').replace(/\s+/g, '');
    if (parsed && storedPhone) {
      const ref = (parsed.customerSoRef ?? '').trim().toUpperCase();
      const slipDate = /^\d{4}-\d{2}-\d{2}$/.test((parsed.slipDate ?? '').trim())
        ? (parsed.slipDate as string).trim()
        : null;
      const totalSen = typeof parsed.totalRm === 'number' && parsed.totalRm > 0
        ? Math.round(parsed.totalRm * 100)
        : null;
      if (ref || (slipDate && totalSen != null)) {
        let dupQ = svc
          .from('mfg_sales_orders')
          .select('doc_no, customer_so_no, so_date, total_revenue_sen')
          .eq('phone', storedPhone)
          .neq('status', 'CANCELLED');
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
          const candTotal = Number(r.totalRevenueSen ?? r.total_revenue_sen ?? NaN);
          if (slipDate && totalSen != null && candDate === slipDate && candTotal === totalSen) {
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
    storedImageKeys: string[];
    receiptImageKey: string | null;
    salespersonId: string;
    salespersonName: string | null;
  },
): Promise<{ recorded: number; failed: number; skippedDuplicate: number; depositBooked: boolean }> {
  const { parsed } = args;
  const receiptIdxs = classifiedReceiptIndices(parsed, args.uploadedImages);
  if (receiptIdxs.length === 0) return { recorded: 0, failed: 0, skippedDuplicate: 0, depositBooked: false };

  const { data: existingRows, error: existingErr } = await svc
    .from('mfg_sales_order_payments')
    .select('id')
    .eq('so_doc_no', args.docNo)
    .limit(1);
  if (existingErr) {
    console.error('[scan-job] payment pre-check failed:', args.docNo, existingErr.message);
    return { recorded: 0, failed: receiptIdxs.length, skippedDuplicate: 0, depositBooked: false };
  }
  if (((existingRows as unknown[] | null) ?? []).length > 0) {
    console.warn('[scan-job] SO already has payment rows — skipping receipt payments:', args.docNo);
    return { recorded: 0, failed: 0, skippedDuplicate: receiptIdxs.length, depositBooked: false };
  }

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
    slipDate: parsed.slipDate,
    nowMs: Date.now(),
    todayStr: todayMyt(),
  });
  if (planned.length === 0) return { recorded: 0, failed: 0, skippedDuplicate: 0, depositBooked: false };

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
  const bookedFingerprints = new Set<string>();
  const approvalCodes = [...new Set(planned.map((p) => p.approvalCode).filter((a): a is string => !!a))];
  if (approvalCodes.length > 0) {
    try {
      const { data: fpRows, error: fpErr } = await svc
        .from('mfg_sales_order_payments')
        .select('approval_code, amount_sen')
        .in('approval_code', approvalCodes);
      if (fpErr) console.warn('[scan-job] payment fingerprint check failed:', fpErr.message);
      else {
        for (const r of ((fpRows as Array<Record<string, unknown>> | null) ?? [])) {
          const code = (r.approvalCode ?? r.approval_code) as string | undefined;
          const amt = Number(r.amountSen ?? r.amount_sen ?? NaN);
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
  let depositBooked = false;
  for (const row of planned) {
    const keyDup = row.slipKey != null && alreadyBookedKeys.has(row.slipKey);
    const fpDup = row.approvalCode != null && bookedFingerprints.has(`${row.approvalCode}|${row.amountSen}`);
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
        amountSen: row.amountSen,
        slipKey: row.slipKey,
        collectedBy: args.salespersonId,
        note: noteParts.join('; '),
        createdBy: args.salespersonId,
        actorName: args.salespersonName,
        isDeposit: row.isDeposit,
        auditSource: 'automation',
        auditNote: 'Auto: payment recorded from scanned receipt (background scan job)',
      });
      if (errorMessage) {
        failed += 1;
        console.error('[scan-job] receipt payment insert failed:', args.docNo, errorMessage);
      } else {
        recorded += 1;
        if (row.isDeposit) depositBooked = true;
      }
    } catch (e) {
      failed += 1;
      console.error('[scan-job] receipt payment threw:', args.docNo, (e as Error).message);
    }
  }
  return { recorded, failed, skippedDuplicate, depositBooked };
}

const SHELL_NAME = 'Scan — please complete';
const SHELL_PHONE = 'To be confirmed';

function buildEmptyShellBody(
  keys: { imageKey: string | null; receiptImageKey: string | null },
): Record<string, unknown> {
  return {
    customerName: SHELL_NAME,
    debtorName: SHELL_NAME,
    phone: SHELL_PHONE,
    note: null,
    depositSen: 0,
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
  await postPersonalNotice(env, {
    userIds: [opts.houzsUserId],
    category: opts.category,
    title: opts.title,
    body: opts.body,
    source: 'scan',
    expiresDays: 7,
  });
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
    if (isDroppedBlankLine(l.rawText, sku !== undefined)) continue;
    const name = sku ? (sku.name ?? '').trim() : '';
    const cat = (sku?.category ?? 'OTHERS').toLowerCase();
    const variants = buildScanLineVariants(l, {
      category: cat,
      skuCode: sku?.code ?? null,
      pools: catalog,
      totalHeights: sku ? catalog.totalHeightsByModelSku.get(sku.code.toUpperCase()) ?? null : null,
    });
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
    items.push({
      itemCode: sku?.code ?? '',
      itemGroup: cat,
      description: name,
      qty: l.qtyGuess > 0 ? l.qtyGuess : 1,
      unitPriceSen: Math.round(Math.max(0, l.priceRmGuess ?? 0) * 100),
      lineDeliveryDate: null,
      ...(Object.keys(variants).length > 0 ? { variants } : {}),
    });
  }
  applySlipTotalToUnpricedLines(items, parsed.totalRm);

  const planMonths = installmentPlanToMonths(parsed.installmentPlanMatch?.value);
  const paymentMethod = parsed.paymentMethodMatch?.value ?? null;

  const noteParts: string[] = [];
  const remarkNote = (parsed.remarks ?? '').trim();
  if (remarkNote) noteParts.push(remarkNote);

  // Owner 2026-08-08 (2990-SO-2608-007, addendum #3) — a DRAFT never carries a
  // Processing Date. The previous rule here (owner 2026-07-04: slip delivery
  // date ⇒ pin processing to TODAY) silently stamped processing_date on
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
    phone: mainPhone ? (normalizePhone(mainPhone) ?? SHELL_PHONE) : SHELL_PHONE,
    customerType: parsed.customerTypeMatch?.value ?? null,
    buildingType: parsed.buildingTypeMatch?.value ?? null,
    note: noteParts.length > 0 ? noteParts.join(' | ') : null,
    address1: (parsed.addressLine1 ?? parsed.address ?? '').trim() || null,
    customerState: parsed.addressStateMatch?.value ?? null,
    city: (parsed.city ?? '').trim() || null,
    postcode: (parsed.postcode ?? '').trim() || null,
    processingDate: scanProcDate,
    customerDeliveryDate: scanDelivDate,
    emergencyContactPhone: normalizePhone(parsed.phones[1] ?? '') ?? null,
    /* No venue, no fair, no fair day (owner 2026-11-12): the slip's place and
       date are not carried onto the draft, and the create core fills none of
       them for a scan. A person picks all three before Confirm. */
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
    depositSen: parsed.depositRm && parsed.depositRm > 0 ? Math.round(parsed.depositRm * 100) : 0,
    slipImageKey: keys.imageKey,
    receiptImageKey: keys.receiptImageKey,
    asDraft: true,
    _scanShell: isShell,
    items,
  };
  return { body, missing };
}

async function runScanJob(
  env: Env,
  job: {
    id: string;
    salesperson: string;
    salespersonId: string;
    salespersonName: string | null;
    houzsUserId: number | null;
    documentType: ScanDocumentType;
    companyId: number | null;
    fileBlocks: ContentBlock[];
    uploadedImages: UploadedImage[];
    firstBuffer: ArrayBuffer | null;
    imageKeys: string[];
  },
): Promise<void> {
  const timer = scanTimer('so');
  let outcome: 'ok' | 'error' = 'ok';
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
    outcome = 'error';
    await touch({ status: 'error', error: plainMsg });
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

    const catalog = await loadCatalog(svc, env.DB, job.companyId);
    const branding = await getBranding(env);
    const cachedPrefix = buildCachedPrefix(catalog, branding.companyName);
    const inj = await loadPromptInjections(svc, job.salesperson);
    timer.mark('prep');
    // HC-0006 T8: this company's confirmed corrections, read before the model and applied to its output.
    const call = await readSlipWithAliases(svc, job.companyId, (hint) => callClaudeSlipExtract(
      apiKey, cachedPrefix, hint ? { ...inj, globalAliasText: [inj.globalAliasText, hint].filter(Boolean).join('\n\n') } : inj, job.fileBlocks,
      { env, feature: 'scan_so', model: scanSoModel(env), companyId: job.companyId, userId: job.houzsUserId, waitUntil: null },
    ));
    timer.mark('model');
    const parsed = call.parsed;

    // Learning pool + slip/receipt provenance — identical to /extract.
    // HC-0006 speed: this and postProcessSlip (geocode + catalogue check) don't need
    // each other, so they run together. The sample keeps the model's raw read — a
    // copy taken before postProcessSlip edits `parsed` in place — as when it ran first.
    const rawParsed = parsed ? structuredClone(parsed) : null;
    const [{ imageSha256, sampleId, imageKey, receiptImageKey }] = await Promise.all([(async () => {
      const imageSha256 = job.firstBuffer ? await sha256Hex(job.firstBuffer) : null;
      const sampleSalesperson = job.salesperson || normalizeRepKey(rawParsed?.salesRep) || null;
      const { sampleId } = await insertScanSample(svc, {
        imageSha256,
        salesperson: sampleSalesperson,
        parsed: rawParsed,
        errorMsg: call.errorMsg,
        claudeText: call.claudeText,
        documentType: job.documentType,
      });
      if (sampleId) await touch({ sample_id: sampleId });
      const keys = await storeScanImages(env.SO_ITEM_PHOTOS, svc, sampleId, job.uploadedImages, rawParsed);
      return { imageSha256, sampleId, ...keys };
    })(), parsed && postProcessSlip(parsed, svc, env.GOOGLE_MAPS_API_KEY, catalog).then(() => timer.mark('parse'))]);
    timer.mark('save', 'sample');

    // Owner 2026-07-04: EVERY scan ends as a draft the rep can open — success,
    // duplicate, OR unreadable. A scan that could not be turned into a full
    // order still lands a SHELL draft carrying the slip photo (with a plain
    // "please complete this from the photo" note the Orders-open toast shows),
    // so the rep never has to hunt a lost scan or re-shoot just to key it in.
    let body: Record<string, unknown>;
    let shellNote: string | null = null;
    let dupDocNo: string | null = null;

    if (!parsed) {
      console.error('[scan-job] extraction failed, creating blank draft:', job.id, call.errorMsg);
      const slipKey = imageKey ?? (job.imageKeys[0] ?? null);
      body = buildEmptyShellBody({ imageKey: slipKey, receiptImageKey });
      shellNote = 'The scan could not read this slip, so this draft is blank. Please open it and fill in the order from the photo.';
    } else {
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
      timer.mark('save', 'dup');

      const draft = buildDraftSoBodyFromSlip(parsed, catalog, { imageKey, receiptImageKey }, { allowShell: true });
      if (!draft.body) {
        return await fail(
          `The scan could not read the ${draft.missing.join(' and ')} on the slip. Please enter this order manually.`,
        );
      }
      body = draft.body;
      if (body._scanShell === true) {
        shellNote = `The scan could not read the ${draft.missing.join(' and ')} on this slip. Please open this draft and complete it from the photo.`;
      }
    }

    /* PAID-ROLLUP INVARIANT (docs/bugs/0785-*) — header deposit_sen is safe ONLY
       when an is_deposit ledger row backs it. `soPaidSen` is
       `(is_deposit-row-exists ? 0 : deposit_sen) + Σ ledger rows`
       (shared/so-outstanding.ts:102; list rollup mfg-sales-orders.ts:2203), so an
       UNBACKED header deposit is added ON TOP of every payment the operator
       records later — double-counting the deposit (a customer who paid 1400
       showed 2800). A scan books that backing row ONLY in recordScanReceiptPayments,
       and ONLY for a NON-shell draft with a CLASSIFIED payment receipt: the shell
       paths return before the receipt pass (:4133), and a receiptless slip books
       nothing (:3407). Everywhere else the slip's handwritten depositRm would
       orphan on the header, so drop it — the ledger is the sole source of Paid and
       the operator adds the payment on review. Owner rule (recordScanReceiptPayments
       header, ~:3375): never book money off an unclassified photo. The receipt-backed
       case is byte-identical — its is_deposit row makes soPaidSen ignore the header
       anyway, so deposit_sen is left untouched for reports/PDF there. */
    const originalDepositSen = typeof body.depositSen === 'number' ? body.depositSen : 0;
    const safeDepositSen = safeScanDepositSen(originalDepositSen, {
      isShell: body._scanShell === true,
      hasClassifiedReceipt:
        parsed != null && classifiedReceiptIndices(parsed, job.uploadedImages).length > 0,
    });
    if (safeDepositSen !== originalDepositSen) {
      console.warn(
        `[scan-job] dropping unbacked header deposit ${fmtSen(originalDepositSen)} -> ${fmtSen(safeDepositSen)} on ${job.id} `
        + '(no classified receipt to book an is_deposit row); operator adds the payment on the draft',
      );
      body.depositSen = safeDepositSen;
    }

    const replay = (b: Record<string, unknown>) => {
      timer.createAttempt();
      return createDraftSalesOrder(env, {
        salespersonId: job.salespersonId,
        salespersonName: job.salespersonName,
        houzsUserId: job.houzsUserId,
        companyId: job.companyId,
        body: b,
      });
    };
    let outcome = await replay(body);
    if (
      outcome.status !== 201 &&
      (body.processingDate != null || body.customerDeliveryDate != null)
    ) {
      console.warn('[scan-job] create rejected with dates, retrying dateless:', job.id, outcome.status);
      body.processingDate = null;
      body.customerDeliveryDate = null;
      outcome = await replay(body);
    }
    if (outcome.status !== 201 && Array.isArray(body.items) && (body.items as unknown[]).length > 0) {
      console.warn('[scan-job] category lines rejected, retrying as loose lines:', job.id, outcome.status);
      body.processingDate = null;
      body.customerDeliveryDate = null;
      body.items = (body.items as Array<Record<string, unknown>>).map((it) => ({
        itemCode: it.itemCode,
        itemGroup: 'others',
        description: it.description,
        qty: it.qty,
        unitPriceSen: it.unitPriceSen,
        lineDeliveryDate: null,
      }));
      outcome = await replay(body);
    }
    timer.mark('save', 'create');
    const docNo = (outcome.body as { docNo?: unknown }).docNo;
    if (outcome.status === 201 && typeof docNo === 'string' && docNo !== '') {
      // HC-0006 T7. Never throws; runs alongside the payment pass (it links the 'so' rows,
      // the payment pass the 'payment' rows) and is awaited before the job reads done.
      const linked = linkScanFiles(svc, { companyId: job.companyId, kind: 'so', documentId: docNo, keys: job.imageKeys, sha256: null });
      if (shellNote) {
        await linked;
        if (sampleId && rawParsed) await snapshotDraftBaseline(svc, { sampleId, docNo, extracted: rawParsed });
        await Promise.all([
          touch({ status: 'done', so_doc_no: docNo, linked_doc_no: docNo, error: shellNote }),
          postScanNotice(env, {
            houzsUserId: job.houzsUserId,
            category: 'WARNING',
            title: `Scan saved as a draft — ${docNo}`,
            body: shellNote,
          }),
        ]);
        return;
      }
      if (!parsed) { await linked; await touch({ status: 'done', so_doc_no: docNo, linked_doc_no: docNo }); return; }
      let paymentNote: string | null = null;
      let depositBooked = false;
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
        depositBooked = pay.depositBooked;
        if (pay.failed > 0) {
          paymentNote = 'Draft created; the payment could not be recorded — please add it on the order.';
        } else if (pay.skippedDuplicate > 0) {
          paymentNote = 'A matching payment was already recorded, so it was not added again.';
        }
      } catch (e) {
        console.error('[scan-job] receipt payment recording threw:', job.id, (e as Error).message);
        paymentNote = 'Draft created; the payment could not be recorded — please add it on the order.';
      }
      // HC-0132: a header deposit with no is_deposit row behind it counts as Paid
      // while the Payments list is empty. Clear it; the operator adds the payment.
      const stampedDepositSen = typeof body.depositSen === 'number' ? body.depositSen : 0;
      if (depositSenAfterReceiptPass(stampedDepositSen, { depositRowBooked: depositBooked }) !== stampedDepositSen) {
        const { error: clearErr } = await scopeToCompanyIdOrOpen(
          svc.from('mfg_sales_orders').update({ deposit_sen: 0 }).eq('doc_no', docNo), job.companyId);
        if (clearErr) console.error('[scan-job] could not clear unbacked header deposit:', docNo, clearErr.message);
        paymentNote ??= 'Draft created; the payment could not be recorded — please add it on the order.';
      }
      await linked;
      if (sampleId && rawParsed) await snapshotDraftBaseline(svc, { sampleId, docNo, extracted: rawParsed });
      const phoneWarnings = phoneDigitCountWarnings(parsed?.phones ?? []);
      const noticeExtras = [
        dupDocNo ? `This looks like a possible duplicate of ${dupDocNo}.` : null,
        paymentNote,
        ...phoneWarnings,
      ].filter(Boolean);
      await Promise.all([
        touch({
          status: 'done',
          so_doc_no: docNo,
          linked_doc_no: docNo,
          ...(paymentNote ? { error: paymentNote } : {}),
        }),
        postScanNotice(env, {
          houzsUserId: job.houzsUserId,
          category: dupDocNo || paymentNote || phoneWarnings.length > 0 ? 'WARNING' : 'GENERAL',
          title: `Sales order saved — ${docNo}`,
          body: [`Your scan was saved as a draft. Open it from your Orders to review.`, ...noticeExtras].join(' '),
        }),
      ]);
      return;
    }
    console.error(
      '[scan-job] draft create rejected:', job.id, outcome.status,
      JSON.stringify(outcome.body).slice(0, 600),
    );
    const reason =
      typeof outcome.body.reason === 'string' ? outcome.body.reason
      : typeof outcome.body.message === 'string' ? outcome.body.message
      : variantNotAllowedSentence(outcome.body) ?? JOB_MSG.createFallback;
    await fail(reason);
  } catch (e) {
    console.error('[scan-job] pipeline threw:', job.id, e);
    await fail(JOB_MSG.fallback);
  } finally {
    timer.mark('save', 'tail');
    timer.done(env, job.id, outcome);
  }
}

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

scanSo.post('/enqueue', async (c) => {
  /* company-scope: the by-id reads the checker attributes to this handler are
     NOT in it — they belong to processScanQueueMessage, declared inside this
     handler's slice. Trace in docs/modules/scan-to-so.md section 7. */
  const timer = scanTimer('so-enqueue');
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
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

  const user = c.get('user');
  const houzsUser = c.get('houzsUser');
  const houzsUserId =
    houzsUser?.id != null && Number.isFinite(Number(houzsUser.id)) ? Number(houzsUser.id) : null;
  const salespersonName =
    ((user.user_metadata as { name?: string } | undefined)?.name ?? '').trim() || repGiven || null;

  const svc = serviceClient(c.env);

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

  const { data: jobRow, error: jobErr } = await svc
    .from('scan_jobs')
    .insert({
      status: 'queued',
      document_type: DEFAULT_SCAN_DOCUMENT_TYPE,
      salesperson: repGiven || null,
      salesperson_id: uploaderStaffId,
      houzs_user_id: houzsUserId,
      image_keys: [],
      company_id: activeCompanyId(c),
    })
    .select('id')
    .single();
  const jobId = (jobRow as { id?: string } | null)?.id ?? null;
  if (jobErr || !jobId) {
    if (jobErr && isMissingTable(jobErr)) {
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
  //    Each kept photo also gets its scm.scan_files row (HC-0006) via keepScanFile.
  const imageKeys: string[] = [];
  if (c.env.SO_ITEM_PHOTOS) {
    const keys = await Promise.all(allFiles.map((f, i) => keepScanFile(c.env, svc, {
      kind: 'so', companyId: activeCompanyId(c), buf: f.buffer,
      mime: f.mime, uploadedBy: user.id, key: `scan-jobs/${jobId}/${i}`,
    })));
    for (const key of keys) if (key) imageKeys.push(key);
    if (imageKeys.length > 0) {
      await svc
        .from('scan_jobs')
        .update({ image_keys: imageKeys, updated_at: new Date().toISOString() })
        .eq('id', jobId);
    }
  }

  timer.mark('upload');
  timer.done(c.env, jobId, 'ok');

  if (c.env.SCAN_QUEUE) {
    try {
      await c.env.SCAN_QUEUE.send({ jobId });
    } catch (e) {
      console.error('[scan-so enqueue] SCAN_QUEUE.send failed:', jobId, (e as Error).message);
    }
  } else {
    const pipeline = runScanJob(c.env, {
      id: jobId,
      salesperson: repGiven,
      salespersonId: uploaderStaffId,
      salespersonName,
      houzsUserId,
      documentType: DEFAULT_SCAN_DOCUMENT_TYPE,
      companyId: activeCompanyId(c) ?? null,
      fileBlocks,
      uploadedImages,
      firstBuffer,
      imageKeys,
    });
    try {
      c.executionCtx.waitUntil(pipeline);
    } catch {
    }
  }

  return c.json({ job_id: jobId, status: 'queued' }, 202);
});

const SCAN_JOB_STALE_MINUTES = 3;
const STALE_JOB_ERROR = 'The scan took too long and was stopped. Please scan this slip again.';

export async function processScanQueueMessage(env: Env, jobId: string): Promise<void> {
  const id = String(jobId ?? '');
  if (!id) return;
  const svc = serviceClient(env);

  const { data: row, error } = await svc
    .from('scan_jobs')
    .select('id, status, salesperson, salesperson_id, houzs_user_id, image_keys, company_id, document_type')
    .eq('id', id)
    .single();
  if (error) {
    if ((error as { code?: string }).code === 'PGRST116') {
      console.warn('[scan-queue] job row not found, acking:', id);
      return;
    }
    throw new Error(`scan_jobs read failed for ${id}: ${error.message}`);
  }

  const r = row as Record<string, unknown>;
  const status = typeof r.status === 'string' ? r.status : '';
  if (status === 'done') {
    console.warn('[scan-queue] job already done, skipping:', id);
    return;
  }

  const rawKeys = r.imageKeys ?? r.image_keys;
  const imageKeys = Array.isArray(rawKeys) ? rawKeys.map(String) : [];
  const salesperson = typeof r.salesperson === 'string' ? r.salesperson : '';
  const salespersonId = String(r.salespersonId ?? r.salesperson_id ?? '');
  const huRaw = r.houzsUserId ?? r.houzs_user_id;
  const houzsUserId = huRaw != null && Number.isFinite(Number(huRaw)) ? Number(huRaw) : null;
  const coRaw = r.companyId ?? r.company_id;
  const companyId = coRaw != null && Number.isFinite(Number(coRaw)) ? Number(coRaw) : null;
  if (String(r.documentType ?? r.document_type ?? '').startsWith('AI_')) return;
  const documentType = coerceScanDocumentType(r.documentType ?? r.document_type);

  if (documentType === 'GR') { await processGrnScanQueueMessage(env, id); return; }
  if (documentType === 'PI') { await processPiScanQueueMessage(env, id); return; }
  if (documentType !== 'SO') {
    console.warn('[scan-queue] no consumer for document_type yet, acking:', documentType, id);
    return;
  }

  const files = salespersonId ? await loadScanJobFilesFromR2(env.SO_ITEM_PHOTOS, imageKeys) : null;
  if (!files) {
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
    salespersonName: salesperson || null,
    salespersonId,
    houzsUserId,
    documentType,
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
  runInBackground: (p: Promise<unknown>) => void,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const cutoff = new Date(Date.now() - SCAN_JOB_STALE_MINUTES * 60 * 1000).toISOString();

    const { data: retryRows, error: retryErr } = await svc
      .from('scan_jobs')
      .select('id, salesperson, salesperson_id, houzs_user_id, image_keys, retry_count, company_id, document_type')
      .in('status', ['queued', 'running'])
      .eq('document_type', 'SO')
      .lt('updated_at', cutoff)
      .eq('retry_count', 0)
      .limit(5);
    if (retryErr) {
      console.warn('[scan-so jobs] retry pass failed (blanket reap fallback):', retryErr.message);
      await svc
        .from('scan_jobs')
        .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
        .in('status', ['queued', 'running'])
        .eq('document_type', 'SO')
        .lt('updated_at', cutoff);
      return;
    }

    for (const r of (retryRows ?? []) as Array<Record<string, unknown>>) {
      const id = String(r.id ?? '');
      if (!id) continue;
      const { data: claimed, error: claimErr } = await svc
        .from('scan_jobs')
        .update({ status: 'queued', retry_count: 1, updated_at: nowIso })
        .eq('id', id)
        .eq('retry_count', 0)
        .in('status', ['queued', 'running'])
        .select('id');
      if (claimErr || !claimed || claimed.length === 0) continue;

      const rawKeys = r.imageKeys ?? r.image_keys;
      const imageKeys = Array.isArray(rawKeys) ? rawKeys.map(String) : [];
      const salesperson = typeof r.salesperson === 'string' ? r.salesperson : '';
      const salespersonId = String(r.salespersonId ?? r.salesperson_id ?? '');
      const huRaw = r.houzsUserId ?? r.houzs_user_id;
      const houzsUserId = huRaw != null && Number.isFinite(Number(huRaw)) ? Number(huRaw) : null;
      const coRaw = r.companyId ?? r.company_id;
      const companyId = coRaw != null && Number.isFinite(Number(coRaw)) ? Number(coRaw) : null;
      const documentType = coerceScanDocumentType(r.documentType ?? r.document_type);

      runInBackground((async () => {
        const files = salespersonId ? await loadScanJobFilesFromR2(env.SO_ITEM_PHOTOS, imageKeys) : null;
        if (!files) {
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
          salespersonName: salesperson || null,
          houzsUserId,
          documentType,
          companyId,
          fileBlocks: files.fileBlocks,
          uploadedImages: files.uploadedImages,
          firstBuffer: files.firstBuffer,
          imageKeys,
        });
      })());
    }

    await svc
      .from('scan_jobs')
      .update({ status: 'error', error: STALE_JOB_ERROR, updated_at: nowIso })
      .in('status', ['queued', 'running'])
      .eq('document_type', 'SO')
      .lt('updated_at', cutoff)
      .gte('retry_count', 1);
  } catch (e) {
    console.warn('[scan-so jobs] stale-job reaper failed:', (e as Error).message);
  }
}

scanSo.get('/jobs', async (c) => {
  const rep = normalizeRepKey(c.req.query('salesperson'));
  const svc = serviceClient(c.env);
  await reapStaleScanJobs(c.env, svc, (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
    }
  });
  let q = svc
    .from('scan_jobs')
    .select('id, status, salesperson, so_doc_no, linked_doc_no, document_type, error, sample_id, duplicate_of, image_keys, created_at, updated_at')
    .eq('company_id', activeCompanyId(c))
    .not('document_type', 'like', 'AI_%')
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

scanSo.get('/jobs/:id', async (c) => {
  const id = (c.req.param('id') ?? '').trim();
  if (!id) return c.json({ error: 'bad_request', reason: 'Missing job id.' }, 400);
  const svc = serviceClient(c.env);
  await reapStaleScanJobs(c.env, svc, (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
    }
  });
  const { data, error } = await scopeToCompany(svc
    .from('scan_jobs')
    .select('id, status, salesperson, so_doc_no, linked_doc_no, document_type, error, sample_id, duplicate_of, image_keys, created_at, updated_at')
    .eq('id', id), c)
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return c.json({ error: 'table_missing', reason: SCAN_JOBS_MISSING_MSG }, 503);
    return c.json({ error: 'query_failed', reason: 'Could not load the scan job. Please try again.' }, 500);
  }
  if (!data) return c.json({ error: 'not_found', reason: 'Scan job not found.' }, 404);
  return c.json({ success: true, data: { job: jobToJson(data as Record<string, unknown>) } });
});

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

scanSo.post('/samples/:id/confirm', async (c) => {
  /* company-scope: scm.so_scan_samples is a GLOBAL OCR TRAINING POOL, not a
     business document — it has NO company_id column and mig 0083's sweep
     skipped it on purpose. Trace in docs/modules/scan-to-so.md section 7. */
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
  const repGiven = normalizeRepKey(body.salesperson);

  const svc = serviceClient(c.env);
  let q = svc
    .from('so_scan_samples')
    .update({
      corrected: body.corrected,
      status: sampleStatus,
      ...(repGiven ? { salesperson: repGiven } : {}),
    })
    .eq('id', id);
  if (acceptedAsIs) q = q.neq('status', SAMPLE_CORRECTED);
  const { data: updated, error } = await q.select('id, salesperson');

  if (error) {
    if (isMissingTable(error)) {
      return c.json({ error: 'table_missing', reason: TABLE_MISSING_MSG }, 503);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!updated || updated.length === 0) {
    if (acceptedAsIs) return c.json({ success: true, skipped: 'already_corrected' });
    return c.json({ error: 'not_found', reason: 'Sample not found.' }, 404);
  }

  if (acceptedAsIs) return c.json({ success: true });

  const rep = repGiven || normalizeRepKey((updated[0] as { salesperson?: string | null }).salesperson);
  const tag = requestAiTag(c, 'scan_so_distill', CLAUDE_MODEL);
  if (c.env.SCAN_QUEUE) {
    try {
      await c.env.SCAN_QUEUE.send({ distill: { rep: rep || null, companyId: tag.companyId, userId: tag.userId } });
      return c.json({ success: true });
    } catch (e) {
      console.warn('[scan-so distill] queue send failed, distilling in waitUntil:', (e as Error).message);
    }
  }
  const distillPromise = runConfirmDistills(c.env, svc, rep || null, { ...tag, waitUntil: null });
  try {
    c.executionCtx.waitUntil(distillPromise);
  } catch {
  }

  return c.json({ success: true });
});

export async function runConfirmDistills(
  env: Env,
  svc: SupabaseClient,
  rep: string | null,
  usage: AiUsageTag,
): Promise<void> {
  const companyName = (await getBranding(env)).companyName;
  if (rep && !isGlobalKey(rep)) {
    try {
      const r = await distillSalespersonRules(svc, env.ANTHROPIC_API_KEY, rep, companyName, usage);
      if (r.status === 'error') console.warn(`[scan-so distill] ${rep}: ${r.reason}`);
    } catch (e) {
      console.warn(`[scan-so distill] ${rep} threw:`, (e as Error).message);
    }
  }
  try {
    const g = await distillGlobalAliases(svc, env.ANTHROPIC_API_KEY, companyName, usage);
    if (g.status === 'error') console.warn(`[scan-so distill] __GLOBAL__ aliases: ${g.reason}`);
  } catch (e) {
    console.warn('[scan-so distill] __GLOBAL__ aliases threw:', (e as Error).message);
  }
  try {
    const gr = await distillGlobalRules(svc, env.ANTHROPIC_API_KEY, companyName, usage);
    if (gr.status === 'error') console.warn(`[scan-so distill] __GLOBAL_RULES__: ${gr.reason}`);
  } catch (e) {
    console.warn('[scan-so distill] __GLOBAL_RULES__ threw:', (e as Error).message);
  }
}

/** The SCAN_QUEUE consumer's half of a { distill } message. */
export async function processDistillQueueMessage(
  env: Env,
  msg: { rep: string | null; companyId: number | null; userId: number | null },
): Promise<void> {
  await runConfirmDistills(env, serviceClient(env), msg.rep, {
    env, feature: 'scan_so_distill', model: CLAUDE_MODEL,
    companyId: msg.companyId, userId: msg.userId, waitUntil: null,
  });
}
