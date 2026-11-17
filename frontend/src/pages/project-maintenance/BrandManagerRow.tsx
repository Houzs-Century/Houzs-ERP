import { useState, type ReactNode } from "react";
import { GripVertical, ChevronUp, ChevronDown, Pencil } from "lucide-react";
import { RowActionsMenu, type MenuItem } from "../../components/RowActionsMenu";
import { cn } from "../../lib/utils";

/**
 * One row of the Brands picker in Project Maintenance.
 *
 * Extracted from ProjectMaintenance.tsx (owner 2026-11-17: "add on edit
 * button" across every picker). The name used to be an always-on input; it now
 * matches Organizers / Venues — plain text with a Pencil "Edit" that reveals an
 * inline Save / Cancel editor — so every picker edits the same way, and the
 * oversized page shrinks. Drag-reorder, the logo cell and the active/share/
 * delete menu are unchanged: the parent still owns them and passes the logo
 * node + the trailing menu items in. `onPatch` is already `void`ed there.
 */

export interface BrandRowLike {
  id: number;
  name: string;
}

export function BrandManagerRow({
  b,
  active,
  logo,
  handlers,
  isDragging,
  isDropTarget,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onPatch,
  menuItems,
}: {
  b: BrandRowLike;
  active: boolean;
  logo: ReactNode;
  handlers: React.ComponentProps<"li">;
  isDragging: boolean;
  isDropTarget: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onPatch: (id: number, body: Record<string, unknown>) => void;
  /** Items shown after Edit: toggle active, share links, delete. */
  menuItems: MenuItem[];
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(b.name);

  function startEdit() {
    setName(b.name);
    setEditing(true);
  }
  function save() {
    const next = name.trim();
    if (!next) return; // keep editing; an empty brand name is never saved
    if (next !== b.name) onPatch(b.id, { name: next });
    setEditing(false);
  }
  function cancel() {
    setEditing(false);
    setName(b.name);
  }

  return (
    <li
      {...handlers}
      className={cn(
        "flex flex-wrap items-center gap-2 px-3 py-2 transition-colors",
        !active && "opacity-75",
        isDragging && "opacity-40",
        isDropTarget && "bg-accent-soft/40"
      )}
    >
      <div className="flex items-center gap-0.5 text-ink-muted">
        <span
          className="cursor-grab rounded p-1 hover:bg-bg/70 active:cursor-grabbing"
          title="Drag to reorder"
          aria-label="Drag handle"
        >
          <GripVertical size={14} />
        </span>
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          title="Move up"
          aria-label="Move up"
          className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          title="Move down"
          aria-label="Move down"
          className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <div className="min-w-[140px] flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") cancel();
              }}
              autoFocus
              className="h-8 min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 text-[13px] font-medium outline-none focus:ring-2 focus:ring-primary/15"
            />
            <button
              type="button"
              onClick={save}
              className="rounded bg-accent px-2 py-1 font-mono text-[8.5px] font-semibold uppercase text-white"
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-border px-2 py-1 font-mono text-[8.5px] font-semibold uppercase text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex h-8 items-center px-2 text-[13px] font-medium text-ink">
            {b.name}
          </div>
        )}
      </div>

      {logo}
      <span
        className={cn(
          "rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
          active ? "bg-synced/15 text-synced" : "bg-bg text-ink-muted"
        )}
      >
        {active ? "Active" : "Hidden"}
      </span>
      <RowActionsMenu
        indicator={!active}
        items={[
          { type: "action", icon: Pencil, label: "Edit", onClick: startEdit },
          ...menuItems,
        ]}
      />
    </li>
  );
}
