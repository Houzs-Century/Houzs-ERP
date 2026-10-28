import { AuthProvider, Gate, Button } from "autocount-sync-frontend";
import { Pencil, Send } from "lucide-react";

// Gate is a pure conditional wrapper over useAuth().can/canAny/canAll — the
// only network the preview needs is the auth bootstrap. One user, several
// gates: the preview user holds projects.write + service_cases.read +
// scm.access but NOT settings.manage, so both the allowed and the denied
// (fallback) states render side by side on the same page.

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
        permissions: ["projects.write", "service_cases.read", "scm.access"],
        page_access: { sales: "full", projects: "full" },
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

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="w-[340px] rounded-md border border-border bg-surface p-4">
      <div className="mb-3 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      {children}
    </div>
  );
}

/** Gate open — user holds projects.write, the edit action renders. */
export const Allowed = () => (
  <AuthProvider>
    <Card label='perm="projects.write" · granted'>
      <Gate perm="projects.write">
        <Button>
          <Pencil size={13} />
          Edit Project PJ-0118
        </Button>
      </Gate>
    </Card>
  </AuthProvider>
);

/** Gate closed — settings.manage missing, the fallback renders instead. */
export const DeniedWithFallback = () => (
  <AuthProvider>
    <Card label='perm="settings.manage" · denied'>
      <Gate
        perm="settings.manage"
        fallback={
          <span className="text-[12px] text-ink-muted">
            Read-only — ask an administrator for Settings access.
          </span>
        }
      >
        <Button>Manage Branding</Button>
      </Gate>
    </Card>
  </AuthProvider>
);

/** anyPerm OR-gate — scm.access alone unlocks the composer action. */
export const AnyPerm = () => (
  <AuthProvider>
    <Card label='anyPerm=["scm.access","finance.read"] · granted via scm.access'>
      <Gate
        anyPerm={["scm.access", "finance.read"]}
        fallback={<span className="text-[12px] text-ink-muted">Hidden</span>}
      >
        <Button variant="secondary">
          <Send size={13} />
          Submit SO-2990-0417 for approval
        </Button>
      </Gate>
    </Card>
  </AuthProvider>
);
