// ----------------------------------------------------------------------------
// MoneyOutErpParts — what the two ERP-only pages under Money out (Supplier
// maintenance, Official invoices owed) share in the owner's redesign (batch 4
// §5): the status tag and the counted views, in the design's look
// (MoneyOutErp.module.css).
// ----------------------------------------------------------------------------

import type { ReactNode } from 'react';
import css from './MoneyOutErp.module.css';

/** The design's four tones: late · warn · info · calm. */
export type Tone = 'calm' | 'warn' | 'info' | 'late';

const toneClass = (tone: Tone): string => {
  switch (tone) {
    case 'warn': return css.toneWarn;
    case 'info': return css.toneInfo;
    case 'late': return css.toneLate;
    default: return css.toneCalm;
  }
};

/** A status tag: 20px high, 4px radius, 11/600. */
export function Tag({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={`${css.tag} ${toneClass(tone)}`} title={title}>{children}</span>;
}

/** One view of the list: its words, its count — left out while the rows behind
    it are not all loaded, so a count never reads a part as the whole — and the
    tone its count takes when it is work waiting. */
export type ViewOption<K extends string> = { key: K; label: string; count?: number | null; work?: 'warn' | 'late' };

const countClass = (n: number, work: ViewOption<string>['work']): string => {
  if (n === 0) return css.count;
  if (work === 'late') return `${css.count} ${css.countLate}`;
  if (work === 'warn') return `${css.count} ${css.countWarn}`;
  return `${css.count} ${css.countSome}`;
};

/** The page's views as the design's segmented switch, a count on each. */
export function Views<K extends string>({ label, options, value, onChange }: {
  label: string; options: ViewOption<K>[]; value: K; onChange: (key: K) => void;
}) {
  return (
    <div className={css.views} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key}
          aria-label={o.count == null ? o.label : `${o.label} (${o.count})`}
          className={value === o.key ? `${css.view} ${css.viewOn}` : css.view} onClick={() => onChange(o.key)}>
          {o.label}
          {o.count != null && <span className={countClass(o.count, o.work)} aria-hidden="true">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
