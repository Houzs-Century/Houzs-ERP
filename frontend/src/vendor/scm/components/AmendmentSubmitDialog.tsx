// ----------------------------------------------------------------------------
// AmendmentSubmitDialog / useAmendmentSubmitDialog — the ONE "submit this Sales
// Order amendment?" ask, shared by the desktop SO page and the phone SO form.
//
// Owner 2026-09-15, option B of 「后期再发生可以给我选项选择approver?」: the
// requester does not CHOOSE the approver — the lane rule does, server-side
// (backend shared/amendment-lane.ts), and twice this month the rule was what
// needed fixing (docs/bugs/0816, 0895). What the requester gets instead:
//
//   1. to SEE which desk the request will go to, before it exists — read from
//      POST /:docNo/amendments/lane-preview, the same resolver the create
//      stores from, so the badge here is the badge the row will carry;
//   2. a REASON, required (owner 2026-09-15, 「reason 换成一定 fill in」).
//
// Flagging the approver as wrong is NOT asked here (owner 2026-09-17): the
// requester cannot judge the desk. The approver reading the change can, so the
// flag lives on their job card (WrongApproverFlag).
//
// Same calm card as PromptDialog, rendered by the page through the hook's
// `element` — a page-owned dialog needs no app-root provider, and the two pages
// that raise amendments are both at their file-size ceiling, so the ask must
// cost them one line, not a modal's worth.
//
//   const submitDialog = useAmendmentSubmitDialog();
//   const answer = await submitDialog.ask({ docNo, lines, headerChanges });
//   if (answer == null) return;                       // cancelled
//   createAmendment.mutate({ docNo, lines, headerChanges, ...answer });
//   …
//   {submitDialog.element}
// ----------------------------------------------------------------------------

import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import {
  useAmendmentLanePreview,
  type AmendmentLane,
  type AmendmentLanePreview,
  type AmendmentLanePreviewArgs,
} from '../lib/so-amendment-queries';
import { AMENDMENT_REASON_REQUIRED } from '../lib/so-amendment-submit';
import { AMENDABLE_HEADER_LABELS } from '../lib/so-amendment-header';
import {
  soAmendmentApprover, AMENDMENT_APPROVER_LABEL, AMENDMENT_APPROVER_TONE,
} from '../lib/amendment-approver';

export type AmendmentSubmitAnswer = { reason: string };

/* One line per lane the request will split into, in the approver's own words. */
export function describeLanePreview(p: AmendmentLanePreview): Array<{ lane: AmendmentLane; text: string }> {
  return p.lanes.map((lane) => {
    const half = p.perLane[lane];
    const parts: string[] = [];
    if (half.lineCount > 0) parts.push(`${half.lineCount} line change${half.lineCount === 1 ? '' : 's'}`);
    /* The server may name a header key this build does not know yet — fall back to the key. */
    for (const k of half.headerKeys) parts.push((AMENDABLE_HEADER_LABELS as Record<string, string | undefined>)[k] ?? k);
    return { lane, text: parts.join(', ') };
  });
}

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 3001, padding: 'var(--space-4)',
};
const card: CSSProperties = {
  background: 'var(--c-paper)', border: '1px solid var(--line-strong)',
  borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-3)',
  width: 'min(480px, 95vw)', padding: 'var(--space-5)', maxHeight: '92vh', overflowY: 'auto',
};
const titleStyle: CSSProperties = {
  fontFamily: 'var(--font-title)', fontWeight: 700, fontSize: 'var(--fs-18, 18px)',
  color: 'var(--c-ink)', margin: '0 0 var(--space-2)',
};
const bodyStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', color: 'var(--c-ink)',
  margin: '0 0 var(--space-3)', lineHeight: 1.5,
};
const labelStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12, 12px)', fontWeight: 700,
  color: 'var(--c-ink)', margin: 'var(--space-3) 0 var(--space-1)', display: 'block',
};
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', minHeight: 72, resize: 'vertical',
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-14, 14px)', color: 'var(--c-ink)',
  padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--line-strong)', background: 'var(--c-paper)',
};
const errStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12, 12px)',
  color: 'var(--c-danger, #c0392b)', margin: 'var(--space-2) 0 0',
};
const laneBox: CSSProperties = {
  border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2) var(--space-3)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
  color: 'var(--c-ink)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)',
};
const badge = (lane: AmendmentLane): CSSProperties => {
  const tone = AMENDMENT_APPROVER_TONE[soAmendmentApprover(lane)];
  return {
    display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontWeight: 700,
    fontSize: 'var(--fs-12, 12px)', background: tone.bg, color: tone.fg, marginRight: 8,
  };
};
const actions: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' };
const btnBase: CSSProperties = {
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 700,
  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
};
const ghostBtn: CSSProperties = { ...btnBase, border: '1px solid var(--line)', background: 'var(--c-paper)', color: 'var(--c-ink)' };
const primaryBtn: CSSProperties = { ...btnBase, border: '1px solid var(--c-orange)', background: 'var(--c-orange)', color: '#fff' };

