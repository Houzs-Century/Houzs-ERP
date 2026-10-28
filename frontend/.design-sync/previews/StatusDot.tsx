import { StatusDot } from "autocount-sync-frontend";

// Tiny colour dot + optional label — row-level status in service-case
// and sync tables.

export const AllVariants = () => (
  <div className="flex flex-col gap-2">
    <StatusDot variant="open" label="Pending Review" />
    <StatusDot variant="in-progress" label="Pending Solution" />
    <StatusDot variant="closed" label="Completed" />
    <StatusDot variant="synced" label="Synced to AutoCount" />
    <StatusDot variant="error" label="Sync failed" />
    <StatusDot variant="neutral" label="Not started" />
  </div>
);

export const DotOnly = () => (
  <div className="flex items-center gap-3">
    <StatusDot variant="open" />
    <StatusDot variant="in-progress" />
    <StatusDot variant="closed" />
    <StatusDot variant="error" />
  </div>
);

export const InTableRow = () => (
  <div className="w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
    {[
      ["ASSR-0231", "in-progress", "Pending Logistics"],
      ["ASSR-0228", "open", "Under Verification"],
      ["ASSR-0219", "closed", "Completed"],
    ].map(([id, variant, label]) => (
      <div key={id} className="flex items-center justify-between border-b border-border-subtle px-3 py-2 last:border-0">
        <span className="font-mono text-[11px] text-ink-secondary">{id}</span>
        <StatusDot variant={variant as any} label={label as string} />
      </div>
    ))}
  </div>
);
