// ----------------------------------------------------------------------------
// Inventory variant key — the canonical "attribute composition" identity.
//
// MIRRORED BYTE FOR BYTE to frontend/src/vendor/shared/variant-key.ts
// (backend/tests/canonicalVariantKey.test.ts is the referee).
//
// Stock is bucketed by (warehouse_id, item_code, variant_key). Two lines
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

import { normaliseTypographicQuotes } from './mfg-pricing';

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
 *  order so the key is deterministic. Specials are appended for every group. */
const ATTRS_BY_GROUP: Record<string, Array<keyof VariantAttrs>> = {
  sofa: ['fabricCode', 'seatHeight', 'legHeight'],
  bedframe: ['fabricCode', 'gap', 'divanHeight', 'legHeight', 'totalHeight'],
  mattress: [],
  /* SOFA ACCESSORIES (owner 2026-09-14): a custom square / long pillow is made
     per order from the customer's fabric, so its COLOUR is its identity. As an
     `accessory` it keyed on the code alone and MRP gave PC151-01 stock to a
     PC151-02 order. Colour only - no seat, leg or gap.
     THE CODE HAS NO 'sofa' IN IT ON PURPOSE: 41 readers test a group with
     includes('sofa') (pricing, sofa-mix, MRP, readiness, delivery rates), and a
     pillow named sofa_* would be treated as a SOFA main product by every one.
     Shown to people as "Sofa Accessories". tasks/PLAN-sofa-accessories-category.md */
  fabric_accessory: ['fabricCode'],
  accessory: [],
  others: [],
  service: [],
};

const norm = (v: unknown): string =>
  v == null ? '' : normaliseTypographicQuotes(String(v).trim().toLowerCase());

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
 */
export function computeVariantKey(
  itemGroup: string | null | undefined,
  attrs: VariantAttrs | null | undefined,
): string {
  const group = norm(itemGroup);
  const a = attrs ?? {};
  const parts: string[] = [];

  for (const k of ATTRS_BY_GROUP[group] ?? []) {
    // Fabric is stored under any of fabricCode / colorCode / colourCode /
    // fabricColor (the GRN-family editors use fabricColor) — treat them as one
    // attribute so colour participates in the bucket identity regardless of which
    // form wrote the line. Seat / leg get the same treatment for the POS sofa
    // vocabulary (so-variant-rule axes): seatHeight ← depth, legHeight ←
    // sofaLegHeight — otherwise a POS sofa and an identical Backend sofa land
    // in different stock buckets (audit 2026-06-11 I3). Canonical key wins
    // when both are present. Historical rows are NOT migrated — pre-fix stock
    // may sit under legacy keys (POS sofas keyed without seat/leg).
    const raw = k === 'fabricCode'
      ? (a.fabricCode ?? a.colorCode ?? a.colourCode ?? a.fabricColor)
      : k === 'seatHeight'
        ? (a.seatHeight ?? a.depth)
        : k === 'legHeight'
          ? (a.legHeight ?? a.sofaLegHeight)
          : (a[k] as unknown);
    const val = norm(raw);
    if (val) parts.push(`${k.toLowerCase()}=${val}`);
  }

  const sp = normSpecials(a.specials);
  if (sp) parts.push(`special=${sp}`);

  return parts.join('|');
}

/** The variant fields that make up a line's SPEC (identity plus the derived
 *  total and the aliases). A DO line linked to an SO line takes exactly these
 *  from the SO line on the server. */
export const VARIANT_SPEC_FIELDS = [
  'fabricCode', 'colorCode', 'colourCode', 'fabricColor',
  'seatHeight', 'depth', 'seatSize',
  'gap', 'divanHeight', 'legHeight', 'sofaLegHeight', 'totalHeight',
  'specials',
] as const;

