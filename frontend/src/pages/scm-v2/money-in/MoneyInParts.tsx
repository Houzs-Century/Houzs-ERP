// The pieces Money in's lists are built from (the owner's Claude Design,
// batch 5): a figure card, chips, segments, a status tag and a document
// number link. Presentation only — each page brings its own data and rules.

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Info, MoreHorizontal, Search, X } from 'lucide-react';
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

/** Segments: one of a few views; the one in use white on the grey track. A
 *  count rides after the label; `ruleBefore` puts a divider before a segment
 *  that stands apart (Receipts' customer payments). */
export function Segments<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string; icon?: ReactNode; count?: number; ruleBefore?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={s.segs} role="group" aria-label={label}>
      {options.map((o) => (
        <span key={o.value} style={{ display: 'contents' }}>
          {o.ruleBefore && <span className={s.segRule} aria-hidden />}
          <button type="button" className={`${s.seg} ${o.value === value ? s.segOn : ''}`}
            aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
            {o.icon}{o.label}
            {o.count != null && <span className={s.segCount}>{o.count.toLocaleString('en-MY')}</span>}
          </button>
        </span>
      ))}
    </div>
  );
}

/** The month nav (the design's monthKit): ‹ 2026/10 › and Any month / This
 *  month. `month` is "YYYY-MM", or '' for any month; from any month either
 *  arrow lands on this month. */
export function MonthNav({ month, thisMonth, onChange, shift }: {
  month: string;
  thisMonth: string;
  onChange: (month: string) => void;
  /** "YYYY-MM" moved by n months. */
  shift: (month: string, by: number) => string;
}) {
  return (
    <div className={s.monthNav} role="group" aria-label="Month">
      <button type="button" className={s.monthStep} title="Previous month" aria-label="Previous month"
        onClick={() => onChange(month ? shift(month, -1) : thisMonth)}><ChevronLeft size={14} /></button>
      <span className={s.monthLabel} aria-live="polite"><CalendarDays size={13} />{month ? month.replace('-', '/') : 'Any month'}</span>
      <button type="button" className={s.monthStep} title="Next month" aria-label="Next month"
        onClick={() => onChange(month ? shift(month, 1) : thisMonth)}><ChevronRight size={14} /></button>
      <button type="button" className={s.monthToggle} onClick={() => onChange(month ? '' : thisMonth)}>{month ? 'Any month' : 'This month'}</button>
    </div>
  );
}

/** The search box with its clear ×. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className={s.search}>
      <Search size={13} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && <button type="button" className={s.clear} onClick={() => onChange('')} aria-label="Clear the search" title="Clear"><X size={12} /></button>}
    </label>
  );
}

/** A row's menu item (the design's menuOf): a divider, or an item — red when it undoes. */
export type MenuItem = { label: string; onClick: () => void; danger?: boolean; divider?: boolean };

/** The ⋯ menu, opened from the row's button or a right-click (DataTable's
 *  contextMenu takes the same items). */
export function useRowMenu<T>(itemsOf: (row: T) => MenuItem[], nameOf: (row: T) => string) {
  const [menu, setMenu] = useState<{ row: T; x: number; y: number } | null>(null);
  const button = (row: T) => (
    <button type="button" className={s.more} aria-label={`${nameOf(row)} menu`} title="More"
      onClick={(e) => { e.stopPropagation(); setMenu({ row, x: e.clientX, y: e.clientY }); }}
      onDoubleClick={(e) => e.stopPropagation()}>
      <MoreHorizontal size={14} />
    </button>
  );
  const popup = menu && (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 79 }} onClick={() => setMenu(null)} aria-hidden />
      <div className={s.menu} role="menu" aria-label={`${nameOf(menu.row)} menu`}
        style={{ top: Math.max(8, Math.min(menu.y + 6, window.innerHeight - 320)), left: Math.max(8, menu.x - 180) }}>
        {itemsOf(menu.row).map((m, i) => (m.divider
          ? <div key={`d${i}`} className={s.menuRule} />
          : (
            <button key={`${m.label}-${i}`} type="button" role="menuitem" className={`${s.menuItem} ${m.danger ? s.menuDanger : ''}`}
              onClick={() => { setMenu(null); m.onClick(); }}>{m.label}</button>
          )))}
      </div>
    </>
  );
  return { button, popup };
}

/** Drop a divider that leads, trails or doubles — a menu built from optional parts. */
export const tidyMenu = (items: MenuItem[]): MenuItem[] =>
  items.filter((m, i, all) => !m.divider || (i > 0 && i < all.length - 1 && !all[i - 1]!.divider));

/** The batch bar (the design's selKit): `<n> ticked · RM x`, the actions, Clear,
 *  and the notes — one of them says how many ticked rows a filter hides. */
export function BatchBar({ count, sum, hidden, notes = [], onClear, children }: {
  count: number;
  sum: string;
  /** Ticked rows the filters hide — left out of every batch action. */
  hidden: number;
  notes?: string[];
  onClear: () => void;
  children?: ReactNode;
}) {
  const all = [...notes, ...(hidden > 0 ? [`${hidden} ticked ${hidden > 1 ? 'are' : 'is'} hidden by a filter and left out.`] : [])];
  return (
    <div className={s.batch} role="region" aria-label="Ticked">
      <div className={s.batchRow}>
        <b>{count} ticked</b>
        <span className={s.money}>· {sum}</span>
        <span className={s.grow} />
        {children}
        <button type="button" className={s.batchClear} onClick={onClear}>Clear</button>
      </div>
      {all.length > 0 && (
        <div className={s.batchNotes}>
          {all.map((n) => <span key={n} className={s.batchNote}><Info size={13} />{n}</span>)}
        </div>
      )}
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
