import { useEffect, useMemo, useState } from "react";
import { ArrowDownAZ, Check, GripVertical, Plus, Trash2, Columns3 } from "lucide-react";
import { Panel } from "./Panel";
import { Button } from "./Button";
import type { UseUdfResult, UdfFieldType } from "../hooks/useUdf";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialog } from "../hooks/useDialog";
import { useToast } from "../hooks/useToast";
import { cn } from "../lib/utils";
import {
  LayoutSection,
  type LayoutDefaultManager,
  type LayoutPresetOption,
} from "./LayoutSection";

/**
 * Unified columns panel — replaces the old dropdown "Columns" chooser
 * AND the separate "Fields" (UDF) button. Sections:
 *
 *   0. Layout (only when the page declares presets) — named column sets, one
 *      click each. Two companies sharing one list page want two different
 *      working views, and a user of either should be able to take the other's
 *      (owner 2026-08-01). Applying one just writes the ordinary column prefs,
 *      so section 1 stays the way to fine-tune it afterwards.
 *   1. Columns — reorderable + show/hide. The list is either in TABLE ORDER
 *      (drag a row by its handle to move it) or A-Z (for finding a column in
 *      a wide table); the header toggle switches between them and only table
 *      order can be dragged. Columns can also be dragged directly by their
 *      table header — same rule, see DataTable's `reorderTo`. Hidden columns
 *      still appear in the list; toggle them back on via the checkbox.
 *   2. Custom Fields (when udf is provided) — add, delete. Renaming
 *      isn't exposed here; the backend `key` is stable by design.
 *
 * Rendered as a right-side <Panel/> so it can grow as needed without
 * getting cramped on mobile.
 */

interface Option {
  key: string;
  label: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** All column options (excluding alwaysVisible). In storage-order, i.e. the
   *  order the user has arranged them in. */
  options: Option[];
  /** Named layouts offered above the column list. Omitted → no Layout section. */
  presets?: LayoutPresetOption[];
  onApplyPreset?: (id: string) => void;
  /** Present only for an admin who may publish this company's default view.
   *  Absent for everyone else — including when the layout server is
   *  unreachable, so the control never appears where it can't work. */
  defaultManager?: LayoutDefaultManager;
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onResetVisibility: () => void;
  /** Move `key` into `targetKey`'s slot. Deliberately NOT "here is the whole
   *  new order": dragging a table header does the same job, and both gestures
   *  must apply ONE rule (DataTable's `reorderTo`) instead of each computing
   *  its own and drifting apart. */
  onReorder: (key: string, targetKey: string) => void;
  onResetOrder: () => void;
  /** Optional UDF integration. When provided, the Custom Fields section
   *  shows up and its add/delete wire through to the hook. */
  udf?: UseUdfResult;
  udfTableLabel?: string;
}

const FIELD_TYPES: Array<{ value: UdfFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select" },
  { value: "checkbox", label: "Checkbox" },
];

