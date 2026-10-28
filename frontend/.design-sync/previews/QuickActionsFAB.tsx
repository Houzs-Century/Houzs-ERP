import { useEffect } from "react";
import { AuthProvider, MemoryRouter, QuickActionsFAB } from "autocount-sync-frontend";

// QuickActionsFAB is CONNECTED: it reads useAuth (user + can/pageAccess gate
// which speed-dial actions exist) and useLocation/useNavigate. The preview
// user holds scm.access AND service_cases.write so BOTH actions are eligible
// and the "+" opens the two-item speed-dial instead of direct-navigating.
//
// The FAB portals to document.body as position:fixed bottom-right — it
// escapes any card box, so this preview belongs on a single full-page card.

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
        id: 4,
        email: "farra@houzscentury.com",
        name: "Farra Aziz",
        role_id: 3,
        role_name: "Sales Executive",
        status: "active",
        permissions: ["scm.access", "service_cases.write", "service_cases.read"],
        page_access: { service_cases: "full", "scm.sales.orders": "full" },
        profile_pic_r2_key: null,
        scm_l2_configured: false,
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

function Stage({ children }: { children?: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/scm/sales-orders"]}>
      <AuthProvider>
        {/* Spacer gives the fixed FAB a visible bottom-right corner to land in. */}
        <div className="h-[420px] w-full bg-bg" />
        <QuickActionsFAB />
        {children}
      </AuthProvider>
    </MemoryRouter>
  );
}

/** Resting "+" FAB pinned to the bottom-right corner. */
export const Fab = () => <Stage />;

// The speed-dial only opens through the FAB's own click handler; the FAB
// renders null until /api/auth/me resolves, so poll for the button then click.
function AutoOpen() {
  useEffect(() => {
    const timer = setInterval(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Quick actions"]'
      );
      if (btn) {
        btn.click();
        clearInterval(timer);
      }
    }, 120);
    const stop = setTimeout(() => clearInterval(timer), 4000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, []);
  return null;
}

/** Speed-dial open — New Sales Order (petrol) + New Service Case (outline). */
export const SpeedDialOpen = () => (
  <Stage>
    <AutoOpen />
  </Stage>
);
