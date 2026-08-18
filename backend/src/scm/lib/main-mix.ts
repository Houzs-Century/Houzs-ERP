// ----------------------------------------------------------------------------
// main-mix — the ONE home for "may a sofa share this order with a bedframe or a
// mattress?" (refusal code `so_sofa_no_other_main`, PR #519, owner rule).
//
// WHY THIS FILE EXISTS. The rule had five hand-written homes and was enforced at
// five of eight places that can put an item code on a line:
//
//   mfg-sales-orders.ts   SO create      inline normCat + MAIN set    GUARDED
//   mfg-sales-orders.ts   SO add-line    soMainMixIntroduced          GUARDED
//   mfg-sales-orders.ts   SO edit-line   soMainMixIntroduced          GUARDED
//   mfg-sales-orders.ts   SO tbc-swap    soMainMixIntroduced          GUARDED
//   mfg-sales-orders.ts   SO amendment   —                            NOTHING
//   consignment-orders.ts CO create      inline normCat + MAIN set    GUARDED
//   consignment-orders.ts CO add-line    —                            NOTHING
//   consignment-orders.ts CO edit-line   —                            NOTHING
//
// Nobody was careless. The reusable form of the rule was a closure INSIDE
// mfg-sales-orders.ts's create handler and a private helper further up the same
// file — nothing another router could call — so the CO line routes were written
// by someone with no way to see it, and the amendment route (the one path that
// can ADD a line without going through POST /:docNo/items) the same. A CO
// created bedframe-only, which create legitimately permits because no sofa is
// present, then accepted a sofa line with nothing refusing it, and every
// downstream consumer that assumes one main category per document (the
// consignment note, the sofa batch guard, the AutoCount per-document item
// derivation) got a shape it was never designed for. Same shape PR #2374 closed
// on the unlinked-line money guard: INSERT paths guarded, EDIT path not.
//
// THREE FORMS, ONE RULE. They are not the same question and must not be
// collapsed into one:
//
//   createMixRefusal    — the whole document arrives at once and nothing is
//                         persisted, so the question is FLAT: does this set of
//                         lines mix?
//   lineMixRefusal      — one line is added / swapped on a document that already
//                         exists, so the question is DIFFERENTIAL: does this
//                         change INTRODUCE a mix that did not exist before? A
//                         pre-rule order that already mixes stays editable
//                         (grandfathered, Loo 2026-06-11). Porting the flat form
//                         to an edit path would make every historic mixed order
//                         uneditable — worse than the bug being fixed.
//   amendmentMixRefusal — the differential form over a whole requested change
//                         set (ADD / REMOVE / SPEC / QTY), applied at SUBMIT.
//
// THE CLASSIFIER IS NOT LOCAL EITHER. Both create paths hand-rolled a `normCat`
// byte-for-byte identical to `so-readiness.normCategory`, and
// `soMainMixIntroduced` hand-rolled a THIRD form (exact `=== 'SOFA'` on the
// catalogue enum, no item_group fallback). They agree on every legal
// `scm.mfg_product_category` value — its members are single uppercase tokens,
// none a substring of another — so unifying on normCategory changes no
// catalogued outcome. What it DOES change is the un-catalogued line: see
// `catOf`.
//
// A READ THAT FAILED IS NOT AN ANSWER. Every function here returns a REFUSAL or
// null, never a bare boolean, because the honest third outcome is "we could not
// tell". `soMainMixIntroduced` discarded its read error, so a five-second
// database blip made every line look absent, the mix look impossible and the
// gate pass silently — a checker that cannot match reporting a clean run. The
// catalogue read is verified by CONSEQUENCE rather than by an error flag:
// validateItemCodes has already proved, in the same request and under the same
// company predicate, that every non-blank code is in mfg_products, so a code
// that does not come back means the read failed, not that the product is gone.
// ----------------------------------------------------------------------------
import { normCategory, MAIN_CATEGORIES } from './so-readiness';
import { loadProductsByCodes } from './mfg-pricing-recompute';

