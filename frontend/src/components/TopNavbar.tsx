import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Check,
  ChevronsUpDown,
  ExternalLink,
  LogOut,
  UserRound,
  UserRoundCog,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { usePresence } from "../hooks/usePresence";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import { PresenceButton } from "./PresenceButton";
import { RefreshButton } from "./RefreshButton";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { Avatar } from "./Avatar";
import { cn } from "../lib/utils";
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { useDialog } from "../hooks/useDialog";
import {
  getActiveCompanySnapshot,
  setActiveCompanyId,
  subscribeActiveCompany,
} from "../lib/activeCompany";
import { clearAllScmHandoffs } from "../lib/scmHandoffStorage";

/**
 * Desktop-only sticky top chrome — ONE 52px bar (top-chrome redesign 2b,
 * owner handoff 2026-07-23). Left: the WorkspaceTabs strip inline. Right:
 * search (Ctrl+K) · company switcher icon · who's-online (green count badge,
 * popover with deep links — 2026-07-26) · notification bell (red dot) ·
 * divider · avatar + name/role with the online state as a green corner dot.
 *
 * The breadcrumb row is GONE — the page name lives once, in the PageHeader
 * title right under this bar (no dead band). DetailLayout still publishes
 * crumbs to BreadcrumbContext; nothing renders them here today.
 * Hidden below lg; the mobile chrome is untouched.
 *
 * Every lg sticky below parks at top-[52px]: Layout PageHeader, DetailLayout,
 * the two SCM V2 doc bars — change this bar's height, change them all.
 */
