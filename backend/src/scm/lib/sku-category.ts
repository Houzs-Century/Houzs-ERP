/* ----------------------------------------------------------------------------
   sku-category — a line's item_group is the SKU's, not the caller's opinion.

   WHY THIS EXISTS. `item_group` is not a label. It is an INPUT TO THE STOCK
   BUCKET: `computeVariantKey(item_group, variants)` composes a sofa's fabric /
   seat / leg into the key ONLY for a sofa or bedframe group — for null or
   `others` it returns `''` by design ("Accessory / Others / Service — product
   code only", shared/variant-key.ts).

   So a document line that reaches the database with a blank group sends its
   goods to the UNCLASSIFIED bucket, and every later reader — the delivery
   order's stock check, the allocator, the dead-stock flag — looks in the sofa
   bucket and finds nothing. The goods are in the warehouse, at the right value,
   with their `variants` jsonb fully intact, and invisible.

   THE VARIANTS ARE NEVER WHAT GOES MISSING. `description2` is built from the
   jsonb alone, so it prints correctly the whole time — which is exactly why the
   symptom reads as impossible from the screen: the specs are right there on the
   document. Only the one word that says HOW TO READ THEM was blank. Owner
   2026-08-22: 「我们的 PO 没有规格 generate 不出的啊？所以应该不可能没有规格？」

   THE SERVER CAN ALWAYS ANSWER THIS, so it should never have to be told. The
   category is a property of the PRODUCT. Owner: 「正常来说就跟着 PO 里面的 SKU
   啊，我的 SKU 也绑定跟 category 了啊」. Fixing a client that loses it leaves the
   next client — mobile, an import, a script — free to lose it again.
   See docs/bugs/0514.
   -------------------------------------------------------------------------- */

/** The shape this helper needs off a request line. */
export type CategoryResolvableLine = {
  materialKind?: unknown;
  itemCode?: unknown;
};

const codeOf = (it: CategoryResolvableLine): string =>
  String(it.itemCode ?? '').trim();

/** The `material_kind` that HAS a product row. Anything else (raw material,
 *  service) has no category to resolve and keeps whatever the caller sent. */
const PRODUCT_KIND = 'mfg_product';

/**
 * `item_code -> category` (lowercased) for every product line in `items`.
 *
 * COMPANY-SCOPED, for the reason grns.ts:287 gives: `code` is shared between the
 * two organisations, so an unscoped read can answer with the other company's
 * product. A null companyId reads unscoped — single-company / pre-migration.
 *
 * Fail-soft: a read error yields an empty map, and every caller then falls back
 * to the value it already had. This helper improves a line; it must never be
 * the reason one cannot be saved.
 */
export async function skuCategoryMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  items: readonly CategoryResolvableLine[],
  companyId: number | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const codes = [...new Set(
    items
      .filter((it) => String(it.materialKind ?? '') === PRODUCT_KIND)
      .map(codeOf)
      .filter((code) => code !== ''),
  )];
  if (codes.length === 0) return out;
  try {
    let q = sb.from('mfg_products').select('code, category').in('code', codes);
    if (companyId != null) q = q.eq('company_id', companyId);
    const { data, error } = await q;
    /* FAIL SOFT, BUT NEVER SILENT. An empty map sends every line back to the
       caller's own value, which is the pre-2026-08-22 behaviour — a product read
       that blipped must not stop a receipt being saved. But a read that failed
       and a catalogue with no rows are different facts, and only one of them is
       somebody's problem: without this line the failure looks exactly like "no
       products matched", and every line silently keeps a category the SKU could
       have corrected. */
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[sku-category] product read failed — lines keep the caller\'s group:', error.message);
      return out;
    }
    for (const r of (data ?? []) as Array<{ code: string; category: string | null }>) {
      const cat = (r.category ?? '').trim().toLowerCase();
      if (cat) out.set(r.code, cat);
    }
  } catch {
    /* Fail-soft — see the contract above. */
  }
  return out;
}

/**
 * The group to STORE on the line: the SKU's, else what the caller sent.
 *
 * The order is the rule. The product master is the single source of truth for
 * what a code IS; a request body is a client's recollection of it.
 */
export function lineItemGroup(
  bySkuCode: Map<string, string>,
  it: CategoryResolvableLine & { itemGroup?: unknown },
): string | null {
  return bySkuCode.get(codeOf(it))
    ?? (typeof it.itemGroup === 'string' && it.itemGroup.trim() !== ''
      ? it.itemGroup
      : null);
}

/**
 * The whole rule as ONE call: `const groupOf = await skuCategoryResolver(...)`,
 * then `groupOf(line)`.
 *
 * Exists so a route adds a single line to adopt this. The call sites that
 * needed it are in files already over their size ceiling, and a rule that costs
 * four lines to adopt is a rule the next route will inline by hand instead —
 * which is exactly how the group came to be lost in the first place.
 */
export async function skuCategoryResolver(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see skuCategoryMap
  sb: any,
  items: readonly CategoryResolvableLine[],
  companyId: number | null,
): Promise<(it: CategoryResolvableLine & { itemGroup?: unknown }) => string | null> {
  const bySkuCode = await skuCategoryMap(sb, items, companyId);
  return (it) => lineItemGroup(bySkuCode, it);
}