/* The request-scoped Supabase client. This repo has no shared type for it —
   every lib helper this file stands beside takes it untyped (loadProductsByCodes,
   validateItemCodes, recomputeTotals) — so the alias names the reason ONCE here
   instead of repeating an inline disable on four signatures. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the comment above
type Sb = any;

/** The refusal code every path returns. Kept here so a call site cannot invent
 *  a near-miss spelling that authed-fetch's curated message map never sees. */
export const SOFA_MIX_ERROR = 'so_sofa_no_other_main';

/** ONE sentence for a rule that had three. The SO create path said "A sofa Sales
 *  Order cannot also contain a bedframe or mattress. Service and accessory items
 *  are fine.", the CO create path said the same with "order" for "Sales Order",
 *  and the three line paths said "A sofa cannot share a Sales Order with a
 *  bedframe or mattress." — no operator ever saw the difference (the frontend's
 *  curated `ERROR_CODE_MESSAGES` entry wins over `reason` for every surface that
 *  goes through humanApiError), but three sentences for one rule is how the
 *  fourth gets written slightly wrong. This wording is true on every path: it
 *  says nothing about WHERE the mix came from, because create / add / edit /
 *  swap / amend all mean the same thing to the person reading it. */
export const SOFA_MIX_REASON =
  'A sofa cannot share an order with a bedframe or mattress. Service and accessory items are fine.';

/** A refusal ready for `c.json(mix.body, mix.status)`. Returning this rather
 *  than a boolean is what keeps "it mixes" and "we could not tell" distinct. */
export type MixRefusal = { status: 400 | 409; body: { error: string; reason: string } };

/** The 400 the rule itself produces. */
export const sofaMixRefusal = (): MixRefusal =>
  ({ status: 400, body: { error: SOFA_MIX_ERROR, reason: SOFA_MIX_REASON } });

/** The 409 for "the check could not run". Mirrors variantCheckUnavailableResponse
 *  (allowed-options-check.ts): a failed read is ignorance, not permission —
 *  refuse, don't skip the gate. The driver's message goes to the log, never into
 *  the operator's sentence: humanApiError discards any `reason` carrying SQL /
 *  PGRST shapes and falls back to a blank-wall 409. */
const mixCheckUnavailable = (where: string, detail?: string): MixRefusal => {
  /* eslint-disable-next-line no-console */
  console.error(`[main-mix] ${where} read failed — refusing rather than passing the gate:`, detail ?? '(no detail)');
  return {
    status: 409,
    body: {
      error: 'sofa_mix_check_unavailable',
      reason: "Could not check this order's item mix, so nothing was saved. Please try again.",
    },
  };
};

/** The pure predicate: does this set of raw categories put a SOFA next to
 *  another MAIN product? SERVICE / ACCESSORY / OTHERS ride on any order.
 *  Exported so the rule can be unit-tested without a database. */
export function mixesSofaWithOtherMain(rawCategories: Array<string | null | undefined>): boolean {
  const cats = rawCategories.map(normCategory);
  return cats.includes('SOFA') && cats.some((cat) => cat !== 'SOFA' && MAIN_CATEGORIES.has(cat));
}

const clean = (v: unknown): string => String(v ?? '').trim();

/** A line as the create paths hold it, before anything is persisted. */
export type CreateMixLine = { itemCode?: unknown; itemGroup?: unknown };

/** CREATE form. `companyId` is explicit rather than a Hono Context because the
 *  SO create path runs on SoCreateContext, which is not one — same contract as
 *  loadProductsByCodes / validateItemCodes.
 *
 *  A BLANK code is the scan pipeline's DRAFT placeholder (see findFreeTextSoLines
 *  in mfg-sales-orders.ts); it classifies from the client itemGroup and is not
 *  evidence of a failed read. */
