// ----------------------------------------------------------------------------
// Houzs → 2990 Product Maintenance push — pure merge + diff core.
//
// Owner goal (2026-07-17): "我的整个 Product Maintenance 需要传送数据到 POS 系统,
// 给他们去做选择" — the POS staff pick from options maintained in Houzs.
//
// The operative word is 选择 (choose). This module pushes the OPTION LISTS and
// nothing else. It never pushes a price, because of a specific, traced hazard:
//
//   · Houzs writes ONE price (`priceSen` = COST, owner rule 2026-06-22) and
//     deliberately omits `sellingPriceSen` — migrations-pg/0030 says so in as
//     many words.
//   · 2990's POS charges the customer from `sellingPriceSen` ALONE
//     (apps/pos/src/lib/queries.ts:720 `surcharge: Math.round(o.sellingPriceSen
//     ?? 0) / 100`).
//   · 2990's only config write endpoint takes the WHOLE blob, and the POS
//     subscribes to `maintenance_config_history` via Supabase Realtime
//     (queries.ts:1474), so a write reaches the tablets in ~300ms with no
//     deploy and no error.
//
// A naive whole-blob push therefore zeroes 2990's live selling prices, silently,
// on the tablets, mid-sale. That is the `?? 0`-hides-ignorance class this repo
// has already paid for three times in one day. Hence:
//
//   1. READ-MODIFY-WRITE only. `merge()` starts from 2990's OWN blob and adds
//      to it. It never starts from Houzs's.
//   2. For a value present on BOTH sides, 2990's entry is preserved BYTE-FOR-
//      BYTE — we do not even rewrite its label. 2990 owns its retail pricing
//      (D1, originating-system ownership).
//   3. `assertNoPriceLoss()` re-derives every price anchor from the before and
//      after blobs and REFUSES the push if any one of them moved. This is a
//      backstop, not the primary mechanism: if the merge is correct it can
//      never fire. It exists because "the merge is correct" is exactly the
//      assumption that cost us those three bugs. Assert, don't assume.
//
// Nothing here performs I/O. The route (routes/maintenance-push.ts) owns the
// HTTP; this file owns the decisions, so they are unit-testable without a
// network or a database.
// ----------------------------------------------------------------------------

import { maintEntryValue, maintEntryActive, type MaintPoolEntry } from '../shared/maintenance-pools';

/** The pools Houzs is allowed to push: PURE CHOICE-LISTS. Every one of these is
 *  a list of things a POS operator picks from, and none of them carries 2990's
 *  retail price. This allow-list IS requirement 2 ("do NOT push any pool's price
 *  field") expressed as code — a pool absent from here cannot be pushed even if
 *  a caller names it explicitly, because the refusal is generated from this set
 *  rather than from a convention someone has to remember.
 *
 *  Deliberately ABSENT (2990 prices these; a push would be a price write):
 *    divanHeights, totalHeights, legHeights, specials, sofaLegHeights,
 *    sofaSpecials, sofaCompartmentMeta.
 *
 *  Deliberately ABSENT for a different reason — `sizeLabels`. It was in the
 *  original scope for this build, and it is dropped on evidence:
 *    · It is not a list. It is a Record<sizeCode, {label, dimensions}> — a
 *      DISPLAY-LABEL OVERRIDE map (apps/pos/src/lib/products/size-info.ts:48
 *      "Commander edits sizeLabels", apps/api/src/routes/product-models.ts:437).
 *      Nobody picks a sizeLabel. It renames what a size is called.
 *    · Houzs deliberately does not populate it: migrations-pg/0027 says the
 *      "sizeLabels override map is only for commander relabels, so it is NOT"
 *      seeded, and 0029 repeats it. There is nothing on the Houzs side to send.
 *    · Pushing it would overwrite 2990's own labels, which 2990's Commander
 *      maintains — D1 (originating-system ownership) says those are 2990's.
 *  Adding it back is an owner decision, not a code change to slip in. */
export const PUSHABLE_POOLS = [
  'gaps',
  'sofaSizes',
  'bedframeSizes',
  'mattressSizes',
  'sofaCompartments',
  'brandings',
  'supplierCategories',
] as const;

