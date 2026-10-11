// ----------------------------------------------------------------------------
// line-identity — the ONE home for "how a document line NAMES itself".
//
// WHY THIS FILE EXISTS (read before adding a surface that renders a line):
// the owner reported the SAME defect FOUR times over as many weeks — a line
// showing its description in bold AND repeating the item CODE on a muted second
// line, the same identity twice in one row:
//
//     AKEMI IMMORTAL MATTRESS (152X190X36CM)     <- description
//     AKEMI IMMORTAL MATT (Q)                    <- the code. redundant.
//
//   #616  SO quick-view drawer          fixed on the drawer only
//   #626  mobile SKU picker             fixed on the picker only
//   #623  ASSR list + picker            fixed on those two only
//   #647  SO detail LINE ITEMS          fixed on that table only
//
// Each fix landed on the ONE screen that had been screenshotted, so the rule
// lived in four hand-copied comments and nowhere a fifth surface could find it.
// FIXING THE SCREEN HE POINTS AT IS WHAT CAUSED THE FOURTH REPORT. This module
// is the same move `finance-keys.ts` made on the backend ("the list used to be
// re-declared per route, and every copy drifted") and `fmtMoneyCenti` made on
// the frontend (#647 — one shape, 16 page-local copies).
//
// THE RULE (owner, standing, restated many times — precedent quote, Commander
// 2026-05-27: "picker rows show description only — one scannable line per SKU.
// The code still binds on click"):
//   On a surface that shows a line's DESCRIPTION, the description shows ONCE and
//   the redundant item CODE is NOT displayed.
// It is a DISPLAY rule, not a data rule. The code still BINDS everywhere it
// binds today — sort, search, export, click-through, payload. Nothing in this
// module touches a getValue / searchValue / sortValue / key / aria-label.
//
// HOW THIS FILE ENFORCES THE RULE BY DEFAULT RATHER THAN BY MEMORY:
// `LineIdentity` has NO `code` field. A caller that renders `primary` and
// `secondary` CANNOT put the code on a second line, because the helper never
// hands the code back as something separately renderable — it is an INPUT that
// only ever surfaces as the fallback inside `primary`. A new surface gets the
// rule by calling the helper, not by remembering a comment.
//
// WHAT THIS MODULE DELIBERATELY DOES **NOT** COVER (each is a LEAVE, and each
// one is a way a blind sweep would DESTROY information):
//  - A code in its OWN table COLUMN beside a separate Description column. That
//    is not a duplicated line, it is a scannable field the owner sorts and
//    exports on (SalesOrderDetailListing, DeliveryPlanning, the Convert-From
//    pickers). Do not route those through here.
//  - A row with NO description available. The code is then the only identifier
//    and dropping it makes the row unidentifiable — which is why `primary`
//    falls back to the code rather than going blank (the #647 behaviour).
//  - The VARIANT. This is the trap #647 caught and the most important line in
//    this file. On `DIVAN ONLY BEDFRAME (5FT)` the second line reads
//    `DIVAN ONLY-(Q) · PC151-14 / DIVAN 8" + LEG 8"`. The CODE is redundant; the
//    VARIANT (`PC151-14 / DIVAN 8" + LEG 8"`) appears NOWHERE ELSE on that row,
//    so dropping the whole second line deletes information rather than a
//    duplicate. `secondary` keeps the variant and drops only the code.
//  - Non-sales vocabularies where the code is the PRIMARY identifier rather than
//    an echo — an ASSR case no, a supplier / creditor code, a project code, a
//    product MODEL code. Every owner precedent is sales-side. Do not force this
//    onto a surface where the code is what the row IS.
//
// ORDER-LINE FLAVOUR — `orderLineIdentity` (owner 2026-07-24). A DOCUMENT ORDER
// LINE (SO / PO / DO / SI / PI / PR / GRN detail, their list expansions, the Fair
// Report's selling-&-cost breakdown, the mobile twins) names itself by its item
// CODE, with the variant summary as the subtitle — the product DESCRIPTION is
// dropped ("我们就呈现 Code 就可以了" — presenting the Code is enough). This is the
// mirror image of `lineIdentity` above (description-first), and it exists as its
// own function ON PURPOSE: `lineIdentity` is still correct for NAME/catalog
// surfaces — product & material pickers, the MRP list, the New-SO product grid —
// where the operator scans by NAME, so those must NOT flip to code-first. The two
// are told apart by INTENT at the call site (which function you call), never by a
// fragile "does it carry a variant" guess (the New-SO pickers pass a branding /
// size label as their `variant`, yet want the name). Same `LineIdentity` shape,
// so a call site migrates by renaming the function; the code still BINDS
// everywhere it bound before (getValue / search / sort / payload untouched).
//
// Pure — no I/O, no DOM, no React (this directory is framework-free .ts by
// convention, vendored from 2990). Desktop and mobile are ONE logic layer
// (standing owner rule), so both consume this same function; a rule that lands
// on desktop only is tomorrow's fifth report.
// ----------------------------------------------------------------------------

