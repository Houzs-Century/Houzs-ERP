import {
  AuthProvider,
  NotificationsProvider,
  BreadcrumbsProvider,
  DialogProvider,
  GlobalSearchProvider,
  QueryClientProvider,
  queryClient,
  ToastProvider,
  MemoryRouter,
  Layout,
  PageHeader,
  Button,
} from "autocount-sync-frontend";
import { Plus } from "lucide-react";

// Layout is the FULL app chrome: Sidebar (nav filter needs the auth user;
// embeds GlobalSearchTrigger / NotificationBell / PresencePanel), the mobile
// top bar + tab rail, TopNavbar (breadcrumbs), the /api/sync/status poll that
// drives the Read-Only banner, and useBranding. Every mount-path endpoint is
// stubbed below. It sizes itself h-dvh/w-screen, so this preview is a
// full-viewport, single-card page.
//
// The fetch stub is module-scope (one per file) but /api/sync/status must
// differ per story, so — same trick as AnnouncementBanner — the story picks
// its payload from the ?story= URL param (each story loads on its own page).

const story = new URLSearchParams(window.location.search).get("story") || "Overview";
const writesDisabled = story === "ReadOnly";

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
  if (url.includes("/api/sync/status"))
    return json({
      checkpoint: "2026-06-13T09:41:00Z",
      last_pull: null,
      last_pull_all: null,
      error_count: 0,
      autocount_writes_disabled: writesDisabled,
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
          note: "SO-2990-0417 approved — release to warehouse.",
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
      total_unread: 3,
      points_balance: 120,
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
  if (url.includes("/api/search")) return json({ hits: [] });
  if (url.includes("/api/companies"))
    return json({
      companies: [{ id: 1, code: "HOUZS", name: "Houzs Century Sdn Bhd" }],
      activeCompanyId: 1,
      activeCompanyCode: "HOUZS",
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

const STATS: Array<[string, string, string]> = [
  ["Open Sales Orders", "38", "RM 412,900 pipeline"],
  ["Service Cases", "12 open", "2 breaching SLA this week"],
  ["Deliveries Today", "9 drops", "3 lorries dispatched"],
];

function DemoPage() {
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Overview"
        description="Today across Sales, Logistics and Service at a glance."
        primaryAction={
          <Button>
            <Plus size={13} />
            New Sales Order
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-3">
        {STATS.map(([label, value, hint]) => (
          <div
            key={label}
            className="rounded-md border border-border bg-surface p-4 shadow-stone"
          >
            <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
              {label}
            </div>
            <div className="mt-1.5 font-display text-[24px] font-extrabold text-ink">
              {value}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-secondary">{hint}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-md border border-border bg-surface p-4 shadow-stone">
        <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
          Recent Activity
        </div>
        <ul className="mt-2 space-y-1.5 text-[12px] text-ink-secondary">
          <li>Melissa Tan approved SO-2990-0417 — released to warehouse.</li>
          <li>Aina Rahman closed service case ASSR-0231 (recliner mechanism).</li>
          <li>Wei Jian dispatched Trip #88 — 4 drops, Klang Valley South.</li>
        </ul>
      </div>
    </>
  );
}

const Chrome = () => (
  <QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={["/"]}>
      <AuthProvider>
        <ToastProvider>
          <DialogProvider>
            <NotificationsProvider>
              <BreadcrumbsProvider>
                <GlobalSearchProvider>
                  <Layout>
                    <DemoPage />
                  </Layout>
                </GlobalSearchProvider>
              </BreadcrumbsProvider>
            </NotificationsProvider>
          </DialogProvider>
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>
  </QueryClientProvider>
);

/** Full chrome — sidebar, top navbar, demo Overview content. */
export const Overview = () => <Chrome />;

/** Same chrome with the AutoCount Read-Only banner active (writes halted). */
export const ReadOnly = () => <Chrome />;
