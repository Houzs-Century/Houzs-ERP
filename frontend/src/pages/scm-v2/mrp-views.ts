
import { isSofaAccessory } from './mrp-sofa-accessory';


export type MrpView = {
  value: string;
  category: string | null;
  label: string;
};

const NEVER_A_TAB = new Set(['SERVICE']);

const BASE: readonly MrpView[] = [
  { value: 'sofa', category: 'SOFA', label: 'Sofa' },
  { value: 'bedframe', category: 'BEDFRAME', label: 'Bedframe' },
  { value: 'mattress', category: 'MATTRESS', label: 'Mattress' },
  { value: 'accessory', category: 'ACCESSORY', label: 'Accessories' },
];

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
  if (view.category === 'SOFA' && isSofaAccessory(cat)) return true;
  if (view.category !== null) return cat === view.category;
  return cat !== '' && !CORE.has(cat) && !NEVER_A_TAB.has(cat) && !isSofaAccessory(cat);
}
