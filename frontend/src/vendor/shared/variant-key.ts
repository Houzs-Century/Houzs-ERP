// ----------------------------------------------------------------------------
// Inventory variant key — the canonical "attribute composition" identity.
//
// Stock is bucketed by (warehouse_id, product_code, variant_key). Two lines
// with identical physical attributes produce the SAME key, so they pool into
// the same on-hand bucket; any difference produces a different key, so they
// are tracked separately.
//
// This helper is the single source of truth, shared by the API (when writing
// inventory movements) AND the frontend (grouping / display) so both sides
// agree byte-for-byte — that is what guarantees "same attributes → same格".
//
// Per-category composition (commander 2026-05-28):
//   · Sofa     — fabric + seat height + leg height (+ special-order config)
//   · Bedframe — fabric + gap + divan height + leg height + total height
//                (+ special-order config)
//   · Mattress — size is already baked into the product code → no soft attrs
//                (+ special-order config)
//   · Accessory / Others / Service — product code only (+ special-order config)
//
// Legacy / unclassified stock carries an empty key (''). A brand-new line with
// no physical attributes set also resolves to '' so it does not fragment away
// from the unclassified bucket.
// ----------------------------------------------------------------------------
//
// HOUZS VENDOR — Inventory/StockCard wave. Copied verbatim from
// @2990s/shared/variant-key.ts. The Inventory hub + Stock Card only call
// formatVariantKey, but the full module is pure (no imports) so it is vendored
// whole to stay byte-for-byte with the source key contract.

export type InventoryItemGroup =
  | 'sofa'
  | 'bedframe'
  | 'mattress'
  | 'accessory'
  | 'others'
  | 'service';

/** Loose attribute bag — callers map a SO/PO/GRN line onto this shape. */
export type VariantAttrs = {
  fabricCode?: string | null;
  /** Many SO/POS lines store the fabric pick as `colorCode` / `colourCode`
   *  (Commander's variant editor) rather than `fabricCode`. These are aliases
   *  for the SAME physical attribute — the fabric — so the key treats a missing
   *  fabricCode as the colorCode/colourCode. Without this, two bedframes that
   *  differ ONLY by colour collapsed into one bucket (the colour never entered
   *  the key). Fixes the long-standing fabric/colour key mismatch. */
  colorCode?: string | null;
  colourCode?: string | null;
  /** The GRN / Purchase-Invoice / Purchase-Return / Stock-Adjustment variant
   *  editors store the fabric pick under `fabricColor` (schema's variants jsonb
   *  key). Same physical attribute as fabricCode/colorCode — aliased here so a
   *  sofa/bedframe RECEIVED with a fabric isn't keyed/summarised without it
   *  (which left bedframe inbound stock un-matchable to its SO line). */
  fabricColor?: string | null;
  seatHeight?: string | null; // sofa
  /** POS configurator stores the sofa seat-size pick as `depth`
   *  (so-variant-rule declares `depth` ≡ `seatHeight` — same physical axis).
   *  Aliased here exactly like fabricColor so a POS-created sofa keys into the
   *  SAME stock bucket as a Backend-keyed identical sofa. NOTE: rows written
   *  before this fix may sit under legacy keys (POS sofas keyed without
   *  seat/leg) — historical keys are NOT migrated. */
  depth?: string | null; // sofa (POS vocabulary for seatHeight)
  gap?: string | null; // bedframe
  divanHeight?: string | null; // bedframe
  legHeight?: string | null; // sofa + bedframe
  /** POS leg picker stores the sofa leg pick as `sofaLegHeight`
   *  (so-variant-rule: `sofaLegHeight` ≡ `legHeight`). Same aliasing as depth. */
  sofaLegHeight?: string | null; // sofa (POS vocabulary for legHeight)
  totalHeight?: string | null; // bedframe (derived from divan+leg+gap)
  /** Special-order config — labels/specs that change the physical item.
   *  Accepts strings or {code|label} objects; order-independent. */
  specials?: Array<string | { code?: string | null; label?: string | null }> | null;
};

