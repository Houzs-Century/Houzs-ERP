// ----------------------------------------------------------------------------
// so-branding-label — the Branding column's label rule, as ONE total function.
//
// THE OWNER'S COMPLAINT (2026-08-17), which is the whole reason this file
// exists: "不可能的，如果他没有东西的话，只是 service 的话，他也会 mention service
// 的不是吗？… 所以 by right 不应该会有空的 branding 的。"
//
// He is right, and the code disagreed with its OWN documentation about it. The
// previous rule returned the EMPTY STRING for three whole buckets (ACCESSORY /
// SERVICE / OTHERS) and for an SO with no readable line — while two separate
// doc comments above two separate copies of it both promised a non-blank
// fallback:
//
//   frontend/src/pages/scm-v2/ConsignmentOrders.tsx (pre-fix, line 270)
//     "· first item ACCESSORY / OTHERS → "2990" (no dedicated furniture brand)"
//   backend/src/scm/routes/mfg-sales-orders.ts (line 1479)
//     "MATTRESS → first_item_branding (its own brand) ?? "2990 Mattress",
//      else → "2990"."
//
// Both said the fallback was "2990". Both sat above code that returned "". The
// intent was never blank; the implementation just never carried it.
//
// THE INVARIANT THIS MODULE EXISTS TO HOLD, and the only one worth remembering:
//
//     brandingLabel() NEVER returns an empty (or whitespace-only) string,
//     for ANY input, from ANY company.
//
// so-branding-label.test.ts proves it as a PROPERTY over every category value
// the system can produce, and that list is derived from source rather than
// hand-written — see CATEGORY_SOURCES below.
//
// ── WHY THE LIVE CATEGORY LIST IS NOT THE FIVE YOU EXPECT ────────────────────
// The product master's category column is a Postgres enum, and it has been
// EXTENDED four times since the baseline. Derived from source, not memory:
//
//   backend/scripts/scm-schema/2990s-full-schema.sql:14
//     CREATE TYPE mfg_product_category AS ENUM
//       ('SOFA','BEDFRAME','ACCESSORY','MATTRESS','SERVICE')
//   backend/src/db/migrations-pg/0258_mfg_category_dining.sql    -> DINING
//   backend/src/db/migrations-pg/0259_mfg_category_bedlines.sql  -> BEDLINES
//   backend/src/db/migrations-pg/0260_mfg_category_diffuser.sql  -> DIFFUSER
//   backend/src/db/migrations-pg/0261_mfg_category_carpet.sql    -> CARPET
//   (0262-0265 repeat the four on scm.mfg_product_category, which is the enum
//    the LIVE column actually uses — 0265's own header says 0258-0261 hit the
//    WRONG schema.)
//
// Those four arrived for Houzs SKUs, and normCategory (so-readiness.ts:66)
// buckets every one of them as OTHERS — the bucket that used to render blank.
// So the blank Branding cell was never a corner case about accessories: it was
// most of the Houzs catalogue.
//
// ── THE SPEC (owner, 2026-08-18 — supersedes the 2026-08-17 reading) ─────────
//   SOFA      the COMPANY's house sofa brand, not the line's: HOUZS -> "ZANOTTI",
//             2990 -> "2990s Sofa". Stated as two equations —「houzs sofa=zanotti
//             / 2990 sofa=2990s sofa」— and each company sells exactly one sofa
//             brand, so the line's own text is ignored on BOTH sides.
//   MATTRESS  the SKU's branding, for BOTH companies; when the SKU carries none,
//             the category noun ("Mattress"). 「mattress follow SKU branding if
//             SKU no brand mean matress」+「both company also」.
//   BEDFRAME  the bedframe noun, both companies.
//   EVERYTHING ELSE  the truthful category noun ("Accessory", "Service",
//             "Dining", ... , "Other"), never "".
//
// WHAT CHANGED, and why the old wording is not worth resurrecting:
//   · Houzs SOFA used to read the line's brand and print "Sofa" when it was
//     blank. 11 live SKUs (the whole 5526 model family) carry no branding, so
//     that path printed "Sofa" on a Zanotti sofa. The equation removes the
//     dependency instead of asking anyone to keep 724 SKUs filled.
//   · 2990 SOFA read "2990 Sofa"; the owner's own brand master (and his
//     message) spell it "2990s Sofa" — 193 SKUs and the Brands screen agree.
//   · MATTRESS had a "2990 Mattress" fallback and a regex that folded the
//     spellings "2990" / "2990's" / "2990s" into it. Both are GONE: the value
//     now comes from the SKU, and the six live lines that carried those loose
//     spellings resolve through their SKU ("2990s Mattress") instead of through
//     a normalisation table that had to know every spelling in advance.
//
// The SKU is the source for mattresses, so CALLERS must hand this rule the
// SKU's branding — not the line's — whenever the two disagree. Both live
// callers do (so-display-branding.ts and the /mfg-sales-orders list handler);
// their `first_item_branding` is SKU-first for a mattress line.
//
// A Houzs order NEVER falls back to a "2990 ..." label — after this change no
// order of either company does, because no "2990 ..." string is synthesised
// here at all. The only 2990 literal left is the sofa equation.
//
// ── WHAT THIS FILE MAY NOT DO ────────────────────────────────────────────────
// It is MIRRORED byte-for-byte into frontend/src/vendor/shared/so-branding-label.ts
// and backend/scripts/check-shared-mirrors.mjs --strict enforces that in CI
// (.github/workflows/ci.yml:151). So: no imports, no server-only anything. The
// rule is pure, and both trees run the same bytes rather than two copies kept
// in step "by hand" — which is exactly how ConsignmentOrders.tsx came to hold a
// second implementation of it.
// ----------------------------------------------------------------------------

