import { AuthProvider, MemoryRouter, MobileTabBar } from "autocount-sync-frontend";

// Mobile bottom navigation — CONNECTED: returns null until useAuth() has a
// user, so the preview stubs the auth boot fetches (same pattern as
// AnnouncementBanner). No NotificationsProvider needed: useNotifications has
// a default context and only the (closed) Menu sheet reads it.
//
// The rail is `fixed left-3 right-3 bottom-…` + `lg:hidden`, so it escapes
// the card and would stack across grid cells — pin with
// cfg.overrides.MobileTabBar = { cardMode: "single", primaryStory: "HomeActive" }.
// The 900px capture viewport is below lg (1024px), so the rail stays visible.

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
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/auth/status")) return json({ has_users: true });
  if (url.includes("/api/auth/me"))
    return json({
      user: {
        id: 7,
        name: "Farra Nadia",
        email: "farra@houzscentury.com",
        permissions: ["projects.read"],
      },
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

// Light canvas behind the fixed rail so the capture reads as a page, not a
// floating pill on void.
const Rail = ({ path }: { path: string }) => (
  <AuthProvider>
    <MemoryRouter initialEntries={[path]}>
      <div className="min-h-[320px] w-full rounded-lg bg-bg p-4">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
          Supply Chain
        </div>
        <div className="mt-1 font-display text-[16px] font-extrabold text-ink">
          Sales Orders
        </div>
        <div className="mt-3 space-y-2">
          {["SO-2990-0417", "SO-2990-0416", "SO-2990-0413"].map((so) => (
            <div
              key={so}
              className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 shadow-stone"
            >
              <span className="font-mono text-[11px] text-ink-secondary">{so}</span>
              <span className="font-money text-[11px] text-ink">RM 12,480.00</span>
            </div>
          ))}
        </div>
      </div>
      <MobileTabBar />
    </MemoryRouter>
  </AuthProvider>
);

export const HomeActive = () => <Rail path="/" />;
export const SalesOrdersActive = () => <Rail path="/scm/sales-orders" />;
export const InboxActive = () => <Rail path="/notifications" />;
