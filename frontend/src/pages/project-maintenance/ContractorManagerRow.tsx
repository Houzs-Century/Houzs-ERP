import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { RowActionsMenu, type MenuItem } from "../../components/RowActionsMenu";

/**
 * One row of the Contractors picker in Project Maintenance.
 *
 * Extracted from ProjectMaintenance.tsx (owner 2026-11-17: "add on edit
 * button" across every picker) so the inline name-edit affordance matches
 * Organizers / Venues and this already-oversized page stops growing. Owns its
 * local edit state; persistence runs through the `onPatch` / `onRemove`
 * callbacks the parent supplies (both already-`void`ed there, so no floating
 * promise crosses this boundary). The parent-built share-link items sit between
 * Edit and Remove, exactly where they were before the extraction.
 */

export interface ContractorRowLike {
  id: number;
  name: string;
}

export function ContractorManagerRow({
  o,
  shareItems,
  onPatch,
  onRemove,
}: {
  o: ContractorRowLike;
  shareItems: MenuItem[];
  onPatch: (id: number, body: Record<string, unknown>) => void;
  onRemove: (o: ContractorRowLike) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(o.name);

  function startEdit() {
    setName(o.name);
    setEditing(true);
  }
  function save() {
    const next = name.trim();
    if (!next) return; // keep editing; an empty contractor name is never saved
    if (next !== o.name) onPatch(o.id, { name: next });
    setEditing(false);
  }
  function cancel() {
    setEditing(false);
    setName(o.name);
  }

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
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
          <div className="text-[13px] font-medium text-ink">{o.name}</div>
        )}
      </div>
      <RowActionsMenu
        items={[
          { type: "action", icon: Pencil, label: "Edit", onClick: startEdit },
          ...shareItems,
          {
            type: "action",
            icon: Trash2,
            label: "Remove",
            danger: true,
            onClick: () => onRemove(o),
          },
        ]}
      />
    </li>
  );
}