/** Which physical attributes count toward identity, per category, in a fixed
 *  order so the key is deterministic. Specials are appended for every group.
 *  The value type carries `| undefined` because the lookup key is a normalised
 *  free-text `item_group`, not this object's own key set — a MISS is the whole
 *  point of the unknown-group branch below, and typing the miss away is what
 *  let `?? []` silently swallow it for months. */
const ATTRS_BY_GROUP: Record<string, Array<keyof VariantAttrs> | undefined> = {
  sofa: ['fabricCode', 'seatHeight', 'legHeight'],
  bedframe: ['fabricCode', 'gap', 'divanHeight', 'legHeight', 'totalHeight'],
  mattress: [],
  accessory: [],
  others: [],
  service: [],
};

/** Every attribute that counts toward identity for SOME group, in one fixed
 *  order — the union of ATTRS_BY_GROUP. Only the unknown-group path below reads
 *  it; a recognised group still emits exactly its own list, in its own order,
 *  so no existing key moves. */
const ALL_IDENTITY_ATTRS: Array<keyof VariantAttrs> = [
  'fabricCode', 'seatHeight', 'gap', 'divanHeight', 'legHeight', 'totalHeight',
];

/** The slug that fronts an UNRECOGNISED-item_group key. It is deliberately not
 *  a legal attribute slug (`fabriccode` / `seatheight` / `gap` / `divanheight` /
 *  `legheight` / `totalheight` / `special` are the only ones a recognised group
 *  can emit), so a quarantined key can never equal a real variant bucket, and
 *  it is never empty, so it can never equal the unclassified '' bucket either. */
export const UNKNOWN_GROUP_SLUG = '!group';

const norm = (v: unknown): string => (v == null ? '' : String(v).trim().toLowerCase());

/** Read one identity attribute, honouring its alias spellings.
 *  Fabric is stored under any of fabricCode / colorCode / colourCode /
 *  fabricColor (the GRN-family editors use fabricColor) — treat them as one
 *  attribute so colour participates in the bucket identity regardless of which
 *  form wrote the line. Seat / leg get the same treatment for the POS sofa
 *  vocabulary (so-variant-rule axes): seatHeight ← depth, legHeight ←
 *  sofaLegHeight — otherwise a POS sofa and an identical Backend sofa land in
 *  different stock buckets (audit 2026-06-11 I3). Canonical key wins when both
 *  are present. Historical rows are NOT migrated — pre-fix stock may sit under
 *  legacy keys (POS sofas keyed without seat/leg). */
const readAttr = (a: VariantAttrs, k: keyof VariantAttrs): unknown =>
  k === 'fabricCode' ? (a.fabricCode ?? a.colorCode ?? a.colourCode ?? a.fabricColor)
    : k === 'seatHeight' ? (a.seatHeight ?? a.depth)
      : k === 'legHeight' ? (a.legHeight ?? a.sofaLegHeight)
        : (a[k] as unknown);

/** Specials → a normalized, order-independent, comma-joined string. */
const normSpecials = (specials: VariantAttrs['specials']): string => {
  if (!Array.isArray(specials) || specials.length === 0) return '';
  return specials
    .map((s) => (typeof s === 'string' ? s : (s?.code ?? s?.label ?? '')))
    .map(norm)
    .filter(Boolean)
    .sort()
    .join(',');
};

/**
 * Compute the canonical variant key for an inventory line.
 *
 * Deterministic: attributes are emitted in a fixed per-category order, empty
 * values are dropped, and specials are sorted. Identical attribute sets always
 * yield an identical string. Returns '' when nothing meaningful is set
 * (legacy / unclassified bucket).
 *
 * UNRECOGNISED item_group (owner 2026-08-16). `ATTRS_BY_GROUP[group]` used to
 * fall back to `[]`, so a group that is NULL, blank, or simply misspelt
 * ('bedframes', 'bed frame', a typo in an import) DROPPED every attribute the
 * line carried and keyed to '' — the unclassified bucket — no matter what the
 * variants JSON held. That is silent: a bedframe PO line written with a null
 * item_group pooled with, and could be spent on, goods that share nothing with
 * it. An unrecognised group now keys DISTINCTLY instead: `!group=<group>` in
 * front of every identity attribute the line does carry. That key can equal no
 * real variant bucket and no '' bucket, so a mis-grouped line is quarantined —
 * it supplies nothing and nothing supplies it, which surfaces as a visible
 * shortage / unmatched stock rather than as silent substitution.
 *
 * A group with NO identity attributes at all still keys '' — that is the
 * documented legacy/unclassified bucket, it holds real production stock, and
 * re-keying it would move that stock out from under every row that reads it.
 * Quarantine only fires where something was previously being THROWN AWAY.
 */
