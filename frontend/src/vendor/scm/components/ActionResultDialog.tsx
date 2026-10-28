// ----------------------------------------------------------------------------
// ActionResultDialog — small in-app result/confirm modal (Commander 2026-05-29:
// "我不要 window.alert，要在界面里面"). Replaces browser alert()/confirm() on the
// batch create pages (GRN-from-PO, PO-from-SO). Same calm look as the MRP
// page's in-app dialog. Presentational only — caller owns the open state.
// ----------------------------------------------------------------------------

import type { CSSProperties } from 'react';

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 80, padding: 'var(--space-4)',
};
const card: CSSProperties = {
  background: 'var(--c-paper)', border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-3)',
  width: 'min(440px, 95vw)', padding: 'var(--space-5)',
};
const titleStyle: CSSProperties = {
  fontFamily: 'var(--font-title)', fontWeight: 700, fontSize: 'var(--fs-18, 18px)',
  color: 'var(--c-ink)', margin: '0 0 var(--space-2)',
};
const bodyStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)',
  margin: '0 0 var(--space-4)', whiteSpace: 'pre-wrap', lineHeight: 1.5,
};
const actions: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' };
const btnBase: CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 700,
  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
};
const ghostBtn: CSSProperties = { ...btnBase, border: '1px solid var(--line)', background: 'var(--c-paper)', color: 'var(--c-ink)' };
const primaryBtn: CSSProperties = { ...btnBase, border: '1px solid var(--c-orange)', background: 'var(--c-orange)', color: '#fff' };

export type ActionResultDialogProps = {
  title: string;
  body: string;
  /** When set, shows a primary action button (e.g. "Open Goods Receipts")
   *  alongside a "Stay here"; otherwise a single OK button. */
  primaryLabel?: string;
  onPrimary?: () => void;
  /** Optional middle action between "Stay here" and the primary (owner
   *  2026-07-23: "Need a button to new purchase invoice" — the batch-entry
   *  loop wants a one-click "start the next document" without detouring
   *  through the list). Ghost-styled so the primary keeps the emphasis. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  onClose: () => void;
};

export const ActionResultDialog = ({ title, body, primaryLabel, onPrimary, secondaryLabel, onSecondary, onClose }: ActionResultDialogProps) => (
  <div style={backdrop} onClick={onClose} role="presentation">
    <div style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <h2 style={titleStyle}>{title}</h2>
      <p style={bodyStyle}>{body}</p>
      <div style={actions}>
        {primaryLabel && onPrimary ? (
          <>
            <button type="button" style={ghostBtn} onClick={onClose}>Stay here</button>
            {secondaryLabel && onSecondary && (
              <button type="button" style={ghostBtn} onClick={onSecondary}>{secondaryLabel}</button>
            )}
            <button type="button" style={primaryBtn} onClick={onPrimary}>{primaryLabel}</button>
          </>
        ) : (
          <button type="button" style={primaryBtn} onClick={onClose}>OK</button>
        )}
      </div>
    </div>
  </div>
);
