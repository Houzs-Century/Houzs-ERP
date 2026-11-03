// ----------------------------------------------------------------------------
// SetupParts — what the Finance › Setup pages share in the owner's Claude Design
// redesign (Finance-1a-Setup, batch 6 §6): the status tag, the form modal and
// its fields, the switch, the row menu and the loading skeleton, in the
// design's look (SetupParts.module.css).
//
// The form modal keeps the ERP's rule from the chart (owner 2026-09-04): a click
// on the backdrop does NOT close it — a stray click must not eat a half-typed
// form; Cancel is the way out. Asks (yes / no) stay the app's useConfirm.
// ----------------------------------------------------------------------------

import type { ReactNode } from 'react';
import css from './SetupParts.module.css';

/** The design's tones: late · warn · info · calm, and brass for a special kind. */
export type Tone = 'calm' | 'warn' | 'info' | 'late' | 'brass';

const toneClass = (tone: Tone): string => {
  switch (tone) {
    case 'warn': return css.toneWarn;
    case 'info': return css.toneInfo;
    case 'late': return css.toneLate;
    case 'brass': return css.toneBrass;
    default: return css.toneCalm;
  }
};

/** A status tag: 20px high, 4px radius, 11/600; a late one may carry its dot. */
export function Tag({ tone, dot, title, children }: { tone: Tone; dot?: boolean; title?: string; children: ReactNode }) {
  return (
    <span className={`${css.tag} ${toneClass(tone)}`} title={title}>
      {dot && <span className={css.tagDot} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** The centred form modal: title, sub-line, fields, the error line, Cancel / ok. */
export function SetupModal({
  title, sub, okLabel, busyLabel, busy, okDanger, error, wide, onOk, onCancel, children,
}: {
  title: string;
  sub?: ReactNode;
  okLabel: string;
  /** What the ok button reads while the save runs. */
  busyLabel?: string;
  busy?: boolean;
  okDanger?: boolean;
  /** The design's error line — a check that failed, or the server's sentence. */
  error?: string | null;
  wide?: boolean;
  onOk: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div className={css.scrim} role="presentation">
      <div className={wide ? `${css.modal} ${css.modalWide}` : css.modal} role="dialog" aria-modal="true" aria-label={title}>
        <form className={css.modalForm} noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) onOk(); }}>
          <div>
            <div className={css.modalTitle}>{title}</div>
            {sub != null && sub !== '' && <div className={css.modalSub}>{sub}</div>}
          </div>
          <div className={css.fields}>{children}</div>
          {error ? <div className={css.error} role="alert">{error}</div> : null}
          <div className={css.modalFoot}>
            <button type="button" className={css.btn} onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className={okDanger ? `${css.btnSolid} ${css.btnDanger}` : css.btnSolid} disabled={busy}>
              {busy ? (busyLabel ?? okLabel) : okLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** One field of a form: its label above the control, a hint under it. `w` is
    the share of the row it takes (the design's 32% / 48% / 64% / 100%). A
    `group` holds controls with their own labels (ticks), so it is not a label. */
export function Field({ label, hint, w = '48%', group, children }: {
  label: ReactNode; hint?: ReactNode; w?: string; group?: boolean; children: ReactNode;
}) {
  const inner = (
    <>
      <span className={css.fieldName}>{label}</span>
      {children}
    </>
  );
  return (
    <div className={css.field} style={{ flex: `0 0 ${w === '100%' ? '100%' : `calc(${w} - 4px)`}` }}>
      {group
        ? <div className={css.fieldLabel} role="group" aria-label={typeof label === 'string' ? label : undefined}>{inner}</div>
        : <label className={css.fieldLabel}>{inner}</label>}
      {hint != null && hint !== '' && <span className={css.fieldHint}>{hint}</span>}
    </div>
  );
}

/** A tick with its words beside it, inside a form. */
export function Check({ checked, onChange, disabled, label, children }: {
  checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string; children: ReactNode;
}) {
  return (
    <label className={css.check}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** The design's switch; `danger` paints it red while on (Quick mode). */
export function Switch({ on, label, title, disabled, danger, onClick, children }: {
  on: boolean; label: string; title?: string; disabled?: boolean; danger?: boolean; onClick: () => void; children?: ReactNode;
}) {
  const state = on ? (danger ? css.switchDanger : css.switchOn) : '';
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title} disabled={disabled}
      className={`${css.switch} ${state}`} onClick={onClick}>
      <span className={css.track} aria-hidden="true"><span className={css.knob} /></span>
      {children}
    </button>
  );
}

export type MenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string };

/** The ⋯ / right-click menu, opened where the pointer was. */
export function PopMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: MenuItem[]; onClose: () => void }) {
  const top = Math.max(8, Math.min(y + 6, window.innerHeight - 16 - items.length * 36));
  const left = Math.max(8, Math.min(x - 180, window.innerWidth - 228));
  return (
    <>
      <div className={css.menuScrim} aria-hidden="true" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className={css.menu} role="menu" aria-label={label} style={{ top, left }}>
        {items.map((m) => (
          <button key={m.label} type="button" role="menuitem" title={m.title} disabled={m.disabled}
            className={m.danger ? `${css.menuItem} ${css.menuDanger}` : css.menuItem}
            onClick={() => { onClose(); m.onClick(); }}>
            {m.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** A loading skeleton the size of the list it stands in for. */
export function Skeleton({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <div className={css.skeleton} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={css.skeletonBar} style={{ width: `${94 - (i % 3) * 16}%` }} />
      ))}
    </div>
  );
}