/* ── Bucket IDENTITY (PR #5609 follow-up) ─────────────────────────────────────
   computeVariantKey above is unchanged: it is the key every reader and every
   company-1 writer has always computed. What follows only COMPARES keys.

   Two keys name the same physical spec when their canonical forms are equal:
   placeholders ("default", "none", "n/a", blank) are absent; a bedframe's
   derived `totalheight` does not count when gap, divan or leg is present; inch
   marks and words, spaces and hyphens are ignored; specials are order-free.
   Used only for companies that track stock by variant (lib/stock-bucket-key.ts
   decides which): a write there carries a canonically equal stocked bucket's
   own string, because the FIFO trigger matches variant_key exactly. */

const SLUG_ORDER = ['fabriccode', 'seatheight', 'gap', 'divanheight', 'legheight', 'totalheight', 'special'];

const PLACEHOLDERS = new Set(['', 'default', 'none', 'na', 'n/a', 'nil', 'null', 'undefined']);

/** Identity value form: lowercased, quote-folded, inch words and marks, spaces and hyphens removed. */
const identityValue = (v: unknown): string =>
  norm(v)
    .replace(/(\d)\s*(?:inches|inch|in)\b\.?/g, '$1')
    .replace(/["']/g, '')
    .replace(/[\s-]+/g, '');

/**
 * The comparison IDENTITY of any stored or computed key. Idempotent. Two keys
 * name the same stock bucket exactly when their canonical forms are equal.
 * Applies the field rules a key string can carry (placeholders, the derived
 * total) and the value normalisation (inch marks/words, spaces, hyphens).
 */
export function canonicalVariantKey(key: string | null | undefined): string {
  if (!key) return '';
  const values = new Map<string, string>();
  for (const part of String(key).split('|')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const slug = part.slice(0, eq).trim().toLowerCase();
    const raw = part.slice(eq + 1);
    if (slug === 'special') {
      const sp = raw.split(',').map(identityValue).filter((s) => !PLACEHOLDERS.has(s)).sort().join(',');
      if (sp) values.set(slug, sp);
      continue;
    }
    const val = identityValue(raw);
    if (PLACEHOLDERS.has(val)) continue;
    values.set(slug, val);
  }
  if (values.has('gap') || values.has('divanheight') || values.has('legheight')) values.delete('totalheight');
  const ordered = [...values.keys()].sort((x, y) => {
    const ix = SLUG_ORDER.indexOf(x); const iy = SLUG_ORDER.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || x.localeCompare(y);
  });
  return ordered.map((slug) => `${slug}=${values.get(slug)}`).join('|');
}

/** True when two keys name the same stock bucket. */
export function sameVariantBucket(a: string | null | undefined, b: string | null | undefined): boolean {
  return canonicalVariantKey(a) === canonicalVariantKey(b);
}

/**
 * Which stored key a write should use, given the buckets that already exist for
 * the same (warehouse, item_code).
 *
 * The FIFO trigger matches `variant_key` as an exact string, so a new movement
 * that is canonically equal to a stocked bucket must carry THAT bucket's string,
 * or it lands in an empty bucket and goes negative. Order:
 *   1. a bucket with exactly the wanted key — keep it (reversals stay exact);
 *   2. canonically equal buckets — the one holding the most stock, ties by key;
 *   3. none — the wanted key, a new bucket.
 */
export function pickStockBucketKey(
  wanted: string,
  existing: ReadonlyArray<{ variantKey: string | null; qty: number }>,
): string {
  const w = wanted;
  if (existing.some((e) => (e.variantKey ?? '') === w)) return w;
  const id = canonicalVariantKey(w);
  const same = existing
    .filter((e) => canonicalVariantKey(e.variantKey) === id)
    .sort((x, y) => y.qty - x.qty || String(x.variantKey ?? '').localeCompare(String(y.variantKey ?? '')));
  return same[0] ? (same[0].variantKey ?? '') : w;
}

/** Human-readable labels for the canonical key's attribute slugs. */
const VARIANT_LABELS: Record<string, string> = {
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
 * Was: "Fabric BF-16 · Gap 16 · Leg 2" (labelled + " · ") — retired. (This BE
 * copy had drifted behind the FE vendored copy's 2026-07-23 format update —
 * re-synced 2026-07-24 so the pair renders identically again.)
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
