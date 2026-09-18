import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import { useUnsavedWork } from "../lib/unsavedWork";

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** When true, Esc and X-click route through `onAttemptClose` (typically a
   *  confirm dialog) instead of `onClose`. The page is responsible for
   *  calling `onClose` itself if the user confirms the discard. */
  dirty?: boolean;
  /** Called when the user attempts to dismiss while `dirty`. Required when
   *  `dirty` is set; ignored otherwise. */
  onAttemptClose?: () => void;
  /** Render as a centered modal (page-middle floating card) instead of
   *  the right-side drawer. `width` becomes the card's max width. */
  centered?: boolean;
}

/** Selector for "anything keyboard-tabbable" used by the focus trap. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Right-side document panel.
 *
 * Rendered through a React portal into <body>. This is required because the
 * page wrapper in Layout.tsx applies an `animate-rise` (transform), and any
 * non-`none` transform on an ancestor turns `position: fixed` into
 * "fixed relative to that ancestor" instead of the viewport. Without the
 * portal, the panel's `translate-x-full` off-screen state ends up inside
 * the page's horizontal scroll area and slides into view whenever a wide
 * table makes the page scrollable to the right.
 */
export function Panel({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 420,
  centered,
  dirty,
  onAttemptClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // An open panel the caller marked dirty is unsaved work for any AUTOMATIC
  // reload (lib/unsavedWork.ts) — the same fact its own close guard acts on.
  useUnsavedWork(open && dirty === true);

  // Route Esc + X click through the dirty guard when set; otherwise close
  // directly. `onClose` callers (e.g. on submit success) bypass this.
  function attemptClose() {
    if (dirty && onAttemptClose) {
      onAttemptClose();
    } else {
      onClose();
    }
  }

  // Keyboard handling: Esc dismiss + Tab focus cycling inside the panel.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        attemptClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const insidePanel = !!(active && panelRef.current.contains(active));
        if (e.shiftKey) {
          if (!insidePanel || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (!insidePanel || active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dirty, onAttemptClose, onClose]);

  // Focus management: capture the previously-focused element on open, focus
  // the first focusable inside the panel after the slide-in begins, restore
  // focus when the panel closes.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      if (!panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      );
      const first = Array.from(focusables).find((el) => el.offsetParent !== null);
      first?.focus();
    }, 50);
    return () => {
      window.clearTimeout(t);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  const node = (
    <div
      className={cn(
        centered
          ? "fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200"
          : "fixed inset-y-0 right-0 z-50 flex transition-transform duration-200",
        // Drawer: width is set inline but capped to leave a 24 px gutter
        // on the left at narrow widths so the panel reads as a sheet, not
        // a full-screen takeover.
        !centered && "max-w-[calc(100vw-1.5rem)] sm:max-w-[100vw]",
        // pointer-events-none when closed so the off-screen panel can't
        // intercept clicks on the underlying canvas.
        open
          ? cn("pointer-events-auto", centered ? "opacity-100" : "translate-x-0")
          : cn("pointer-events-none", centered ? "opacity-0" : "translate-x-full"),
      )}
      style={centered ? undefined : { width }}
      aria-hidden={!open}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
    >
      {centered && (
        <div
          className="absolute inset-0 bg-ink/40"
          onClick={attemptClose}
          aria-hidden="true"
        />
      )}
      <div
        ref={panelRef}
        className={cn(
          "relative flex w-full flex-col bg-surface shadow-slab",
          centered
            ? "max-h-[88vh] overflow-hidden rounded-lg border border-border"
            : "h-full border-l border-border",
        )}
        style={centered ? { maxWidth: width } : undefined}
      >
        {/* Brass accent rail at the very left edge of the panel */}
        <span className="pointer-events-none absolute left-0 top-0 h-full w-[2px] bg-gradient-to-b from-accent/0 via-accent/60 to-accent/0" />
        <div className="flex items-start justify-between border-b border-border px-4 py-4 sm:px-6 sm:py-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              Document
            </div>
            <h2 className="mt-1 font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{subtitle}</p>}
          </div>
          <button
            onClick={attemptClose}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-dim hover:text-ink"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">{children}</div>
        {footer && (
          <div className="border-t border-border bg-bg/60 px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-6">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  // SSR safety: createPortal requires a real DOM target.
  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}

interface SectionProps {
  title: ReactNode;
  children: ReactNode;
  muted?: boolean;
  /** Optional control rendered top-right of the section header. */
  action?: ReactNode;
  /** Optional small leading icon in the header (lucide, ~13px). */
  icon?: ReactNode;
  /** Optional left accent strip colour class (e.g. "bg-accent", "bg-synced"). */
  accent?: string;
}

export function PanelSection({ title, children, muted, action, icon, accent }: SectionProps) {
  return (
    <section
      className={cn(
        "relative mb-3 overflow-hidden rounded-lg border border-border px-4 py-3.5 shadow-stone",
        muted ? "bg-bg/50" : "bg-surface"
      )}
    >
      {accent && (
        <span className={cn("pointer-events-none absolute left-0 top-0 h-full w-1", accent)} />
      )}
      <div className="mb-3 flex items-center gap-2">
        {icon && <span className="shrink-0 text-ink-muted">{icon}</span>}
        <div className="flex-1 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
          {title}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function FieldRow({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <span className={cn("min-w-0 break-words text-right text-[12.5px] leading-snug text-ink", mono && "font-mono text-[11.5px]")}>
        {children}
      </span>
    </div>
  );
}
