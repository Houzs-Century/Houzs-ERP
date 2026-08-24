/* ----------------------------------------------------------------------------
   brandingTone — what COLOUR a Branding chip is, in one place.

   THE OWNER'S COMPLAINT (2026-08-21): 「比如 Mattress 和 Sofa 用不一样的颜色，
   要不然 Happy Sleep Mattress 和 Accessories 那些颜色不一样，看起来不是很奇怪
   吗？」 — two mattresses were two different colours. Given the choice between
   one colour for everything and a colour per category, he chose the second:
   「品牌颜色按品类」.

   WHY IT LOOKED RANDOM. Five lists each hand-wrote the same function, and every
   copy matched on the LABEL TEXT rather than on what the line actually is:

       if (s.includes("2990") || s.includes("SOFA")) return "success";
       ...
       return "warning";                       // <- everything else

   So `2990S MATTRESS` matched on "2990" and came out GREEN, while
   `HAPPI.S MATTRESS` matched nothing and fell through to AMBER. Same product
   category, two colours, decided by whose brand name happened to contain a
   digit. The Sales Invoice copy had drifted further still — three tones where
   the other four had four.

   THE RULE NOW: the colour says what the line IS, and the label says whose
   brand it is. Four groups, which are exactly the buckets `brandingCategoryNoun`
   already resolves and `so-branding-label.test.ts` already pins:

       SOFA      success   (green)
       BEDFRAME  accent
       MATTRESS  warning   (amber)
       everything else — accessory, service, dining, bedlines, diffuser,
       carpet, other — neutral

   TWO ENTRY POINTS, AND THE DIFFERENCE MATTERS.

   `brandingToneForCategory` is the truth: it reads the line's own category and
   funnels through the same bucket rule the LABEL uses, so the colour and the
   word can never disagree. Use it wherever the row carries a category.

   `brandingToneForLabel` is a BRIDGE, and it is one on purpose. Three lists —
   Sales Invoice, Delivery Return, Delivery Order — carry only the stored
   `branding` text and no category at all, so there is nothing better to read
   yet. It recovers the bucket from the words the label is built out of, which
   is deterministic for every label this system produces but NOT for arbitrary
   free text. The proper fix is to put the first line's category on those three
   list payloads, the way the Sales Order list already does; until then this is
   the honest approximation and it still fixes the owner's actual complaint,
   because both mattresses now land in the same bucket.
   ---------------------------------------------------------------------------- */

import { brandingCategoryNoun, houseSofaBrandName } from "../vendor/shared/so-branding-label";

export type BrandTone = "success" | "neutral" | "warning" | "accent";

/** The four groups, and the only place a Branding chip's colour is decided. */
const TONE_BY_BUCKET: Record<"SOFA" | "BEDFRAME" | "MATTRESS" | "OTHER", BrandTone> = {
  SOFA: "success",
  BEDFRAME: "accent",
  MATTRESS: "warning",
  OTHER: "neutral",
};

/** The colour for a line whose CATEGORY is known. Preferred everywhere it can
 *  be used, because it shares its bucket rule with the label the chip prints. */
export function brandingToneForCategory(category: string | null | undefined): BrandTone {
  return TONE_BY_BUCKET[brandingCategoryNoun(category).bucket];
}

/* The house sofa brands name no furniture — "ZANOTTI" contains neither "sofa"
   nor anything else the noun match would catch — so a Zanotti sofa would read
   as OTHER and turn grey. Both companies' names are read from the one place
   that owns them rather than re-typed here. */
const SOFA_BRAND_WORDS = [houseSofaBrandName("HOUZS"), houseSofaBrandName("2990")]
  .filter((n): n is string => !!n)
  .map((n) => n.toUpperCase());

/** The colour for a chip where only the LABEL is available. See the header —
 *  this is the bridge, not the rule. Matches on the nouns `brandingLabel`
 *  builds its output from, plus the two house sofa brand names.
 *
 *  MATTRES, not MATTRESS: the stored `branding` text on live documents carries
 *  both spellings, and the shorter one is a prefix of the longer. */
export function brandingToneForLabel(label: string | null | undefined): BrandTone {
  const s = String(label ?? "").trim().toUpperCase();
  if (!s || s === "—") return TONE_BY_BUCKET.OTHER;
  if (s.includes("MATTRES")) return TONE_BY_BUCKET.MATTRESS;
  if (s.includes("BEDFRAME") || s.includes("BED FRAME")) return TONE_BY_BUCKET.BEDFRAME;
  if (s.includes("SOFA") || SOFA_BRAND_WORDS.some((w) => s.includes(w))) return TONE_BY_BUCKET.SOFA;
  return TONE_BY_BUCKET.OTHER;
}
