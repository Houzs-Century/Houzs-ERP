import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { TopNavbar } from "./TopNavbar";
import { RefreshButton } from "./RefreshButton";
import { MobileTabBar } from "./MobileTabBar";
import { PullToRefresh, PullToRefreshGuardProvider } from "./PullToRefresh";
import { RowActionsMenu, type MenuItem } from "./RowActionsMenu";
import { useBranding } from "../hooks/useBranding";
import { CompanyMark } from "./CompanyMark";
import { whenPageChunksSettled } from "../lib/lazyPage";
import { HighlightSlot } from "./HighlightSlot";

interface Props {
  children: ReactNode;
}

export function Layout({ children }: Props) {
  useEffect(() => { void import("../vendor/scm/lib/product-categories-store").then((m) => m.ensureProductCategories()).catch((e: unknown) => console.warn("product categories not loaded; labels read the code", e)); }, []);
  const [collapsed, setCollapsed] = useState(false);

  useBranding();

  useEffect(() => {
    void whenPageChunksSettled()
      .then(() => import("../lib/prefetch-routes"))
      .then((m) => m.prefetchTopRoutes())
      .catch(() => {});
  }, []);

  // AutoCount sync-status poll removed (owner 2026-07-14): there is no
  // /api/sync/status backend route, so it 404'd on every page for every user.
  // The read-only banner stays dormant (never shown) until the kill-switch is
  // re-wired to a real endpoint.
  const writesDisabled = false;

  return (
    <div className="flex h-dvh min-h-dvh w-screen overflow-hidden">
      <HighlightSlot />
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={false}
      />

      <main className="paper-grain thin-scroll flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
        <MobileTopBar />

        <TopNavbar />

        {writesDisabled && <ReadOnlyBanner />}

        <PullToRefreshGuardProvider>
          <PullToRefresh className="w-full px-3 pt-6 pb-[calc(10rem+env(safe-area-inset-bottom))] sm:px-4 sm:pt-8 lg:px-4 lg:pt-2 lg:pb-10 animate-rise">
            {children}
          </PullToRefresh>
        </PullToRefreshGuardProvider>
      </main>

      <MobileTabBar />
    </div>
  );
}

function MobileTopBar() {
  return (
    <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm lg:hidden">
      <CompanyMark
        variant="wordmark"
        imgClassName="h-5 w-auto max-w-[104px] object-contain sm:h-7 sm:max-w-[140px]"
        textClassName="truncate text-[13px] font-bold tracking-tight text-ink sm:text-[15px]"
      />
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <GlobalSearchTrigger collapsed />
        <RefreshButton />
      </div>
    </div>
  );
}

