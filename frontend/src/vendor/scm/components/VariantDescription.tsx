// ----------------------------------------------------------------------------
// VariantDescription — consistent rendering of the "Description" column on
// every Convert From picker (GRN ← PO, DO ← SO, SI ← DO, DR ← DO, PI ← GRN,
// PO ← SO). Wei Siang 2026-05-30.
//
// Background: legacy line data stores the variant string into different
// fields depending on which upstream doc it came from — sometimes in
// `description`, sometimes in `variants`, sometimes blank. So rendering the
// raw `description` field directly produces 1-line / 2-line / variant-in-the-
// wrong-place inconsistency across rows.
//
// This component normalises: always show the LIVE variant summary
// (computed from `variants` via buildVariantSummary), and only show the
// stored description text when it actually adds information (non-empty,
// not the item_code repeat, not a stray variant string).
//
// THE VARIANT LINE IS "DESCRIPTION 2", AND IT NOW SAYS SO. Owner 2026-08-21,
// on the PO → GRN picker: 「看不到 description 2 的?」. It WAS rendered — a bare
// grey line under the description — but every field beside it on that screen
// carries a small uppercase label and this one carried none, so it read as
// decoration rather than as the field the rest of the system calls Description
// 2 (SalesOrderDetail's <th>, so-audit-labels.ts, the six list columns and the
// mobile amendment label map all spell it exactly that way). The label lives
// HERE rather than on each picker so all ten consumers gain it at once and no
// eleventh screen has to remember to add it.
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '@2990s/shared';

/** The word the WHOLE system uses for the variant summary. Do not invent a
 *  third name for this string — `pages/scm-v2/so-audit-labels.ts` and every
 *  list column already say "Description 2". */
export const DESCRIPTION_2_LABEL = 'Description 2';

/* Matches the .fieldLabel treatment the PO / GRN line editors use for their
   own small uppercase labels (10px, 600, .06em, uppercase, muted). Inline
   because this component has no stylesheet of its own and is rendered inside
   ten different pages' grids. */
const LABEL_STYLE = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  opacity: 0.75,
  marginRight: 5,
} as const;

export const VariantDescription = ({
  itemCode, itemGroup, variants, description,
  mutedClassName,
}: {
  itemCode: string;
  itemGroup: string | null;
  variants: unknown;
  description: string | null | undefined;
  mutedClassName?: string;
}) => {
  const summary = buildVariantSummary(
    itemGroup ?? '',
    (variants as Record<string, unknown> | null | undefined) ?? null,
  );
  const desc = (description ?? '').trim();
  /* Show the stored description ONLY when it adds info:
       - non-empty
       - not equal to the item code (already shown in the Item Code column)
       - doesn't look like a variant string (no " / " separator — catches the
         legacy rows that stored "BF-01 / DIVAN…" into description) */
  const showDesc = Boolean(desc) && desc !== itemCode && !desc.includes(' / ');
  return (
    <div>
      {showDesc && <div>{desc}</div>}
      <div className={mutedClassName} style={{ fontSize: 'var(--fs-11)' }}>
        <span style={LABEL_STYLE}>{DESCRIPTION_2_LABEL}</span>
        {/* The summary keeps its own element so it is still one findable
            string — a label glued into the same text node would make the row
            read as "Description 2PC151-12 / SEAT 28 / LEG DEFAULT" to anything
            matching on text, tests included. */}
        <span>{summary || 'Standard'}</span>
      </div>
    </div>
  );
};
