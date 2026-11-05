// ----------------------------------------------------------------------------
// AskBanner — the redesign's confirmation (the owner's Claude Design, batch 5
// §1, the design's askVals): an inline banner above the table or the document
// instead of a modal. A title, a body, an optional reason box, then `Keep it`
// (`Not now` when the step moves the document on) and the go button — red
// when it undoes something, petrol when it moves it on. A required reason
// greys the go button until it is typed; pressing it then says so.
//
// The banner asks; the page acts. Whatever the server refuses comes back as
// `error` and is shown verbatim in the banner, which stays open.
// ----------------------------------------------------------------------------

import { useState, type ReactNode } from 'react';
import { useToastOptional } from '../../../hooks/useToast';
import s from '../MoneyIn.module.css';

export type Ask = {
  title: string;
  body: ReactNode;
  /** `undo` (Void, Cancel, Reject) is red; `go` (Approve) is petrol. */
  tone: 'undo' | 'go';
  goLabel: string;
  /** A reason box; the go button stays grey until it holds something. */
  reason?: { placeholder: string };
  /** False when the step is refused: the body says why and only `Keep it` shows. */
  canGo?: boolean;
  /** Runs the step with the typed reason (trimmed; '' when there is no box). */
  onGo: (reason: string) => void;
};

/** Render with `key={ask.title}` so a new ask starts with an empty reason. */
export function AskBanner({ ask, onKeep, busy = false, error = null }: {
  ask: Ask;
  onKeep: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const toast = useToastOptional();
  const [reason, setReason] = useState('');
  const ready = !ask.reason || reason.trim() !== '';
  const go = () => {
    if (busy) return;
    if (!ready) { toast?.info('Type the reason first'); return; }
    ask.onGo(reason.trim());
  };
  const goClass = [s.askButton, ask.tone === 'go' ? s.askButtonGo : '', ready ? '' : s.askButtonWaiting].filter(Boolean).join(' ');
  return (
    <section aria-label={ask.title} className={`${s.ask} ${ask.tone === 'go' ? s.askGo : ''}`}>
      <div className={s.askTitle}>{ask.title}</div>
      <div className={s.askBody}>{ask.body}</div>
      {error && <div role="alert" className={s.askError}>{error}</div>}
      <div className={s.askRow}>
        {ask.reason && (
          <input className={s.askInput} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder={ask.reason.placeholder} aria-label={ask.reason.placeholder} autoFocus />
        )}
        <span className={s.grow} />
        <button type="button" className={s.askKeep} onClick={onKeep} disabled={busy}>{ask.tone === 'go' ? 'Not now' : 'Keep it'}</button>
        {ask.canGo !== false && (
          <button type="button" className={goClass} onClick={go} disabled={busy} aria-disabled={!ready || undefined}>{ask.goLabel}</button>
        )}
      </div>
    </section>
  );
}