/** What a line renders. Note the absence of a `code` field — see the header:
 *  the code is an input to the rule, never an output of it. */
export interface LineIdentity {
  /** The ONE line that NAMES the row — the description, or the code when the
   *  row has no description (never both). '' only when the caller passed
   *  neither; call sites that need a placeholder keep their own `|| "—"`. */
  primary: string;
  /** The supporting line — the VARIANT summary, and never the code. null when
   *  there is no variant, or when the variant would merely restate `primary`
   *  (in which case rendering it would re-create the duplicate this module
   *  exists to remove). Render this line only when it is non-null. */
  secondary: string | null;
}

const clean = (v: unknown): string => (v == null ? '' : String(v).trim());

/**
 * Resolve a document line to the ONE description line + its variant line.
 *
 * @param input.code        The item / SKU code. BINDING stays the caller's job;
 *                          here it is only the fallback when there is no
 *                          description. Never rendered on its own line.
 * @param input.description The line's description — what the operator reads.
 * @param input.variant     An ALREADY-BUILT variant summary — normally
 *                          `buildVariantSummary(item_group, variants)` with the
 *                          stored `description2` as the fallback for older rows
 *                          that carry no variants blob. Pass null when the
 *                          surface has no variant vocabulary.
 *
 * @example
 *   const { primary, secondary } = lineIdentity({
 *     code: l.item_code,
 *     description: l.description,
 *     variant: buildVariantSummary(l.item_group ?? '', l.variants ?? null)
 *              || (l.description2 ?? ''),
 *   });
 *   // primary   -> 'DIVAN ONLY BEDFRAME (5FT)'
 *   // secondary -> 'PC151-14 / DIVAN 8" + LEG 8"'   (the code is gone)
 */
export function lineIdentity(input: {
  code?: string | null;
  description?: string | null;
  variant?: string | null;
}): LineIdentity {
  const code = clean(input.code);
  const description = clean(input.description);
  const variant = clean(input.variant);

  // Description ONCE — the code only when there is no description, so a
  // codeless-vocabulary row still names itself and a description-less row stays
  // identifiable (#647 kept exactly this fallback).
  const primary = description || code;

  // The variant is KEPT (it is the only display of fabric / divan / leg / seat
  // on the row) but suppressed when it merely restates the line we already
  // rendered — a variant equal to `primary` is the duplicate, not the identity.
  const secondary = variant && variant !== primary ? variant : null;

  return { primary, secondary };
}

/**
 * ORDER-LINE identity: the item CODE, then the variant summary (owner 2026-07-24,
 * see the "ORDER-LINE FLAVOUR" note in the header). The product description is
 * DROPPED — the code is the identity the owner wants on a document order line, and
 * the variant (`PC151-01 / SEAT 28 / LEG 6"`, supplier code already folded in as
 * "BF-01 (PC151-01)") is the subtitle.
 *
 * Takes the SAME `{ code, description, variant }` shape as `lineIdentity` so a
 * call site migrates by renaming the function — `description` is accepted for that
 * parity and used ONLY as the fallback when a line has no code, so a codeless row
 * (e.g. a free-text service line) still names itself rather than rendering blank.
 *
 * Use this on document order lines; keep `lineIdentity` for name/catalog surfaces
 * (pickers, MRP list) where the operator scans by name — see the header note.
 */
export function orderLineIdentity(input: {
  code?: string | null;
  description?: string | null;
  variant?: string | null;
}): LineIdentity {
  const code = clean(input.code);
  const description = clean(input.description);
  const variant = clean(input.variant);

  // CODE leads; description is only the no-code fallback so a row is never blank.
  const primary = code || description;

  // Variant subtitle, suppressed only when it would merely restate `primary`.
  const secondary = variant && variant !== primary ? variant : null;

  return { primary, secondary };
}
