import {
  createContext,
  lazy,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Search } from "lucide-react";
import { cn } from "../lib/utils";
import { LazySlot } from "./LazySlot";



interface SearchContextValue {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const SearchContext = createContext<SearchContextValue | null>(null);

export function useGlobalSearch(): SearchContextValue {
  const ctx = useContext(SearchContext);
  if (!ctx) {
    throw new Error("useGlobalSearch must be used within <GlobalSearchProvider>");
  }
  return ctx;
}

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const value = useMemo<SearchContextValue>(
    () => ({
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
      toggle: () => setIsOpen((o) => !o),
    }),
    []
  );

  useEffect(() => {
    void preloadGlobalSearchPalette();
  }, []);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((o) => !o);
        return;
      }
      if (e.key === "/" && !isMeta) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
        e.preventDefault();
        setIsOpen(true);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <SearchContext.Provider value={value}>
      {children}
      {isOpen && <PaletteSlot onClose={() => setIsOpen(false)} />}
    </SearchContext.Provider>
  );
}


let paletteModule: typeof import("./GlobalSearchPalette") | null = null;

/** Fetch the overlay module; once it has arrived the palette opens with no wait. */
export function preloadGlobalSearchPalette(): Promise<typeof import("./GlobalSearchPalette")> {
  return import("./GlobalSearchPalette").then((m) => {
    paletteModule = m;
    return m;
  });
}

const LazyPalette = lazy(() => preloadGlobalSearchPalette().then((m) => ({ default: m.Palette })));

function PaletteSlot({ onClose }: { onClose: () => void }) {
  const Loaded = paletteModule?.Palette;
  if (Loaded) return <Loaded onClose={onClose} />;
  return (
    <LazySlot resetKey="global-search" fallback={null}>
      <LazyPalette onClose={onClose} />
    </LazySlot>
  );
}


export function GlobalSearchTrigger({
  collapsed,
  className,
  tone = "surface",
}: {
  collapsed?: boolean;
  className?: string;
  tone?: "surface" | "inset";
}) {
  const { open } = useGlobalSearch();
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcut = isMac ? "⌘K" : "Ctrl+K";

  if (collapsed) {
    return (
      <button
        onClick={open}
        className={cn(
          "flex h-11 w-11 sm:h-9 sm:w-9 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary transition-colors hover:border-primary/50 hover:text-primary",
          className
        )}
        title={`Search (${shortcut})`}
        aria-label="Open global search"
      >
        <Search size={15} />
      </button>
    );
  }

  return (
    <button
      onClick={open}
      className={cn(
        "group flex h-9 w-full items-center gap-2 rounded-md border border-border px-2.5 text-left text-[12px] text-ink-muted transition-colors hover:border-primary/50 hover:text-ink",
        tone === "inset" ? "bg-surface-2" : "bg-surface",
        className
      )}
      title={`Search (${shortcut})`}
      aria-label="Open global search"
    >
      <Search size={13} className="shrink-0 group-hover:text-primary" />
      <span className="flex-1 truncate">Search…</span>
      <kbd className="rounded border border-border bg-bg px-1 py-0.5 font-mono text-[9.5px] text-ink-muted">
        {shortcut}
      </kbd>
    </button>
  );
}
