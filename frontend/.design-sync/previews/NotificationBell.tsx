import { useEffect, useRef } from "react";
import {
  AuthProvider,
  NotificationsProvider,
  MemoryRouter,
  NotificationBell,
} from "autocount-sync-frontend";

// NotificationBell is CONNECTED: it renders from the NotificationsProvider
// poll (GET /api/notifications?unread=1&limit=20), which itself only fires
// once AuthProvider has a signed-in user. Stub the whole chain: fake token,
// /api/auth/* and a canned unread feed with realistic Houzs activity.

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const FEED = [
  {
    id: 9101,
    project_id: 112,
    project_code: "PJ-0112",
    project_name: "MIFF 2026 · Hall B",
    brand: "Sofa+",
    action: "stage_change",
    from_value: "Setup",
    to_value: "Live",
    note: null,
    user_id: 7,
    user_name: "Wei Jian",
    user_email: "weijian@houzscentury.com",
    user_profile_pic_r2_key: null,
    created_at: minsAgo(6),
    project_start_date: "2026-07-08",
    project_end_date: "2026-07-12",
  },
  {
    id: 9098,
    project_id: 118,
    project_code: "PJ-0118",
    project_name: "HomeDec KL · Booth 12",
    brand: "Houzs",
    action: "note",
    from_value: null,
    to_value: null,
    note: "Client confirmed SO-2990-0417 — deposit received, releasing to warehouse.",
    user_id: 4,
    user_name: "Farra Aziz",
    user_email: "farra@houzscentury.com",
    user_profile_pic_r2_key: null,
    created_at: minsAgo(24),
    project_start_date: "2026-07-17",
    project_end_date: "2026-07-20",
  },
  {
    id: 9095,
    project_id: 112,
    project_code: "PJ-0112",
    project_name: "MIFF 2026 · Hall B",
    brand: "Sofa+",
    action: "checklist_status",
    from_value: null,
    to_value: null,
    note: "Ticked: Delivery photos uploaded (4/4) for ASSR-0231",
    user_id: 11,
    user_name: "Aina Rahman",
    user_email: "aina@houzscentury.com",
    user_profile_pic_r2_key: null,
    created_at: minsAgo(51),
    project_start_date: "2026-07-08",
    project_end_date: "2026-07-12",
  },
  {
    id: 9090,
    project_id: 121,
    project_code: "PJ-0121",
    project_name: "Ampang Showroom Refresh",
    brand: "Houzs",
    action: "created",
    from_value: null,
    to_value: null,
    note: null,
    user_id: 1,
    user_name: "Nick Ho",
    user_email: "hello@houzscentury.com",
    user_profile_pic_r2_key: null,
    created_at: minsAgo(140),
    project_start_date: "2026-08-01",
    project_end_date: null,
  },
  {
    id: 9084,
    project_id: 118,
    project_code: "PJ-0118",
    project_name: "HomeDec KL · Booth 12",
    brand: "Houzs",
    action: "finance_edit",
    from_value: null,
    to_value: null,
    note: null,
    user_id: 9,
    user_name: "Melissa Tan",
    user_email: "melissa@houzscentury.com",
    user_profile_pic_r2_key: null,
    created_at: minsAgo(310),
    project_start_date: "2026-07-17",
    project_end_date: "2026-07-20",
  },
];

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
        permissions: ["service_cases.read", "scm.access", "projects.write"],
        page_access: { sales: "full", projects: "full" },
        profile_pic_r2_key: null,
        scm_l2_configured: false,
      },
    });
  if (url.includes("/api/notifications"))
    return json({
      feed: FEED,
      unread_by_project: { 112: 2, 118: 2, 121: 1 },
      total_unread: 5,
      points_balance: 120,
      gifting_balance: 30,
      current_streak: 4,
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

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <AuthProvider>
        <NotificationsProvider>{children}</NotificationsProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

/** Icon-only bell as the desktop top navbar renders it — closed, unread badge. */
export const TopbarBadge = () => (
  <Providers>
    <div className="flex h-24 w-64 items-start justify-end bg-surface p-4">
      <NotificationBell collapsed direction="down" align="end" />
    </div>
  </Providers>
);

/** Full-width row as the mobile sidebar drawer renders it (dark rail). */
export const SidebarRow = () => (
  <Providers>
    <div className="w-[232px] bg-sidebar p-2">
      <NotificationBell collapsed={false} direction="up" align="start" />
    </div>
  </Providers>
);

/** Popover open — a mount-time click on the bell reveals the unread feed. */
export const OpenPopover = () => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(
      () => ref.current?.querySelector("button")?.click(),
      250
    );
    return () => clearTimeout(t);
  }, []);
  return (
    <Providers>
      <div ref={ref} className="h-[440px] w-[400px] bg-surface p-4">
        <NotificationBell collapsed direction="down" align="start" />
      </div>
    </Providers>
  );
};