function ReadOnlyBanner() {
  return (
    <div className="sticky top-14 z-10 border-b border-warning-text/30 bg-warning-bg/95 backdrop-blur-sm lg:top-0">
      <div className="flex w-full items-start gap-3 px-3 py-2.5 sm:px-4 lg:px-4">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning-text/15 text-warning-text">
          <ShieldAlert size={13} strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-warning-text">
            Read-Only Mode
          </div>
          <div className="text-[12px] font-medium leading-snug text-warning-text/90">
            AutoCount writes are halted. Edits are saved locally but{" "}
            <span className="font-semibold">not pushed to AutoCount</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: MenuItem[];
  eyebrow?: string;
  eyebrowMeta?: ReactNode;
  dense?: boolean;
  /** Title scale. Default = the roomy 19/26/28 brochure h1 every list and
   *  landing page uses.
   *
   *  `"sm"` (owner 2026-07-16, "header的UI 可以排版一下 可能字體小一點") is the
   *  17px DOCUMENT title: a detail page whose h1 is just a doc number + a
   *  customer name doesn't need brochure sizing, and the tall h1 was pushing
   *  an already-long page longer. OPT-IN on purpose — PageHeader is shared by
   *  every page in the app, so shrinking the default here would silently
   *  reskin all of them. Only pass this where the owner approved it. */
  titleSize?: "default" | "sm";
  /** Round ← back button above the eyebrow — the same circular affordance
   *  DetailLayout's sticky chrome renders. OPT-IN, like `titleSize`: the owner
   *  wants it on pages you click INTO, not on lists (2026-07-23: "每个页面点开
   *  之后需要有这样红色标记的返回button" then "只需要在details page才需要，
   *  在list page不用"), and PageHeader can't tell a list from a detail on its
   *  own. Pass `back` on New / Detail / From-X pages; a string routes to that
   *  path instead of history-back (mirrors DetailLayout's `backTo`). */
  back?: boolean | string;
  /** Optional gate in front of the back button (owner 2026-08-07). Return false
   *  to cancel the navigation — for a page holding work that leaving would
   *  destroy. Async so the caller can await its own confirm dialog.
   *
   *  This exists because react-router 6 can only block in-app navigation through
   *  `useBlocker`, which requires a DATA router; this app mounts a plain
   *  `BrowserRouter` + `<Routes>`. A form that holds lib/leaveGuard is asked
   *  about on every exit (left nav and workspace tabs included) by
   *  LeaveGuardBridge; this gate is for a page's own, more specific question. */
  beforeBack?: () => boolean | Promise<boolean>;
}

export function PageHeader({
  title,
  description,
  actions,
  primaryAction,
  secondaryActions,
  eyebrow,
  eyebrowMeta,
  dense,
  titleSize = "default",
  back,
  beforeBack,
}: PageHeaderProps) {
  const secondary = secondaryActions ?? [];
  const hasSecondary = secondary.length > 0;
  const hasActions = !!actions || !!primaryAction || hasSecondary;

  const navigate = useNavigate();
  const showBack = back === true || typeof back === "string";
  async function goBack() {
    if (beforeBack && !(await beforeBack())) return;
    if (typeof back === "string") navigate(back);
    else if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const publish = () => {
      const stickyTop = parseFloat(getComputedStyle(el).top);
      const offset = (Number.isFinite(stickyTop) ? stickyTop : 0) + el.offsetHeight;
      document.documentElement.style.setProperty("--page-header-offset", `${offset}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
      document.documentElement.style.removeProperty("--page-header-offset");
    };
  }, []);

  return (
    <div
      className={
        /* Nick 2026-07-09 — "每个页面的抬头都需要 PIN 起来". Made PageHeader
           always sticky so the title + description + actions stay visible as
           the operator scrolls through any long list or nested view.

           · top-12 (48 px) — parks flush under TopNavbar (sticky top-0 h-12
             z-30). z-20 keeps section content below.
           · Negative -mx per breakpoint breaks out of the PullToRefresh
             wrapper's px padding (px-4 sm:px-6 lg:px-10 xl:px-12 2xl:px-16)
             so the sticky backdrop reads full-width edge-to-edge.
           · Matching positive px so the inner content (h1 / actions) stays
             aligned to the same page rhythm as when the page loaded.
           · pt-3/sm:pt-4 gives the pinned header its own top breathing room
             (the parent's pt-6 lives ABOVE us and stays there); the border-b
             does the visual separation from below.
           · bg-bg/95 + backdrop-blur keeps the header legible over any
             content that would otherwise show through. */
        (dense
          ? "sticky top-14 lg:top-[52px] z-10 lg:z-20 -mx-3 sm:-mx-4 lg:-mx-4 px-3 sm:px-4 lg:px-4 bg-bg mb-3 flex flex-col gap-2 border-b border-border pt-3 pb-2 sm:mb-4 sm:pt-4 sm:pb-3 md:flex-row md:flex-wrap md:items-end md:justify-between"
          : "sticky top-14 lg:top-[52px] z-10 lg:z-20 -mx-3 sm:-mx-4 lg:-mx-4 px-3 sm:px-4 lg:px-4 bg-bg mb-4 flex flex-col gap-3 border-b border-border pt-3 pb-3 sm:mb-8 sm:pt-4 sm:gap-3 sm:pb-6 md:flex-row md:flex-wrap md:items-end md:justify-between")
      }
      ref={hostRef}
    >
      <div className="min-w-0 md:flex-1 md:basis-72">
        {showBack && (
          <button
            type="button"
            onClick={() => { void goBack(); }}
            aria-label="Back"
            title="Back"
            className="mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-ink-muted transition-all hover:-translate-x-0.5 hover:border-accent/50 hover:text-accent sm:mb-2"
          >
            <ArrowLeft size={14} strokeWidth={2.2} />
          </button>
        )}
        {eyebrow && (
          <div className="mb-1.5 flex items-center gap-2 sm:mb-2">
            <span className="h-px w-5 bg-accent sm:w-6" />
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-brand text-accent sm:text-[10px]">
              {eyebrow}
            </span>
            {eyebrowMeta != null && (
              <>
                <span aria-hidden className="text-[11px] leading-none text-ink-muted">
                  ·
                </span>
                <span className="font-mono text-[11px] text-ink-muted">{eyebrowMeta}</span>
              </>
            )}
          </div>
        )}
        <h1
          className={
            titleSize === "sm"
              ? "font-display text-[15px] font-extrabold leading-tight tracking-tight text-ink max-[359px]:text-[14px] sm:text-[16px] lg:text-[17px]"
              : "font-display text-[19px] font-extrabold leading-tight tracking-tight text-ink max-[359px]:text-[17px] sm:text-[26px] lg:text-[28px]"
          }
        >
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-secondary sm:mt-1.5 sm:text-sm">
            {description}
          </p>
        )}
      </div>
      {hasActions && (
        <div className="flex max-w-full flex-wrap items-center gap-1.5 sm:gap-2 md:shrink-0">
          {/* max-w-full: md:shrink-0 alone let a rail wider than the header run
              off-screen at tablet width instead of wrapping (HC-0149). */}
          {actions}
          {hasSecondary && (
            <div className="hidden items-center gap-1.5 sm:flex sm:gap-2">
              {secondary.map((it, i) => {
                const Icon = it.icon;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={it.onClick}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                  >
                    <Icon size={13} />
                    {it.label}
                  </button>
                );
              })}
            </div>
          )}
          {primaryAction}
          {hasSecondary && (
            <div className="sm:hidden">
              <RowActionsMenu items={secondary} title="More actions" size={44} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
