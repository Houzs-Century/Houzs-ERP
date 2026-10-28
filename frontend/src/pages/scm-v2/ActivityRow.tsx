/* ActivityRow — one dot-and-line entry in a detail page's activity timeline.

   Lifted out of SalesInvoiceDetailV2 unchanged. That file sat three lines under
   the 2,000-line cap, so the change-log wiring could not be added to it without
   first taking something out, and this is the piece that was least entangled
   with the page: four props, no page state, no data fetching.

   The delivery order carried its own copy of the same dots-and-rules markup
   inside a modal that has since been deleted. Point a second page at this one
   rather than pasting it back. */

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type ActivityDot = 'success' | 'primary' | 'muted';

const DOT_CLS: Record<ActivityDot, string> = {
  success: 'bg-synced',
  primary: 'bg-primary',
  muted: 'bg-border-strong',
};

export function ActivityRow({
  title,
  meta,
  dot,
  isLast,
}: {
  title: ReactNode;
  meta: string;
  dot: ActivityDot;
  /* Drops the connecting rule below the dot, so the last entry does not trail
     a line into empty space. */
  isLast?: boolean;
}) {
  return (
    <div className="flex gap-3 pb-3.5">
      <div className="flex flex-col items-center">
        <span className={cn('mt-1 h-2 w-2 rounded-full', DOT_CLS[dot])} />
        {!isLast && <span className="mt-1 w-[2px] flex-1 bg-border-subtle" />}
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">{meta}</div>
      </div>
    </div>
  );
}
