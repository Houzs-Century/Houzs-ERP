import { useEffect } from "react";
import {
  GlobalSearchProvider,
  GlobalSearchTrigger,
  useGlobalSearch,
  MemoryRouter,
} from "autocount-sync-frontend";

// GlobalSearchProvider is the ⌘K search CONTEXT: it renders nothing itself —
// it owns the open/close state, the global hotkeys (⌘K / Ctrl+K / "/") and
// mounts the Palette overlay. These stories show it doing its real job:
// wrapping an app region (trigger reads the context) and serving a live
// palette whose query hits the (stubbed) /api/search.

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/search"))
    return json({
      hits: [
        { type: "sales_order", id: "SO-2990-0417", title: "SO-2990-0417 · Amirah Binti Salleh", subtitle: "3-seater Oslo sofa · RM 4,280 · deposit paid", date: "2026-07-04", link: "/scm/sales-orders/SO-2990-0417" },
        { type: "sales_order", id: "SO-2990-0423", title: "SO-2990-0423 · Nurul Aina", subtitle: "Panasonic 2.5HP install · RM 8,340 · partial delivery", date: "2026-07-05", link: "/scm/sales-orders/SO-2990-0423" },
        { type: "assr_case", id: "ASSR-0231", title: "ASSR-0231 · Recliner mechanism jam", subtitle: "Customer: Lim Chee Keong · Technician assigned", date: "2026-07-08", link: "/assr/ASSR-0231" },
        { type: "user", id: 4, title: "Farra Aziz", subtitle: "Sales Executive · farra@houzscentury.com", date: null, link: "/team?tab=members" },
      ],
    });
  // Unstubbed API paths must NOT fall through: the DS bundle's baseUrl points
  // at the real workers.dev API, and a genuine 401 there fires the global
  // logout listener — wiping the preview auth token mid-render.
  if (url.includes("/api/"))
    return new Response(JSON.stringify({ error: "not stubbed in preview" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  return realFetch(input as RequestInfo, init);
};

/** Provider in place: wraps an app region; the trigger reads its context. */
export const WrapsAppRegion = () => (
  <MemoryRouter initialEntries={["/"]}>
    <GlobalSearchProvider>
      <div className="w-[360px] space-y-3 bg-bg p-4">
        <GlobalSearchTrigger collapsed={false} />
        <p className="text-[11.5px] leading-relaxed text-ink-muted">
          GlobalSearchProvider renders nothing itself — it owns the palette
          state, binds <span className="font-mono">⌘K / Ctrl+K / "/"</span>{" "}
          globally, and any descendant can call{" "}
          <span className="font-mono">useGlobalSearch().open()</span>.
        </p>
      </div>
    </GlobalSearchProvider>
  </MemoryRouter>
);

// Open the palette via the context, then type a query through the native
// value setter so the controlled input runs its real debounced /api/search.
function AutoSearch() {
  const { open } = useGlobalSearch();
  useEffect(() => {
    const t1 = setTimeout(open, 50);
    const t2 = setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(
        'div[aria-label="Global search"] input',
      );
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "SO-2990");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, 150);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [open]);
  return null;
}

/** The palette the provider serves — live results for "SO-2990". */
export const PaletteWithResults = () => (
  <MemoryRouter initialEntries={["/"]}>
    <GlobalSearchProvider>
      <AutoSearch />
      <div className="h-[560px] w-[900px] bg-bg p-6">
        <GlobalSearchTrigger collapsed={false} className="max-w-[280px]" />
      </div>
    </GlobalSearchProvider>
  </MemoryRouter>
);
