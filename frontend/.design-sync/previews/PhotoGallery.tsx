import { PhotoGallery } from "autocount-sync-frontend";
import * as DS from "autocount-sync-frontend";

// Product-model photo gallery — CONNECTED: lists photos itself via authedFetch
// (needs localStorage "auth:token" + a fetch stub) AND calls useQuery /
// useQueryClient / useMutation from @tanstack/react-query.
//
// BLOCKER (today): same as HeroImageEditor — the bundle inlines react-query
// and neither QueryClient nor QueryClientProvider is re-exported from
// .design-sync/entry.tsx, so no provider with matching context identity can
// be supplied. Fix: add
// `export { QueryClient, QueryClientProvider } from "@tanstack/react-query";`
// to entry.tsx and rebuild — the guard below then renders live automatically.
//
// Story picked via ?story= (the list query caches per modelId). Suggest
// cfg.overrides.PhotoGallery = { cardMode: "single", primaryStory: "Gallery" }.
// The NotWired story exercises the real classifyLoadError path: a 404
// not_found response renders the "Photo gallery not yet wired" panel.

const QueryClient = (DS as any).QueryClient;
const QueryClientProvider = (DS as any).QueryClientProvider;

const story = new URLSearchParams(window.location.search).get("story") || "Gallery";

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {}

// Inline data-URI product shots (no external hosts allowed) — flat "studio"
// tiles in petrol/brass with a unit silhouette.
const shot = (bg: string, accent: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">` +
      `<rect width="300" height="300" fill="${bg}"/>` +
      `<rect x="45" y="90" width="210" height="72" rx="12" fill="#eef3f2"/>` +
      `<rect x="60" y="142" width="180" height="7" rx="3.5" fill="${accent}"/>` +
      `<circle cx="235" cy="112" r="9" fill="${accent}"/>` +
      `<rect x="45" y="205" width="120" height="10" rx="5" fill="#ffffff" opacity="0.35"/>` +
    `</svg>`,
  );

const PHOTOS = [
  { id: "ph1", key: "pm/pan-25hp/1.webp", url: shot("#1f4e56", "#b08d3f"), is_primary: true, order: 0 },
  { id: "ph2", key: "pm/pan-25hp/2.webp", url: shot("#2c6b74", "#d8b25e"), is_primary: false, order: 1 },
  { id: "ph3", key: "pm/pan-25hp/3.webp", url: shot("#173a40", "#b08d3f"), is_primary: false, order: 2 },
  { id: "ph4", key: "pm/pan-25hp/4.webp", url: shot("#39626a", "#e8f0ef"), is_primary: false, order: 3 },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/product-models/") && url.includes("/photos")) {
    if (story === "NotWired") return json({ error: "not_found" }, 404);
    if (story === "EmptyGallery") return json({ photos: [] });
    return json({ photos: PHOTOS });
  }
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

const qc = QueryClient
  ? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  : null;

const Live = () => (
  <QueryClientProvider client={qc}>
    <div className="w-[40rem]">
      <PhotoGallery
        modelId="pm-2990-pan-25hp"
        modelName="Panasonic 2.5HP X-Premium Inverter"
      />
    </div>
  </QueryClientProvider>
);

// Honest placeholder until the react-query exports land in the entry.
const Blocked = () => (
  <div className="w-[28rem] rounded-lg border border-dashed border-border-strong bg-surface p-4 shadow-stone">
    <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-accent">
      Preview blocked · provider missing
    </div>
    <div className="mt-1 text-[13px] font-semibold text-ink">
      PhotoGallery needs QueryClientProvider
    </div>
    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
      useQuery/useQueryClient/useMutation throw without the bundle's own
      react-query provider. Re-export QueryClient + QueryClientProvider from
      .design-sync/entry.tsx and rebuild — this preview then renders live.
    </p>
  </div>
);

const Story = () => (qc ? <Live /> : <Blocked />);

export const Gallery = () => <Story />;
export const EmptyGallery = () => <Story />;
export const NotWired = () => <Story />;