export function ColumnsPanel({
  open,
  onClose,
  options,
  presets,
  onApplyPreset,
  defaultManager,
  hidden,
  onToggle,
  onResetVisibility,
  onReorder,
  onResetOrder,
  udf,
  udfTableLabel,
}: Props) {
  // ── Drag state ──────────────────────────────────────────────
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  /* Owner 2026-07-24 wanted the picker A-Z so a column is easy to FIND (#1169),
     and drag-to-reorder (#1004) so the table can be arranged. Those two cannot
     share one list: reordering a list that is displayed in someone else's order
     is a gesture with no meaning. #1169 shipped the A-Z sort over the top of the
     drag and the drag has been broken since — it read the drop position out of
     the STORAGE order while the operator was pointing at an ALPHABETICAL one,
     so the column landed somewhere unrelated and the drawer, still A-Z, looked
     like nothing had happened.

     So the list has two explicit modes. "Table order" mirrors the table and is
     the only one that can be dragged; "A-Z" is for finding a column and hides
     the grips rather than offering a handle that lies. Default is table order —
     drag is the thing that breaks silently; hunting a column isn't. */
  const [azSort, setAzSort] = useLocalStorage<boolean>("dt:cols-drawer-az", false);
  const canReorder = !azSort;

  function handleDragStart(key: string) {
    setDragKey(key);
  }
  function handleDragOver(e: React.DragEvent, key: string) {
    // Reorder is VISIBLE-only: the checked block is the table's column order and
    // is hand-arrangeable; the hidden block below is an A-Z pool to pick from,
    // not hand-ordered, so it accepts neither a grabbed row nor a drop.
    if (!canReorder || hidden.has(key)) return;
    e.preventDefault();
    if (key !== overKey) setOverKey(key);
  }
  function handleDrop(targetKey: string) {
    const from = dragKey;
    setDragKey(null);
    setOverKey(null);
    if (!canReorder || !from || hidden.has(targetKey)) return;
    onReorder(from, targetKey);
  }
  function handleDragEnd() {
    setDragKey(null);
    setOverKey(null);
  }

  /* Checked (visible) columns float to the TOP in BOTH modes (owner 2026-07-24:
     "勾选的自动置顶" + "勾选的同时要有可以拖拽排序功能"). Within each block the
     active mode applies — A-Z when hunting for a column, otherwise storage order.
     Keeping the VISIBLE block in STORAGE order in Table-order mode preserves
     display==storage there, so the key-based onReorder(from, target) still lands
     a drop exactly where the line sits — the invariant #1169 restored, now with
     the checked rows grouped on top. Drag stays visible-only (see rowCanDrag). */
  const displayOptions = useMemo(() => {
    const az = (arr: Option[]) =>
      [...arr].sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" })
      );
    const shown = options.filter((o) => !hidden.has(o.key));
    const notShown = options.filter((o) => hidden.has(o.key));
    // Checked block follows the mode (storage order to drag, else A-Z). The
    // unchecked pool is ALWAYS A-Z — it is never hand-ordered (owner: 抽屉都按
    // A-Z排序), just a findable list to pick the next column from.
    return [...(azSort ? az(shown) : shown), ...az(notShown)];
  }, [options, hidden, azSort]);

  // Where the carried row currently sits, so the insertion line can be drawn
  // on the side it is arriving from. -1 when no drag is in flight.
  const dragIndex = dragKey ? displayOptions.findIndex((o) => o.key === dragKey) : -1;

  return (
    <Panel
      open={open}
      onClose={onClose}
      title="Columns"
      subtitle="Show / hide, reorder, and manage custom fields"
      /* Owner 2026-07-22: keep the right-side drawer, but NARROW — 460 covered
         too much of the working area. Matches the SCM DataGrid columns drawer. */
      width={340}
    >
      <LayoutSection
        presets={presets}
        onApplyPreset={onApplyPreset}
        defaultManager={defaultManager}
      />

      {/* ── Columns list ───────────────────────────────────── */}
      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Table Columns
          </h3>
          <div className="flex items-center gap-2 text-[10px]">
            {/* Which order the list below is in. Table order is draggable;
                A-Z is for finding a column in a wide table. */}
            <button
              onClick={() => setAzSort((prev) => !prev)}
              title={
                azSort
                  ? "Listing A-Z. Switch to table order to drag columns into place."
                  : "Listing in table order — drag to rearrange. Switch to A-Z to find a column."
              }
              className="inline-flex items-center gap-1 text-ink-muted underline-offset-2 hover:text-accent hover:underline"
            >
              {azSort ? <ArrowDownAZ size={11} /> : <GripVertical size={11} />}
              {azSort ? "A-Z" : "Table order"}
            </button>
            <span className="text-ink-muted">·</span>
            <button
              onClick={onResetVisibility}
              className="text-ink-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Show all
            </button>
            <span className="text-ink-muted">·</span>
            <button
              onClick={() => {
                /* Unified with the SCM grid's Reset: order AND visibility back
                   to defaults in one action. */
                onResetOrder();
                onResetVisibility();
              }}
              title="Reset order and visibility"
              className="text-ink-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Reset
            </button>
          </div>
        </div>
        <div className="divide-y divide-border-subtle rounded-md border border-border bg-surface">
          {options.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-ink-muted">No reorderable columns.</div>
          )}
          {displayOptions.map((opt, index) => {
            const visible = !hidden.has(opt.key);
            // Only checked rows are hand-arrangeable; unchecked rows are the A-Z
            // pick-pool, so they carry no grip and refuse drops (see handlers).
            const rowCanDrag = canReorder && visible;
            const isDragging = dragKey === opt.key;
            const isDropTarget = overKey === opt.key && dragKey && dragKey !== opt.key;
            /* Owner 2026-07-24: "拖拽的时候可以有个加粗线条" — a BOLD insertion
               line, drawn on the edge the row is arriving from, so the drop
               lands exactly where the line sits. A background tint only says
               "this row" and leaves above-or-below to guesswork. */
            const dropAbove = dragIndex >= 0 && dragIndex > index;
            return (
              <div
                key={opt.key}
                draggable={rowCanDrag}
                onDragStart={(e) => {
                  handleDragStart(opt.key);
                  // Firefox refuses to start a drag with no payload.
                  e.dataTransfer.effectAllowed = "move";
                  try {
                    e.dataTransfer.setData("text/plain", opt.key);
                  } catch {
                    // Locked-down dataTransfer — Chromium reads our state.
                  }
                }}
                onDragOver={(e) => handleDragOver(e, opt.key)}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(opt.key);
                }}
                onDragEnd={handleDragEnd}
                className={cn(
                  "relative flex items-center gap-2 px-2 py-2 transition-colors",
                  isDragging && "opacity-50",
                  isDropTarget && "bg-accent-soft/40"
                )}
              >
                {isDropTarget && (
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-x-0 z-10 h-[3px] rounded-full bg-primary",
                      dropAbove ? "-top-px" : "-bottom-px"
                    )}
                  />
                )}
                {/* Grip only where a drag is real: table-order mode AND a checked
                    row. A handle you can't drag is a lie; the spacer keeps every
                    row on the same left edge (A-Z mode, or an unchecked row). */}
                {rowCanDrag ? (
                  <span
                    className="cursor-grab text-ink-muted hover:text-ink active:cursor-grabbing"
                    title="Drag to reorder"
                  >
                    <GripVertical size={14} />
                  </span>
                ) : (
                  <span className="w-[14px] shrink-0" aria-hidden />
                )}
                <button
                  onClick={() => onToggle(opt.key)}
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                    visible ? "border-primary bg-primary text-white" : "border-border bg-surface"
                  )}
                  aria-label={visible ? "Hide column" : "Show column"}
                >
                  {visible && <Check size={10} strokeWidth={3} />}
                </button>
                <button
                  onClick={() => onToggle(opt.key)}
                  className={cn(
                    "flex-1 text-left text-[12.5px]",
                    visible ? "text-ink" : "text-ink-muted"
                  )}
                >
                  {opt.label}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Custom fields (UDF) section ─────────────────────── */}
      {udf && <CustomFieldsSection udf={udf} label={udfTableLabel || ""} />}
    </Panel>
  );
}

