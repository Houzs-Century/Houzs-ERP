import { useEffect, useRef } from "react";
import { AuthProvider, MemoryRouter, PresenceButton } from "autocount-sync-frontend";

// Who's-online header control (2026-07-27, #1335). CONNECTED: usePresence
// polls GET /api/presence + POSTs a heartbeat, and AuthProvider bootstraps
// /api/auth/*. Everything is stubbed below — unmatched /api/* returns a
// LOCAL 404 so nothing reaches the real backend with the fake token (a
// genuine 401 would fire the global logout and blank the card mid-render).
// The popover only opens on click, so the primary story auto-clicks the
// button after mount (same trick as DetailListingShell's AutoInquiry).

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {
  /* private mode */
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/* last_seen_at rides the backend's SQLite shape: "YYYY-MM-DD HH:MM:SS" UTC.
   Computed per request so the since/idle labels stay truthful on re-poll. */
const sqlite = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

const member = (
  id: number,
  name: string,
  role: string,
  msAgo: number,
  path: string | null,
) => ({
  id,
  email: name.toLowerCase().replace(/\s+/g, ".") + "@houzscentury.com",
  name,
  role_id: 3,
  role_name: role,
  last_seen_at: sqlite(msAgo),
  last_path: path,
  is_self: false,
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
        email: "nico@houzscentury.com",
        name: "Nico",
        role_id: 1,
        role_name: "Super Admin",
        status: "active",
        permissions: [],
        page_access: {},
        profile_pic_r2_key: null,
        scm_l2_configured: false,
      },
    });
  if (url.includes("/api/presence/heartbeat")) return json({ ok: true });
  if (url.includes("/api/presence"))
    return json({
      active: [
        member(4, "Farra Aziz", "Sales Executive", 20_000, "/orders/SO-2990-2607-022"),
        member(7, "Wei Jian", "Logistics Coordinator", 70_000, "/delivery-planning"),
        member(11, "Aina Rahman", "Service Admin", 95_000, "/assr"),
      ],
      away: [
        member(9, "Melissa Tan", "Finance Manager", 5 * 60_000, "/po"),
        member(15, "Hafiz Rahim", "Warehouse Lead", 9 * 60_000, "/team"),
      ],
      count: 3,
      window_seconds: 120,
      away_window_seconds: 900,
    });
  if (url.includes("/api/"))
    return new Response(JSON.stringify({ error: "not stubbed in preview" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  return realFetch(input as RequestInfo, init);
};

/* The popover opens on click — press the button for the story once mounted. */
function AutoOpen({ hostRef }: { hostRef: { current: HTMLDivElement | null } }) {
  useEffect(() => {
    const t = setTimeout(() => {
      hostRef.current?.querySelector("button")?.click();
    }, 120);
    return () => clearTimeout(t);
  }, [hostRef]);
  return null;
}

const Frame = ({
  autoOpen,
  height,
  children,
}: {
  autoOpen?: boolean;
  height: string;
  children?: never;
} & { children?: React.ReactNode }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  return (
    <MemoryRouter initialEntries={["/"]}>
      <AuthProvider>
        <div
          ref={hostRef}
          className={`flex ${height} w-[420px] justify-end bg-bg p-4`}
        >
          {autoOpen && <AutoOpen hostRef={hostRef} />}
          <PresenceButton />
        </div>
      </AuthProvider>
    </MemoryRouter>
  );
};

/** The full popover: 3 online (doc-number deep link on the first row) + 2 away. */
export const OpenPopover = () => <Frame autoOpen height="h-[600px]" />;

/** Closed rest state — green count badge on the 36px Users tile. */
export const ClosedWithBadge = () => <Frame height="h-[90px]" />;