export function computeVariantKey(
  itemGroup: string | null | undefined,
  attrs: VariantAttrs | null | undefined,
): string {
  const group = norm(itemGroup);
  const a = attrs ?? {};
  const known = ATTRS_BY_GROUP[group];
  const parts: string[] = [];

  if (known === undefined) {
    const quarantined: string[] = [];
    for (const k of ALL_IDENTITY_ATTRS) {
      const val = norm(readAttr(a, k));
      if (val) quarantined.push(`${k.toLowerCase()}=${val}`);
    }
    if (quarantined.length > 0) {
      parts.push(`${UNKNOWN_GROUP_SLUG}=${group || 'none'}`, ...quarantined);
    }
  }

  for (const k of known ?? []) {
    const val = norm(readAttr(a, k));
    if (val) parts.push(`${k.toLowerCase()}=${val}`);
  }

  const sp = normSpecials(a.specials);
  if (sp) parts.push(`special=${sp}`);

  return parts.join('|');
}

/** Human-readable labels for the canonical key's attribute slugs. */
const VARIANT_LABELS: Record<string, string> = {
  '!group': 'Unknown group',
  fabriccode: 'Fabric',
  seatheight: 'Seat',
  gap: 'Gap',
  divanheight: 'Divan',
  legheight: 'Leg',
  totalheight: 'Total H',
  special: 'Special',
};

/**
 * Turn a canonical variant key into a readable label for the UI, e.g.
 * "fabriccode=bf-16|gap=16|legheight=2" -> "BF-16 / GAP 16 / LEG 2".
 *
 * Owner 2026-07-23: unify with the SO/PO/GRN/PI/DR variant summary style
 * (buildVariantSummary — terse " / " separator, bare fabric code, UPPERCASE
 * bedframe/sofa labels). Empty / unclassified -> '' (caller decides how to
 * show it, e.g. "Standard").
 *
 * Was: "Fabric BF-16 · Gap 16 · Leg 2" (labelled + " · ") — retired.
 *
 * Owner 2026-07-24 ("全部包裹 stocks 你也是要看到 supplier 的 fabric code"):
 * optional `fabricSupplierCode` — the supplier's own code for the key's
 * internal fabric, resolved READ-side by the inventory endpoints (batched,
 * fail-soft; see backend scm/lib/fabric-supplier-code.ts). When present +
 * distinct it renders in parens straight after the fabric code — the SAME
 * final format buildVariantSummary uses on document lines:
 * "EZ-002 (KN390-2) / SEAT 28 / LEG 6\"". Absent -> unchanged.
 */
export function formatVariantKey(
  key: string | null | undefined,
  fabricSupplierCode?: string | null,
): string {
  if (!key) return '';
  const sup = (fabricSupplierCode ?? '').trim();
  return key
    .split('|')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return part;
      const slug = part.slice(0, eq);
      const value = part.slice(eq + 1);
      // Fabric code is bare (no "Fabric" prefix — matches buildVariantSummary);
      // everything else upper-cases the slug label to read like the SO summary.
      if (slug === 'fabriccode') {
        const code = value.toUpperCase();
        // Distinct-only, same guard as buildVariantSummary — a supplier code
        // equal to the internal code adds no parens.
        return sup && sup.toUpperCase() !== code ? `${code} (${sup})` : code;
      }
      const label = (VARIANT_LABELS[slug] ?? slug).toUpperCase();
      return `${label} ${value}`;
    })
    .join(' / ');
}
