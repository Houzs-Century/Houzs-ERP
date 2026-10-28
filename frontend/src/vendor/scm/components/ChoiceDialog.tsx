// ----------------------------------------------------------------------------
// ChoiceDialog / ChoiceProvider / useChoice — app-wide in-app *pick-one* modal.
// A sibling of useConfirm/useNotify/usePrompt (same calm card) for the case
// where an action needs the operator to choose between a few labelled options —
// e.g. batch download: "One combined PDF" vs "Separate files". Each option is a
// button; resolves the chosen option's `value`, or null on Cancel / backdrop.
//
// HOUZS VENDOR: ported verbatim from 2990's components/ChoiceDialog. It was
// dropped in the original SCM clone; the batch "Export PDF (N)" list-page flow
// needs it for the combined-vs-separate chooser. Mounted ONCE in Scm2990Shell.
// Usage:
//
//   const choose = useChoice();
//   const how = await choose({
//     title: 'Download 5 documents',
//     options: [
//       { value: 'one',  label: 'One combined PDF' },
//       { value: 'many', label: 'Separate files', detail: 'One PDF per document' },
//     ],
//   });
//   if (how == null) return;            // cancelled
// ----------------------------------------------------------------------------

import {
  createContext, useCallback, useContext, useState,
  type CSSProperties, type ReactNode,
} from 'react';

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  // 3001 — above every page modal (~1000), matching the other system dialogs
  // so a choice raised from inside a modal isn't hidden behind it. 2026-06-20.
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
  margin: '0 0 var(--space-4)', whiteSpace: 'pre-wrap', lineHeight: 1.5,
};
const optionsWrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' };
const optionBtn: CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 700,
  padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  border: '1px solid var(--c-orange)', background: 'var(--c-orange)', color: '#fff',
  textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2,
};
const optionDetail: CSSProperties = { fontWeight: 400, fontSize: 'var(--fs-11)', opacity: 0.9 };
const cancelRow: CSSProperties = { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-3)' };
const ghostBtn: CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 700,
  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  border: '1px solid var(--line)', background: 'var(--c-paper)', color: 'var(--c-ink)',
};

export type ChoiceOption = { value: string; label: string; detail?: string };
export type ChoiceOpts = {
  title: string;
  body?: ReactNode;
  options: ChoiceOption[];
  cancelLabel?: string;
};

export type ChoiceDialogProps = ChoiceOpts & {
  onPick: (value: string) => void;
  onCancel: () => void;
};

export const ChoiceDialog = ({ title, body, options, cancelLabel = 'Cancel', onPick, onCancel }: ChoiceDialogProps) => (
  <div style={backdrop} onClick={onCancel} role="presentation">
    <div style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <h2 style={titleStyle}>{title}</h2>
      {body != null && <p style={bodyStyle}>{body}</p>}
      <div style={optionsWrap}>
        {options.map((o) => (
          <button key={o.value} type="button" style={optionBtn} onClick={() => onPick(o.value)}>
            <span>{o.label}</span>
            {o.detail && <span style={optionDetail}>{o.detail}</span>}
          </button>
        ))}
      </div>
      <div style={cancelRow}>
        <button type="button" style={ghostBtn} onClick={onCancel}>{cancelLabel}</button>
      </div>
    </div>
  </div>
);

type ChoiceFn = (opts: ChoiceOpts) => Promise<string | null>;

const ChoiceContext = createContext<ChoiceFn | null>(null);

/* Mount once at the app root. Holds the live prompt state, renders the modal,
   and hands every descendant a choose() through context. */
export function ChoiceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ChoiceOpts & { resolve: (v: string | null) => void }) | null>(null);
  const choose = useCallback<ChoiceFn>(
    (opts) => new Promise<string | null>((resolve) => {
      // A new prompt supersedes any open one (resolve the old as cancelled).
      setState((prev) => { prev?.resolve(null); return { ...opts, resolve }; });
    }),
    [],
  );
  const settle = (v: string | null) => setState((s) => { s?.resolve(v); return null; });
  return (
    <ChoiceContext.Provider value={choose}>
      {children}
      {state && (
        <ChoiceDialog
          title={state.title}
          body={state.body}
          options={state.options}
          cancelLabel={state.cancelLabel}
          onPick={(v) => settle(v)}
          onCancel={() => settle(null)}
        />
      )}
    </ChoiceContext.Provider>
  );
}

/* Ask the operator to pick one option: `const v = await choose({…}); if (v == null) return;` */
export function useChoice(): ChoiceFn {
  const choose = useContext(ChoiceContext);
  if (!choose) throw new Error('useChoice must be used within <ChoiceProvider>');
  return choose;
}
