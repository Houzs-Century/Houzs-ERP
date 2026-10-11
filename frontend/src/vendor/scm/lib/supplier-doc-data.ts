// ----------------------------------------------------------------------------
// supplier-doc-data — print-time lookups for SUPPLIER-FACING purchasing docs
// (PO / GRN / PI / PR PDFs).
//
// Owner's rule (Commander): the supplier must see THEIR codes (they can only
// act on their own), and our internal codes stay visible too — BOTH on every
// purchasing document. Fabric/colour must show the SUPPLIER's colour code with
// our internal code alongside.
//
// Data sources (REUSED, no new backend routes):
//   • supplier_material_bindings — via GET /suppliers/:id (the SupplierDetail
//     page endpoint, returns { supplier, bindings }) → material_code →
//     supplier_sku for material_kind='mfg_product'. Main binding wins.
//   • fabric_trackings — via GET /fabric-tracking (the FabricTracking page
//     endpoint) → fabric_code (internal) → supplier_code.
//
// All loaders are DEFENSIVE: any fetch failure returns an empty map so PDF
// generation never dies on a lookup hiccup — the doc just falls back to '—' /
// our internal codes.
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '@2990s/shared';
import { authedFetch } from './authed-fetch';

/** Minimal line shape the PDF generators share. Extra fields welcome. */
export type SupplierDocLine = {
  material_code: string;
  supplier_sku?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

/** Full supplier master row (GET /suppliers/:id → `supplier`). The PO detail
 *  endpoint embeds only a 7-field subset (no fax / attention / payment_terms),
 *  so the PO PDF tops itself up from this record at print time — fail-soft. */
export type SupplierRecord = {
  id?: string;
  code?: string | null;
  name?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  mobile?: string | null;
  fax?: string | null;
  email?: string | null;
  address?: string | null;
  area?: string | null;
  postcode?: string | null;
  state?: string | null;
  country?: string | null;
  attention?: string | null;
  payment_terms?: string | null;
};

/* The variant keys that can carry an INTERNAL fabric/colour code. SO-keyed
   lines use fabricCode/colorCode; GRN/PI/PR editors store fabricColor (see
   buildVariantSummary in packages/shared). */
const FABRIC_VARIANT_KEYS = ['fabricCode', 'colorCode', 'fabricColor'] as const;

/* ── Shared fabric catalog cache (PERF, owner "Print PDF very slow" 2026-07-15) ─
   Every customer/supplier PDF resolves fabric codes through the two loaders
   below. The /fabric-tracking endpoint takes only `category` / a single-term
   `search` ilike — it has NO code-list filter — so each loader has to pull the
   whole catalog and filter client-side. Previously EVERY loader call refetched
   the entire catalog: a single sofa DO print fired it TWICE (supplier + desc
   map via Promise.all), and each reprint refetched from scratch.

   This module-level cache collapses that to ONE network round per print burst:
   an in-flight promise dedupes concurrent callers (the DO's Promise.all now
   shares one request) and a short TTL lets back-to-back reprints reuse the
   result. Failures are never cached, so a hiccup still falls back to '—' /
   internal codes on the next attempt. Output is byte-identical — only the fetch
   count changes. */
type FabricCatalogRow = {
  fabric_code: string;
  supplier_code: string | null;
  fabric_description: string | null;
};

const FABRIC_CATALOG_TTL_MS = 60_000;
let fabricCatalogCache: { at: number; rows: FabricCatalogRow[] } | null = null;
let fabricCatalogInflight: Promise<FabricCatalogRow[]> | null = null;

async function loadFabricCatalog(): Promise<FabricCatalogRow[]> {
  const fresh =
    fabricCatalogCache && Date.now() - fabricCatalogCache.at < FABRIC_CATALOG_TTL_MS;
  if (fresh) return fabricCatalogCache!.rows;
  if (fabricCatalogInflight) return fabricCatalogInflight;
  fabricCatalogInflight = (async () => {
    try {
      const res = await authedFetch<{ fabrics: FabricCatalogRow[] }>('/fabric-tracking');
      const rows = res.fabrics ?? [];
      fabricCatalogCache = { at: Date.now(), rows };
      return rows;
    } finally {
      fabricCatalogInflight = null; // failures don't poison the cache
    }
  })();
  return fabricCatalogInflight;
}

/**
 * internal fabric_code → supplier_code, via the same /fabric-tracking endpoint
 * the FabricTracking page queries. Only codes in `fabricCodes` are kept.
 * Backed by the shared catalog cache so concurrent/repeat prints reuse one fetch.
 */
export async function loadFabricSupplierMap(fabricCodes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(fabricCodes.map((c) => c.trim()).filter(Boolean));
  if (wanted.size === 0) return new Map();
  try {
    const rows = await loadFabricCatalog();
    const map = new Map<string, string>();
    for (const f of rows) {
      const sup = (f.supplier_code ?? '').trim();
      if (sup && wanted.has(f.fabric_code)) map.set(f.fabric_code, sup);
    }
    return map;
  } catch {
    return new Map(); // lookup failure must never block the PDF
  }
}

/**
 * internal fabric_code → fabric_description, same /fabric-tracking endpoint.
 * Used by the CUSTOMER-facing SO PDF so the printed line reads
 * "EZ-001 — Easy Clean Velvet" instead of the bare code. Fail-soft: any
 * fetch hiccup returns an empty map and the PDF prints codes as-is.
 * Backed by the shared catalog cache so concurrent/repeat prints reuse one fetch.
 */
export async function loadFabricDescriptionMap(fabricCodes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(fabricCodes.map((c) => c.trim()).filter(Boolean));
  if (wanted.size === 0) return new Map();
  try {
    const rows = await loadFabricCatalog();
    const map = new Map<string, string>();
    for (const f of rows) {
      const desc = (f.fabric_description ?? '').trim();
      if (desc && wanted.has(f.fabric_code)) map.set(f.fabric_code, desc);
    }
    return map;
  } catch {
    return new Map(); // lookup failure must never block the PDF
  }
}

/** The binding shape both the SKU map and its callers care about. */
export type SupplierBinding = {
  material_kind: string;
  material_code: string;
  supplier_sku: string | null;
  is_main_supplier: boolean;
};

/**
 * material_code → supplier_sku out of ONE supplier's bindings. Filters to
 * material_kind='mfg_product' and (when `codes` is given) the requested codes;
 * when the same code is bound twice the main binding (is_main_supplier) wins.
 *
 * Pure so the SCREEN can share the rule with the PDF: the purchase-order detail
 * page already holds these bindings via useSupplierDetail's cache and must not
 * re-derive "which SKU wins" on its own — a screen that disagrees with the
 * printed PO is worse than one that shows nothing.
 *
 * `codes` omitted = map every bound mfg_product.
 */
export function skuMapFromBindings(
  bindings: SupplierBinding[] | null | undefined,
  codes?: string[],
): Map<string, string> {
  const wanted = codes && new Set(codes.map((c) => c.trim()).filter(Boolean));
  const candidates = (bindings ?? [])
    .filter((b) => b.material_kind === 'mfg_product'
      && (!wanted || wanted.has(b.material_code))
      && (b.supplier_sku ?? '').trim() !== '')
    // Main binding first; first writer wins below.
    .sort((a, b) => Number(b.is_main_supplier) - Number(a.is_main_supplier));
  const map = new Map<string, string>();
  for (const b of candidates) {
    if (!map.has(b.material_code)) map.set(b.material_code, (b.supplier_sku ?? '').trim());
  }
  return map;
}

/**
 * material_code → supplier_sku for ONE supplier, via the SupplierDetail page's
 * GET /suppliers/:id (returns every binding for that supplier).
 */
export async function loadSupplierSkuMap(
  supplierId: string | null | undefined,
  codes: string[],
): Promise<Map<string, string>> {
  const wanted = codes.map((c) => c.trim()).filter(Boolean);
  if (!supplierId || wanted.length === 0) return new Map();
  try {
    const res = await authedFetch<{ bindings: SupplierBinding[] }>(`/suppliers/${supplierId}`);
    return skuMapFromBindings(res.bindings, wanted);
  } catch {
    return new Map();
  }
}

/** Collect every internal fabric code riding in the lines' variants JSONB. */
export function collectFabricCodes(items: SupplierDocLine[]): string[] {
  const codes = new Set<string>();
  for (const it of items) {
    const v = it.variants;
    if (!v || typeof v !== 'object') continue;
    for (const key of FABRIC_VARIANT_KEYS) {
      const raw = v[key];
      if (typeof raw === 'string' && raw.trim()) codes.add(raw.trim());
    }
  }
  return [...codes];
}

/** Full supplier master record via GET /suppliers/:id. Fail-soft → null. */
export async function loadSupplierRecord(
  supplierId: string | null | undefined,
): Promise<SupplierRecord | null> {
  if (!supplierId) return null;
  try {
    const res = await authedFetch<{ supplier: SupplierRecord | null }>(`/suppliers/${supplierId}`);
    return res.supplier ?? null;
  } catch {
    return null;
  }
}

/** Everything a purchasing-doc PDF needs, fetched in one parallel round.
 *  `supplier` = the FULL master record (fax / attention / payment_terms …)
 *  that the PO detail endpoint's 7-field embed omits; null on any failure.
 *  `fabricMap` = internal→supplier external colour code; `fabricDescMap` =
 *  internal→fabric_description. Supplier PDFs feed BOTH to `docVariantLine`
 *  so their fabric segment prints the ONE unified format `CG-001 Pearl
 *  (KN390-1)` — the same composer the customer docs use (owner 2026-07-24). */
export async function loadSupplierDocData(
  supplierId: string | null | undefined,
  items: SupplierDocLine[],
): Promise<{
  skuMap: Map<string, string>;
  fabricMap: Map<string, string>;
  fabricDescMap: Map<string, string>;
  supplier: SupplierRecord | null;
}> {
  // Binding lookup only for lines that never snapshotted a supplier_sku
  // (PI/PR lines have no supplier_sku column at all → all of them).
  const missing = items
    .filter((it) => !(it.supplier_sku ?? '').trim())
    .map((it) => it.material_code);
  const fabricCodes = collectFabricCodes(items);
  const [skuMap, fabricMap, fabricDescMap, supplier] = await Promise.all([
    loadSupplierSkuMap(supplierId, missing),
    loadFabricSupplierMap(fabricCodes),
    loadFabricDescriptionMap(fabricCodes),
    loadSupplierRecord(supplierId),
  ]);
  return { skuMap, fabricMap, fabricDescMap, supplier };
}

/**
 * The supplier-facing item code for a line: snapshotted supplier_sku first,
 * then the live binding lookup, else '—' (our code has its own column).
 */
export function supplierCodeFor(it: SupplierDocLine, skuMap: Map<string, string>): string {
  return (it.supplier_sku ?? '').trim() || skuMap.get(it.material_code) || '—';
}

/* ── Unified document variant line (Commander 2026-06-16; owner 2026-07-24) ──
   ONE shared composer so EVERY document — customer (SO / DO / DR / SI /
   Consignment) AND supplier-facing (PO / GRN / PI / PR) — renders the line
   description identically: `buildVariantSummary` with each fabric code shown
   as the ONE unified format `CG-001 Pearl (KN390-1)` (internal code + our
   description, the SUPPLIER's external code appended LAST in parens).

   Owner ruling 2026-07-24: the supplier-facing docs no longer recompose the
   fabric "supplier-code-first" (the retired `specsLine` prepended `KN390-1
   (CG-001)`, which — once the read-side also stamped `variants.fabricSupplierCode`
   in #1209 — printed the fabric TWICE, "KN390-1 (CG-001) CG-001 Pearl
   (KN390-1)"). The supplier's own item code lives ONLY in the Supplier-Code
   column, never duplicated into the fabric line. Supplier docs pass
   `{ labelled: true }` so the fabric segment keeps its "Fabric: " prefix. */
export function docVariantLine(
  item: { item_group?: string | null; variants?: Record<string, unknown> | null },
  fabricExtMap: Map<string, string>,
  fabricDescMap: Map<string, string>,
  /* labelled — prefix the fabric segment with "Fabric: " on supplier-facing
     docs (PO / GRN / PI / PR). Default off → customer docs unchanged. */
  opts?: { labelled?: boolean },
): string {
  const v = item.variants;
  if (!v || typeof v !== 'object') return '';
  let mapped: Record<string, unknown> = v;
  for (const key of FABRIC_VARIANT_KEYS) {
    const raw = v[key];
    if (typeof raw === 'string' && raw.trim()) {
      const code = raw.trim();
      const ext = fabricExtMap.get(code);   // supplier external colour code
      const desc = fabricDescMap.get(code);  // our fabric description
      if (ext || desc) {
        if (mapped === v) mapped = { ...v };
        // Owner format ruling 2026-07-24: customer PDFs print the SAME final
        // fabric format as the shared on-screen summary — description joined
        // bare, supplier parens LAST: "CG-001 Pearl (KN390-1)". The supplier
        // code is stamped as variants.fabricSupplierCode so buildVariantSummary
        // appends the parens at the segment end (the single home of that rule)
        // instead of being spliced inline here. Strip a redundant leading code
        // from the description (often starts with the code, e.g. "EZ-008
        // Forest") so the line doesn't read "EZ-008 EZ-008 Forest"
        // (Commander 2026-06-19).
        const cleanDesc = desc && desc.toLowerCase().startsWith(code.toLowerCase())
          ? desc.slice(code.length).trim()
          : desc;
        mapped[key] = `${code}${cleanDesc ? ` ${cleanDesc}` : ''}`;
        if (ext && !(mapped as Record<string, unknown>).fabricSupplierCode) {
          (mapped as Record<string, unknown>).fabricSupplierCode = ext;
        }
      }
    }
  }
  return buildVariantSummary(item.item_group ?? null, mapped, opts);
}

/** Load BOTH fabric maps (supplier external colour + our description) for a set
 *  of doc lines in one parallel round — feeds docVariantLine on customer docs. */
export async function loadCustomerFabricMaps(
  items: Array<{ variants?: Record<string, unknown> | null }>,
): Promise<{ ext: Map<string, string>; desc: Map<string, string> }> {
  const set = new Set<string>();
  for (const it of items) {
    const v = it.variants;
    if (!v || typeof v !== 'object') continue;
    for (const k of FABRIC_VARIANT_KEYS) {
      const r = v[k];
      if (typeof r === 'string' && r.trim()) set.add(r.trim());
    }
  }
  const codes = [...set];
  const [ext, desc] = await Promise.all([loadFabricSupplierMap(codes), loadFabricDescriptionMap(codes)]);
  return { ext, desc };
}
