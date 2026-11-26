
import { Link } from 'react-router-dom';
import { linePoLink, poDetailHref, type LinePoFields } from '../lib/line-po-link';

export function LinePoRefLink({ line, empty = '—', className }: {
  line: LinePoFields;
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
