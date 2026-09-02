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

interface Props {
  children: ReactNode;
}

export function Layout({ children }: Props) {
  // Desktop collapse — only used at lg+. Mobile no longer has a
  // drawer-opening hamburger; the bottom rail's centre Menu disc
  // covers nav, so the top bar is just brand + chrome.
  const [collapsed, setCollapsed] = useState(false);

  // Fetch the company identity once here (Layout wraps every authed page). This
  // primes the module-level branding cache that the pure jspdf PDF libs read,
  // so any document generated from inside the app carries the live letterhead.
  useBranding();

  // Warm the few route chunks the office opens most, once per session, while
  // the browser is idle — Layout wraps every authed page, so this is the one
  // place that mounts once and outlives every navigation. Without it the first
  // click into each of the 113 lazy routes waits out a chunk download before
  // the page can start fetching its data. Self-throttling and failure-proof;
  // see lib/prefetch-routes.
  //
  // Imported dynamically, not statically: the route map holds an import() per
  // route, so a static import drags the whole table into the initial bundle —
  // which pushed initial JS to 131.5/130 KB gzip and failed the budget gate.
  // Nothing here is needed before first paint, so the table rides in its own
  // chunk, fetched on the same idle tick that uses it.
  useEffect(() => {
    void import("../lib/prefetch-routes")
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
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={false}
      />

      <main className="paper-grain thin-scroll flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
        {/* Mobile top bar — brand + topbar chrome only. Hidden on lg+. */}
        <MobileTopBar />

        {/* Desktop top chrome — ONE 52px bar (2b): workspace tabs inline +
            search / company / bell / avatar. No breadcrumb, no second row.
            Every lg+ sticky below parks at top-[52px]: PageHeader here,
            DetailLayout, the two SCM V2 doc bars. Hidden below lg. */}
        <TopNavbar />

        {writesDisabled && <ReadOnlyBanner />}

        {/* Bottom padding clears the mobile tab rail (h-14 + safe area)
            AND the floating chat FAB which sits above the rail at
            bottom-20 + safe area + h-12. Total clearance: 160 + safe
            area for mobile/sm, normal for lg+ where the rail is hidden
            and the FAB tucks into the corner.
            The Guard provider wraps both PullToRefresh and children so
            pages with unsaved Panel state can call
            `usePullToRefreshBlock(true)` to block accidental F5. */}
        <PullToRefreshGuardProvider>
          {/* lg:pt-2 (was lg:py-10) is the 2b "dead band" fix — the tall empty
              gap between the chrome and the PageHeader is gone; the header's
              own pt supplies the breathing room. Bottom padding unchanged. */}
          <PullToRefresh className="w-full px-3 pt-6 pb-[calc(10rem+env(safe-area-inset-bottom))] sm:px-4 sm:pt-8 lg:px-4 lg:pt-2 lg:pb-10 animate-rise">
            {children}
          </PullToRefresh>
        </PullToRefreshGuardProvider>
      </main>

      {/* Mobile bottom tab rail — visible below lg, sits above the
          Floating Chat FAB which auto-clears it on mobile. The centre
          "Menu" tab opens its own bottom-sheet modal (no longer
          delegates to the Sidebar drawer), so onOpenDrawer is gone. */}
      <MobileTabBar />
    </div>
  );
}

/**
 * Mobile-only top bar. Brand mark on the left + PointsChip + collapsed
 * search on the right. Hidden on lg+. Navigation is handled exclusively
 * by the bottom rail's centre Menu disc — no hamburger here.
 */
function MobileTopBar() {
  return (
    <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm lg:hidden">
      {/* Phone: shrink the wordmark so the top bar reads as chrome, not a
          brochure header (owner: logo too big on phone). Steps back up to the
          original size at sm+ (tablet). h-5≈20px → h-7≈28px. CompanyMark:
          HOUZS keeps the bundled wordmark; other companies get their uploaded
          logo or a text lockup. */}
      <CompanyMark
        variant="wordmark"
        imgClassName="h-5 w-auto max-w-[104px] object-contain sm:h-7 sm:max-w-[140px]"
        textClassName="truncate text-[13px] font-bold tracking-tight text-ink sm:text-[15px]"
      />
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <GlobalSearchTrigger collapsed />
        {/* Same control as the lg+ bar. This bar is what a PHONE on the 2990
            host gets (AuthGate builds the mobile product for HOUZS only), so
            without it that whole company would have no refresh on a phone. */}
        <RefreshButton />
      </div>
    </div>
  );
}

/**
 * Persistent banner shown whenever the worker reports that outbound
 * writes to AutoCount are disabled. Sticky at the top of the main
 * scroll area so it's always visible no matter which tab the user is
 * on.
 */
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
  /** Always-rendered ReactNode (status pill, filter strip, bespoke chrome).
   *  Same shape as before — pages that don't opt into the new split keep working. */
  actions?: ReactNode;
  /** Primary CTA — always visible. Sits at the right edge of the action row.
   *  On mobile this is the only inline action besides the optional kebab. */
  primaryAction?: ReactNode;
  /** Secondary actions. On `sm+` they render as a row of compact buttons.
   *  On `<sm` they collapse into a single kebab so the header stays one-row. */
  secondaryActions?: MenuItem[];
  /** Optional small label rendered above the title — e.g. section name. */
  eyebrow?: string;
  /** Optional metadata rendered after the eyebrow with a · separator — the 2b
   *  record count ("128 orders"). Mono like the eyebrow, muted so the brass
   *  label keeps the emphasis. Ignored when `eyebrow` is unset. */
  eyebrowMeta?: ReactNode;
  /** Tightens the header's bottom margin/padding for dense pages (e.g. the
   *  Calendar, where the grid should sit high). Default keeps the roomy
   *  spacing every other page uses. NOTE: `dense` is SPACING ONLY — it does
   *  not touch the title size. See `titleSize` for that. */
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
   *  `BrowserRouter` + `<Routes>`, so there is no generic blocker to hang a
   *  guard on. Guarding the affordances a page actually owns is the honest
   *  substitute — it is not the same thing, and the left nav / workspace tabs
   *  remain unguarded. */
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
  // Opt-in back affordance (see the `back` prop doc) — detail-type pages only.
  const showBack = back === true || typeof back === "string";
  async function goBack() {
    // The gate runs FIRST and can cancel — see the `beforeBack` prop doc.
    if (beforeBack && !(await beforeBack())) return;
    if (typeof back === "string") navigate(back);
    else if (window.history.length > 1) navigate(-1);
    else navigate("/");
  }

  /* Publish where this pinned header ENDS, as `--page-header-offset` on <html>.
     Anything that scrolls a target into view has to clear it, and until now each
     page guessed: SO Maintenance hardcoded `scroll-margin-top: 96px` on its three
     section anchors while the real bottom edge is ~155 px on desktop (48 px
     sticky top + ~107 px of eyebrow + title + description + padding). So every
     section-jump pill scrolled its heading to 96 px — 59 px UNDERNEATH the
     header — and the operator saw the header sitting on top of the first rows of
     the list, cutting them in half. That is the bug, and a bigger constant would
     only move the guess: the height changes with the breakpoint, with the title
     wrapping, and with whether an action rail wrapped to its own row.

     Measured instead. `offsetHeight` is layout height (unaffected by scroll
     position, unlike getBoundingClientRect().top on a sticky element) and the
     resolved `top` is read from the cascade, so this stays correct across the
     top-14/lg:top-12 switch without duplicating those numbers here. */
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
    // The sticky `top` is breakpoint-dependent, and a resize that changes only
    // the breakpoint may not change our own box — observe the viewport too.
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
        /* 2026-07-19 (fix/so-maintenance-403) — the sticky offsets were
           DESKTOP-ONLY correct. Below lg the chrome above us is MobileTopBar
           (`sticky top-0 z-20 h-14`, 56 px), not TopNavbar (`sticky top-0 z-30
           h-12`, 48 px). Parking at top-12 on every breakpoint left this header
           8 px INSIDE the mobile app bar, and z-20 TIED with it — a tie the
           later-painted element wins, so the pinned page header covered the
           bottom edge of the app bar on every tablet/narrow-desktop page.
           `top-14 lg:top-…` parks flush under whichever bar is actually there,
           and `z-10 lg:z-20` puts us definitively BELOW the app bar (z-20) while
           still sitting above page content, which carries no z-index. */
        /* 2026-07-23 (top-chrome 2b) — the lg chrome is ONE 52px bar
           (TopNavbar hosting the tab strip inline), so the lg park is
           top-[52px]. Below lg top-14 (MobileTopBar) is unchanged. */
        (dense
          ? "sticky top-14 lg:top-[52px] z-10 lg:z-20 -mx-3 sm:-mx-4 lg:-mx-4 px-3 sm:px-4 lg:px-4 bg-bg mb-3 flex flex-col gap-2 border-b border-border pt-3 pb-2 sm:mb-4 sm:pt-4 sm:pb-3 md:flex-row md:flex-wrap md:items-end md:justify-between"
          : "sticky top-14 lg:top-[52px] z-10 lg:z-20 -mx-3 sm:-mx-4 lg:-mx-4 px-3 sm:px-4 lg:px-4 bg-bg mb-4 flex flex-col gap-3 border-b border-border pt-3 pb-3 sm:mb-8 sm:pt-4 sm:gap-3 sm:pb-6 md:flex-row md:flex-wrap md:items-end md:justify-between")
      }
      ref={hostRef}
    >
      {/* md:flex-1 + a basis floor so a wide action rail (md:shrink-0) can
          never squeeze the title to a per-character column — the rail wraps
          to its own row instead (container is md:flex-wrap). */}
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
        {/* Two literal class strings, not an interpolated one — Tailwind only
            emits classes it can see whole in the source. */}
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
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 md:shrink-0">
          {actions}
          {/* Desktop (sm+): secondary actions render as inline buttons.
              h-9 matches <Button> — actions / secondary / primaryAction all land
              in THIS one flex row, so this chrome must share the Button height or
              the rail renders at two sizes. The 11px uppercase label is what
              keeps it reading as secondary; the height is not. */}
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
          {/* Mobile (<sm): secondary actions collapse into a kebab so the
              header stays one row. Trigger sized to the 44 px touch floor. */}
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