export type PushablePool = (typeof PUSHABLE_POOLS)[number];

/** Every key anywhere in the blob that carries money. `priceSen` is included
 *  even though Houzs treats it as COST: on 2990 it is 2990's number (e.g. the
 *  live master's totalHeights `10"` carries priceSen=40000 with NO selling
 *  price), and D1 says 2990 owns it. The anchor check is about not MOVING a
 *  number we do not own — not about what the number means. */
const PRICE_KEYS: ReadonlySet<string> = new Set([
  'sellingPriceSen',
  'costSen',
  'defaultPriceCenti',
  'priceSen',
]);

export type ConfigBlob = Record<string, unknown>;

export interface PriceAnchorLoss {
  /** Value-anchored path, e.g. `divanHeights[#10"].sellingPriceSen`. */
  anchor: string;
  before: string;
  after: string | null;
  reason: 'removed' | 'changed';
}

export interface PoolDiff {
  pool: PushablePool;
  /** 2990 has no such pool. Pushing would CREATE it there. */
  remoteMissing: boolean;
  /** Houzs has no such pool — nothing to push, pool skipped entirely. */
  localMissing: boolean;
  /** Present on both. 2990's entry is preserved verbatim. These are the values
   *  that WORK today: an operator can already pick them. */
  matched: string[];
  /** Houzs-only AND active → would be added to 2990's pool. */
  additions: string[];
  /** Houzs-only but switched OFF in Houzs → never introduced to 2990. */
  houzsOnlyInactive: string[];
  /** 2990-only → PRESERVED by default (never silently dropped). */
  remoteOnly: string[];
  /** 2990-only entries that would be dropped — only ever non-empty when the
   *  caller explicitly passed allowRemovals. */
  removals: string[];
  /** Matched, but Houzs says inactive while 2990 says active. NOT applied —
   *  reported so the divergence is visible instead of silently resolved. */
  activeDivergence: string[];
  /** additions AND remoteOnly both non-empty on sofaCompartments — the exact
   *  shape of a RENAME (see SOFA_COMPARTMENT_RENAME below). */
  renameSuspect: boolean;
}

export interface Refusal {
  code: string;
  pool?: string;
  message: string;
  detail?: unknown;
}

export interface MergeResult {
  /** The blob to POST back to 2990 — 2990's own blob plus Houzs's additions.
   *  ALWAYS ignore this when `refusals` is non-empty. */
  merged: ConfigBlob;
  diffs: PoolDiff[];
  refusals: Refusal[];
  /** True when nothing would change on 2990 — the push is a no-op. */
  noop: boolean;
}

export interface MergeOptions {
  /** Defaults to PUSHABLE_POOLS. */
  pools?: readonly string[];
  /** Compute and apply removals of 2990-only values. OFF by default: an option
   *  the owner deleted in Houzs is not, on its own, evidence that 2990 should
   *  stop offering it — 2990 has its own catalogue (D1). */
  allowRemovals?: boolean;
}

// --- tolerant readers --------------------------------------------------------
// The LOCAL (Houzs) side is read through the shared helpers, so the push reads
// Houzs's pools with exactly Houzs's own ACTIVE semantics (owner spec
// 2026-06-12) and cannot drift from the rest of the app.
//
// The REMOTE (2990) side gets its own tolerant reader on purpose: that blob is
// not ours and carries shapes Houzs does not model (CfgPricedOption, HOOKKA's
// inert `packSeparately`, and whatever 2990 adds next). Parsing it through
// Houzs's stricter type would be a lie about who owns the shape, and a shape we
// fail to parse must be PRESERVED, never dropped.

/** Unwrap a remote entry to its value string, or null when the entry has no
 *  readable value. A null here means "we do not understand this entry" — the
 *  caller must keep it, not drop it. */
function remoteEntryValue(e: unknown): string | null {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const v = (e as { value?: unknown }).value;
    if (typeof v === 'string') return v;
  }
  return null;
}

/** True when a remote entry carries ANY money key, at any value including 0.
 *  Zero counts: 2990 setting a price to 0 is still 2990 having priced it, and
 *  deleting the entry would delete that decision. */
