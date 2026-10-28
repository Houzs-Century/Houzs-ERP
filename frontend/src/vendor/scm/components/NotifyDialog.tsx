// ----------------------------------------------------------------------------
// NotifyDialog / NotifyProvider / useNotify — app-wide in-app *alert* modal.
// Commander 2026-05-29: "我不要 window.alert，要在界面里面" — every informational
// or error message shows in-app, never a naked browser alert(). Same calm look
// as ConfirmDialog, but a single OK button. `tone: 'error'` tints the title red.
//
// Mounted ONCE at the app root (main.tsx), inside ConfirmProvider. Any component:
//
//   const notify = useNotify();
//   ...
//   await notify({ title: 'Saved', body: 'The supplier was updated.' });
//   notify({ title: 'Update failed', body: err.message, tone: 'error' }); // fire-and-forget ok
//
// notify() resolves once the user dismisses (OK / backdrop), so callers may await
// it to sequence a follow-up, or ignore the promise for a plain toast.
// ----------------------------------------------------------------------------

import {
  createContext, useCallback, useContext, useState,
  type CSSProperties, type ReactNode,
} from 'react';

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  // 3001 — above every page modal (~1000) AND just above the confirm (3000),
  // so a notify raised over a confirm still shows on top. Wei Siang 2026-06-20.
  zIndex: 3001, padding: 'var(--space-4)',
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
const titleErrStyle: CSSProperties = { ...titleStyle, color: 'var(--c-danger, #c0392b)' };
const bodyStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)',
  margin: '0 0 var(--space-4)', whiteSpace: 'pre-wrap', lineHeight: 1.5,
};
const actions: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' };
const btnBase: CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 700,
  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
};
const primaryBtn: CSSProperties = { ...btnBase, border: '1px solid var(--c-orange)', background: 'var(--c-orange)', color: '#fff' };

export type NotifyOpts = {
  title: string;
  body?: ReactNode;
  okLabel?: string;
  /** 'error' tints the title red (for failures); 'info' (default) keeps it ink. */
  tone?: 'info' | 'error';
};

export type NotifyDialogProps = NotifyOpts & { onClose: () => void };

export const NotifyDialog = ({ title, body, okLabel = 'OK', tone, onClose }: NotifyDialogProps) => (
  <div style={backdrop} onClick={onClose} role="presentation">
    <div style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <h2 style={tone === 'error' ? titleErrStyle : titleStyle}>{title}</h2>
      {body != null && <p style={bodyStyle}>{body}</p>}
      <div style={actions}>
        <button type="button" style={primaryBtn} onClick={onClose} autoFocus>{okLabel}</button>
      </div>
    </div>
  </div>
);

type NotifyFn = (opts: NotifyOpts) => Promise<void>;

const NotifyContext = createContext<NotifyFn | null>(null);

/* Mount once at the app root. Holds the live message state, renders the modal,
   and hands every descendant a notify() through context. */
export function NotifyProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(NotifyOpts & { resolve: () => void }) | null>(null);
  const notify = useCallback<NotifyFn>(
    (opts) => new Promise<void>((resolve) => {
      // A new message supersedes any open one (resolve the old immediately).
      setState((prev) => { prev?.resolve(); return { ...opts, resolve }; });
    }),
    [],
  );
  const close = () => setState((s) => { s?.resolve(); return null; });
  return (
    <NotifyContext.Provider value={notify}>
      {children}
      {state && (
        <NotifyDialog
          title={state.title}
          body={state.body}
          okLabel={state.okLabel}
          tone={state.tone}
          onClose={close}
        />
      )}
    </NotifyContext.Provider>
  );
}

/* Show an in-app message: `await notify({ title, body })` (or fire-and-forget). */
export function useNotify(): NotifyFn {
  const notify = useContext(NotifyContext);
  if (!notify) throw new Error('useNotify must be used within <NotifyProvider>');
  return notify;
}