/** Company whose house-brand labels are NOT the 2990 ones. */
const HOUZS = 'HOUZS';

/**
 * Every category value the system can produce, with the source it was read
 * from. The test enumerates THIS — a hand-written list is exactly how a
 * category gets forgotten, and four of these nine were added after the rule
 * this module replaces was written.
 */
export const CATEGORY_SOURCES = {
  /** public/scm.mfg_product_category enum members (schema + migrations 0258-0265). */
  productEnum: ['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE',
                'DINING', 'BEDLINES', 'DIFFUSER', 'CARPET'] as const,
  /** normCategory (backend/src/scm/lib/so-readiness.ts:66) output buckets — what
   *  the SO list, Delivery Planning and the reports actually hand us. */
  normBuckets: ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE', 'OTHERS'] as const,
} as const;

/**
 * Category text -> the noun we are willing to print for it.
 *
 * SUBSTRING matching, in this order, because the input is not always
 * normalised: mfg_sales_order_items.item_group is free TEXT (schema:
 * "item_group" text NOT NULL) and reaches us as things like
 * "BEDFRAME - DIVAN". BEDFRAME is tested FIRST and that ordering is the rule,
 * not an accident — "BEDFRAME + MATTRESS SET" must read as a bedframe
 * (so-display-branding.test.ts pins it).
 *
 * ACCESSOR (no Y) matches accessory AND accessories, as normCategory does.
 * BEDLINE is checked before... nothing that could swallow it, but it is listed
 * after the mains so a hypothetical "BEDFRAME BEDLINES" reads as the bedframe.
 */
const CATEGORY_NOUNS: ReadonlyArray<readonly [needle: string, noun: string]> = [
  ['BEDFRAME', 'Bedframe'],
  ['SOFA', 'Sofa'],
  ['MATTRESS', 'Mattress'],
  ['ACCESSOR', 'Accessory'],
  ['SERVICE', 'Service'],
  ['BEDLINE', 'Bedlines'],
  ['DIFFUSER', 'Diffuser'],
  ['DINING', 'Dining'],
  ['CARPET', 'Carpet'],
];

/** The bucket the branded rules below switch on. Anything unrecognised is
 *  OTHER — which is a routing decision, NOT a licence to print nothing. */
type Bucket = 'SOFA' | 'BEDFRAME' | 'MATTRESS' | 'OTHER';

/** Title Case for a category we have no hand-written noun for, so a category
 *  added to the enum tomorrow still prints something true about itself
 *  ("CARPET" -> "Carpet", "BATH MAT" -> "Bath Mat") instead of "". */
function titleCase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * The truthful noun for a category, and the bucket it routes to.
 *
 * DELIBERATELY A SUPERSET of normCategory rather than a call to it: this takes
 * the RAW enum values too, so a DINING line reads "Dining" and not "Other".
 * normCategory collapses all four of the added enum members into OTHERS, and
 * that collapse is why they rendered blank. so-branding-label.test.ts asserts
 * the two agree on all six normCategory buckets, so this superset cannot drift
 * away from the bucket rule it extends.
 */
export function brandingCategoryNoun(category: string | null | undefined): { bucket: Bucket; noun: string } {
  const raw = (category ?? '').trim();
  if (!raw) return { bucket: 'OTHER', noun: '' };
  const upper = raw.toUpperCase();
  for (const [needle, noun] of CATEGORY_NOUNS) {
    if (upper.includes(needle)) {
      const bucket: Bucket =
        noun === 'Sofa' ? 'SOFA' : noun === 'Bedframe' ? 'BEDFRAME' : noun === 'Mattress' ? 'MATTRESS' : 'OTHER';
      return { bucket, noun };
    }
  }
  /* OTHERS is normCategory's own name for "unrecognised" — printing "Others"
     is honest; printing the raw token would leak an internal bucket name. */
  return { bucket: 'OTHER', noun: upper === 'OTHERS' ? 'Other' : titleCase(raw) };
}

/** The house sofa brand per company. Each company sells exactly one, so these
 *  are the whole SOFA rule — see THE SPEC above. Not a lookup that grows: a
 *  second sofa brand at either company makes the equation false, and the fix
 *  then is to read the SKU again, not to add a row here. */
const SOFA_BRAND_HOUZS = 'ZANOTTI';
const SOFA_BRAND_2990 = '2990s Sofa';

