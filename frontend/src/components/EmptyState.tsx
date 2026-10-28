import type { ReactNode } from "react";
import { cn } from "../lib/utils";

interface Props {
  /** One-line headline. Required. */
  message: string;
  /** Optional sub-line. Renders below the headline at slightly smaller size. */
  description?: ReactNode;
  /** Optional CTA — `label` plus `onClick`. Renders as an inline accent link. */
  cta?: { label: string; onClick: () => void };
  /** Optional leading icon (lucide-react `<Icon size={…} />`). */
  icon?: ReactNode;
  /** Tighter padding for in-panel use (e.g. inside a sidebar card). */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  message,
  description,
  cta,
  icon,
  compact,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border bg-surface text-center text-ink-muted",
        compact ? "px-4 py-6 text-[11.5px]" : "px-5 py-10 text-[12px]",
        className
      )}
    >
      {icon && <div className="mb-1 text-ink-muted/70">{icon}</div>}
      <div>{message}</div>
      {description && (
        <div className={cn("text-ink-muted/80", compact ? "text-[10.5px]" : "text-[11px]")}>
          {description}
        </div>
      )}
      {cta && (
        <button
          type="button"
          onClick={cta.onClick}
          className="mt-1 font-semibold text-accent hover:underline"
        >
          {cta.label}
        </button>
      )}
    </div>
  );
}
