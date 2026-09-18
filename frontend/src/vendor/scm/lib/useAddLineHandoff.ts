/* useAddLineHandoff — the editor half of the "Add line" handoff, as ONE hook.

   Why a hook and not four lines pasted into each editor: those editors carry an
   early `return <SkeletonDetailPage />` while the document loads, and everything
   after it — including where the add-row trigger is defined — sits BELOW that
   return. A `useEffect` written down there is a hook after a conditional return,
   which React forbids and the linter caught in two files the moment it was
   pasted in. One hook, called at the top with the rest of them, is the shape
   that is correct in every editor rather than the one that happens to work in
   the file it was written for.

   `enabled` and `onTrigger` arrive through a REF the caller fills in later in
   the same render, because both are derived from state declared below the early
   return. The effect reads them at fire time, so it never needs them as
   dependencies and never fires with a stale closure.

   Fires ONCE per mount, and strips the fragment when it does: left on the URL it
   re-opens the add row on every remount, which on a page that remounts after a
   save is a form that will not shut. See lib/add-line-handoff.ts for the
   contract and docs/bugs/0853 for what it is fixing. */

import { useEffect, useRef, type MutableRefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { consumedAddLine, wantsAddLine } from './add-line-handoff';

export type AddLineHandoffTarget = {
  /** Whether the editor is in a state that can accept a new line right now. */
  enabled: boolean;
  /** Opens the editor's add row. */
  onTrigger: () => void;
};

/**
 * Call at the TOP of an editor, beside the other hooks, then fill the returned
 * ref once `enabled` and `onTrigger` exist:
 *
 *     const handoff = useAddLineHandoff();
 *     // …later, after isEditing / startAddLine are declared:
 *     handoff.current = { enabled: isEditing && !isLocked, onTrigger: startAddLine };
 *
 * Assigning during render is deliberate and safe here: the ref is read only
 * inside an effect, which runs after the render that wrote it.
 */
export function useAddLineHandoff(): MutableRefObject<AddLineHandoffTarget> {
  const target = useRef<AddLineHandoffTarget>({ enabled: false, onTrigger: () => {} });
  const fired = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (fired.current) return;
    if (!wantsAddLine(location.hash)) return;
    /* Not yet editable — the editor is still loading, or the document is
       locked. Leave the fragment ALONE so the effect can fire on a later
       render; consuming it here would swallow the operator's intent. */
    if (!target.current.enabled) return;
    fired.current = true;
    target.current.onTrigger();
    navigate(consumedAddLine(`${location.pathname}${location.search}`), { replace: true });
  });

  return target;
}