/**
 * Rewrite each REQUEST line's `itemGroup` to the SKU's, once, before anything
 * reads it. Returns copies; the input is untouched.
 *
 * WHY A REWRITE RATHER THAN A LOOKUP AT EACH READER — this is the OUTBOUND
 * difference, and it is the reason the inbound helpers above were not enough.
 * An inbound document (PO / GRN / CO) reads the group in ONE place: the row it
 * writes. A delivery order reads it in at least three — the pre-flight stock
 * CHECK, the ship-commitment planner, and the row it stores, whose stored value
 * is what the OUT movement is keyed from later. Three lookups can disagree; one
 * assignment cannot. A line that passed the check against the sofa bucket and
 * then deducted from the unclassified one would be WORSE than the bug being
 * fixed, because the operator's "ship anyway?" answer would have been about a
 * different bucket than the goods left.
 *
 * The rewrite also reaches the readers a per-row helper would have missed:
 * `isServiceLine`, the sofa dye-lot guard and the whole-set guard all read
 * `itemGroup` off the same line objects, so a sofa mis-declared as `others` now
 * meets the guards a sofa is supposed to meet.
 *
 * Fail-soft exactly like `skuCategoryMap`: an unreadable product catalogue
 * yields an empty map and every line keeps the value it arrived with.
 */
export async function resolveItemGroups<
  T extends { itemCode?: unknown; itemGroup?: unknown },
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see skuCategoryMap
  sb: any,
  items: readonly T[],
  companyId: number | null,
): Promise<T[]> {
  const bySkuCode = await skuCategoryMap(
    sb,
    items.map((it) => ({ materialKind: PRODUCT_KIND, itemCode: it.itemCode })),
    companyId,
  );
  return items.map((it) => ({ ...it, itemGroup: lineItemGroup(bySkuCode, it) }));
}

/**
 * The two fields a line derives from its group, together — because they must
 * agree. `description2` is what the document PRINTS; `item_group` is what the
 * stock key is composed from. Built apart, they drift: that is precisely how a
 * purchase order came to print "PC151-12 / SEAT 30" while its receipt keyed the
 * goods into the unclassified bucket (docs/bugs/0514).
 *
 * `summarise` is passed in rather than imported so this module stays free of
 * the variant-rule dependency graph; every caller hands it `buildVariantSummary`.
 */
export function lineIdentityFields(
  groupOf: (it: CategoryResolvableLine & { itemGroup?: unknown }) => string | null,
  it: CategoryResolvableLine & { itemGroup?: unknown; variants?: unknown },
  summarise: (group: string, variants: Record<string, unknown> | null) => string,
): { item_group: string | null; description2: string | null } {
  const item_group = groupOf(it);
  return {
    item_group,
    description2: summarise(
      String(item_group ?? ''),
      (it.variants as Record<string, unknown> | null) ?? null,
    ) || null,
  };
}

/* ── The contradiction detector ────────────────────────────────────────────
   A line that CARRIES physical attributes but whose group does not compose
   them is a contradiction: the operator picked a fabric and a seat size, and
   the stock key is about to ignore both.

   This REPORTS; it does not repair. Changing `computeVariantKey` to compose
   attributes regardless of group would re-key every historical row in the
   ledger — a different and much larger risk than the one being fixed — so the
   rule stays exactly as it is and the contradiction is made LOUD instead.

   Owner 2026-08-22, on why the goods were invisible: 「什么叫判断？为什么不是
   跟着源代码是绝对的？」 The code IS absolute; it executed a rule whose unstated
   precondition — that the group is correct — nobody checked, and said nothing
   when it failed. This is that check. */

/** Attribute keys that only a sofa/bedframe group composes into the key. */
const COMPOSED_ONLY_FOR_SOFA_OR_BEDFRAME = [
  'fabricCode', 'colorCode', 'colourCode', 'fabricColor',
  'seatHeight', 'depth', 'gap', 'divanHeight', 'legHeight', 'sofaLegHeight',
] as const;

const COMPOSING_GROUPS = new Set(['sofa', 'bedframe']);

/**
 * Does this line carry attributes its group will throw away?
 *
 * Returns the offending attribute names, or `[]`. Callers log it — a receipt
 * must never fail to post because its paperwork is self-contradictory; the
 * goods are physically in the building either way.
 */
export function attributesTheGroupWillIgnore(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
): string[] {
  const group = (itemGroup ?? '').trim().toLowerCase();
  if (COMPOSING_GROUPS.has(group)) return [];
  if (!variants) return [];
  return COMPOSED_ONLY_FOR_SOFA_OR_BEDFRAME.filter((k) => {
    const v = (variants as Record<string, unknown>)[k];
    return typeof v === 'string' ? v.trim() !== '' : v != null;
  });
}

/**
 * The stock key, plus a loud line when the group is about to throw the line's
 * own attributes away.
 *
 * Wrapped rather than inlined at the call site because the routes that key
 * stock are all over their size ceiling, and a warning that costs a route eight
 * lines is a warning the next route will leave out.
 *
 * `compute` is passed in for the same reason `summarise` is above: this module
 * stays out of the variant-rule dependency graph.
 */
export function keyedVariantWithWarning(
  docNo: string,
  it: { item_code?: unknown; item_group?: unknown; variants?: unknown },
  compute: (group: string | null, variants: Record<string, unknown> | null) => string,
): string {
  const group = (it.item_group as string | null) ?? null;
  const variants = (it.variants as Record<string, unknown> | null) ?? null;
  const ignored = attributesTheGroupWillIgnore(group, variants);
  if (ignored.length) {
    /* eslint-disable-next-line no-console */
    console.error(
      `[variant-key] ${docNo} ${String(it.item_code ?? '')}: item_group=${JSON.stringify(group)} `
      + `ignores ${ignored.join(', ')} — stock keyed WITHOUT them (docs/bugs/0514)`,
    );
  }
  return compute(group, variants);
}