export async function createMixRefusal(
  sb: Sb, items: readonly CreateMixLine[], companyId: number | null | undefined,
): Promise<MixRefusal | null> {
  if (items.length === 0) return null;
  const codes = items.map((it) => clean(it.itemCode));
  const byCode = await loadProductsByCodes(sb, codes, companyId);
  const unresolved = codes.filter((code) => code !== '' && !byCode.has(code));
  if (unresolved.length > 0) {
    return mixCheckUnavailable('mfg_products (create)', `${unresolved.length} validated code(s) did not come back`);
  }
  return mixesSofaWithOtherMain(items.map((it) =>
    byCode.get(clean(it.itemCode))?.category ?? (it.itemGroup as string | null | undefined) ?? ''))
    ? sofaMixRefusal()
    : null;
}

/** The line table this rule can be asked about. Both carry `id`, `item_code`,
 *  `item_group`, `doc_no` and `cancelled`, so one body serves both; the CO
 *  table's `cancelled` is the same soft-cancel flag its own router already
 *  filters on (recomputeTotals and the list rollup both `.eq('cancelled',
 *  false)`). */
export type MixLineTable = 'mfg_sales_order_items' | 'consignment_sales_order_items';

/** Read a document's live lines. Binds the error, because "the read failed" and
 *  "the order is empty" are the same `data: null` and mean opposite things to a
 *  gate — an empty order can never mix, so a discarded failure is a silent
 *  pass. */
async function liveLines(sb: Sb, table: MixLineTable, docNo: string): Promise<
  | { ok: true; rows: Array<{ id: string; item_code: string; item_group: string | null }> }
  | { ok: false; detail: string }
> {
  const { data, error } = await sb.from(table)
    .select('id, item_code, item_group')
    .eq('doc_no', docNo).eq('cancelled', false);
  if (error) return { ok: false, detail: String((error as { message?: unknown }).message ?? error) };
  return { ok: true, rows: (data ?? []) as Array<{ id: string; item_code: string; item_group: string | null }> };
}

/* Catalogue category first, stored item_group second — the idiom every other
   category reader in this tree already uses for exactly this situation
   (delivery-planning.ts:573, delivery-zones.ts:342, so-display-branding.ts:133
   are all `productCategory.get(code) ?? normCategory(group)`), and what the
   create paths do with their client-supplied itemGroup. `soMainMixIntroduced`
   was the outlier: catalogue only, so a line whose code is not in this company's
   mfg_products classified as nothing at all and a genuine mix could be built on
   top of it. The fallback fires ONLY when the catalogue row is missing, so it
   can never contradict the catalogue, and it cannot break the grandfathering: a
   more complete `before` set makes `mix(before)` MORE likely, i.e. an
   already-mixed document MORE editable, never less. */
const catOf = (
  byCode: Map<string, { category?: string | null }>, code: string, group: string | null,
): string => byCode.get(code)?.category ?? group ?? '';

/** ADD / EDIT / SWAP form. `excludeItemId` is the line being REPLACED — null for
 *  a pure add. Refuses only when the change INTRODUCES the violation;
 *  grandfathering is the whole point of the `&& !` and must survive any future
 *  edit here. */
export async function lineMixRefusal(
  sb: Sb,
  table: MixLineTable,
  docNo: string,
  excludeItemId: string | null,
  newItemCode: string,
  companyId: number | null | undefined,
): Promise<MixRefusal | null> {
  const newCode = clean(newItemCode);
  const live = await liveLines(sb, table, docNo);
  if (!live.ok) return mixCheckUnavailable(table, live.detail);
  const rows = live.rows;
  const byCode = await loadProductsByCodes(sb, rows.map((r) => r.item_code).concat(newCode), companyId);
  /* validateItemCodes ran on this code moments ago, in this request and under
     this company predicate. Not coming back means the catalogue read failed. */
  if (newCode !== '' && !byCode.has(newCode)) {
    return mixCheckUnavailable('mfg_products (line)', `the validated code ${newCode} did not come back`);
  }
  const before = rows.map((r) => catOf(byCode, r.item_code, r.item_group));
  const after = rows.filter((r) => r.id !== excludeItemId)
    .map((r) => catOf(byCode, r.item_code, r.item_group))
    .concat(byCode.get(newCode)?.category ?? '');
  return mixesSofaWithOtherMain(after) && !mixesSofaWithOtherMain(before) ? sofaMixRefusal() : null;
}

