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
import { AC_DESC2_MAX } from '../../../lib/acColumnWidths';

/** The word the WHOLE system uses for the variant summary. Do not invent a
 *  third name for this string — `pages/scm-v2/so-audit-labels.ts` and every
 *  list column already say "Description 2". */
export const DESCRIPTION_2_LABEL = 'Description 2';

/* AutoCount stores this string as nvarchar(100) and refuses the WHOLE document
   when a line is over — not the field, the document. Three sales orders sat
   outside the account book on 2026-09-09 for four characters each, and nobody
   could see why from any screen: the refusal was a line in a workflow log.

   THE WARNING LIVES HERE for the reason the label does — twelve screens render
   this component, and the thirteenth gains it without remembering to. It is a
   warning and NOT a block: the owner's standing rule is to loosen restrictions
   rather than wall the workflow, and the ERP has to stay usable on a line the
   accounts cannot yet take. Nothing is ever truncated — Desc2 is what the
   factory builds from. */
const OVERRUN_STYLE = {
  fontSize: 10,
  fontWeight: 600,
  color: '#a1442e',
  background: '#fbeae6',
  border: '1px solid #efc9c0',
  borderRadius: 6,
  padding: '1px 5px',
  marginLeft: 6,
  whiteSpace: 'nowrap',
} as const;

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
        {summary.length > AC_DESC2_MAX && (
          <span style={OVERRUN_STYLE} title={`AutoCount stores Description 2 as ${AC_DESC2_MAX} characters and refuses the whole document when a line is over. Shorten the special order or the colour text on this line.`}>
            {summary.length}/{AC_DESC2_MAX} — too long for AutoCount
          </span>
        )}
      </div>
    </div>
  );
};
