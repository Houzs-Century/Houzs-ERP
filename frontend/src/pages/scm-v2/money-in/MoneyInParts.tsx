// The pieces Money in's lists are built from (the owner's Claude Design,
// batch 5): a figure card, chips, segments, a status tag and a document
// number link. Presentation only — each page brings its own data and rules.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import s from '../MoneyIn.module.css';
import type { Tag, TagTone } from './moneyInStatus';

const TONE_CLASS: Record<TagTone, string> = { late: s.toneLate, warn: s.toneWarn, info: s.toneInfo, calm: s.toneCalm };

export function StatusTag({ tag }: { tag: Tag }) {
  return <span className={`${s.tag} ${TONE_CLASS[tag.tone]}`}>{tag.text}</span>;
}

/** A card: icon and label, the figure, a line under it. With `onClick` it is a
 *  button that picks what the list below shows. `pending` means the figure is
 *  not known yet — a dash, never a zero that reads as a fact. */
export function FigureCard({
  icon, label, value, sub, subBad = false, zero = false, on = false, onClick, pending = false, title,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  subBad?: boolean;
  zero?: boolean;
  on?: boolean;
  onClick?: () => void;
  pending?: boolean;
  title?: string;
}) {
  const body = (
    <>
      <span className={s.cardHead}>{icon}<span className={s.cardLabel}>{label}</span></span>
      <span className={`${s.cardValue} ${zero || pending ? s.cardValueZero : ''}`} aria-busy={pending || undefined}>
        {pending ? <span title="Not loaded yet">—</span> : value}
      </span>
      {sub != null && sub !== '' && <span className={`${s.cardSub} ${subBad ? s.cardSubBad : ''}`}>{sub}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={`${s.card} ${on ? s.cardOn : ''}`} aria-pressed={on} title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={s.card} title={title}>{body}</div>
  );
}

export type ChipOption<T extends string> = { value: T; label: string; count?: number };

/** Chips: ink-filled when on; the count, when given, after the label. */
export function Chips<T extends string>({ options, value, onChange, label }: {
  options: ChipOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={s.chips} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`${s.chip} ${o.value === value ? s.chipOn : ''}`}
          aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count != null && <span className={s.chipCount}>{o.count.toLocaleString('en-MY')}</span>}
        </button>
      ))}
    </div>
  );
}

/** Segments: one of a few views; the one in use white on the grey track. */
export function Segments<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={s.segs} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`${s.seg} ${o.value === value ? s.segOn : ''}`}
          aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

/** A document number that opens its page: 13/600, dotted underline. A click
 *  on it never also reaches the row under it. */
export function DocLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={`${s.docLink} ${className ?? ''}`}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {children}
    </Link>
  );
}
