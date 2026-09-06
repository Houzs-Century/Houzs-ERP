// ----------------------------------------------------------------------------
// Modal — the pop-out a document opens in (owner 2026-09-06: 我点开时他是跑上
// 去,我希望是 pop out 出来). The AP invoice's detail used to be a card pushed
// in ABOVE the list, which jumped the page to the top and buried the list;
// now the row opens over the page, the list stays where it was, Esc or the
// backdrop closes. One shell for the finance documents that open in place —
// the system dialogs (ConfirmDialog, ChoiceDialog) keep their own, narrower
// frames and sit ABOVE this (z 3001 vs 1000) so a confirm raised from inside
// a modal is never hidden behind it.
// ----------------------------------------------------------------------------

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(34,31,32,0.4)',
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  zIndex: 1000, padding: 'var(--space-5) var(--space-4)', overflowY: 'auto',
};
const panel: CSSProperties = {
  background: 'var(--c-cream, #f5f1ea)', border: '1px solid var(--line-strong, rgba(34,31,32,0.3))',
  borderRadius: 'var(--radius-xl, 14px)', boxShadow: 'var(--shadow-3, 0 16px 40px rgba(0,0,0,0.2))',
  display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 2 * var(--space-5, 24px))', overflow: 'hidden',
};
const header: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)',
  padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--line, rgba(34,31,32,0.2))', background: 'var(--c-paper, #fff)',
};
const titleStyle: CSSProperties = { fontFamily: 'var(--font-title)', fontWeight: 700, fontSize: 'var(--fs-15, 15px)', color: 'var(--c-ink)', margin: 0 };
const body: CSSProperties = { padding: 'var(--space-4)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' };
const closeBtn: CSSProperties = { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 4, display: 'inline-flex' };

export const Modal = ({ title, onClose, width = 'min(1100px, 100%)', actions, children, ariaLabel }: {
  title: ReactNode;
  onClose: () => void;
  /** CSS width of the panel; the default suits a document with a lines table. */
  width?: string;
  /** Buttons for the header's right side, before the close cross. */
  actions?: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div style={backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
      <div style={{ ...panel, width }} role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div style={header}>
          <h2 style={titleStyle}>{title}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {actions}
            <button type="button" aria-label="Close" onClick={onClose} style={closeBtn}><X size={18} strokeWidth={1.75} /></button>
          </div>
        </div>
        <div style={body}>{children}</div>
      </div>
    </div>
  );
};
