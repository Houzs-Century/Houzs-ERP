// ----------------------------------------------------------------------------
// ConfirmDialog / ConfirmProvider / useConfirm — app-wide in-app confirm modal
// for destructive or important actions (Commander 2026-06-15: edits & deletes
// must not be "裸奔" — ask first, in-app, never window.confirm). Same calm look
// as ActionResultDialog, but a Cancel + Confirm pair (optional danger-red).
//
// Mounted ONCE at the app root (main.tsx). Any component then gates an action:
//
//   const confirm = useConfirm();
//   ...
//   onClick={async () => {
//     if (await confirm({ title: 'Remove this line?', confirmLabel: 'Remove', danger: true })) {
//       deleteItem.mutate(...);
//     }
//   }}
//
// confirm() resolves true only when the user clicks Confirm; Cancel / backdrop /
// a superseding prompt all resolve false, so a dismissed prompt never acts.
// ----------------------------------------------------------------------------

import {
  createContext, useCallback, useContext, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import { useEscapeLayer } from '../../../lib/escapeStack';

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  // 3000 — ABOVE every page modal (which top out ~1000). The confirm is
  // routinely raised FROM inside a modal (e.g. "Create N SKUs" in the bulk
  // New-Models dialog); at the old z-index 90 it rendered BEHIND that modal so
  // the button looked dead ("没反应"). Wei Siang 2026-06-20.
  zIndex: 3000, padding: 'var(--space-4)',
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
const dangerBtn: CSSProperties = { ...btnBase, border: '1px solid var(--c-danger, #c0392b)', background: 'var(--c-danger, #c0392b)', color: '#fff' };

export type ConfirmOpts = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Ask for a line of text with the confirm (owner 2026-09-10: a payment
      correction made on the amend right owes a reason). When `required`,
      Confirm stays disabled until something is typed — the dialog does not
      let an empty reason through and make the server refuse it instead. */
  input?: { label: string; placeholder?: string; required?: boolean };
};

export type ConfirmDialogProps = ConfirmOpts & {
  onConfirm: () => void;
  onCancel: () => void;
  value?: string;
  onValueChange?: (v: string) => void;
};

const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', minHeight: 72, resize: 'vertical',
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)',
  border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2)', margin: '0 0 var(--space-4)', background: 'var(--c-paper)',
};
const labelStyle: CSSProperties = {
  display: 'block', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)',
  color: 'var(--c-ink)', fontWeight: 700, margin: '0 0 var(--space-1)',
};

export const ConfirmDialog = ({
  title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, input,
  value = '', onValueChange, onConfirm, onCancel,
}: ConfirmDialogProps) => {
  const blocked = Boolean(input?.required) && value.trim() === '';
  useEscapeLayer(onCancel, true);
  return (
    <div style={backdrop} onClick={onCancel} role="presentation">
      <div style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 style={titleStyle}>{title}</h2>
        {body != null && <p style={bodyStyle}>{body}</p>}
        {input && (
          <label style={labelStyle}>
            {input.label}
            <textarea
              style={inputStyle}
              value={value}
              placeholder={input.placeholder}
              onChange={(e) => onValueChange?.(e.target.value)}
              autoFocus
              aria-required={input.required === true}
            />
          </label>
        )}
        <div style={actions}>
          <button type="button" style={ghostBtn} onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            style={{ ...(danger ? dangerBtn : primaryBtn), ...(blocked ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
            onClick={onConfirm}
            disabled={blocked}
            autoFocus={!input}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

type Settled = { ok: boolean; text: string };
type AskFn = (opts: ConfirmOpts) => Promise<Settled>;
type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>;
type PromptFn = (opts: ConfirmOpts & { input: NonNullable<ConfirmOpts['input']> }) => Promise<string | null>;

const AskContext = createContext<AskFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: Settled) => void; text: string }) | null>(null);
  const ask = useCallback<AskFn>(
    (opts) => new Promise<Settled>((resolve) => {
      setState((prev) => { prev?.resolve({ ok: false, text: '' }); return { ...opts, resolve, text: '' }; });
    }),
    [],
  );
  const settle = (ok: boolean) => setState((s) => { s?.resolve({ ok, text: s.text }); return null; });
  return (
    <AskContext.Provider value={ask}>
      {children}
      {state && (
        <ConfirmDialog
          title={state.title}
          body={state.body}
          confirmLabel={state.confirmLabel}
          cancelLabel={state.cancelLabel}
          danger={state.danger}
          input={state.input}
          value={state.text}
          onValueChange={(text) => setState((s) => (s ? { ...s, text } : s))}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </AskContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ask = useContext(AskContext);
  if (!ask) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return useCallback<ConfirmFn>(async (opts) => (await ask(opts)).ok, [ask]);
}

export function usePrompt(): PromptFn {
  const ask = useContext(AskContext);
  if (!ask) throw new Error('usePrompt must be used within <ConfirmProvider>');
  return useCallback<PromptFn>(async (opts) => {
    const r = await ask(opts);
    return r.ok ? r.text.trim() : null;
  }, [ask]);
}
