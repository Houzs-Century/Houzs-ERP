// Default Free Gift (accessory) — pure, shared by the POS cart reconciler and
// the server SO-create validator. NO voucher codes: a gift is deterministic
// from the trigger's configured `default_free_gifts`. The GIFT is always an
// accessory; the TRIGGER may be a product (matched by id/model) or a sofa combo
// (matched by combo, D9). One gift set per qualifying item (qty scales).
import { parseTargetRefinement, refinementMatchesLine, type TargetRefinement } from './rule-target';

export interface DefaultFreeGift {
  /** mfg_products.id of an ACCESSORY product (the gift). */
  giftProductId: string;
  /** count PER qualifying trigger unit (>= 1). */
  qty: number;
  /** free-text; null/blank => the line shows "Free gift". */
  campaignName: string | null;
  /** Optional gating: when set, the gift only triggers for lines whose
   *  size_code / build compartments match (scope 'variant' / 'compartment').
   *  Absent / scope 'model' = the whole Model (legacy behavior, 2026-06-20). */
  condition?: TargetRefinement;
}

/** A trigger present in the cart/order, with the gifts it grants. */
export interface FreeGiftTrigger {
  /**
   * cart line key (client) or a stable per-line ref (server).
   * MUST be unique per trigger line within a single call — the reconciler
   * keys gift lines off this value.
   */
  triggerKey: string;
  /** product id ('product') or combo id ('combo'). */
  triggerRef: string;
  triggerKind: 'product' | 'combo';
  /** the trigger LINE's qty (gift qty scales by this). */
  triggerQty: number;
  gifts: DefaultFreeGift[];
}

/** A gift line the cart SHOULD contain. */
export interface DesiredFreeGift {
  key: string;
  triggerKey: string;
  giftProductId: string;
  qty: number;
  campaignName: string | null;
}

/** A gift line the order DOES contain (server side), to validate. */
export interface FreeGiftLineClaim {
  idx: number;
  giftProductId: string;
  qty: number;
}

export interface FreeGiftRejection {
  idx: number;
  giftProductId: string;
  reason: 'no_trigger' | 'qty_exceeds_allowance' | 'invalid_qty';
}

/** Deterministic cart-line key so the reconciler can find/replace a gift line. */
export const freeGiftLineKey = (triggerKey: string, entryIndex: number): string =>
  `gift-${triggerKey}-${entryIndex}`;

/** Gift qty = configured-per-trigger × the trigger line's qty, each floored at 1. */
const scaleGiftQty = (giftQty: number, triggerQty: number): number =>
  Math.max(1, giftQty) * Math.max(1, triggerQty);

/** Coerce raw jsonb into clean DefaultFreeGift[] (drops malformed entries). */
export function parseDefaultFreeGifts(raw: unknown): DefaultFreeGift[] {
  if (!Array.isArray(raw)) return [];
  const out: DefaultFreeGift[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const giftProductId = typeof r.giftProductId === 'string' ? r.giftProductId.trim() : '';
    const qty = typeof r.qty === 'number' ? Math.floor(r.qty) : NaN;
    if (!giftProductId || !Number.isFinite(qty) || qty < 1) continue;
    const campaignName =
      typeof r.campaignName === 'string' && r.campaignName.trim() !== '' ? r.campaignName.trim() : null;
    // A 'model'-scope (or absent / malformed) condition is the legacy whole-Model
    // gift — store no condition so non-gated entries serialize unchanged.
    const cond = parseTargetRefinement(r.condition);
    const entry: DefaultFreeGift = { giftProductId, qty, campaignName };
    if (cond && cond.scope !== 'model') entry.condition = cond;
    out.push(entry);
  }
  return out;
}

/** The gift lines the cart should contain, scaled by each trigger's qty. */
export function computeDesiredFreeGifts(triggers: FreeGiftTrigger[]): DesiredFreeGift[] {
  const desired: DesiredFreeGift[] = [];
  for (const t of triggers) {
    t.gifts.forEach((g, i) => {
      desired.push({
        key: freeGiftLineKey(t.triggerKey, i),
        triggerKey: t.triggerKey,
        giftProductId: g.giftProductId,
        qty: scaleGiftQty(g.qty, t.triggerQty),
        campaignName: g.campaignName ?? null,
      });
    });
  }
  return desired;
}

/** A persisted free-gift SO line, for reconciling a placed order. */
export interface ExistingGiftLine {
  id: string;
  giftProductId: string;
  campaignName: string | null;
  qty: number;
}

export interface FreeGiftLineDiff {
  /** New gift lines to insert (one per changed/added bucket). */
  toInsert: { giftProductId: string; campaignName: string | null; qty: number }[];
  /** Existing gift line ids to delete. */
  toDeleteIds: string[];
}

