import { Button } from "autocount-sync-frontend";
import { Plus, RefreshCw, Trash2, Download } from "lucide-react";

// Standard CTA button — petrol fill for primary actions, outlined
// secondary, quiet ghost, and a red-outline danger. `brass` is a legacy
// alias that now renders identically to primary.

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button variant="primary">Create Sales Order</Button>
    <Button variant="secondary">Export CSV</Button>
    <Button variant="ghost">View history</Button>
    <Button variant="danger">Void DO-01842</Button>
    <Button variant="brass">Sync AutoCount</Button>
  </div>
);

export const WithIcon = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button variant="primary" icon={<Plus size={14} />}>New Service Case</Button>
    <Button variant="secondary" icon={<Download size={14} />}>Download DO</Button>
    <Button variant="ghost" icon={<RefreshCw size={14} />}>Refresh</Button>
  </div>
);

export const Disabled = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Button variant="primary" disabled>Confirm Delivery</Button>
    <Button variant="secondary" disabled>Export CSV</Button>
    <Button variant="danger" disabled icon={<Trash2 size={14} />}>Remove Line</Button>
  </div>
);

export const InContext = () => (
  <div className="flex w-[26rem] items-center justify-between rounded-lg border border-border bg-surface p-3 shadow-stone">
    <div>
      <div className="font-mono text-[11px] text-ink-secondary">SO-2990-0417</div>
      <div className="text-[13px] font-semibold text-ink">Farra Aziz — RM 4,280.00</div>
    </div>
    <div className="flex items-center gap-2">
      <Button variant="ghost">Cancel</Button>
      <Button variant="primary" icon={<Plus size={14} />}>Add Delivery</Button>
    </div>
  </div>
);