export type AmendmentSubmitDialogProps = {
  ask: AmendmentLanePreviewArgs;
  onConfirm: (answer: AmendmentSubmitAnswer) => void;
  onCancel: () => void;
};

export const AmendmentSubmitDialog = ({ ask, onConfirm, onCancel }: AmendmentSubmitDialogProps) => {
  const preview = useAmendmentLanePreview(ask);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!reason.trim()) { setError(AMENDMENT_REASON_REQUIRED); return; }
    onConfirm({ reason: reason.trim() });
  };

  const lanes = preview.data ? describeLanePreview(preview.data) : [];

  return (
    <div style={backdrop} onClick={onCancel} role="presentation">
      <div style={card} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="amend-submit-title">
        <h2 id="amend-submit-title" style={titleStyle}>Submit amendment for {ask.docNo}?</h2>
        <p style={bodyStyle}>
          This Sales Order is already ordered from the supplier, so your changes go out as an
          amendment request and are applied once approved.
        </p>

        <div style={laneBox} data-testid="lane-preview">
          {preview.isLoading && <span>Working out who approves this…</span>}
          {preview.isError && (
            <span>Could not work out the approver yet — the request is still routed by the rule when you submit.</span>
          )}
          {preview.data && lanes.length === 0 && <span>Nothing here needs approval.</span>}
          {lanes.map(({ lane, text }) => (
            <span key={lane}>
              <span style={badge(lane)}>{AMENDMENT_APPROVER_LABEL[soAmendmentApprover(lane)]}</span>
              approves {text}
            </span>
          ))}
          {lanes.length > 1 && (
            <span style={{ color: 'var(--c-ink-muted, #6b6f66)' }}>
              {lanes.length} desks are involved, so this is raised as {lanes.length} amendments, one per approver.
            </span>
          )}
        </div>

        <label htmlFor="amend-submit-reason" style={labelStyle}>Reason</label>
        <textarea
          id="amend-submit-reason"
          style={inputStyle}
          value={reason}
          placeholder="e.g. customer changed the fabric colour"
          autoFocus
          onChange={(e) => { setReason(e.target.value); if (error) setError(null); }}
        />

        {error && <p style={errStyle}>{error}</p>}
        <div style={actions}>
          <button type="button" style={ghostBtn} onClick={onCancel}>Cancel</button>
          <button type="button" style={primaryBtn} onClick={submit}>Submit amendment</button>
        </div>
      </div>
    </div>
  );
};

type Pending = { id: number; ask: AmendmentLanePreviewArgs; resolve: (v: AmendmentSubmitAnswer | null) => void };

/* Page-owned: render `element` once anywhere in the page's tree, then `ask()`.
   A second ask while one is open resolves the first with null, like usePrompt. */
export function useAmendmentSubmitDialog(): {
  ask: (a: AmendmentLanePreviewArgs) => Promise<AmendmentSubmitAnswer | null>;
  element: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback(
    (a: AmendmentLanePreviewArgs) => new Promise<AmendmentSubmitAnswer | null>((resolve) => {
      setPending((prev) => { prev?.resolve(null); return { id: (prev?.id ?? 0) + 1, ask: a, resolve }; });
    }),
    [],
  );
  const settle = (v: AmendmentSubmitAnswer | null) => setPending((p) => { p?.resolve(v); return null; });
  const element = pending ? (
    <AmendmentSubmitDialog
      key={pending.id}
      ask={pending.ask}
      onConfirm={(v) => settle(v)}
      onCancel={() => settle(null)}
    />
  ) : null;
  return { ask, element };
}
