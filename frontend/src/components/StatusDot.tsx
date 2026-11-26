import { cn } from "../lib/utils";

type Variant = "synced" | "error" | "open" | "in-progress" | "closed" | "neutral";

const COLORS: Record<Variant, string> = {
  synced: "bg-synced",
  error: "bg-err",
  open: "bg-primary",
  "in-progress": "bg-primary",
  closed: "bg-ink-muted",
  neutral: "bg-ink-muted",
};

interface Props {
  variant: Variant;
  label?: string;
  className?: string;
}

export function StatusDot({ variant, label, className }: Props) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("h-2 w-2 rounded-full", COLORS[variant])} />
      {label && <span className="text-xs text-ink-secondary">{label}</span>}
    </span>
  );
}

export function statusVariantForAssr(status: string): Variant {
  const s = status.toLowerCase();
  if (s.includes("closed") || s.includes("complete")) return "closed";
  if (s.includes("progress")) return "in-progress";
  if (s.includes("open") || s.includes("verification")) return "open";
  return "neutral";
}

const STAGE_VARIANT: Record<string, Variant> = {
  pending_review: "open",
  under_verification: "open",
  pending_solution: "open",
  pending_supplier_pickup: "open",
  pending_item_ready: "open",
  pending_delivery_service: "open",
  completed: "closed",
  pending_inspection: "open",
  pending_item_pickup: "open",
  registration: "open",
  triage: "open",
  action: "in-progress",
  logistics: "in-progress",
  resolution: "in-progress",
  closed: "closed",
};

const STAGE_LABEL: Record<string, string> = {
  registration: "Review",
  triage: "Verification",
  action: "Solution",
  logistics: "Pending Logistics",
  resolution: "Pending Completion",
  closed: "Completed",
};

export function stageVariant(stage: string): Variant {
  return STAGE_VARIANT[stage] ?? "neutral";
}

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-ink-muted",
  normal: "bg-accent",
  high: "bg-amber-500",
  urgent: "bg-err",
};

export function priorityColor(priority: string): string {
  return PRIORITY_COLORS[priority] ?? "bg-ink-muted";
}

const RESOLUTION_LABEL: Record<string, string> = {
  replace_unit: "Replace Unit",
  supplier_repair: "Supplier Service",
  field_service_own: "On Site Service (Own Team)",
  field_service_supplier: "On Site Service (Supplier)",
  return_visit: "2nd Services",
};

export function resolutionLabel(method: string | null): string {
  if (!method) return "—";
  return RESOLUTION_LABEL[method] ?? method;
}
