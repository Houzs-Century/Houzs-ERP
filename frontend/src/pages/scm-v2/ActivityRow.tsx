
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
