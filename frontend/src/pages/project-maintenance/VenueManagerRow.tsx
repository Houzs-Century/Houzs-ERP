import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { RowActionsMenu } from "../../components/RowActionsMenu";
import {
  AddressTripleFields,
  type AddressTripleClasses,
} from "../../vendor/scm/components/AddressTripleFields";

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
  city?: string | null;
  postcode?: string | null;
  size?: string | null;
}

const CONTROL =
  "h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15";
export const VENUE_TRIPLE_CLASSES: AddressTripleClasses = {
  field: "flex min-w-0 flex-col",
  label: "sr-only",
  select: CONTROL,
  input: CONTROL,
  selectWrap: "relative block",
  chevron: "pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted",
};

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
    if (!next) return;
    if (next !== v.name) onPatch(v.id, { name: next });
    setEditing(false);
  }
  function cancel() {
    setEditing(false);
    setName(v.name);
  }

  return (
    <li className="px-3 py-2">
      {/* Name and the row menu on the first line, the fields under it: side by
          side the name was squeezed to one word per line (owner 2026-11-18). */}
      <div className="flex items-center justify-between gap-3">
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
          <div className="truncate text-[13px] font-medium text-ink" title={v.name}>{v.name}</div>
        )}
      </div>
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
      </div>
      <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-[repeat(3,minmax(0,1fr))_8rem]">
        <AddressTripleFields
          postcodeRequired
          country=""
          value={{ state: v.state ?? "", city: v.city ?? "", postcode: v.postcode ?? "" }}
          onChange={(next, derivedCountry) =>
            onPatch(v.id, {
              state: next.state || null,
              city: next.city || null,
              postcode: next.postcode || null,
              ...(derivedCountry ? { country: derivedCountry } : {}),
            })
          }
          classes={VENUE_TRIPLE_CLASSES}
        />
      <input
        key={`size-${v.id}-${v.size ?? ""}`}
        defaultValue={v.size ?? ""}
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next !== (v.size ?? "")) onPatch(v.id, { size: next || null });
        }}
        placeholder="Size"
        aria-label="Venue size"
        className="h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
      />
      </div>
    </li>
  );
}