const giftBucketKey = (giftProductId: string, campaignName: string | null): string =>
  `${giftProductId} ${campaignName ?? ''}`;

/**
 * Collapse desired gift lines that are the SAME (giftProductId, campaignName)
 * into ONE line with the summed qty, so the POS cart shows a single
 * "<gift> · Free gift" row instead of one row per trigger (Loo 2026-06-15).
 * Mirrors diffFreeGiftLines' bucketing, so the cart matches the placed SO.
 * The bucket key is deterministic so the cart reconciler matches it stably
 * across recomputes; triggerKey keeps the first contributing trigger as an
 * informational ref (the server re-derives real eligibility regardless).
 */
export function mergeDesiredFreeGifts(desired: DesiredFreeGift[]): DesiredFreeGift[] {
  const byBucket = new Map<string, DesiredFreeGift>();
  for (const d of desired) {
    const bucket = giftBucketKey(d.giftProductId, d.campaignName);
    const cur = byBucket.get(bucket);
    if (cur) cur.qty += d.qty;
    else byBucket.set(bucket, { ...d, key: `gift-${bucket}` });
  }
  return [...byBucket.values()];
}

/**
 * Reconcile a placed SO's existing free-gift lines against the desired set,
 * bucketed by (giftProductId, campaignName). Idempotent: when a bucket's
 * existing total qty already equals the desired total, it is left untouched
 * (no churn). When a bucket's total changed, it is collapsed to a single line
 * at the new desired total (delete the bucket's existing lines, insert one at
 * the desired qty); a bucket with desired 0 is just deleted.
 */
export function diffFreeGiftLines(
  desired: DesiredFreeGift[],
  existing: ExistingGiftLine[],
): FreeGiftLineDiff {
  const desiredByBucket = new Map<string, { giftProductId: string; campaignName: string | null; qty: number }>();
  for (const d of desired) {
    const k = giftBucketKey(d.giftProductId, d.campaignName);
    const cur = desiredByBucket.get(k);
    if (cur) cur.qty += d.qty;
    else desiredByBucket.set(k, { giftProductId: d.giftProductId, campaignName: d.campaignName, qty: d.qty });
  }
  const existingByBucket = new Map<string, { ids: string[]; qty: number; giftProductId: string; campaignName: string | null }>();
  for (const e of existing) {
    const k = giftBucketKey(e.giftProductId, e.campaignName);
    const cur = existingByBucket.get(k);
    if (cur) { cur.ids.push(e.id); cur.qty += e.qty; }
    else existingByBucket.set(k, { ids: [e.id], qty: e.qty, giftProductId: e.giftProductId, campaignName: e.campaignName });
  }

  const toInsert: FreeGiftLineDiff['toInsert'] = [];
  const toDeleteIds: string[] = [];
  const keys = new Set<string>([...desiredByBucket.keys(), ...existingByBucket.keys()]);
  for (const k of keys) {
    const d = desiredByBucket.get(k);
    const ex = existingByBucket.get(k);
    const desiredQty = d?.qty ?? 0;
    const existingQty = ex?.qty ?? 0;
    if (desiredQty === existingQty) continue;          // idempotent no-op
    if (ex) toDeleteIds.push(...ex.ids);               // bucket changed → drop existing
    if (desiredQty > 0 && d) toInsert.push({ giftProductId: d.giftProductId, campaignName: d.campaignName, qty: desiredQty });
  }
  return { toInsert, toDeleteIds };
}

/**
 * Server-side eligibility. Each claimed gift line must be covered by the order's
 * triggers: the gift product must be granted by some trigger, and the TOTAL
 * claimed qty for a gift product must not exceed the SUM of allowances
 * (Σ entry.qty × trigger.qty) across all triggers that grant it.
 */
export function validateFreeGiftClaims(
  claims: FreeGiftLineClaim[],
  triggers: FreeGiftTrigger[],
): { valid: number[]; rejected: FreeGiftRejection[] } {
  const allowance = new Map<string, number>();
  for (const t of triggers) {
    for (const g of t.gifts) {
      const cur = allowance.get(g.giftProductId) ?? 0;
      allowance.set(g.giftProductId, cur + scaleGiftQty(g.qty, t.triggerQty));
    }
  }
  const valid: number[] = [];
  const rejected: FreeGiftRejection[] = [];
  const remaining = new Map(allowance);
  for (const claim of claims) {
    if (!Number.isFinite(claim.qty) || claim.qty < 1) {
      rejected.push({ idx: claim.idx, giftProductId: claim.giftProductId, reason: 'invalid_qty' });
      continue;
    }
    if (!allowance.has(claim.giftProductId)) {
      rejected.push({ idx: claim.idx, giftProductId: claim.giftProductId, reason: 'no_trigger' });
      continue;
    }
    const left = remaining.get(claim.giftProductId) ?? 0;
    if (claim.qty > left) {
      rejected.push({ idx: claim.idx, giftProductId: claim.giftProductId, reason: 'qty_exceeds_allowance' });
      continue;
    }
    remaining.set(claim.giftProductId, left - claim.qty);
    valid.push(claim.idx);
  }
  return { valid, rejected };
}