/**
 * The house sofa brand NAME for a company, or null when the company cannot be
 * identified.
 *
 * WHY THIS IS EXPORTED, and why it returns null instead of defaulting.
 * `brandingLabel` below must always print SOMETHING, so its unknown-company
 * case falls to the 2990 reading — that is a LABEL, and a slightly wrong word
 * in a grid cell is recoverable. A LETTERHEAD is not: the SO PDF stamps a
 * brand's LOGO over the company's own, and a document that carries the wrong
 * company's mark is a customer-facing legal document making a false claim
 * about who sold the goods. That happened — the owner found a "2990 HOME SDN.
 * BHD." Sales Order printing the Zanotti mark on 2026-08-21, and production
 * counted 69 orders in that state. So the letterhead caller needs the honest
 * "I do not know", and null is it; the PDF then keeps the company letterhead,
 * which is never wrong.
 *
 * The two equations themselves are unchanged (owner 2026-08-18):
 * 「houzs sofa=zanotti / 2990 sofa=2990s sofa」.
 */
export function houseSofaBrandName(companyCode?: string | null): string | null {
  const code = (companyCode ?? '').trim().toUpperCase();
  if (!code) return null;
  if (code === HOUZS) return SOFA_BRAND_HOUZS;
  if (code === '2990') return SOFA_BRAND_2990;
  /* A THIRD company has no house sofa brand recorded, and inventing one is how
     this defect happened in the first place. Unknown -> null. */
  return null;
}

/**
 * Shown when an order has NO readable line at all (every line cancelled, or
 * none yet). It is not a brand and cannot be mistaken for one, and it does not
 * quietly imply the order is fine — an empty read is never evidence on its own.
 */
export const NO_ITEMS_LABEL = 'No Items';

/**
 * The Branding column's label. NEVER returns "".
 *
 * @param category  the line's category — normCategory bucket OR raw
 *                  mfg_products.category OR raw item_group text; all three
 *                  reach this rule from live callers, so all three are handled.
 * @param branding  that line's own `branding` text, if any.
 * @param companyCode  the owning company's code ("2990" / "HOUZS"). Omitted or
 *                  unrecognised keeps the 2990 reading, which is what every
 *                  caller had before this argument existed.
 */
/* The book's ways of writing "no brand". AutoCount's branding field is free
   text and the floor types a placeholder rather than leaving it empty — 170
   imported company-1 orders carry the literal "NONE" (measured 2026-08-31).
   The import copies it faithfully (copy-never-compute), so it is the READERS
   that must know a placeholder is not a brand: a header carrying one must not
   out-rank the derived label, or a TRION bedframe renders "NONE" where the
   catalog plainly says BEDFRAME (owner, HC-SO-013402).

   Deliberately a SMALL closed list of spellings, not a heuristic: a brand this
   business actually uses must never be swallowed ("Nonesuch" is a brand). */
const PLACEHOLDER_BRAND_TEXTS = new Set(['NONE', 'N/A', 'NA', 'N.A.', 'NIL', 'TBC', 'KIV', '-', '--', '—']);

export function isPlaceholderBrandText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (t === '') return true;
  return PLACEHOLDER_BRAND_TEXTS.has(t.toUpperCase().replace(/\s+/g, ''));
}

export function brandingLabel(
  category: string | null | undefined,
  branding: string | null | undefined,
  companyCode?: string | null,
): string {
  const { bucket, noun } = brandingCategoryNoun(category);
  if (!noun) return NO_ITEMS_LABEL;

  const brand = (branding ?? '').trim();

  if (bucket === 'SOFA') {
    /* The line's brand text is deliberately IGNORED for BOTH companies now.
       2990's side has been pinned this way since 2026-05-28; Houzs joined it on
       2026-08-18 («houzs sofa=zanotti»), which also retires the "Sofa" label
       that the 11 unbranded 5526 SKUs used to produce.

       `?? SOFA_BRAND_2990` keeps this function's own contract EXACTLY as it was
       — an omitted or unrecognised company still reads as 2990, because a
       label may never be blank. It is the letterhead caller, not this one, that
       needs the null; see houseSofaBrandName above for why the two differ. */
    return houseSofaBrandName(companyCode) ?? SOFA_BRAND_2990;
  }

  if (bucket === 'BEDFRAME') {
    /* Both companies print the bedframe noun. See the DEFERRED question in the
       PR: the owner's Houzs list said "Big frame 就显示 big frame", and NO such
       category exists anywhere in this repo, so this uses the system's own
       bedframe label rather than inventing one. */
    return noun;
  }

  if (bucket === 'MATTRESS') {
    /* IDENTICAL for both companies (owner: «both company also»): whatever the
       SKU says — "2990s Mattress", "Happi.S Mattress", "AKEMI", "DUNLOPILLO" —
       and the noun when it says nothing. `brand` is the SKU's value here, not
       the line's; see the caller contract in THE SPEC above. Nothing is
       synthesised: an unbranded mattress reads "Mattress" rather than being
       claimed for a house brand. */
    return brand || noun;
  }

  /* ACCESSORY / SERVICE / DINING / BEDLINES / DIFFUSER / CARPET / OTHERS, both
     companies. The owner's point in one line: a service order still says
     "Service". The category noun is the truthful thing we know. */
  return noun;
}
