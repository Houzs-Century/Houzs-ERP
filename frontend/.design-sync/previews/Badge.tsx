import { Badge } from "autocount-sync-frontend";

// Status / count chip — SLA pills, role chips, sync-state tags across
// every list page. tone × variant are the two real axes.

export const Tones = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge tone="neutral">Draft</Badge>
    <Badge tone="accent">Consignment</Badge>
    <Badge tone="success">Synced</Badge>
    <Badge tone="warning">Pending</Badge>
    <Badge tone="error">SLA</Badge>
  </div>
);

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge tone="success" variant="soft">Soft</Badge>
    <Badge tone="success" variant="solid">Solid</Badge>
    <Badge tone="success" variant="outline">Outline</Badge>
    <Badge tone="error" variant="solid">Overdue</Badge>
    <Badge tone="warning" variant="outline">On Hold</Badge>
  </div>
);

export const SizesAndCase = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge tone="accent" size="xs">SO-2990</Badge>
    <Badge tone="accent" size="sm">SO-2990</Badge>
    <Badge tone="success" variant="outline" caseless>Confirmed by Farra</Badge>
    <Badge tone="neutral" caseless>3 attachments</Badge>
  </div>
);

export const InContext = () => (
  <div className="w-72 rounded-lg border border-border bg-surface p-3 shadow-stone">
    <div className="flex items-center justify-between">
      <span className="font-mono text-[11px] text-ink-secondary">DO-01842</span>
      <Badge tone="warning">Partial</Badge>
    </div>
    <div className="mt-1 text-[13px] font-semibold text-ink">
      Aircon install — Bandar Puteri
      <Badge tone="error" className="ml-1.5 align-middle">SLA</Badge>
    </div>
  </div>
);
