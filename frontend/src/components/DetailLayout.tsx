import { type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { cn } from "../lib/utils";
import { useSetBreadcrumbs } from "../hooks/useBreadcrumbs";

export interface DetailBreadcrumb {
  label: string;
  to?: string;
}

interface Props {
  breadcrumbs: DetailBreadcrumb[];
  /** Tiny brass label above the title, e.g. "Project · AKEMI-001". */
  eyebrow?: string;
  title: string;
  /** Override the default title classes when a page needs a different
   *  size/family (e.g. Service Case detail uses IBM Plex Serif 32px). */
  titleClassName?: string;
  description?: ReactNode;
  /** Page-level action buttons rendered top-right of the sticky chrome. */
  actions?: ReactNode;
  /** Pin the title block (eyebrow + h1 + description) inside the sticky
   *  chrome so page identity + actions stay visible while scrolling.
   *  Opt-in per page (Service Case detail uses it); the default keeps
   *  the title in normal flow. */
  stickyTitle?: boolean;
  /** Optional fallback path for the back button when there's no history. */
  backTo?: string;
  /** Loading + error surfaced above the body grid, before main/aside split. */
  loading?: boolean;
  error?: string | null;
  /** Body content. Use DetailLayout.Main + DetailLayout.Aside as children
   *  for a 2-column layout, or pass plain JSX for full-width content. */
  children: ReactNode;
  /** When true, the body pulls toward the screen edges on large screens
   *  (less side padding) so the page uses more width. Opt-in per page. */
  wide?: boolean;
}

/**
 * Shared chrome for every detail page (creditor, project, PO, order, …).
 *
 *   ┌─[ ← ] Projects > AKEMI Booth ────────── [Archive] [→ Live] ─┐  ← sticky
 *   │                                                              │
 *   │ PROJECT · AKEMI-2024-001                                     │
 *   │ Akemi Booth at MIFF 2024                                     │
 *   │ Booth build · MIFF · 14 days                                 │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ ┌─ Main ────────────────────┐ ┌─ Aside ───────────┐          │
 *   │ │ heavy content             │ │ metadata          │          │
 *   │ └───────────────────────────┘ └───────────────────┘          │
 *   └──────────────────────────────────────────────────────────────┘
 */
export function DetailLayout({
  breadcrumbs,
  eyebrow,
  title,
  titleClassName,
  description,
  actions,
  stickyTitle,
  backTo,
  loading,
  error,
  children,
  wide,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  // Push the breadcrumb stack into the top-navbar context. On mount
  // the TopNavbar re-renders; on unmount the context clears so list
  // pages fall back to the route-derived crumb.
  useSetBreadcrumbs(breadcrumbs);

  function goBack() {
    if (backTo) return navigate(backTo);
    // No explicit target: return to THIS detail's list by dropping the
    // trailing id segment (/scm/foo/ID → /scm/foo). Deliberately NOT
    // navigate(-1): every details page's back button must land on its own
    // list, never on wherever external browser history happens to point
    // (owner 2026-07-24). Falls back to "/" only for a top-level path.
    const parent = location.pathname.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    navigate(parent || "/");
  }

  return (
    // The page wrapper in Layout.tsx already constrains us to max-w-1400 +
    // px-10. We pull the sticky bar to the edges with negative margins so
    // it spans the full canvas, then re-pad the inner row.
    <div>
      {/* ── Sticky chrome — back button + page actions ─────────
          Breadcrumb now lives in the desktop TopNavbar; this row
          keeps the back affordance + any page-scoped action buttons
          (Archive / Stage transition / etc.). Mobile still sees the
          breadcrumb inline so nothing gets lost below lg.
      */}
      <div
        className={cn(
          // lg:top-[52px] = the single 2b top-chrome bar (see Layout.tsx
          // PageHeader — the lg stickies move together).
          "sticky top-14 z-20 -mx-4 -mt-6 mb-4 border-b border-border sm:-mx-6 sm:-mt-8 lg:top-[52px] lg:-mx-10 lg:-mt-10 xl:-mx-12 2xl:-mx-16",
          stickyTitle ? "bg-bg" : "bg-bg/85 backdrop-blur-md"
        )}
      >
        <div className="flex h-10 w-full items-center gap-3 px-4 sm:px-6 lg:px-10 xl:px-12 2xl:px-16">
          <button
            onClick={goBack}
            className="group flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-ink-muted transition-all hover:-translate-x-0.5 hover:border-accent/50 hover:text-accent"
            aria-label="Back"
            title="Back"
          >
            <ArrowLeft size={14} strokeWidth={2.2} />
          </button>

          {/* Mobile-only breadcrumb trail: the TopNavbar is lg-only,
              so without this the breadcrumb would disappear on phones. */}
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[11px] text-ink-muted lg:hidden"
          >
            {breadcrumbs.map((item, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <span
                  key={`${item.label}-${i}`}
                  className={cn(
                    "shrink-0 truncate px-1",
                    isLast ? "font-semibold text-ink" : "text-ink-secondary"
                  )}
                >
                  {i > 0 && <span className="mr-1 text-ink-muted/50">/</span>}
                  {item.label}
                </span>
              );
            })}
          </nav>

          {/* Spacer on desktop so the action buttons stay right-aligned. */}
          <div className="hidden flex-1 lg:block" />

          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
          )}
        </div>
        {stickyTitle && (
          <div className="px-4 pb-3 sm:px-6 lg:px-10 xl:px-12 2xl:px-16">
            {eyebrow && (
              <div className="mb-1 flex items-center gap-2">
                <span className="h-px w-5 bg-accent" />
                <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-accent">
                  {eyebrow}
                </span>
              </div>
            )}
            <h1 className={cn(
              titleClassName ||
                "font-serif text-[22px] font-semibold leading-tight tracking-tight text-ink sm:text-[24px] lg:text-[28px]"
            )}>
              {title}
            </h1>
            {description && (
              <p className="mt-1 max-w-3xl text-[12px] leading-snug text-ink-secondary">
                {description}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Title block (normal flow unless stickyTitle pinned it above) ── */}
      {!stickyTitle && (
      <header className="mb-4">
        {eyebrow && (
          <div className="mb-1.5 flex items-center gap-2">
            <span className="h-px w-5 bg-accent" />
            <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-accent">
              {eyebrow}
            </span>
          </div>
        )}
        <h1 className={cn(
          titleClassName ||
            "font-serif text-[22px] font-semibold leading-tight tracking-tight text-ink sm:text-[24px] lg:text-[28px]"
        )}>
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-[12px] leading-snug text-ink-secondary">
            {description}
          </p>
        )}
      </header>
      )}

      {loading && (
        <div className="rounded-md border border-border bg-surface px-3 py-3 text-[12px] text-ink-muted">
          Loading…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
          {error}
        </div>
      )}

      {/* ── Body grid — Main + Aside split ───────────────────────────── */}
      {wide ? (
        <div className="lg:-mx-4 xl:-mx-6 2xl:-mx-8">{children}</div>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * 2-column grid: main (8/12) + aside (4/12) on lg+. Stacks on mobile.
 * Use as <DetailGrid><Main>...</Main><Aside>...</Aside></DetailGrid>.
 */
export function DetailGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:gap-4">
      {children}
    </div>
  );
}

export function DetailMain({ children }: { children: ReactNode }) {
  return (
    <div className="lg:col-span-8 space-y-3">{children}</div>
  );
}

export function DetailAside({ children }: { children: ReactNode }) {
  return (
    <aside className="lg:col-span-4 space-y-3">{children}</aside>
  );
}

// ── Section card ──────────────────────────────────────────────
// Lighter, denser version of PanelSection — meant for full-page detail
// surfaces where a Panel-internal "card-in-a-card" feels heavy.

export function Section({
  title,
  actions,
  children,
  dense,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Tighter inner padding for tabular content. */
  dense?: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-px w-3 shrink-0 bg-accent" />
          <h2 className="truncate font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
            {title}
          </h2>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      <div className={cn(dense ? "p-0" : "p-3")}>{children}</div>
    </section>
  );
}

// ── Stat strip ────────────────────────────────────────────────
// Horizontal row of small stats, divided by hairlines. Replaces the
// prior ad-hoc grid-cols-4 stat blocks.

export interface StatItem {
  label: string;
  value: ReactNode;
  /** Optional small caption shown beneath the value. */
  hint?: string;
  /** Optional tone tweak for the value. */
  tone?: "default" | "ok" | "err" | "warn";
}

export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-border-subtle overflow-hidden rounded-md border border-border bg-surface shadow-stone sm:grid-cols-4">
      {items.map((s, i) => (
        <div key={i} className="px-3 py-2">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            {s.label}
          </div>
          <div
            className={cn(
              "mt-0.5 font-mono text-[13.5px] font-bold leading-tight",
              s.tone === "ok" && "text-synced",
              s.tone === "err" && "text-err",
              s.tone === "warn" && "text-warning-text",
              (!s.tone || s.tone === "default") && "text-ink"
            )}
          >
            {s.value}
          </div>
          {s.hint && (
            <div className="mt-0.5 text-[10px] text-ink-muted">{s.hint}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Definition list ───────────────────────────────────────────
// Two-column grid of label/value pairs that wraps responsively.
// Replaces stacked FieldRow lists where horizontal density is wanted.

export interface DefnItem {
  label: string;
  value: ReactNode;
  /** Force this row to span the full width — good for long addresses. */
  full?: boolean;
  mono?: boolean;
}

export function DefinitionList({ items }: { items: DefnItem[] }) {
  const visible = items.filter(
    (i) =>
      i.value !== null &&
      i.value !== undefined &&
      i.value !== "" &&
      !(typeof i.value === "string" && i.value.trim() === "")
  );
  if (visible.length === 0) {
    return <div className="text-[11px] text-ink-muted">—</div>;
  }
  return (
    <dl className="grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2">
      {visible.map((item, i) => (
        <div
          key={`${item.label}-${i}`}
          className={cn(
            "flex items-baseline gap-2.5 border-b border-border-subtle/60 pb-1",
            item.full && "sm:col-span-2"
          )}
        >
          <dt className="min-w-[100px] shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            {item.label}
          </dt>
          <dd
            className={cn(
              "min-w-0 flex-1 break-words text-[12px] text-ink",
              item.mono && "font-mono text-[11.5px]"
            )}
            title={typeof item.value === "string" ? item.value : undefined}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Primary action button ─────────────────────────────────────
// Matches the brass accent button used elsewhere; small variant suited
// for the sticky chrome row.

export function HeaderButton({
  onClick,
  disabled,
  variant = "ghost",
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  variant?: "ghost" | "primary" | "danger";
  children: ReactNode;
}) {
  const base =
    "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[11.5px] font-bold uppercase tracking-wider transition-all disabled:opacity-50 disabled:pointer-events-none";
  const variants = {
    ghost:
      "border border-border bg-surface text-ink-secondary hover:border-accent/40 hover:bg-accent-soft/40 hover:text-accent",
    primary:
      "bg-primary text-white shadow-stone hover:bg-primary-ink",
    danger:
      "border border-err/40 bg-err/5 text-err hover:bg-err/10",
  } as const;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(base, variants[variant])}
    >
      {children}
    </button>
  );
}