/**
 * One cart/order line flattened to what trigger-building needs. The caller
 * resolves `gifts` from the line's Model (Map<model_id, DefaultFreeGift[]>) — the
 * builder is key-agnostic and never queries.
 */
export interface TriggerLine {
  /** stable per-line id: cart line key (POS), `idx-${i}` (create), or row id (reconcile). */
  triggerKey: string;
  /** SO line item_code (SKU) — used as a non-sofa trigger ref. */
  itemCode: string;
  /** product category (SOFA / MATTRESS / BEDFRAME / ...). */
  category: string;
  qty: number;
  /** product_models.id of the line's Model (null = orphan SKU → no gift). */
  modelId: string | null;
  /** sofa build grouping (variants.buildKey on the SO); null for non-sofa / single-line sofa. */
  buildKey: string | null;
  /** variants.freeGift present → never a trigger (one-way). */
  isFreeGift: boolean;
  /** mfg_products.size_code (UPPERCASE) for mattress/bedframe; null otherwise.
   *  Required by 'variant'-scope gift conditions (2026-06-20). */
  sizeCode: string | null;
  /** this line's sofa module codes (a split row carries only its own cell;
   *  the builder unions them across the build). [] for non-sofa. */
  builtCompartments: string[];
  /** the line's Model gifts, already resolved by the caller. */
  gifts: DefaultFreeGift[];
}

/**
 * Build the free-gift triggers granted by a set of lines (per-Model, mig 0174).
 *   - a gift line (isFreeGift) is never a trigger (one-way);
 *   - a SOFA line triggers ONE gift per complete sofa — dedup by buildKey
 *     (the split module rows share one buildKey); triggerQty is always 1;
 *   - any other line triggers from its Model's gifts, scaled by the line qty.
 * A gift carrying a `condition` (size / compartment) only fires when the line
 * matches it; for a sofa the build's compartments are UNIONed across its split
 * rows first, so a "build contains CNR" condition resolves identically on create
 * (one sofa line) and reconcile (split rows) — no drift.
 */
export function buildFreeGiftTriggers(
  lines: TriggerLine[],
  comboModulesById: Map<string, string[][]> = new Map(),
): FreeGiftTrigger[] {
  // Union each sofa build's compartments across its (possibly split) rows.
  const buildCompartments = new Map<string, string[]>();
  for (const line of lines) {
    if (String(line.category ?? '').toUpperCase() !== 'SOFA') continue;
    const buildId = line.buildKey ?? line.triggerKey;
    const cur = buildCompartments.get(buildId) ?? [];
    buildCompartments.set(buildId, [...cur, ...line.builtCompartments]);
  }

  const triggers: FreeGiftTrigger[] = [];
  const seenSofaBuilds = new Set<string>();
  for (const line of lines) {
    if (line.isFreeGift) continue;
    if (line.gifts.length === 0) continue;
    const isSofa = String(line.category ?? '').toUpperCase() === 'SOFA';
    const buildId = line.buildKey ?? line.triggerKey;
    const li = {
      category: line.category,
      modelId: line.modelId,
      sizeCode: line.sizeCode,
      builtCompartments: isSofa ? (buildCompartments.get(buildId) ?? line.builtCompartments) : line.builtCompartments,
    };
    const gifts = line.gifts.filter((g) => !g.condition || refinementMatchesLine(li, g.condition, comboModulesById));
    if (gifts.length === 0) continue;
    if (isSofa) {
      if (seenSofaBuilds.has(buildId)) continue;   // one gift per complete sofa
      seenSofaBuilds.add(buildId);
      triggers.push({
        triggerKey:  buildId,
        triggerRef:  line.modelId ?? buildId,
        triggerKind: 'product',
        triggerQty:  1,                          // one complete sofa = one gift; never scale by module-row qty
        gifts,
      });
    } else {
      triggers.push({
        triggerKey:  line.triggerKey,
        triggerRef:  line.itemCode || line.triggerKey,
        triggerKind: 'product',
        triggerQty:  Number(line.qty ?? 1),
        gifts,
      });
    }
  }
  return triggers;
}
