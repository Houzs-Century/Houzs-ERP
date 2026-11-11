// Carriers & Rates: the pieces its three tabs share, in the Coverage & Fleet
// look (bg-surface / text-ink / border-border, primary #16695f).
import type { ReactNode } from 'react';
import { fmtSen } from '@2990s/shared';
import { cn } from '../../../lib/utils';

export const CARD = 'rounded-2xl border border-border bg-surface';
export const LABEL = 'text-[12.5px] font-semibold text-ink-secondary';
export const HINT = 'text-[12px] leading-snug text-ink-muted';
export const INPUT = 'min-h-[40px] w-full rounded-lg border border-border bg-surface px-3 text-[14px] text-ink';
export const EYEBROW = 'text-[12px] font-bold uppercase tracking-[0.06em] text-ink-muted';
export const BTN_PRI = 'inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-primary px-4 text-[13.5px] font-semibold text-white disabled:opacity-60';
export const BTN_QUIET = 'inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-surface-2 px-4 text-[13.5px] font-semibold text-ink disabled:opacity-60';
export const ICON_BTN = 'grid h-9 w-9 flex-none place-items-center rounded-lg bg-surface-2 text-ink-secondary hover:text-[color:var(--hz-dk-err,#8a2c2c)] disabled:opacity-50';

const TONE = {
  green: 'bg-[color:var(--hz-dk-synced-bg,#dcebe3)] text-[#1f5c43]',
  red: 'bg-[color:var(--hz-dk-err-bg,#f6dcdc)] text-[color:var(--hz-dk-err,#8a2c2c)]',
  amber: 'bg-[color:var(--hz-dk-warning-bg,#f6ecd4)] text-[#7a5000]',
  blue: 'bg-[color:var(--hz-dk-surface-2,#e7eef6)] text-[#1f4f75]',
  grey: 'bg-surface-2 text-ink-muted',
} as const;
export type Tone = keyof typeof TONE;

export const Pill = ({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) => (
  <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold', TONE[tone], className)}>{children}</span>
);

/** Billed less the rate card. Over the card is red, under it amber, equal green,
 *  and no card grey: the colour says which way to look before the number does. */
export const diffTone = (v: number | null): Tone => (v == null ? 'grey' : v === 0 ? 'green' : v > 0 ? 'red' : 'amber');
export const diffText = (v: number | null): string =>
  (v == null ? 'no rate card' : v === 0 ? 'matches' : `${v > 0 ? '+' : '−'}${fmtSen(Math.abs(v))}`);
export const DiffPill = ({ v }: { v: number | null }) => <Pill tone={diffTone(v)} className="tabular-nums">{diffText(v)}</Pill>;

/** One figure in a tab's summary strip. */
export const Kpi = ({ label, value, sub, tone }: { label: string; value: ReactNode; sub: ReactNode; tone: Tone | null }) => (
  <div className={cn(CARD, 'flex min-w-0 flex-col gap-1 px-4 py-3.5')}>
    <span className={EYEBROW}>{label}</span>
    <span className={cn('text-[22px] font-bold tabular-nums leading-tight',
      tone === 'red' ? 'text-[color:var(--hz-dk-err,#8a2c2c)]' : tone === 'amber' ? 'text-[#7a5000]' : tone === 'green' ? 'text-[#1f5c43]' : 'text-ink')}>{value}</span>
    {sub != null && <span className={HINT}>{sub}</span>}
  </div>
);
export const KpiStrip = ({ children }: { children: ReactNode }) => (
  <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">{children}</div>
);

/** A titled card holding one table: the title, a count, a hint and actions sit
 *  inside the card, over the table. */
export const TableCard = ({ title, count, hint, actions, children, label }: {
  title: ReactNode; count: ReactNode; hint: ReactNode; actions: ReactNode; children: ReactNode; label: string | null;
}) => (
  <section aria-label={label ?? undefined} className={cn(CARD, 'overflow-hidden')}>
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-[16px] font-bold text-ink">
          {title}{count != null && <span className="ml-1.5 font-medium text-ink-muted">{count}</span>}
        </h3>
        {hint && <p className={cn(HINT, 'max-w-[820px]')}>{hint}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-end gap-2.5">{actions}</div>}
    </div>
    <div className="min-w-0 border-t border-border px-3 pb-3 pt-2">{children}</div>
  </section>
);

/** The filters over a tab: one quiet bar. */
export const FilterBar = ({ children }: { children: ReactNode }) => (
  <div className={cn(CARD, 'flex flex-wrap items-end gap-3 bg-surface-2/40 px-4 py-3')}>{children}</div>
);