export function TopNavbar() {
  const { user } = useAuth();

  return (
    <header className="sticky top-0 z-30 hidden h-[52px] items-center border-b border-border bg-surface pl-3.5 pr-2 lg:flex">
      {/* Workspace tabs (left; scrolls in place on overflow). */}
      <WorkspaceTabs />

      {/* Utility cluster (right): company / search / bell / profile — the
          company pill leads, as it always has (owner screenshot 2026-07-23). */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-4">
        <CompanySwitcher />
        <div className="w-[220px]">
          <GlobalSearchTrigger tone="inset" />
        </div>
        {user && (
          <>
            {/* Refresh leads the icon tiles (owner 2026-09-02, "button refresh
                apply for all pages"). One control in the shared chrome reaches
                every page — see RefreshButton for why it drops two caches. */}
            <RefreshButton />
            <PresenceButton />
            <NotificationBell collapsed direction="down" align="end" tone="navbar" unread="dot" />
            <span aria-hidden className="mx-0.5 h-6 w-px bg-border-subtle" />
            <ProfileMenu />
          </>
        )}
      </div>
    </header>
  );
}

// ── Company switcher ───────────────────────────────────────
// Multi-company (Phase 0c). Fetches GET /api/companies and renders a compact
// dropdown of the active company's name. NO-OP by design: renders NOTHING until
// the companies master exists and returns MORE THAN ONE company — so today
// (single-company Houzs) it is invisible and no X-Company-Id header is sent.
// Selecting a company writes the active-company store (persisted to
// localStorage) and invalidates every query so the whole app refetches scoped
// to the new company. Styling reuses the navbar's Ink & Petrol tokens.

interface CompaniesResponse {
  companies: Array<{ id: number; code: string; name: string }>;
  activeCompanyId: number | null;
  activeCompanyCode: string | null;
}

function CompanySwitcher() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dialog = useDialog();

  // Persisted switcher pick (null = follow the backend hostname default).
  const stored = useSyncExternalStore(
    subscribeActiveCompany,
    getActiveCompanySnapshot,
    getActiveCompanySnapshot,
  );

  const { data } = useQuery<CompaniesResponse>("/api/companies",
    () => api.get<CompaniesResponse>("/api/companies"),
    [],
  );
  const companies = data?.companies ?? [];

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  // No-op: hidden entirely until there is a real choice to make.
  if (companies.length <= 1) return null;

  // Active = the stored pick when it's still a valid company, else the company
  // the BACKEND says it actually resolved for this request (the hostname
  // default when we sent no X-Company-Id).
  //
  // There is deliberately NO `companies[0]` fallback. Falling back to the first
  // row is a positional guess: it labels the user with a company nobody has
  // confirmed they are in, and every document they then raise is attributed
  // somewhere else. When neither source can answer we say so — an unlabelled
  // switcher is a prompt to choose; a wrong label is a silent misattribution.
  const resolvedByBackend = data?.activeCompanyId ?? null;
  const activeId =
    (stored !== null && companies.some((co) => co.id === stored) ? stored : null) ??
    (resolvedByBackend !== null && companies.some((co) => co.id === resolvedByBackend)
      ? resolvedByBackend
      : null);
  const active = activeId === null ? undefined : companies.find((co) => co.id === activeId);

  async function pick(id: number) {
    setOpen(false);
    if (id === activeId) return;
    // The switch below hard-reloads the whole app (see the block comment) to
    // guarantee zero cross-company staleness — but a reload silently discards
    // any unsaved edits: the app registers no beforeunload guard, so nothing
    // else warns the user. Confirm first so a mid-edit switch can't lose work.
    // Only reached when the target company actually differs (same-company
    // re-selects already returned above), so we never nag on a no-op pick.
    const ok = await dialog.confirm({
      title: "Switch company?",
      message:
        "Switching company reloads the page — any unsaved changes will be lost. Continue?",
      confirmLabel: "Switch company",
    });
    if (!ok) return;
    // A company switch is a fundamental tenant-context change. Backend scoping
    // already isolates each company's data (companyContext + X-Company-Id); the
    // frontend must never leave the previous company's rows on screen for even
    // one frame. In-place cache invalidation could not guarantee that: react-query
    // keys don't include the company, invalidateQueries raced, and
    // queryClient.clear() empties the cache but does NOT re-trigger a mounted
    // observer to refetch — so a list kept showing the previous company until it
    // happened to remount. A full page reload is the bulletproof fix: nothing
    // stale can render because the whole app re-boots. We persist the new active
    // company FIRST — setActiveCompanyId writes this tab's sessionStorage pick
    // AND the durable per-user record synchronously — so after the reload the app
    // boots under the new company and every request carries the new X-Company-Id
    // header. Company switches are rare + deliberate, so the reload cost is an
    // acceptable trade for guaranteed zero cross-company staleness.
    //
    // clearAllScmHandoffs drops the TRANSIENT navigation handoffs only. Staged
    // payment-retry intents are company-scoped and stay put: they are money
    // already collected, and switching company is not permission to destroy it
    // (see lib/scmHandoffStorage).
    clearAllScmHandoffs();
    setActiveCompanyId(id);
    window.location.reload();
  }

  return (
    <div ref={wrapRef} className="relative">
      {/* Owner 2026-07-23 (on the 2b handoff): KEEP the labelled pill, not the
          icon-only compression the mock drew — with one window per company,
          the visible company NAME in the bar is load-bearing context. Height
          tuned to the 34px cluster; everything else is the pre-2b trigger. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[34px] items-center gap-1.5 rounded-md border border-border bg-bg/40 px-2.5 text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-bg/60 hover:text-accent"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active ? "Switch company" : "No company selected — choose one"}
      >
        {/* Never a company NAME we have not confirmed. "Select company" reads as
            an unanswered question, which is exactly what it is. */}
        <span
          className={cn("max-w-[9rem] truncate", !active && "italic text-warning-text")}
          data-company-unresolved={active ? undefined : "true"}
        >
          {active?.name ?? "Select company"}
        </span>
        <ChevronsUpDown size={13} strokeWidth={2} className="shrink-0 text-ink-muted/70" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-40 mt-1 min-w-[13rem] overflow-hidden rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {companies.map((co) => {
            const isActive = co.id === activeId;
            return (
              <div key={co.id} className="flex items-stretch">
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => pick(co.id)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 pr-1.5 text-left text-[12px] transition-colors hover:bg-bg/60",
                    isActive ? "font-semibold text-primary" : "text-ink-secondary",
                  )}
                >
                  <Check
                    size={13}
                    strokeWidth={2.5}
                    className={cn("shrink-0", isActive ? "text-primary" : "text-transparent")}
                  />
                  <span className="min-w-0 flex-1 truncate">{co.name}</span>
                  <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-ink-muted">
                    {co.code}
                  </span>
                </button>
                {/* Side-by-side windows (owner ask 2026-07-23): boot a fresh
                    window straight into this company via the ?company= seed
                    (see lib/activeCompany.ts). Each window keeps its own
                    company for its whole lifetime, so this one is untouched —
                    which is also why this button never needs pick()'s
                    unsaved-changes confirm. */}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    window.open(`/?company=${co.id}`, "_blank", "noopener,noreferrer");
                  }}
                  title={`Open ${co.name} in a new window`}
                  aria-label={`Open ${co.name} in a new window`}
                  className="shrink-0 px-2.5 text-ink-muted/70 transition-colors hover:bg-bg/60 hover:text-accent"
                >
                  <ExternalLink size={12.5} strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Profile menu ───────────────────────────────────────────
// Nico 2026-07-14 — clicking the avatar in the top rail now opens a small
// dropdown with Profile + Log out, instead of jumping straight to /profile
// (which was a surprise for anyone reaching for a sign-out control). Follows
// the CompanySwitcher popover pattern in this file: click-outside + Esc close.

function ProfileMenu() {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const activeRoute = location.pathname === "/profile";
  // 2b: the separate "N online" presence cluster is gone — the online state
  // rides on the avatar as a green corner dot, and the live count surfaces
  // through the trigger's title/aria-label.
  const { members } = usePresence();
  const onlineCount = members.length;

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  if (!user) return null;

  async function onLogout() {
    setOpen(false);
    // Same rule as the company switcher: transient SCM navigation handoffs
    // must not survive an SPA identity change, or the next user picks up the
    // outgoing user's in-flight state.
    clearAllScmHandoffs();
    try {
      await logout();
    } finally {
      // logout() clears the SPA session; route back to /login so the user
      // lands somewhere sensible even when a stray page was open.
      navigate("/login", { replace: true });
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-bg/60",
          (open || activeRoute) && "bg-bg/60",
        )}
        title={
          onlineCount > 0
            ? `${user.name || user.email} · ${onlineCount} online`
            : `${user.name || user.email}`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <span className="relative shrink-0">
          <Avatar
            userId={user.id}
            hasImage={user.profile_pic_r2_key}
            name={user.name}
            email={user.email}
            size={30}
          />
          {/* Online state as an avatar badge (2b) — you are online whenever
              this chrome is rendered; the ring keeps it legible over photos. */}
          <span
            aria-hidden
            className="absolute -bottom-px -right-px h-[9px] w-[9px] rounded-full bg-synced ring-[1.5px] ring-surface"
          />
        </span>
        <div className="min-w-0 max-w-[140px]">
          <div
            className={cn(
              "truncate text-[12px] font-semibold leading-tight text-ink",
              !open && "group-hover:text-primary",
            )}
          >
            {user.name || user.email.split("@")[0]}
          </div>
          <div className="truncate text-[10px] leading-tight text-ink-muted">
            {user.role_name}
          </div>
        </div>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account menu"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-[220px] overflow-hidden rounded-lg border border-border bg-surface shadow-slab animate-toast-in"
        >
          {/* Identity strip — echoes who the menu belongs to; the chip alone
              is easy to misread once the menu is open and the trigger's
              hover state has dropped. */}
          <div className="flex items-center gap-2.5 border-b border-border-subtle px-3 py-2.5">
            <Avatar
              userId={user.id}
              hasImage={user.profile_pic_r2_key}
              name={user.name}
              email={user.email}
              size={32}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-ink">
                {user.name || user.email.split("@")[0]}
              </div>
              <div className="truncate text-[10.5px] text-ink-muted">
                {user.email}
              </div>
            </div>
          </div>
          <div className="p-1">
            <Link
              to="/profile"
              role="menuitem"
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] font-medium text-ink transition-colors hover:bg-primary/[.07] hover:text-primary",
                activeRoute && "bg-primary/[.07] text-primary",
              )}
            >
              <UserRound size={14} className="shrink-0" />
              Profile
            </Link>
            {/* Nico 2026-07-22 — OWNER-ONLY (wildcard `*` = Super Admin role /
                god-tier position; same signal the backend's impersonation gate
                uses). Jumps to the Team page where the per-member "Login as"
                button lives (POST /api/users/:id/impersonate, see main.tsx
                view-as hand-off block). Non-owners don't see this entry at
                all — an admin who can't impersonate shouldn't be offered a
                dead-end "Switch user". */}
            {can("*") && (
              <Link
                to="/team"
                role="menuitem"
                onClick={() => setOpen(false)}
                className={cn(
                  "mt-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] font-medium text-ink transition-colors hover:bg-primary/[.07] hover:text-primary",
                  location.pathname === "/team" && "bg-primary/[.07] text-primary",
                )}
              >
                <UserRoundCog size={14} className="shrink-0" />
                Switch user
              </Link>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => void onLogout()}
              className="mt-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium text-ink transition-colors hover:bg-err/[.08] hover:text-err"
            >
              <LogOut size={14} className="shrink-0" />
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
