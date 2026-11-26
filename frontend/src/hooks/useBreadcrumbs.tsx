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
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    set(crumbs);
    return () => clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
