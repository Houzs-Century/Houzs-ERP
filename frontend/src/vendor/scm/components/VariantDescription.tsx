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

const OVERRUN_STYLE = {
  fontSize: 10,
  fontWeight: 600,
  color: '#a1442e',
  background: 'var(--hz-dk-err-bg, #fbeae6)',
  border: '1px solid #efc9c0',
  borderRadius: 6,
  padding: '1px 5px',
  marginLeft: 6,
  whiteSpace: 'nowrap',
} as const;

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
  const showDesc = Boolean(desc) && desc !== itemCode && !desc.includes(' / ');
  return (
    <div>
      {showDesc && <div>{desc}</div>}
      <div className={mutedClassName} style={{ fontSize: 'var(--fs-11)' }}>
        <span style={LABEL_STYLE}>{DESCRIPTION_2_LABEL}</span>
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
