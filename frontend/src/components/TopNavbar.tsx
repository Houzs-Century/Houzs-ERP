import { lazy, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { LazySlot } from "./LazySlot";

const ThemeChoice = lazy(() => import("./ThemeChoice"));
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { useDialog } from "../hooks/useDialog";
import {
  getActiveCompanySnapshot,
  setActiveCompanyId,
  subscribeActiveCompany,
} from "../lib/activeCompany";
import { clearAllScmHandoffs } from "../lib/scmHandoffStorage";
import { allowNextUnload, confirmLeaving, leaveGuardActive } from "../lib/leaveGuard";

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
    <header className="sticky top-0 z-40 hidden h-[52px] items-center border-b border-border bg-surface pl-3.5 pr-2 lg:flex">
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
            {/* Count, not the 2b dot (owner 2026-09-02, "需要有红色号码
                notice"): a dot says something happened, a number says how
                much is waiting — which is the whole point of routing
                amendment approvals here. */}
            <NotificationBell collapsed direction="down" align="end" tone="navbar" />
            <span aria-hidden className="mx-0.5 h-6 w-px bg-border-subtle" />
            <ProfileMenu />
          </>
        )}
      </div>
    </header>
  );
}


interface CompaniesResponse {
  companies: Array<{ id: number; code: string; name: string }>;
  activeCompanyId: number | null;
  activeCompanyCode: string | null;
}

function CompanySwitcher() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dialog = useDialog();

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

  if (companies.length <= 1) return null;

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
    const ok = await dialog.confirm({
      title: "Switch company?",
      message:
        "Switching company reloads the page — any unsaved changes will be lost. Continue?",
      confirmLabel: "Switch company",
    });
    if (!ok) return;
    clearAllScmHandoffs();
    setActiveCompanyId(id);
    allowNextUnload();
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


function ProfileMenu() {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const activeRoute = location.pathname === "/profile";
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
    if (leaveGuardActive() && !(await confirmLeaving())) return;
    clearAllScmHandoffs();
    try {
      await logout();
    } finally {
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
            <LazySlot resetKey="account-menu" fallback={null}>
              <ThemeChoice />
            </LazySlot>
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
