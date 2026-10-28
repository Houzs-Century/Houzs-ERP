import { HeroImageEditor } from "autocount-sync-frontend";
import * as DS from "autocount-sync-frontend";

// Category hero editor — CONNECTED: loads hero meta itself via authedFetch
// (needs localStorage "auth:token" + a fetch stub) AND calls useQuery /
// useQueryClient from @tanstack/react-query.
//
// BLOCKER (today): the bundle inlines its own react-query copy, and neither
// QueryClient nor QueryClientProvider is re-exported from
// .design-sync/entry.tsx — a copy imported from node_modules would be a
// different context instance, so no provider can be supplied from here.
// Fix: add `export { QueryClient, QueryClientProvider } from "@tanstack/react-query";`
// to entry.tsx and rebuild — the guard below picks the exports up off the
// bundle namespace and this preview renders live automatically.
//
// One category state per page (the meta query caches per categoryId anyway) —
// story picked via ?story=, same pattern as AnnouncementBanner. Suggest
// cfg.overrides.HeroImageEditor = { cardMode: "single", primaryStory: "SavedCover" }.

const QueryClient = (DS as any).QueryClient;
const QueryClientProvider = (DS as any).QueryClientProvider;

const story =
  new URLSearchParams(window.location.search).get("story") || "SavedCover";

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {}

// Petrol/brass abstract "showroom wall" cover as an inline data URI (no
// external hosts allowed).
const HERO_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 350">` +
      `<rect width="800" height="350" fill="#1f4e56"/>` +
      `<rect x="60" y="70" width="330" height="110" rx="16" fill="#e8f0ef"/>` +
      `<rect x="80" y="150" width="290" height="10" rx="5" fill="#9db8b4"/>` +
      `<circle cx="620" cy="120" r="70" fill="#b08d3f" opacity="0.85"/>` +
      `<rect x="430" y="230" width="300" height="60" rx="10" fill="#2c6b74"/>` +
      `<rect x="60" y="230" width="330" height="60" rx="10" fill="#173a40"/>` +
    `</svg>`,
  );

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/hero-meta")) {
    if (story === "NoCoverYet")
      return json({ url: null, focal_x: 0.5, focal_y: 0.5, alt: "" });
    return json({
      url: HERO_URI,
      focal_x: 0.42,
      focal_y: 0.35,
      alt: "Wall-mounted inverter units on the Ampang showroom display wall",
    });
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
    <div className="w-[40rem] rounded-lg border border-border bg-surface p-4 shadow-stone">
      <HeroImageEditor
        categoryId="cat-air-conditioning"
        categoryName="Air Conditioning"
        onClose={() => {}}
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
      HeroImageEditor needs QueryClientProvider
    </div>
    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
      useQuery/useQueryClient throw without the bundle's own react-query
      provider. Re-export QueryClient + QueryClientProvider from
      .design-sync/entry.tsx and rebuild — this preview then renders live.
    </p>
  </div>
);

const Story = () => (qc ? <Live /> : <Blocked />);

export const SavedCover = () => <Story />;
export const NoCoverYet = () => <Story />;
