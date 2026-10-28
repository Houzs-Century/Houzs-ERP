import { Fragment } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

export interface BreadcrumbItem {
  label: string;
  /** Omit on the trailing (current) item to render it as plain text. */
  to?: string;
}

/**
 * Breadcrumb trail rendered above the PageHeader on detail pages.
 *
 *   <Breadcrumbs items={[
 *     { label: "Projects", to: "/projects" },
 *     { label: project.code },
 *   ]} />
 */
export function Breadcrumbs({
  items,
  className,
}: {
  items: BreadcrumbItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        "mb-3 flex flex-wrap items-center gap-1 text-[11px] text-ink-muted",
        className
      )}
    >
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <Fragment key={`${item.label}-${i}`}>
            {i > 0 && (
              <ChevronRight
                size={12}
                className="shrink-0 text-ink-muted/50"
                strokeWidth={2}
              />
            )}
            {item.to && !isLast ? (
              <Link
                to={item.to}
                className="rounded px-1 py-0.5 text-ink-secondary transition-colors hover:bg-surface-dim hover:text-accent"
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={cn(
                  "px-1 py-0.5",
                  isLast ? "font-semibold text-ink" : "text-ink-secondary"
                )}
                aria-current={isLast ? "page" : undefined}
              >
                {item.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
