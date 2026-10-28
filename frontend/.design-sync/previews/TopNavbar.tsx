import {
  AuthProvider,
  DialogProvider,
  NotificationsProvider,
  BreadcrumbsProvider,
  GlobalSearchProvider,
  QueryClientProvider,
  queryClient,
  MemoryRouter,
  TopNavbar,
} from "autocount-sync-frontend";

// TopNavbar is CONNECTED chrome: breadcrumb (BreadcrumbsProvider — empty here,
// so it falls back to a route-derived label), GlobalSearchTrigger
// (GlobalSearchProvider), PresenceIndicator (GET /api/presence + POST
// heartbeat), NotificationBell (NotificationsProvider poll) and the profile
// avatar from the auth user. All endpoints stubbed below.
//
// NOTE: the <header> is `hidden lg:flex` — it only renders at a desktop
// viewport width (>= 1024px).

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/auth/status")) return json({ has_users: true });
  if (url.includes("/api/auth/me"))
    return json({
      user: {
        id: 4,
        email: "farra@houzscentury.com",
        name: "Farra Aziz",
        role_id: 3,
        role_name: "Sales Executive",
        status: "active",
        permissions: ["scm.access", "service_cases.read", "projects.write"],
        page_access: { sales: "full" },
        profile_pic_r2_key: null,
        scm_l2_configured: false,
      },
    });
  if (url.includes("/api/notifications"))
    return json({
      feed: [
        {
          id: 9101,
          project_id: 118,
          project_code: "PJ-0118",
          project_name: "HomeDec KL · Booth 12",
          brand: "Houzs",
          action: "note",
          from_value: null,
          to_value: null,
          note: "SO-2990-0417 approved by Director — release to warehouse.",
          user_id: 9,
          user_name: "Melissa Tan",
          user_email: "melissa@houzscentury.com",
          user_profile_pic_r2_key: null,
          created_at: minsAgo(18),
          project_start_date: "2026-07-17",
          project_end_date: "2026-07-20",
        },
      ],
      unread_by_project: { 118: 1 },
      total_unread: 4,
    });
  if (url.includes("/api/companies"))
    return json({
      companies: [{ id: 1, code: "HOUZS", name: "Houzs Century Sdn Bhd" }],
      activeCompanyId: 1,
      activeCompanyCode: "HOUZS",
    });
  if (url.includes("/api/presence/heartbeat")) return json({ ok: true });
  if (url.includes("/api/presence"))
    return json({
      active: [
        { id: 4, email: "farra@houzscentury.com", name: "Farra Aziz", role_id: 3, role_name: "Sales Executive", last_seen_at: new Date().toISOString(), is_self: true },
        { id: 7, email: "weijian@houzscentury.com", name: "Wei Jian", role_id: 5, role_name: "Logistics Coordinator", last_seen_at: new Date().toISOString(), is_self: false },
        { id: 11, email: "aina@houzscentury.com", name: "Aina Rahman", role_id: 6, role_name: "Service Admin", last_seen_at: new Date().toISOString(), is_self: false },
        { id: 9, email: "melissa@houzscentury.com", name: "Melissa Tan", role_id: 4, role_name: "Finance Manager", last_seen_at: new Date().toISOString(), is_self: false },
      ],
      count: 4,
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

function Bar({ route }: { route: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <DialogProvider>
            <NotificationsProvider>
              <BreadcrumbsProvider>
                <GlobalSearchProvider>
                  <div className="w-[960px] bg-bg pb-10">
                    <TopNavbar />
                  </div>
                </GlobalSearchProvider>
              </BreadcrumbsProvider>
            </NotificationsProvider>
          </DialogProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Overview route — single route-derived crumb + search, presence, bell, avatar. */
export const Overview = () => <Bar route="/" />;

/** Sales Orders listing route — SCM segment-table crumb label. */
export const SalesOrders = () => <Bar route="/scm/sales-orders" />;
