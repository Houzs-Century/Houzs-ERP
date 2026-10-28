import { EmptyState } from "autocount-sync-frontend";
import { PackageSearch, Inbox } from "lucide-react";

// Dashed placeholder panel shown when a list or sub-panel has no rows.

export const Default = () => (
  <div className="w-[26rem]">
    <EmptyState message="No delivery orders match your filters." />
  </div>
);

export const WithDescriptionAndCta = () => (
  <div className="w-[26rem]">
    <EmptyState
      message="No service cases assigned to you."
      description="New ASSR cases appear here as soon as dispatch assigns a technician."
      cta={{ label: "Browse unassigned cases", onClick: () => {} }}
    />
  </div>
);

export const WithIcon = () => (
  <div className="w-[26rem]">
    <EmptyState
      icon={<PackageSearch size={28} />}
      message="No stock movements for SO-2990-0417."
      description="Items sync from AutoCount after the order is confirmed."
    />
  </div>
);

export const Compact = () => (
  <div className="w-72 rounded-lg border border-border bg-surface p-3 shadow-stone">
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
      Attachments
    </div>
    <EmptyState
      compact
      icon={<Inbox size={20} />}
      message="No photos uploaded yet."
      cta={{ label: "Upload", onClick: () => {} }}
    />
  </div>
);
