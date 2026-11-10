import { useCallback, useEffect, useRef, useState } from "react";
import { confirmLeaving, holdLeaveGuard } from "../lib/leaveGuard";
import { holdUnsavedWork } from "../lib/unsavedWork";

/**
 * While `dirty`, leaving the page asks first (lib/leaveGuard, LeaveGuardBridge),
 * and no automatic reload fires (lib/unsavedWork). `allowLeave()` is for the
 * successful save: call it before navigating to the saved document, so the
 * move is not asked about while the `dirty` state is still catching up.
 * `placeParams`: the query parameters that address this form when it shares a
 * URL path with a list (`["form"]` for `?form=new`); null when the path alone
 * is the form.
 */
export function useLeaveGuard(dirty: boolean, placeParams: readonly string[] | null): { allowLeave: () => void } {
  const releaseRef = useRef<(() => void) | null>(null);
  const paramsKey = (placeParams ?? []).join("&");
  useEffect(() => {
    if (!dirty) return;
    const releaseGuard = holdLeaveGuard(paramsKey === "" ? [] : paramsKey.split("&"));
    const releaseWork = holdUnsavedWork();
    const release = () => {
      releaseGuard();
      releaseWork();
    };
    releaseRef.current = release;
    return () => {
      release();
      releaseRef.current = null;
    };
  }, [dirty, paramsKey]);
  const allowLeave = useCallback(() => {
    releaseRef.current?.();
  }, []);
  return { allowLeave };
}

/**
 * Whether the person has touched the form. Pair with <FormTouchScope
 * onTouch={markTouched}> around the form; `resetTouched` after a save that
 * keeps the page open.
 */
export function useFormTouched(): { touched: boolean; markTouched: () => void; resetTouched: () => void } {
  const [touched, setTouched] = useState(false);
  const markTouched = useCallback(() => setTouched(true), []);
  const resetTouched = useCallback(() => setTouched(false), []);
  return { touched, markTouched, resetTouched };
}

/**
 * For a screen whose own Back is not a router move (the mobile shell switches
 * screens in state): ask first while the guard is held, then go back.
 */
export function useGuardedBack(onBack: () => void): () => void {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  return useCallback(() => {
    void confirmLeaving().then((leave) => {
      if (leave) latest.current();
    });
  }, []);
}
