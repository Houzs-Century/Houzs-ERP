import { RowActionsMenu } from "autocount-sync-frontend";
import { Pencil, Copy, Trash2, Star } from "lucide-react";

// Ellipsis kebab that collapses per-row controls. The menu itself opens
// on click (stateful) — cards show the closed trigger in row context.

const items = [
  { icon: Pencil, label: "Edit", onClick: () => {} },
  { icon: Copy, label: "Duplicate", onClick: () => {} },
  { type: "toggle" as const, icon: Star, label: "Pin to top", onClick: () => {}, active: true },
  { icon: Trash2, label: "Delete", onClick: () => {}, danger: true },
];

export const Trigger = () => (
  <div className="flex items-center gap-3">
    <RowActionsMenu items={items} />
    <RowActionsMenu items={items} indicator title="Needs review" />
  </div>
);

export const InTableRows = () => (
  <div className="w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
    {["Installation checklist", "Warranty card template", "Site survey form"].map((name, i) => (
      <div
        key={name}
        className="flex items-center justify-between border-b border-border-subtle px-3 py-2 last:border-0"
      >
        <span className="text-[12.5px] text-ink">{name}</span>
        <RowActionsMenu items={items} indicator={i === 1} />
      </div>
    ))}
  </div>
);
