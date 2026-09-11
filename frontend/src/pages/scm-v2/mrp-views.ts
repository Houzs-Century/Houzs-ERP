/* ----------------------------------------------------------------------------
   mrp-views — the MRP page's tab list, derived from the catalogue the SERVER
   reports rather than typed here.

   WHY IT IS DERIVED. A tab is not decoration on this page: it is the ONLY way a
   demand row can be seen. The page asks for `?category=<the tab>` and the engine
   drops everything else before rendering (`if (catFilter && cat !== catFilter)
   continue`, mrp.ts section 6, with no tally), then the page filters what
   survives again with `s.category === <the tab>`. So a category with no tab is a
   category whose demand is planned, given a real quantity, and shown NOWHERE —
   no empty state, no count, no warning. A missing row and a covered row look
   identical here, which is why this class is found on delivery day.

   The four hard-coded tabs were written when `mfg_product_category` had five
   members. It has NINE: migrations 0258-0261 (and their scm twins 0262-0265)
   added DINING, BEDLINES, DIFFUSER and CARPET so the AutoCount catalogue could
   be tagged, and backend/scripts/data/align-skus-houzs-century.json — the
   committed payload align-open-skus.mjs writes into scm.mfg_products for
   company 1 — opens 181 SKUs across those four. Every one of them was stranded.

   `MrpResponse.categories` has carried the answer the whole time: the distinct
   category of every product in the company's catalogue, paged, company-scoped,
   and independent of the category filter (mrp.ts section 2, whose own comment
   calls it "the tab list"). The page simply never read it. Reading it is what
   makes the two expressions ONE.

   WHAT THIS DOES NOT DO: invent a category, or write a second label table. The
   every extra category gets ONE shared tab, labelled "Others" — the owner's
   ruling, and the shape that survives him adding a category at runtime.
   ---------------------------------------------------------------------------- */


export type MrpView = {
  /** The tab's own id — the lower-cased category, or 'others' for the catch-all. */
  value: string;
  /** The `?category=` the tab asks the server for, and the value a row's
   *  `category` must equal to render on it. ONE string, both jobs.
   *  NULL on the Others tab, which asks for everything and then keeps what no
   *  other tab claims — see `OTHERS` below. */
  category: string | null;
  label: string;
};

/* SERVICE is the one member that legitimately has no tab: `isServiceLine` skips
   service lines BEFORE the category filter ("they never create purchase
   demand", mrp.ts), so a Service tab could only ever be empty. Named here
   rather than filtered out silently. */
const NEVER_A_TAB = new Set(['SERVICE']);

/* The four that shipped, with the labels the page has always shown (the
   accessory tab is plural here, which is a wording difference on one screen,
   not a second rule). They stand even when
   `categories` is absent — a response still in flight, or from a backend
   predating the field, must not blank the tab bar. */
const BASE: readonly MrpView[] = [
  { value: 'sofa', category: 'SOFA', label: 'Sofa' },
  { value: 'bedframe', category: 'BEDFRAME', label: 'Bedframe' },
  { value: 'mattress', category: 'MATTRESS', label: 'Mattress' },
  { value: 'accessory', category: 'ACCESSORY', label: 'Accessories' },
];

/* The four the page has always had, as a set — the membership test the Others
   tab is defined against. */
const CORE: ReadonlySet<string> = new Set(BASE.map((v) => v.category as string));

/* ONE tab for everything else — the owner, 2026-09-10: 「应该要放others 一个
   category把」.

   PR #3522 made the tab list derive from the catalogue, which fixed the
   disappearance (DINING / BEDLINES / DIFFUSER / CARPET rows belonged to no tab
   and were dropped twice) but gave each of those four its own tab. He wants the
   four he works from, plus one catch-all.

   IT IS ALSO THE MORE DURABLE SHAPE, which is why it is not merely a preference
   being honoured. `scm.acc_register_item_group()` is SECURITY DEFINER granted to
   `service_role` precisely so a category can be created at runtime; under the
   per-category rule his own new category would grow a tab nobody designed, and
   under this one it lands in Others the moment it exists. A tab bar that changes
   shape when somebody adds a lookup value is a tab bar nobody trusts.

   `category: null` means: ask the server for EVERYTHING (no `?category=`), then
   keep the rows no other tab claims. It cannot be a single `?category=` string
   because it stands for a set — and inventing a fake enum value to put in the
   query string would be a lie the engine would then filter on. */
const OTHERS: MrpView = { value: 'others', category: null, label: 'Others' };

/**
 * The `?category=` a tab id asks for.
 *
 * THE INVERSE OF `value` BELOW, AND THE REASON THIS IS A FUNCTION. The page has
 * to know which category to REQUEST before it has a response to derive tabs
 * from, so the tab id and the category it means cannot be related by a lookup
 * into the derived list without a cycle. They are related by this one pair of
 * expressions instead, and `mrp-views.test.ts` pins the round-trip on every tab
 * — which is the whole point: a tab whose id says one thing while its rows are
 * filtered by another is this bug with extra steps.
 */
export function mrpCategoryOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  /* The Others tab stands for a SET, so it asks for no filter at all and sorts
     the rows out itself (`rowBelongsToView`). Returning 'OTHERS' here would send
     the engine a category no product has, and it would answer with nothing. */
  return v === OTHERS.value ? null : value.trim().toUpperCase();
}

/**
 * The tabs to render for a plan whose catalogue holds `categories`.
 *
 * The four originals first, then every other catalogue category in the order
 * the server sent them. Duplicates and SERVICE are dropped; nothing else is.
 */
export function mrpViews(
  /* Ignored since 2026-09-10, and kept only so callers need not change. Owner,
     seeing the Others tab blink out during every reload: 「loading 的时候它就不见
     了，没有 loading 的时候就有，为什么那么奇怪呢？它的那个组件不是跟正常的
     Matrix、Serena 是一样的吗？」 — he is right. The four core tabs are a constant
     and so are always painted, even while `data` is still loading; Others was
     DERIVED from the loaded `categories`, so it was absent until the response
     arrived and then popped in. A tab that appears a beat after its siblings is
     a tab nobody trusts. Others is now a permanent fifth tab, painted with the
     other four from the first frame, and `rowBelongsToView` still routes rows to
     it by exclusion. An occasional empty Others (a company selling only the four)
     is a fair price for a tab bar whose shape never flickers — and this overrides
     the earlier "show Others only when the catalogue has a non-core category". */
  _categories?: readonly (string | null | undefined)[] | undefined,
): MrpView[] {
  return [...BASE, OTHERS].filter((v) => !NEVER_A_TAB.has(v.category as string)).map((v) => ({ ...v }));
}

/** Does a row belong on this tab? The Others tab claims what no other tab does. */
export function rowBelongsToView(view: MrpView, rowCategory: string | null | undefined): boolean {
  const cat = (rowCategory ?? '').trim().toUpperCase();
  if (view.category !== null) return cat === view.category;
  /* BY EXCLUSION, not by the catalogue list, and that is the load-bearing
     choice. Matching Others against the `categories` the response happened to
     report would strand a row whose category is not in that list — a product
     deleted from the catalogue, a category added between two requests, a row
     the engine kept on its item GROUP rather than a catalogue category (bug
     0777). Exclusion cannot strand anything: every row that is not one of the
     four, and is not SERVICE, has a home. */
  return cat !== '' && !CORE.has(cat) && !NEVER_A_TAB.has(cat);
}
