import { AuthProvider, PresencePanel } from "autocount-sync-frontend";

// PresencePanel is the sidebar-styled sibling of PresenceIndicator — same
// usePresence hook (POST /api/presence/heartbeat + GET /api/presence), but
// painted with the dark rail tokens, so each story wraps it in a bg-sidebar
// column at the rail's real widths (232px expanded / 64px collapsed). It
// renders nothing until the first presence payload lands.

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const MEMBERS = [
  { id: 1, email: "hello@houzscentury.com", name: "Nick Ho", role_id: 1, role_name: "Managing Director", last_seen_at: new Date().toISOString(), is_self: false },
  { id: 4, email: "farra@houzscentury.com", name: "Farra Aziz", role_id: 3, role_name: "Sales Executive", last_seen_at: new Date().toISOString(), is_self: true },
  { id: 7, email: "weijian@houzscentury.com", name: "Wei Jian", role_id: 5, role_name: "Logistics Coordinator", last_seen_at: new Date().toISOString(), is_self: false },
  { id: 11, email: "aina@houzscentury.com", name: "Aina Rahman", role_id: 6, role_name: "Service Admin", last_seen_at: new Date().toISOString(), is_self: false },
  { id: 9, email: "melissa@houzscentury.com", name: "Melissa Tan", role_id: 4, role_name: "Finance Manager", last_seen_at: new Date().toISOString(), is_self: false },
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
        permissions: ["scm.access"],
        page_access: {},
        profile_pic_r2_key: null,
        scm_l2_configured: false,
      },
    });
  if (url.includes("/api/presence/heartbeat")) return json({ ok: true });
  if (url.includes("/api/presence"))
    return json({ active: MEMBERS, count: MEMBERS.length, window_seconds: 120 });
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

/** Expanded rail slot — "5 Online" label + 4-avatar stack with +1 overflow. */
export const Expanded = () => (
  <AuthProvider>
    <div className="w-[232px] bg-sidebar pt-6">
      <PresencePanel collapsed={false} />
    </div>
  </AuthProvider>
);

/** Collapsed rail slot — green dot + bare member count. */
export const Collapsed = () => (
  <AuthProvider>
    <div className="w-16 bg-sidebar pt-6">
      <PresencePanel collapsed />
    </div>
  </AuthProvider>
);