/** One submitted amendment line, in the shape the submit route receives it
 *  (`SubmittedAmendmentLine`, lib/amendment-lines.ts). Only the three fields
 *  that can move a MAIN category are named. */
export type AmendmentMixLine = {
  salesOrderItemId?: string | null;
  changeType?: string | null;
  newItemCode?: string | null;
};

/** AMENDMENT form — the third unguarded home, found while wiring the other two.
 *
 *  `POST /:docNo/amendments` accepts ADD lines (`sales_order_item_id: null`) and
 *  product swaps (`newItemCode` on an existing line). It validated every
 *  requested code against the catalogue and said nothing about composition, and
 *  neither does applySoAmendment — so the one path that can add a line without
 *  going through POST /:docNo/items could put a sofa on a bedframe order.
 *  Applied to the set the amendment would PRODUCE, using applySoAmendment's own
 *  change-type dispatch (SPEC | QTY | ADD | REMOVE, so-revision.ts:432+).
 *
 *  Gated at SUBMIT and deliberately NOT at apply: an amendment already sitting
 *  in the queue when this landed must stay approvable, and the approver is not
 *  the person who can fix it. Same reason the route already refuses unknown
 *  codes at submit — so the requester fixes it, not the approver. */
export async function amendmentMixRefusal(
  sb: Sb, docNo: string, lines: readonly AmendmentMixLine[], companyId: number | null | undefined,
): Promise<MixRefusal | null> {
  const code = (l: AmendmentMixLine) => clean(l.newItemCode);
  const kind = (l: AmendmentMixLine) => clean(l.changeType).toUpperCase();
  /* No requested code, no possible introduction: a QTY / SPEC / remark-only
     amendment cannot move a category, and a REMOVE-only one can only ever make
     the set SMALLER. Exit before the reads so the ordinary amendment pays
     nothing for this gate. */
  const requested = lines.map(code).filter(Boolean);
  if (requested.length === 0) return null;
  const live = await liveLines(sb, 'mfg_sales_order_items', docNo);
  if (!live.ok) return mixCheckUnavailable('mfg_sales_order_items (amendment)', live.detail);
  const rows = live.rows;
  const byCode = await loadProductsByCodes(sb, rows.map((r) => r.item_code).concat(requested), companyId);
  const unresolved = requested.filter((x) => !byCode.has(x));
  if (unresolved.length > 0) {
    return mixCheckUnavailable('mfg_products (amendment)', `${unresolved.length} validated code(s) did not come back`);
  }
  const before = rows.map((r) => catOf(byCode, r.item_code, r.item_group));

  const removed = new Set(lines.filter((l) => kind(l) === 'REMOVE' && l.salesOrderItemId)
    .map((l) => l.salesOrderItemId as string));
  const swappedTo = new Map<string, string>();
  for (const l of lines) {
    if (kind(l) !== 'REMOVE' && l.salesOrderItemId && code(l)) swappedTo.set(l.salesOrderItemId, code(l));
  }
  const after = rows.filter((r) => !removed.has(r.id)).map((r) => {
    const swap = swappedTo.get(r.id);
    return swap ? (byCode.get(swap)?.category ?? '') : catOf(byCode, r.item_code, r.item_group);
  });
  for (const l of lines) {
    if (kind(l) === 'ADD' && code(l)) after.push(byCode.get(code(l))?.category ?? '');
  }
  return mixesSofaWithOtherMain(after) && !mixesSofaWithOtherMain(before) ? sofaMixRefusal() : null;
}