function CustomFieldsSection({ udf, label }: { udf: UseUdfResult; label: string }) {
  const dialog = useDialog();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [formLabel, setFormLabel] = useState("");
  const [key, setKey] = useState("");
  const [type, setType] = useState<UdfFieldType>("text");
  const [optionsRaw, setOptionsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!creating) return;
    const auto = formLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (auto && (key === "" || key === prevAutoKey(formLabel))) setKey(auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formLabel, creating]);

  function prevAutoKey(s: string) {
    return s
      .slice(0, -1)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  }

  async function submitNew() {
    setFormError(null);
    if (!formLabel.trim()) return setFormError("Label is required");
    if (!/^[a-z][a-z0-9_]*$/.test(key)) return setFormError("Key must be snake_case starting with a letter");
    let options: string[] | undefined;
    if (type === "select") {
      options = optionsRaw.split(/\r?\n|,/).map((o) => o.trim()).filter(Boolean);
      if (!options.length) return setFormError("Select fields need at least one option");
    }
    setSubmitting(true);
    try {
      await udf.addField({ label: formLabel.trim(), key, type, options });
      setFormLabel("");
      setKey("");
      setType("text");
      setOptionsRaw("");
      setCreating(false);
    } catch (e: any) {
      setFormError(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(fieldKey: string, fieldLabel: string) {
    if (!await dialog.confirm(`Delete custom field "${fieldLabel}"?\n\nAll stored values will be removed.`)) return;
    try {
      await udf.deleteField(fieldKey);
    } catch (e: any) {
      toast.error(`Failed to delete: ${e?.message || e}`);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Custom Fields {label && `· ${label}`}
        </h3>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-brand text-accent hover:underline"
          >
            <Plus size={11} /> Add field
          </button>
        )}
      </div>

      {udf.loading && <div className="text-[11px] text-ink-muted">Loading…</div>}
      {udf.error && (
        <div className="rounded border border-err/30 bg-err/5 px-3 py-2 text-[11px] text-err">
          {udf.error}
        </div>
      )}

      {!udf.loading && !udf.error && udf.fields.length === 0 && !creating && (
        <div className="rounded-md border border-dashed border-border bg-bg/60 px-4 py-5 text-center text-[11px] text-ink-muted">
          No custom fields yet.
        </div>
      )}

      {udf.fields.length > 0 && (
        <ul className="divide-y divide-border-subtle rounded-md border border-border bg-surface">
          {udf.fields.map((f) => (
            <li key={f.key} className="group flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold text-ink">{f.label}</span>
                  <span className="rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                    {f.type}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-ink-muted">
                  {f.key}
                  {f.options && ` · ${f.options.length} options`}
                </div>
              </div>
              <button
                onClick={() => handleDelete(f.key, f.label)}
                className="rounded p-1 text-ink-muted opacity-0 transition-all hover:bg-err/10 hover:text-err group-hover:opacity-100"
                aria-label={`Delete ${f.label}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/30 p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-brand text-accent">
            New Custom Field
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <FieldLabel>Label</FieldLabel>
              <input
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder="e.g. Internal Notes"
                autoFocus
                className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <FieldLabel>Key</FieldLabel>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="snake_case"
                className="h-9 w-full rounded-md border border-border bg-surface px-3 font-mono text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <FieldLabel>Type</FieldLabel>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as UdfFieldType)}
                className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            {type === "select" && (
              <div className="col-span-2">
                <FieldLabel>Options (comma or newline separated)</FieldLabel>
                <textarea
                  value={optionsRaw}
                  onChange={(e) => setOptionsRaw(e.target.value)}
                  placeholder="High&#10;Medium&#10;Low"
                  className="min-h-[68px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}
          </div>
          {formError && <div className="mt-2 text-[11px] text-err">{formError}</div>}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="brass" onClick={submitNew} disabled={submitting}>
              {submitting ? "Adding…" : "Add Field"}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 text-[10px] text-ink-muted">
        Stored locally · Never sent to AutoCount
      </div>
    </section>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      {children}
    </label>
  );
}

// ── Trigger button ──────────────────────────────────────────
// Rendered by DataTable next to Export/Density. Kept in this file so
// the look stays in one place.

export function ColumnsPanelButton({
  visibleCount,
  totalCount,
  onClick,
  active,
  disabled,
}: {
  visibleCount: number;
  totalCount: number;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={`Columns — ${visibleCount} of ${totalCount} shown`}
      className={cn(
        "group inline-flex h-[34px] items-center gap-2.5 rounded-lg border bg-surface px-3.5 text-[12.5px] font-medium text-ink-secondary",
        "shadow-[0_1px_1px_rgba(17,20,15,0.03)] transition-all duration-fast ease-out",
        "hover:-translate-y-px hover:border-primary/45 hover:shadow-[0_4px_12px_rgba(22,105,95,0.12)]",
        "active:translate-y-0 disabled:pointer-events-none disabled:opacity-45",
        active ? "border-primary text-primary" : "border-border"
      )}
    >
      {/* icon tile */}
      <span
        className={cn(
          "-ml-1 grid h-[22px] w-[22px] place-items-center rounded-md transition-colors duration-fast",
          active
            ? "bg-primary text-white"
            : "bg-surface-2 text-ink-muted group-hover:bg-primary/12 group-hover:text-primary"
        )}
      >
        <Columns3 size={13} />
      </span>

      {/* label — hidden on narrow screens (collapses to compact form C) */}
      <span className="hidden sm:inline">Columns</span>

      {/* fraction, tabular-nums so it doesn't jitter */}
      <span
        className={cn(
          "font-mono text-[11.5px] font-bold tabular-nums",
          active ? "text-primary" : "text-ink-muted"
        )}
      >
        {visibleCount}/{totalCount}
      </span>
    </button>
  );
}
