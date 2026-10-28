import { useState } from 'react';

// In-app confirm dialog (NEVER window.confirm). Destructive = red primary.
// Usage:
//   const [ask, setAsk] = useState(false);
//   <ConfirmDialog open={ask} title="Cancel this order?" body="SO-… will be voided. This can't be undone."
//     confirmLabel="Cancel order" destructive onConfirm={doCancel} onClose={() => setAsk(false)} />

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;      // default "Confirm"
  cancelLabel?: string;       // default "Keep"
  destructive?: boolean;      // red primary
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Keep', destructive, onConfirm, onClose } = props;
  if (!open) return null;
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'absolute', inset: 0, zIndex: 50, background: 'rgba(17,20,15,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <div style={{ width: '100%', background: '#fff', borderRadius: 16, padding: 16, boxShadow: '0 20px 50px -12px rgba(0,0,0,.4)' }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: '#11140f' }}>{title}</div>
        {body && <div style={{ fontSize: 11.5, color: '#767b6e', marginTop: 5, lineHeight: 1.4 }}>{body}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost" style={{ flex: 1, whiteSpace: 'nowrap' }} onClick={onClose}>{cancelLabel}</button>
          <button
            className="btn"
            style={{ flex: 1, whiteSpace: 'nowrap', background: destructive ? '#b23a3a' : '#16695f' }}
            onClick={() => { onConfirm(); onClose(); }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// Small hook so screens can trigger the dialog imperatively.
export function useConfirm() {
  const [state, setState] = useState<null | Omit<ConfirmDialogProps, 'open' | 'onClose'>>(null);
  const node = (
    <ConfirmDialog
      open={!!state}
      title={state?.title ?? ''}
      body={state?.body}
      confirmLabel={state?.confirmLabel}
      destructive={state?.destructive}
      onConfirm={() => state?.onConfirm()}
      onClose={() => setState(null)}
    />
  );
  return { confirm: (opts: Omit<ConfirmDialogProps, 'open' | 'onClose'>) => setState(opts), node };
}
