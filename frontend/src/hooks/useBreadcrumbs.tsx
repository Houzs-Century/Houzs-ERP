import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface Ctx {
  crumbs: BreadcrumbItem[];
  /** Set the full crumb stack. Returns a cleanup fn that resets it
   *  to empty — call from `useEffect` so a detail page's crumbs
   *  disappear when it unmounts. */
  set: (crumbs: BreadcrumbItem[]) => void;
  clear: () => void;
}

const BreadcrumbContext = createContext<Ctx>({
  crumbs: [],
  set: () => {},
  clear: () => {},
});

export function BreadcrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, setCrumbs] = useState<BreadcrumbItem[]>([]);
  const set = useCallback((next: BreadcrumbItem[]) => setCrumbs(next), []);
  const clear = useCallback(() => setCrumbs([]), []);
  const value = useMemo(() => ({ crumbs, set, clear }), [crumbs, set, clear]);
  return (
    <BreadcrumbContext.Provider value={value}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumbs(): Ctx {
  return useContext(BreadcrumbContext);
}

/**
 * Convenience: declare breadcrumbs for the lifetime of the caller.
 * Clears them on unmount. DetailLayout uses this.
 */
export function useSetBreadcrumbs(crumbs: BreadcrumbItem[]) {
  const { set, clear } = useBreadcrumbs();
  // Depend on a stable JSON snapshot so re-renders with equivalent
  // arrays don't thrash context state.
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    set(crumbs);
    return () => clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
