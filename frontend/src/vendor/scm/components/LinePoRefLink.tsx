/* LinePoRefLink — the purchase order a goods-receipt / purchase-invoice line
   came from, as a link to that order (#26). Whether a line HAS one is decided
   by `linePoLink`, not here. */

import { Link } from 'react-router-dom';
import { linePoLink, poDetailHref, type LinePoFields } from '../lib/line-po-link';

export function LinePoRefLink({ line, empty = '—', className }: {
  line: LinePoFields;
  /* What a line with no PO behind it says. A dash on the read grids; the
     receipt editor says "— (manual)" because that is the only way it happens. */
  empty?: string;
  className?: string;
}) {
  const ref = linePoLink(line);
  if (!ref) return <span className="text-ink-muted">{empty}</span>;
  return (
    <Link
      to={poDetailHref(ref.id)}
      className={className ?? 'font-mono text-[12px] font-semibold text-primary-ink hover:underline'}
      title={`Open purchase order ${ref.number}`}
      onClick={(e) => e.stopPropagation()}
    >
      {ref.number}
    </Link>
  );
}