function remoteEntryIsPriced(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  return Object.keys(e as object).some((k) => PRICE_KEYS.has(k));
}

const asArray = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

/** JSON round-trip clone. The blob IS JSON (it round-trips through jsonb and
 *  HTTP), so this is exact for every value it can legally hold, and it cannot
 *  smuggle a live reference into the outgoing payload the way a shallow copy
 *  could. */
function cloneBlob(b: ConfigBlob): ConfigBlob {
  return JSON.parse(JSON.stringify(b)) as ConfigBlob;
}

/** Stable JSON encoding for anchor comparison. `undefined` is distinguished
 *  from the absent case by the caller (a missing anchor is `removed`). */
function encode(v: unknown): string {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

/** Address an array element by its own `value` when it has one, so that
 *  inserting or reordering entries does NOT shift every later anchor and
 *  produce a storm of false "price changed" reports. Falls back to the index
 *  for entries with no readable value. */
function elementKey(el: unknown, i: number): string {
  const v = remoteEntryValue(el);
  return v === null ? String(i) : `#${v}`;
}

/**
 * Walk a config blob and collect every money value, keyed by a value-anchored
 * path. This is the mechanism behind requirement 1's "assert this in code, not
 * by convention".
 */
export function collectPriceAnchors(blob: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((el, i) => walk(el, `${path}[${elementKey(el, i)}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const child = path ? `${path}.${k}` : k;
        if (PRICE_KEYS.has(k)) out.set(child, encode(v));
        else walk(v, child);
      }
    }
  };
  walk(blob, '');
  return out;
}

/**
 * Every money value present on 2990 BEFORE must still be present, at the same
 * anchor, with the same encoding, AFTER. Returns the violations; empty means
 * the merge is price-neutral.
 *
 * Note it is deliberately one-directional: `after` may contain price anchors
 * `before` lacked (2990 could add an option while we compute). We only assert
 * that we destroyed nothing.
 */
export function assertNoPriceLoss(before: unknown, after: unknown): PriceAnchorLoss[] {
  const b = collectPriceAnchors(before);
  const a = collectPriceAnchors(after);
  const losses: PriceAnchorLoss[] = [];
  for (const [anchor, was] of b) {
    const now = a.get(anchor);
    if (now === undefined) losses.push({ anchor, before: was, after: null, reason: 'removed' });
    else if (now !== was) losses.push({ anchor, before: was, after: now, reason: 'changed' });
  }
  return losses;
}

// --- the sofaCompartments rule ----------------------------------------------
// apps/api/src/routes/maintenance-config.ts:210-240 exposes
// rename_sofa_compartment(), which rewrites the SKU master, EVERY SO / DO /
// invoice / GRN / PO line snapshot, Modular ticks, combos and in-flight carts.
// This module never calls it — there is no code path here that can.
//
// But a rename does not need that endpoint to happen. Pushing a blob that drops
// `Console` and adds `CSL` IS a rename, and it is strictly WORSE than the
// cascading one: the cascade at least rewrites the documents to match, whereas
// the blob edit leaves every document still carrying `Console` while the pool
// no longer offers it — orphaned values, no error, no alarm.
//
// We cannot distinguish {rename A→B} from {independent add B, independent
// remove A} by looking at two lists. So we refuse the shape: on
// sofaCompartments, an addition and a removal in the SAME push is refused. Add
// alone is fine. Remove alone is fine. Both together is a rename until the
// owner says otherwise, and a rename is a mass document rewrite, not a config
// edit.
const SOFA_COMPARTMENTS: PushablePool = 'sofaCompartments';

/**
 * Build the merged blob: 2990's config plus the option-list values Houzs owns.
 *
 * The result is only safe to send when `refusals` is empty. The caller MUST
 * check; `merged` is still returned on refusal so the diff report can show what
 * WOULD have been sent.
 */
export function mergeMaintenanceConfig(
  remote: ConfigBlob,
  local: ConfigBlob,
  opts: MergeOptions = {},
): MergeResult {
  const refusals: Refusal[] = [];
  const diffs: PoolDiff[] = [];
  const requested = opts.pools ?? PUSHABLE_POOLS;
  const allowRemovals = opts.allowRemovals === true;

  // Requirement 2, enforced rather than documented: a pool outside the
  // allow-list is refused by name, before any merging happens.
  const pools: PushablePool[] = [];
  for (const p of requested) {
    if ((PUSHABLE_POOLS as readonly string[]).includes(p)) pools.push(p as PushablePool);
    else
      refusals.push({
        code: 'pool_not_pushable',
        pool: p,
        message:
          `"${p}" is not a pushable pool. Houzs pushes the option lists only. ` +
          `2990 owns its own retail pricing, so priced pools are never sent.`,
      });
  }

  // READ-MODIFY-WRITE: the merged blob STARTS as 2990's. Every key we do not
  // touch survives by construction, including the 7 priced pools.
  const merged = cloneBlob(remote);
  let changed = false;

  for (const pool of pools) {
    const remoteRaw = remote[pool];
    const localRaw = local[pool];
    const remoteList = asArray(remoteRaw);
    const localList = asArray(localRaw);

    // A pool that EXISTS but is not a list is not a pool we understand. Skipping
    // it silently would be the exact failure mode this feature exists to
    // prevent: a push that reports success while quietly doing nothing (or, if
    // we "helpfully" coerced it, while overwriting a map with an array).
    // `sizeLabels` is the known case (a Record, not a list) and is already out
    // of PUSHABLE_POOLS; this catches the next one.
    if (localRaw != null && !localList) {
      refusals.push({
        code: 'local_pool_not_a_list',
        pool,
        message: `Houzs's "${pool}" is not a list of options, so it cannot be pushed as one. This needs a look before it is sent anywhere.`,
        detail: { type: Array.isArray(localRaw) ? 'array' : typeof localRaw },
      });
      continue;
    }
    if (remoteRaw != null && !remoteList) {
      refusals.push({
        code: 'remote_pool_not_a_list',
        pool,
        message: `2990's "${pool}" is not a list of options. Refusing to merge into a shape we do not understand.`,
        detail: { type: Array.isArray(remoteRaw) ? 'array' : typeof remoteRaw },
      });
      continue;
    }

    if (!localList) {
      diffs.push({
        pool,
        remoteMissing: !remoteList,
        localMissing: true,
        matched: [],
        additions: [],
        houzsOnlyInactive: [],
        remoteOnly: remoteList ? remoteList.map((e, i) => remoteEntryValue(e) ?? `<unreadable#${i}>`) : [],
        removals: [],
        activeDivergence: [],
        renameSuspect: false,
      });
      continue;
    }

    // NOT a `?? []` that hides ignorance: the guard above has already refused
    // the case where 2990 HAS this pool in a shape we cannot read. Reaching
    // here with no list means remoteRaw was null — 2990 genuinely has no such
    // pool — which is an established fact, not an unknown, and is reported as
    // `remoteMissing` rather than silently absorbed.
    const base: unknown[] = remoteList === undefined ? [] : remoteList;
    const remoteValues: string[] = [];
    const remoteByValue = new Map<string, unknown>();
    for (const e of base) {
      const v = remoteEntryValue(e);
      // An unreadable entry is kept in `merged` (it is already in the clone)
      // but takes no part in matching — we will not reason about a shape we
      // cannot read.
      if (v === null) continue;
      remoteValues.push(v);
      remoteByValue.set(v, e);
    }
    const remoteSet = new Set(remoteValues);

    // Houzs's side, read with Houzs's own semantics.
    const entries = localList as MaintPoolEntry[];
    const localAll: string[] = [];
    const localActive = new Set<string>();
    for (const e of entries) {
      const v = maintEntryValue(e);
      if (typeof v !== 'string' || v === '') continue;
      localAll.push(v);
      if (maintEntryActive(e)) localActive.add(v);
    }
    const localAllSet = new Set(localAll);

    const matched = localAll.filter((v) => remoteSet.has(v));
    const additions = localAll.filter((v) => !remoteSet.has(v) && localActive.has(v));
    const houzsOnlyInactive = localAll.filter((v) => !remoteSet.has(v) && !localActive.has(v));
    const remoteOnly = remoteValues.filter((v) => !localAllSet.has(v));
    const activeDivergence = matched.filter((v) => !localActive.has(v));

    const removals = allowRemovals ? [...remoteOnly] : [];
    const renameSuspect = pool === SOFA_COMPARTMENTS && additions.length > 0 && remoteOnly.length > 0;

    diffs.push({
      pool,
      remoteMissing: !remoteList,
      localMissing: false,
      matched,
      additions,
      houzsOnlyInactive,
      remoteOnly,
      removals,
      activeDivergence,
      renameSuspect,
    });

    // --- refusals for THIS pool ---------------------------------------------
    if (pool === SOFA_COMPARTMENTS && additions.length > 0 && removals.length > 0) {
      refusals.push({
        code: 'sofa_compartment_rename_refused',
        pool,
        message:
          'Refusing to add and remove sofa compartments in the same push. That is ' +
          'indistinguishable from a rename, and a rename rewrites the SKU master and ' +
          'every SO / DO / invoice / GRN / PO line snapshot on 2990. Push the addition ' +
          'and the removal separately, or do the rename in 2990 where the cascade runs.',
        detail: { additions, removals },
      });
    }

    for (const v of removals) {
      const entry = remoteByValue.get(v);
      if (remoteEntryIsPriced(entry)) {
        refusals.push({
          code: 'removal_would_drop_price',
          pool,
          message:
            `Refusing to remove "${v}" from ${pool}: 2990 has priced that option. ` +
            `Removing it here would delete 2990's price. 2990 owns its retail pricing.`,
          detail: { value: v, entry },
        });
      }
    }

    // --- apply ---------------------------------------------------------------
    // Matched values are NOT rewritten. 2990's entry stays exactly as it is,
    // which is what preserves sellingPriceSen / costSen / priceSen for the 4
    // priced divanHeights and everything like them.
    const kept = base.filter((e) => {
      const v = remoteEntryValue(e);
      if (v === null) return true; // unreadable → keep, never drop
      return !removals.includes(v);
    });
    // Additions land as PLAIN STRINGS — the historic active shape, which both
    // Houzs (maintEntryValue) and 2990's POS (`typeof g === 'string' ? g :
    // g?.value`) already read. A bare string carries no price, so an added
    // option cannot assert a price 2990 did not set.
    const next = [...kept, ...additions];
    if (removals.length > 0 || additions.length > 0) {
      merged[pool] = next;
      changed = true;
    }
  }

  // --- the backstop ----------------------------------------------------------
  // Independent of every rule above: re-derive the money anchors from the blob
  // we are actually about to send and compare against the blob 2990 actually
  // has. If a single number moved, refuse. If the merge is right this never
  // fires — which is the point of keeping it.
  const losses = assertNoPriceLoss(remote, merged);
  if (losses.length > 0) {
    refusals.push({
      code: 'price_loss_detected',
      message:
        `Refusing to push: ${losses.length} price value(s) on 2990 would be lost or changed. ` +
        `This is a bug in the merge, not a configuration problem — the push is blocked.`,
      detail: losses,
    });
  }

  return { merged, diffs, refusals, noop: !changed };
}

/** Roll the per-pool diffs into the single number that decides whether this
 *  feature is usable: of the values Houzs would offer, how many does 2990
 *  already understand, and how many are new. */
export function summariseDiff(diffs: readonly PoolDiff[]): {
  matched: number;
  additions: number;
  houzsOnlyInactive: number;
  remoteOnlyPreserved: number;
  activeDivergence: number;
  renameSuspects: string[];
} {
  const sum = (f: (d: PoolDiff) => number) => diffs.reduce((a, d) => a + f(d), 0);
  return {
    matched: sum((d) => d.matched.length),
    additions: sum((d) => d.additions.length),
    houzsOnlyInactive: sum((d) => d.houzsOnlyInactive.length),
    remoteOnlyPreserved: sum((d) => d.remoteOnly.length - d.removals.length),
    activeDivergence: sum((d) => d.activeDivergence.length),
    renameSuspects: diffs.filter((d) => d.renameSuspect).map((d) => d.pool),
  };
}
