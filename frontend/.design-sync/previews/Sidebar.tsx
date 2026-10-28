import {
  AuthProvider,
  NotificationsProvider,
  GlobalSearchProvider,
  QueryClientProvider,
  queryClient,
  MemoryRouter,
  Sidebar,
} from "autocount-sync-frontend";

// Sidebar is CONNECTED: it reads the auth user (permissions + page_access
// drive which NAV_TABS survive the recursive filter), renders NavLink/
// useLocation (router), and embeds GlobalSearchTrigger (GlobalSearchProvider),
// NotificationBell (NotificationsProvider) and PresencePanel (usePresence →
// GET /api/presence + POST /api/presence/heartbeat). useBranding fetches
// GET /api/branding for the logo alt text. The preview user carries the "*"
// wildcard so every section (Workspace / Operations / System) is visible.
//
// NOTE: below the lg breakpoint the <aside> is position:fixed and translated
// off-canvas (mobileOpen=false) — capture needs a desktop-width viewport,
// where it becomes lg:relative and sits inside the flex container.

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
  if (url.includes("/api/auth/status")) return json({ has_users: true });
  if (url.includes("/api/auth/me"))
    return json({
      user: {
        id: 1,
        email: "hello@houzscentury.com",
        name: "Nick Ho",
        role_id: 1,
        role_name: "Managing Director",
        status: "active",
        permissions: ["*"],
        page_access: {},
        profile_pic_r2_key: null,
        scm_l2_configured: false,
      },
    });
  if (url.includes("/api/branding"))
    return json({ branding: { company_name: "Houzs Century Sdn Bhd" } });
  if (url.includes("/api/notifications"))
    return json({
      feed: [],
      unread_by_project: { 112: 2, 118: 1 },
      total_unread: 3,
    });
  if (url.includes("/api/presence/heartbeat")) return json({ ok: true });
  if (url.includes("/api/presence"))
    return json({
      active: [
        { id: 1, email: "hello@houzscentury.com", name: "Nick Ho", role_id: 1, role_name: "Managing Director", last_seen_at: new Date().toISOString(), is_self: true },
        { id: 4, email: "farra@houzscentury.com", name: "Farra Aziz", role_id: 3, role_name: "Sales Executive", last_seen_at: new Date().toISOString(), is_self: false },
        { id: 7, email: "weijian@houzscentury.com", name: "Wei Jian", role_id: 5, role_name: "Logistics Coordinator", last_seen_at: new Date().toISOString(), is_self: false },
      ],
      count: 3,
      window_seconds: 120,
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

function Shell({
  collapsed,
  route,
}: {
  collapsed: boolean;
  route: string;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <NotificationsProvider>
            <GlobalSearchProvider>
              <div className="relative flex h-[760px] overflow-hidden bg-bg">
                <Sidebar
                  collapsed={collapsed}
                  onToggle={() => {}}
                  mobileOpen={false}
                  onMobileClose={() => {}}
                />
              </div>
            </GlobalSearchProvider>
          </NotificationsProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Full 232px rail on the Overview route — all three sections visible. */
export const Expanded = () => <Shell collapsed={false} route="/" />;

/** Icon-only 64px rail, Sales Orders route active. */
export const Collapsed = () => <Shell collapsed route="/scm/sales-orders" />;
