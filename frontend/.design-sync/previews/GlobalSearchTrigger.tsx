import { useEffect } from "react";
import {
  GlobalSearchProvider,
  GlobalSearchTrigger,
  useGlobalSearch,
  MemoryRouter,
} from "autocount-sync-frontend";

// GlobalSearchTrigger only needs the GlobalSearchProvider context (no auth).
// The Cmd+K palette it opens portals to document.body and calls useNavigate,
// so everything sits inside a MemoryRouter. The palette fetches
// GET /api/search?q=… only once the user types >= 2 chars — stubbed anyway so
// a stray keystroke during capture can't hit the network.

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

/** Field-style trigger — search box lookalike with the ⌘K/Ctrl+K kbd hint. */
export const FieldTrigger = () => (
  <MemoryRouter initialEntries={["/"]}>
    <GlobalSearchProvider>
      <div className="w-[280px] bg-surface-dim p-4">
        <GlobalSearchTrigger collapsed={false} />
      </div>
    </GlobalSearchProvider>
  </MemoryRouter>
);

/** Icon-only trigger — the compact square used in the top navbar / mobile bar. */
export const IconTrigger = () => (
  <MemoryRouter initialEntries={["/"]}>
    <GlobalSearchProvider>
      <div className="flex w-24 justify-center bg-surface-dim p-4">
        <GlobalSearchTrigger collapsed />
      </div>
    </GlobalSearchProvider>
  </MemoryRouter>
);

// Opens the palette on mount via the context's own open() — the overlay
// portals to document.body and covers the viewport (own-page story).
function AutoOpen() {
  const { open } = useGlobalSearch();
  useEffect(() => {
    const t = setTimeout(open, 150);
    return () => clearTimeout(t);
  }, [open]);
  return null;
}

/** Full Cmd+K palette open in its empty-help state ("What you can search"). */
export const OpenPalette = () => (
  <MemoryRouter initialEntries={["/"]}>
    <GlobalSearchProvider>
      <AutoOpen />
      <div className="h-[560px] w-[900px] bg-bg p-6">
        <GlobalSearchTrigger collapsed={false} className="max-w-[280px]" />
      </div>
    </GlobalSearchProvider>
  </MemoryRouter>
);
