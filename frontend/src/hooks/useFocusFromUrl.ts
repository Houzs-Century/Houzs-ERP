import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Pop the side panel for whatever id is in the URL's `?focus=` param
 * on mount, then strip the param so refresh/back-nav doesn't keep
 * re-triggering it. Used by the Overview inbox to deep-link into
 * ASSR / Projects / Trips detail panels.
 *
 * Pass the page's setSelectedId (or equivalent). If the param is
 * absent or non-numeric, this is a no-op.
 *
 * @param onFocus  Called once with the parsed id from `?focus=`.
 */
export function useFocusFromUrl(onFocus: (id: number) => void): void {
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const raw = params.get("focus");
    if (!raw) return;
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id)) return;
    onFocus(id);
    const next = new URLSearchParams(params);
    next.delete("focus");
    setParams(next, { replace: true });
    // Run only on mount — subsequent navigations are user-initiated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
