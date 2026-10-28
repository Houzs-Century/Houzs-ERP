import type { ReactNode } from "react";
import { cn } from "../lib/utils";

type Tone = "neutral" | "accent" | "success" | "warning" | "error";
type Variant = "soft" | "solid" | "outline";

interface Props {
  children: ReactNode;
  /** Semantic colour. Defaults to neutral. */
  tone?: Tone;
  /** soft (tinted bg) · solid (filled) · outline (bordered). Default soft. */
  variant?: Variant;
  /** xs = 9px (dense table pills) · sm = 10.5px. Default xs. */
  size?: "xs" | "sm";
  /** Drop the uppercase + wide tracking (for mixed-case labels). */
  caseless?: boolean;
  className?: string;
  title?: string;
}

// tone → [soft, solid, outline] class sets. Palette-only (brass accent,
// synced green, err red, warning amber, ink-muted neutral) so badges stay
// on-brand and reuse the same tokens as the rest of the design system.
const TONES: Record<Tone, { soft: string; solid: string; outline: string }> = {
  neutral: {
    soft: "bg-ink-muted/10 text-ink-muted",
    solid: "bg-ink-muted text-white",
    outline: "border border-ink-muted/40 text-ink-muted",
  },
  accent: {
    soft: "bg-accent-soft text-accent",
    solid: "bg-accent text-white",
    outline: "border border-accent/40 text-accent",
  },
  success: {
    soft: "bg-synced/12 text-synced",
    solid: "bg-synced text-white",
    outline: "border border-synced/40 text-synced",
  },
  warning: {
    soft: "bg-warning-bg text-warning-text",
    solid: "bg-warning-text text-white",
    outline: "border border-warning-text/40 text-warning-text",
  },
  error: {
    soft: "bg-err/10 text-err",
    solid: "bg-err text-white",
    outline: "border border-err text-err",
  },
};

/**
 * Status / count chip — the shared replacement for the
 * `inline-flex … rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase
 * tracking-wider` pattern hand-rolled across the app (SLA pills, role
 * chips, warning tags, count badges).
 *
 *   <Badge tone="error">SLA</Badge>
 *   <Badge tone="success" variant="outline" caseless>Confirmed</Badge>
 */
export function Badge({
  children,
  tone = "neutral",
  variant = "soft",
  size = "xs",
  caseless = false,
  className,
  title,
}: Props) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-bold leading-none",
        size === "xs" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10.5px]",
        !caseless && "uppercase tracking-wider",
        TONES[tone][variant],
        className
      )}
    >
      {children}
    </span>
  );
}
