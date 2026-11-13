import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { RowActionsMenu } from "../../components/RowActionsMenu";
import { StatePicker } from "../../vendor/scm/components/StatePicker";

/**
 * One row of the Venues picker in Project Maintenance.
 *
 * Extracted from ProjectMaintenance.tsx (owner 2026-11-12: "add on button
 * edit, so [I] can edit here") so the inline name-edit affordance lives in its
 * own module instead of growing that already-oversized page. Owns its local
 * edit state; the actual persistence runs through the `onPatch` / `onRemove`
 * callbacks the parent supplies (both already-`void`ed there, so no floating
 * promise crosses this boundary).
 */

export interface VenueRowLike {
  id: number;
  name: string;
  state: string | null;
  size?: string | null;
}

export function VenueManagerRow({
  v,
  onPatch,
  onRemove,
}: {
  v: VenueRowLike;
  onPatch: (id: number, body: Record<string, unknown>) => void;
  onRemove: (v: VenueRowLike) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(v.name);

  function startEdit() {
    setName(v.name);
    setEditing(true);
  }
  function save() {
    const next = name.trim();
    if (!next) return; // keep editing; an empty venue name is never saved
    if (next !== v.name) onPatch(v.id, { name: next });
    setEditing(false);
  }
  function cancel() {
    setEditing(false);
    setName(v.name);
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
          <div className="text-[13px] font-medium text-ink">{v.name}</div>
        )}
      </div>
      {/* Inline state re-pick — same maintenance-only source (my_localities) as
          the Add form's StatePicker. A value not in the seeded set shows blank,
          forcing a legit pick or an addition via Localities Maintenance first. */}
      <div className="w-56">
        <StatePicker
          value={v.state || ""}
          onChange={(next) => {
            if (next !== (v.state || "")) onPatch(v.id, { state: next || null });
          }}
        />
      </div>
      {/* Inline size edit (mig 0222). Free text, committed on blur so the
          operator can type "12,000 sqft" without a PATCH per character. key
          includes the saved value so a reload after save re-seeds defaultValue. */}
      <input
        key={`size-${v.id}-${v.size ?? ""}`}
        defaultValue={v.size ?? ""}
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next !== (v.size ?? "")) onPatch(v.id, { size: next || null });
        }}
        placeholder="size"
        className="h-8 w-28 min-w-0 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
      />
      <RowActionsMenu
        items={[
          { type: "action", icon: Pencil, label: "Edit", onClick: startEdit },
          {
            type: "action",
            icon: Trash2,
            label: "Remove",
            danger: true,
            onClick: () => onRemove(v),
          },
        ]}
      />
    </li>
  );
}
