// ----------------------------------------------------------------------------
// PromptDialog / PromptProvider / usePrompt — app-wide in-app *text prompt*
// modal, replacing the naked browser window.prompt() (Commander "no 裸奔": even a
// one-field ask stays in-app, on-brand, and validatable). Same calm card as
// ConfirmDialog with a single text field, optional inline validation, and a
// Cancel + Confirm pair.
//
// Mounted ONCE at the app root (main.tsx). Any component:
//
//   const prompt = usePrompt();
//   const reason = await prompt({
//     title: 'Reason for override?',
//     placeholder: 'At least 10 characters',
//     validate: (v) => v.trim().length < 10 ? 'Please give a fuller reason (≥ 10 chars).' : null,
//   });
//   if (reason == null) return;            // cancelled / dismissed
//
// prompt() resolves the entered string on Confirm (only when validate passes),
// and null on Cancel / backdrop / a superseding prompt.
// ----------------------------------------------------------------------------

import {
  createContext, useCallback, useContext, useState,
  type CSSProperties, type ReactNode,
} from 'react';

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  // 3001 — above every page modal (~1000), matching the other system dialogs
  // so a prompt raised from inside a modal isn't hidden behind it. 2026-06-20.
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
const bodyStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)',
  margin: '0 0 var(--space-3)', whiteSpace: 'pre-wrap', lineHeight: 1.5,
};
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-14, 14px)', color: 'var(--c-ink)',
  padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--line-strong)', background: 'var(--c-paper)',
};
const errStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12, 12px)',
  color: 'var(--c-danger, #c0392b)', margin: 'var(--space-2) 0 0',
};
const actions: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' };
const btnBase: CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 700,
  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
};
const ghostBtn: CSSProperties = { ...btnBase, border: '1px solid var(--line)', background: 'var(--c-paper)', color: 'var(--c-ink)' };
const primaryBtn: CSSProperties = { ...btnBase, border: '1px solid var(--c-orange)', background: 'var(--c-orange)', color: '#fff' };

export type PromptOpts = {
  title: string;
  body?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Return an error string to block Confirm (kept open), or null when valid. */
  validate?: (value: string) => string | null;
  /** Render a textarea instead of a single-line input. */
  multiline?: boolean;
};

export type PromptDialogProps = PromptOpts & {
  onConfirm: (value: string) => void;
  onCancel: () => void;
};

export const PromptDialog = ({
  title, body, defaultValue = '', placeholder, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  validate, multiline, onConfirm, onCancel,
}: PromptDialogProps) => {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const err = validate ? validate(value) : null;
    if (err) { setError(err); return; }
    onConfirm(value);
  };

  return (
    <div style={backdrop} onClick={onCancel} role="presentation">
      <div style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 style={titleStyle}>{title}</h2>
        {body != null && <p style={bodyStyle}>{body}</p>}
        {multiline ? (
          <textarea
            style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
            value={value}
            placeholder={placeholder}
            autoFocus
            onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          />
        ) : (
          <input
            style={inputStyle}
            value={value}
            placeholder={placeholder}
            autoFocus
            onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          />
        )}
        {error && <p style={errStyle}>{error}</p>}
        <div style={actions}>
          <button type="button" style={ghostBtn} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" style={primaryBtn} onClick={submit}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

type PromptFn = (opts: PromptOpts) => Promise<string | null>;

const PromptContext = createContext<PromptFn | null>(null);

/* Mount once at the app root. Holds the live prompt state, renders the modal,
   and hands every descendant a prompt() through context. The `key` on
   PromptDialog resets its internal field state for each new prompt. */
export function PromptProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(PromptOpts & { id: number; resolve: (v: string | null) => void }) | null>(null);
  const prompt = useCallback<PromptFn>(
    (opts) => new Promise<string | null>((resolve) => {
      setState((prev) => { prev?.resolve(null); return { ...opts, id: (prev?.id ?? 0) + 1, resolve }; });
    }),
    [],
  );
  const settle = (v: string | null) => setState((s) => { s?.resolve(v); return null; });
  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {state && (
        <PromptDialog
          key={state.id}
          title={state.title}
          body={state.body}
          defaultValue={state.defaultValue}
          placeholder={state.placeholder}
          confirmLabel={state.confirmLabel}
          cancelLabel={state.cancelLabel}
          validate={state.validate}
          multiline={state.multiline}
          onConfirm={(v) => settle(v)}
          onCancel={() => settle(null)}
        />
      )}
    </PromptContext.Provider>
  );
}

/* Ask for a value in-app: `const v = await prompt({…}); if (v == null) return;` */
export function usePrompt(): PromptFn {
  const prompt = useContext(PromptContext);
  if (!prompt) throw new Error('usePrompt must be used within <PromptProvider>');
  return prompt;
}
