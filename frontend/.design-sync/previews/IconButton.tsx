import { IconButton } from "autocount-sync-frontend";
import { Pencil, Trash2, Printer, Download, RefreshCw, Check } from "lucide-react";

// Plan B "Soft Card" (2026-07-10): white card + hairline border, radius 10;
// hover = petrol border + 1px lift + petrol glow. variant ghost/primary/
// secondary, size sm/md/lg. Danger stays className-driven (err utilities).

export const Variants = () => (
  <div className="flex items-center gap-2">
    <IconButton icon={<Pencil />} title="Edit (ghost)" />
    <IconButton variant="primary" icon={<Check />} title="Confirm (primary)" />
    <IconButton variant="secondary" icon={<RefreshCw />} title="Refresh (secondary)" />
  </div>
);

export const Sizes = () => (
  <div className="flex items-end gap-2">
    <IconButton size="sm" icon={<Printer />} title="sm 30px" />
    <IconButton size="md" icon={<Printer />} title="md 36px (default)" />
    <IconButton size="lg" icon={<Printer />} title="lg 42px" />
  </div>
);

export const DangerAndDisabled = () => (
  <div className="flex items-center gap-2">
    <IconButton
      icon={<Trash2 />}
      title="Delete"
      className="text-err hover:border-err/60 hover:bg-err/5 hover:text-err hover:shadow-[0_2px_8px_rgba(183,51,31,0.15)]"
    />
    <IconButton icon={<Pencil />} disabled title="Locked" />
    <IconButton variant="primary" icon={<Check />} disabled title="Locked primary" />
  </div>
);

export const InPanelHeader = () => (
  <div className="flex w-80 items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 shadow-stone">
    <span className="text-[12px] font-semibold text-ink">Delivery photos</span>
    <div className="flex gap-1.5">
      <IconButton icon={<Download />} title="Download all" />
      <IconButton icon={<RefreshCw />} title="Reload" />
      <IconButton variant="primary" icon={<Check />} title="Approve" />
    </div>
  </div>
);
