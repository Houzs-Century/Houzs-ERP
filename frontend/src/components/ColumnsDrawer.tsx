import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Check,
  ChevronDown,
  Columns3,
  Copy,
  Download,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  MoreVertical,
  Search,
  Star,
  X,
} from "lucide-react";
import { Button, IconButton, SearchInput } from "./Button";
import { EmptyState } from "./EmptyState";
import { CustomFieldsSection } from "./CustomFieldsSection";
import { useToastOptional } from "../hooks/useToast";
import { useDialogOptional } from "../hooks/useDialog";
import { useSmallViewport } from "../hooks/useSmallViewport";
import { cn } from "../lib/utils";
import type { UseUdfResult } from "../hooks/useUdf";
import type { LayoutDefaultManager, LayoutPresetOption } from "./LayoutSection";

/**
 * Columns drawer — design handoff "Direction A" (2026-08-01), replacing
 * ColumnsPanel / ColumnsPanelButton.
 *
 * What changed and why, from the handoff:
 *   • the layout picker collapses from a block of radio cards to ONE row that
 *     opens a popover — it was eating the top third of the panel;
 *   • columns sit under sticky group headers (Basic / Amounts / Logistics /
 *     Custom fields) with per-group counts and collapse, because 44 flat rows
 *     is a scroll, not a chooser;
 *   • rows drop to 32px, and width + pin move onto the row itself;
 *   • Show all / Reset move next to the search field — buried in the list
 *     header, nobody found them;
 *   • "save as default" demotes from a large card to a quiet footer action.
 *
 * Every gesture applies to the table IMMEDIATELY. `Done` only closes.
 *
 * Groups come from `Column.group`; a table that annotates none renders one
 * flat list, which is exactly today's behaviour — that is what let this ship
 * to all 36 list pages at once.
 */

/** Group name used when a table annotates nothing. Never rendered as a header:
 *  a single unnamed group draws no chrome, so an un-annotated table looks the
 *  way it always did. */
export const UNGROUPED = "__ungrouped__";
/** UDF columns land here, and this header carries the "New field" entry. */
export const CUSTOM_FIELDS_GROUP = "Custom fields";

const MIN_WIDTH = 60;
const MAX_WIDTH = 400;

export interface DrawerColumn {
  key: string;
  label: string;
  group: string;
  visible: boolean;
  /** Effective width in px (user override or the column's own default). */
  width: number;
  /** Which edge it is frozen to, if any. */
  pinned: "left" | "right" | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Eyebrow, e.g. "Sales Orders". Rendered as `Document · <docLabel>`. */
  docLabel?: string;
  /** Movable columns in TABLE order (alwaysVisible ones are not listed). */
  columns: DrawerColumn[];
  onToggle: (key: string) => void;
  /** Move `key` into `targetKey`'s slot — same single rule the table header
   *  drag uses, so the two gestures cannot disagree. */
  onReorder: (key: string, targetKey: string) => void;
  onTogglePin: (key: string) => void;
  onSetWidth: (key: string, px: number) => void;
  onShowAll: () => void;
  onReset: () => void;
  /** Named layouts for the picker (company defaults today). */
  layouts?: LayoutPresetOption[];
  onApplyLayout?: (id: string) => void;
  /* Layout CRUD (mig 0239). Absent when the layout server isn't up, so the
     controls never appear where they can't work. */
  onSaveLayout?: (name: string) => Promise<void>;
  onDuplicateLayout?: (id: string, name: string) => Promise<void>;
  /** Renames whichever row the id names — the caller decides whether that is
   *  a saved layout or the company default. */
  onRenameLayout?: (id: string, name: string) => Promise<void>;
  onDeleteLayout?: (savedId: number) => Promise<void>;
  /** Replace the named layout's columns with what is on screen. Works for the
   *  company default too — the caller routes it. */
  onUpdateLayout?: (id: string) => Promise<void>;
  defaultManager?: LayoutDefaultManager;
  /** True when the columns no longer match the active layout. */
  dirty?: boolean;
  /** When set, the Custom fields group header grows a "New field" button that
   *  reveals the UDF editor at the foot of the list. */
  udf?: UseUdfResult;
  udfTableLabel?: string;
  /** Payload for "Export column config". */
  onExport?: () => void;
}

/** Case-insensitive match split into <mark>ed parts. */
function highlight(label: string, query: string) {
  if (!query) return label;
  const at = label.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="rounded-[3px] bg-accent/20 text-inherit">
        {label.slice(at, at + query.length)}
      </mark>
      {label.slice(at + query.length)}
    </>
  );
}

export function ColumnsDrawer({
  open,
  onClose,
  docLabel,
  columns,
  onToggle,
  onReorder,
  onTogglePin,
  onSetWidth,
  onShowAll,
  onReset,
  layouts,
  onApplyLayout,
  onSaveLayout,
  onDuplicateLayout,
  onRenameLayout,
  onDeleteLayout,
  onUpdateLayout,
  defaultManager,
  dirty,
  udf,
  udfTableLabel,
  onExport,
}: Props) {
  const isSmallViewport = useSmallViewport();
  const toast = useToastOptional();
  const dialog = useDialogOptional();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [popover, setPopover] = useState<null | "layout" | "more">(null);
  /** Which layout row has its ⋮ menu open. The list stays visible behind it. */
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [editingWidth, setEditingWidth] = useState<string | null>(null);
  const [widthDraft, setWidthDraft] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [udfOpen, setUdfOpen] = useState(false);

  // A drawer that reopens on a stale search reads as "my columns are gone".
  useEffect(() => {
    if (!open) {
      setQuery("");
      setPopover(null);
      setEditingWidth(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape peels one layer at a time — a popover first, the drawer last.
      if (popover) setPopover(null);
      else if (editingWidth) setEditingWidth(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, popover, editingWidth, onClose]);

  const visibleCount = columns.filter((c) => c.visible).length;

  /** Groups in first-appearance order — the order the page declared them. */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const order: string[] = [];
    const byGroup = new Map<string, DrawerColumn[]>();
    const totals = new Map<string, number>();
    for (const col of columns) {
      const group = col.group || UNGROUPED;
      if (!byGroup.has(group)) {
        byGroup.set(group, []);
        order.push(group);
      }
      totals.set(group, (totals.get(group) ?? 0) + 1);
      if (q && !col.label.toLowerCase().includes(q)) continue;
      byGroup.get(group)!.push(col);
    }
    return order
      .map((name) => ({
        name,
        columns: byGroup.get(name) ?? [],
        total: totals.get(name) ?? 0,
        shown: (byGroup.get(name) ?? []).filter((c) => c.visible).length,
      }))
      // A group whose every column was filtered out drops away; its header
      // would be a promise of rows that aren't there.
      .filter((g) => g.columns.length > 0);
  }, [columns, query]);

  const nothingMatches = groups.length === 0;
  /* One group is no grouping: a five-column list would gain a header that
     says only "everything below". Headers earn their space from CONTRAST. */
  const showGroupHeaders = groups.length > 1;

  function commitWidth(key: string) {
    const parsed = Number.parseInt(widthDraft, 10);
    setEditingWidth(null);
    if (!Number.isFinite(parsed)) return;
    onSetWidth(key, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed)));
  }

  function handleExport() {
    setPopover(null);
    onExport?.();
    toast?.success("Column config exported");
  }

  /* Naming goes through the app dialog rather than an inline field: the
     popover is 6px of padding around a list, and a text input in a row that
     also carries a radio and a ⋮ is a row that does three things. Without a
     dialog host (a bare test render) the action simply doesn't run. */
  async function promptForName(title: string, defaultValue: string) {
    if (!dialog) return null;
    const name = await dialog.prompt({
      title,
      placeholder: "e.g. Finance review",
      defaultValue,
      required: true,
      confirmLabel: "Save",
    });
    return name?.trim() ? name.trim() : null;
  }

  async function runLayoutAction(work: Promise<void>, done: string) {
    try {
      await work;
      toast?.success(done);
    } catch (e) {
      toast?.error((e as { message?: string })?.message || "Could not save the layout.");
    }
  }

  const activeLayout = layouts?.find((l) => l.active);
  const layoutMeta = [
    activeLayout?.hint,
    `${visibleCount} columns`,
    layouts && layouts.length > 1 ? `${layouts.length - 1} more layouts` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // ── Row ───────────────────────────────────────────────────────────────────
  const renderRow = (col: DrawerColumn) => {
    const isDragging = dragKey === col.key;
    const isDropTarget = overKey === col.key && dragKey !== null && dragKey !== col.key;
    return (
      <div
        key={col.key}
        data-column-row={col.key}
        draggable={!query}
        onDragStart={(e) => {
          setDragKey(col.key);
          e.dataTransfer.effectAllowed = "move";
          try {
            e.dataTransfer.setData("text/plain", col.key);
          } catch {
            // Locked-down dataTransfer — our own state carries the payload.
          }
        }}
        onDragOver={(e) => {
          // Reorder is WITHIN a group: group order is the page's, not the
          // operator's, so a drop across groups has no meaning to honour.
          if (!dragKey) return;
          const from = columns.find((c) => c.key === dragKey);
          if (!from || from.group !== col.group) return;
          // Nor across freeze sides: the table renders the left run, the
          // scrolling middle and the right run as three blocks, so a drop
          // between them would rewrite the order and change nothing on screen.
          if (from.pinned !== col.pinned) return;
          e.preventDefault();
          if (overKey !== col.key) setOverKey(col.key);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const from = dragKey;
          setDragKey(null);
          setOverKey(null);
          if (!from || from === col.key) return;
          const source = columns.find((c) => c.key === from);
          if (!source || source.group !== col.group) return;
          if (source.pinned !== col.pinned) return;
          onReorder(from, col.key);
        }}
        onDragEnd={() => {
          setDragKey(null);
          setOverKey(null);
        }}
        className={cn(
          "group/row relative flex items-center gap-[9px] rounded-lg pl-1 pr-1.5 transition-colors",
          isSmallViewport ? "h-12" : "h-8",
          isDragging
            ? "border border-primary bg-surface shadow-[0_10px_24px_rgba(34,31,32,0.16)]"
            : "hover:bg-surface-2",
          dragKey && !isDragging && "opacity-45"
        )}
      >
        {isDropTarget && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-1 -top-px z-10 h-[2px] rounded-full bg-primary"
          />
        )}
        {/* Handle sits on the THUMB side on a phone (right), by the checkbox
            on a pointer device (left). */}
        {!isSmallViewport && (
          <span
            className="flex cursor-grab p-0.5 text-border-strong group-hover/row:text-ink-muted active:cursor-grabbing"
            title="Drag to reorder"
          >
            <GripVertical size={13} />
          </span>
        )}
        <button
          type="button"
          onClick={() => onToggle(col.key)}
          aria-label={col.visible ? "Hide column" : "Show column"}
          aria-pressed={col.visible}
          className={cn(
            "grid h-[15px] w-[15px] shrink-0 place-items-center rounded border-[1.5px] transition-colors",
            col.visible
              ? "border-primary bg-primary text-white"
              : "border-border-strong bg-surface"
          )}
        >
          {col.visible && <Check size={9} strokeWidth={3} />}
        </button>
        <button
          type="button"
          onClick={() => onToggle(col.key)}
          /* Explicit: the search highlight splits the label into text + <mark>,
             and a name computed from those children reads as "Tot al". */
          aria-label={col.label}
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            isSmallViewport ? "text-[13.5px]" : "text-[12.5px]",
            col.visible ? "text-ink" : "text-ink-muted"
          )}
        >
          {highlight(col.label, query.trim())}
        </button>
        {/* Freeze: none → left → right → none. One button, because the three
            states are one axis — a column is frozen to an edge or it isn't. */}
        <button
          type="button"
          onClick={() => onTogglePin(col.key)}
          title={
            col.pinned === "left"
              ? "Frozen left — click to freeze right"
              : col.pinned === "right"
                ? "Frozen right — click to unfreeze"
                : "Freeze to the left"
          }
          className={cn(
            "flex items-center gap-[3px] rounded-md px-[5px] py-[3px] text-[9px] font-semibold uppercase tracking-[0.08em] transition-opacity",
            col.pinned
              ? "bg-primary-soft text-primary-ink opacity-100"
              : "text-ink-muted opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
          )}
        >
          {col.pinned === "left" ? (
            <ArrowLeftToLine size={10} />
          ) : col.pinned === "right" ? (
            <ArrowRightToLine size={10} />
          ) : (
            <Columns3 size={10} />
          )}
          {col.pinned === "left" ? "Left" : col.pinned === "right" ? "Right" : ""}
        </button>
        {editingWidth === col.key ? (
          <input
            autoFocus
            value={widthDraft}
            onChange={(e) => setWidthDraft(e.target.value)}
            onBlur={() => commitWidth(col.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitWidth(col.key);
              if (e.key === "Escape") setEditingWidth(null);
            }}
            aria-label={`Width of ${col.label} in pixels`}
            className="w-11 rounded-md border border-primary px-1 py-[3px] text-center font-mono text-[10.5px] tabular-nums outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setWidthDraft(String(col.width));
              setEditingWidth(col.key);
            }}
            title={`Column width — ${MIN_WIDTH}–${MAX_WIDTH}px`}
            className={cn(
              "w-11 rounded-md border border-border-subtle bg-surface px-1 py-[3px] text-center font-mono text-[10.5px] tabular-nums text-ink-muted transition-opacity",
              isSmallViewport
                ? "hidden"
                : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
            )}
          >
            {col.width}px
          </button>
        )}
      </div>
    );
  };

  // ── List ──────────────────────────────────────────────────────────────────
  const list = nothingMatches ? (
    <div className="px-4 py-8">
      <EmptyState
        icon={<Search size={18} />}
        message={`No columns match “${query.trim()}”`}
        description="Try a shorter word, or add it as a custom field on this document type."
        cta={{ label: "Clear search", onClick: () => setQuery("") }}
      />
    </div>
  ) : (
    groups.map((group) => {
      const isCollapsed = collapsed.includes(group.name);
      const isCustom = group.name === CUSTOM_FIELDS_GROUP;
      return (
        <div key={group.name}>
          {group.name !== UNGROUPED && showGroupHeaders && (
            <div
              role="button"
              tabIndex={0}
              onClick={() =>
                setCollapsed((prev) =>
                  prev.includes(group.name)
                    ? prev.filter((g) => g !== group.name)
                    : [...prev, group.name]
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setCollapsed((prev) =>
                    prev.includes(group.name)
                      ? prev.filter((g) => g !== group.name)
                      : [...prev, group.name]
                  );
                }
              }}
              aria-expanded={!isCollapsed}
              className={cn(
                "sticky top-0 z-[1] flex cursor-pointer select-none items-center gap-[7px] bg-surface px-1.5 pb-[5px] pt-[9px] text-[9.5px] font-semibold uppercase tracking-[0.14em]",
                isCustom ? "text-accent" : "text-ink-muted"
              )}
            >
              <ChevronDown
                size={11}
                strokeWidth={2}
                className={cn("transition-transform duration-150", isCollapsed && "-rotate-90")}
              />
              {group.name}
              <span className="text-[9.5px] tabular-nums tracking-[0.04em] opacity-80">
                {group.shown}/{group.total}
              </span>
              <span className="h-px flex-1 bg-border-subtle" />
              {isCustom && udf && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setUdfOpen((v) => !v);
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-normal text-accent hover:bg-accent-soft"
                >
                  {udfOpen ? "Close" : "New field"}
                </button>
              )}
            </div>
          )}
          {!isCollapsed && group.columns.map(renderRow)}
        </div>
      );
    })
  );

  // ── Chrome ────────────────────────────────────────────────────────────────
  const header = (
    <div className="flex flex-none items-start justify-between gap-3 border-b border-border-subtle px-[18px] pb-3.5 pt-[18px]">
      <div className="min-w-0">
        {docLabel && (
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
            Document · {docLabel}
          </div>
        )}
        <h2 className="mt-[7px] text-[19px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink">
          Columns
        </h2>
        <div className="mt-1 text-[11.5px] text-ink-muted">
          Show, reorder, pin and manage custom fields
        </div>
      </div>
      <div className="flex gap-0.5">
        <IconButton
          variant="quiet"
          size="xs"
          aria-label="More column actions"
          icon={<MoreVertical size={14} />}
          onClick={() => setPopover((p) => (p === "more" ? null : "more"))}
        />
        <IconButton
          variant="quiet"
          size="xs"
          aria-label="Close columns drawer"
          icon={<X size={14} />}
          onClick={onClose}
        />
      </div>
    </div>
  );

  const layoutPicker = layouts && layouts.length > 0 && (
    <button
      type="button"
      onClick={() => setPopover((p) => (p === "layout" ? null : "layout"))}
      className="mx-3.5 mt-3 flex flex-none items-center gap-2.5 rounded-[10px] border border-border-subtle bg-surface-2 py-2 pl-3 pr-2.5 text-left transition-colors hover:border-border"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[9.5px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
          Layout
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <span className="truncate">{activeLayout?.label ?? "Custom"}</span>
          {activeLayout?.isDefault && (
            <span className="rounded-full bg-accent-soft px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.1em] text-accent">
              Default
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-ink-muted">{layoutMeta}</span>
      </span>
      <ChevronDown size={14} className="shrink-0 text-ink-muted" />
    </button>
  );

  const toolbar = (
    <div className="flex flex-none items-center gap-1.5 px-3.5 pb-2.5 pt-3">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Search columns"
        aria-label="Search columns"
        className="flex-1"
        leadingIcon={<Search size={13} />}
        inputClassName="h-8 w-full rounded-[9px] border-transparent bg-surface-2 pl-[30px] pr-2.5 text-[12.5px] focus:bg-surface"
      />
      <button
        type="button"
        onClick={onShowAll}
        className="h-[30px] shrink-0 rounded-lg px-2.5 text-[11.5px] font-semibold text-ink-secondary hover:bg-surface-2 hover:text-ink"
      >
        Show all
      </button>
      <button
        type="button"
        onClick={onReset}
        title="Restore this layout's columns, order and widths"
        className="h-[30px] shrink-0 rounded-lg px-2.5 text-[11.5px] font-semibold text-ink-secondary hover:bg-surface-2 hover:text-ink"
      >
        Reset
      </button>
    </div>
  );

  const footer = (
    <div className="flex flex-none items-center gap-2 border-t border-border-subtle px-3.5 py-[11px]">
      <span className="flex-1 text-[11.5px] tabular-nums text-ink-muted">
        {visibleCount} of {columns.length} shown
        {dirty ? " · edited" : ""}
      </span>
      {defaultManager && (
        <Button
          variant="ghost"
          className="h-8 px-3 text-[12px]"
          disabled={defaultManager.state === "saving"}
          onClick={() => {
            defaultManager.onSave();
            toast?.success(`Saved as the ${defaultManager.companyLabel} default`);
          }}
        >
          {defaultManager.state === "saving" ? "Saving…" : "Save as default"}
        </Button>
      )}
      <Button className="h-8 px-4 text-[12px]" onClick={onClose}>
        Done
      </Button>
    </div>
  );

  const layoutPopover = popover === "layout" && layouts && (
    <div
      role="listbox"
      aria-label="Layouts"
      className="absolute inset-x-3.5 top-[104px] z-20 rounded-[14px] border border-border bg-surface p-1.5 shadow-[0_18px_44px_rgba(34,31,32,0.18)]"
    >
      {layouts.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => {
            onApplyLayout?.(l.id);
            setPopover(null);
          }}
          role="option"
          aria-selected={l.active}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-left",
            l.active ? "bg-primary-soft" : "hover:bg-surface-2"
          )}
        >
          <span
            className={cn(
              "grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border-[1.5px]",
              l.active ? "border-primary bg-primary" : "border-border-strong"
            )}
          >
            {l.active && <span className="h-[5px] w-[5px] rounded-full bg-white" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
              <span className="truncate">{l.label}</span>
              {l.isDefault && (
                <span className="rounded-full bg-accent-soft px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.1em] text-accent">
                  Default
                </span>
              )}
            </span>
            <span className="block truncate text-[11px] text-ink-muted">
              {[l.hint, `${l.count} columns`].filter(Boolean).join(" · ")}
            </span>
          </span>
          {(onDuplicateLayout || onRenameLayout) && (
            <span
              role="button"
              tabIndex={0}
              aria-label={`Actions for ${l.label}`}
              onClick={(e) => {
                e.stopPropagation();
                setRowMenu((cur) => (cur === l.id ? null : l.id));
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                setRowMenu((cur) => (cur === l.id ? null : l.id));
              }}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <MoreVertical size={13} />
            </span>
          )}
        </button>
      ))}
      {/* Row menu — the layout list stays visible behind it, as designed. */}
      {rowMenu && (
        <div className="mt-1 rounded-[10px] border border-border bg-surface p-1 shadow-[0_10px_28px_rgba(34,31,32,0.16)]">
          {(() => {
            const target = layouts.find((l) => l.id === rowMenu);
            if (!target) return null;
            const close = () => {
              setRowMenu(null);
              setPopover(null);
            };
            return (
              <>
                {onUpdateLayout && (
                  <button
                    type="button"
                    onClick={async () => {
                      close();
                      await runLayoutAction(
                        onUpdateLayout(target.id),
                        `“${target.label}” now matches these columns`,
                      );
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
                  >
                    <Check size={13} /> Update with current columns
                  </button>
                )}
                {onRenameLayout && (
                  <button
                    type="button"
                    onClick={async () => {
                      const name = await promptForName("Rename layout", target.label);
                      close();
                      if (name) await runLayoutAction(onRenameLayout(target.id, name), "Layout renamed");
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
                  >
                    <Pencil size={13} /> Rename
                  </button>
                )}
                {onDuplicateLayout && (
                  <button
                    type="button"
                    onClick={async () => {
                      const name = await promptForName("Duplicate layout as", `${target.label} copy`);
                      close();
                      if (name) await runLayoutAction(onDuplicateLayout(target.id, name), "Layout duplicated");
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
                  >
                    <Copy size={13} /> Duplicate
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    close();
                    handleExport();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
                >
                  <Download size={13} /> Export config
                </button>
                {target.savedId != null && onDeleteLayout && (
                  <>
                    <div className="mx-2 my-1 h-px bg-border-subtle" />
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await dialog?.confirm({
                          title: `Delete “${target.label}”?`,
                          message:
                            "The layout is removed from your picker. Columns on screen stay as they are.",
                          danger: true,
                          confirmLabel: "Delete",
                        });
                        close();
                        if (ok) await runLayoutAction(onDeleteLayout(target.savedId!), "Layout deleted");
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-err/10 hover:text-err"
                    >
                      <Trash2 size={13} /> Delete layout
                    </button>
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}
      {onSaveLayout && (
        <>
          <div className="mx-2 my-1.5 h-px bg-border-subtle" />
          <button
            type="button"
            onClick={async () => {
              const name = await promptForName("New layout from current columns", "");
              setPopover(null);
              if (name) await runLayoutAction(onSaveLayout(name), `Saved “${name}”`);
            }}
            className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
          >
            <Plus size={14} />
            New layout from current columns
          </button>
        </>
      )}
      {defaultManager && (
        <>
          <div className="mx-2 my-1.5 h-px bg-border-subtle" />
          <button
            type="button"
            onClick={() => {
              setPopover(null);
              defaultManager.onSave();
              toast?.success(`Saved as the ${defaultManager.companyLabel} default`);
            }}
            className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
          >
            <Star size={14} />
            Save current as {defaultManager.companyLabel} default
            <span className="text-[11px] font-normal text-ink-muted">
              applies to everyone unset
            </span>
          </button>
        </>
      )}
    </div>
  );

  const morePopover = popover === "more" && (
    <div className="absolute right-4 top-14 z-20 w-[210px] rounded-[14px] border border-border bg-surface p-1.5 shadow-[0_18px_44px_rgba(34,31,32,0.18)]">
      <button
        type="button"
        onClick={handleExport}
        className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
      >
        <Download size={14} />
        Export column config
      </button>
      {defaultManager && (
        <button
          type="button"
          onClick={() => {
            setPopover(null);
            defaultManager.onSave();
            toast?.success(`Saved as the ${defaultManager.companyLabel} default`);
          }}
          className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
        >
          <Star size={14} />
          Save as {defaultManager.companyLabel} default
        </button>
      )}
      <div className="mx-2 my-1.5 h-px bg-border-subtle" />
      <button
        type="button"
        onClick={() => {
          setPopover(null);
          onReset();
        }}
        className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-surface-2"
      >
        Reset to layout defaults
      </button>
    </div>
  );

  if (!open) return null;

  // ── Mobile: bottom sheet ──────────────────────────────────────────────────
  if (isSmallViewport) {
    return createPortal(
      <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Columns">
        <div className="absolute inset-0 bg-[rgba(17,20,15,0.18)]" onClick={onClose} />
        <div className="absolute inset-x-0 bottom-0 flex h-[88%] flex-col rounded-t-[20px] bg-surface shadow-[0_-14px_40px_rgba(34,31,32,0.2)]">
          <div className="mx-auto mt-2 h-1 w-9 flex-none rounded-full bg-border" />
          <div className="flex flex-none items-center justify-between px-4 pb-1.5 pt-2.5">
            <div className="min-w-0">
              {docLabel && (
                <div className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
                  {docLabel}
                </div>
              )}
              <div className="mt-1 text-[19px] font-semibold leading-[1.2] text-ink">Columns</div>
            </div>
            <IconButton
              variant="quiet"
              size="xs"
              aria-label="Close columns drawer"
              icon={<X size={14} />}
              onClick={onClose}
            />
          </div>
          {layouts && layouts.length > 0 && (
            <div className="thin-scroll flex flex-none gap-1.5 overflow-x-auto px-3.5 pb-0.5 pt-2.5">
              {layouts.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => onApplyLayout?.(l.id)}
                  aria-pressed={l.active}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[12px] font-semibold",
                    l.active
                      ? "border-primary bg-primary text-white"
                      : "border-border bg-surface text-ink-secondary"
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-none items-center gap-1.5 px-3.5 pb-1.5 pt-2.5">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search columns"
              aria-label="Search columns"
              className="flex-1"
              leadingIcon={<Search size={13} />}
              inputClassName="h-9 w-full rounded-[9px] border-transparent bg-surface-2 pl-[30px] pr-2.5 text-[13px] focus:bg-surface"
            />
            <button
              type="button"
              onClick={onReset}
              className="h-8 shrink-0 rounded-lg px-2.5 text-[11.5px] font-semibold text-ink-secondary"
            >
              Reset
            </button>
          </div>
          <div className="thin-scroll flex-1 overflow-y-auto px-2.5 pb-2">
            {list}
            {udf && udfOpen && (
              <div className="mt-3 border-t border-border-subtle px-1 pt-3">
                <CustomFieldsSection udf={udf} label={udfTableLabel || ""} />
              </div>
            )}
          </div>
          <div className="flex flex-none gap-2 border-t border-border-subtle px-3.5 pb-5 pt-3">
            {defaultManager && (
              <Button
                variant="secondary"
                className="h-11 flex-1 justify-center rounded-xl text-[13px]"
                onClick={() => {
                  defaultManager.onSave();
                  toast?.success(`Saved as the ${defaultManager.companyLabel} default`);
                }}
              >
                Save as default
              </Button>
            )}
            <Button
              className="h-11 flex-[1.4] justify-center rounded-xl text-[13px]"
              onClick={onClose}
            >
              Apply · {visibleCount} columns
            </Button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // ── Desktop: right drawer ─────────────────────────────────────────────────
  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Columns">
      <div className="absolute inset-0 bg-[rgba(17,20,15,0.18)]" onClick={onClose} />
      <div
        className="absolute inset-y-0 right-0 flex w-[420px] flex-col border-l border-border bg-surface shadow-[-18px_0_44px_rgba(34,31,32,0.12)]"
        onClick={() => popover && setPopover(null)}
      >
        {header}
        {layoutPicker}
        {toolbar}
        <div className="thin-scroll flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
          {list}
          {udf && udfOpen && (
            <div className="mt-3 border-t border-border-subtle px-1.5 pt-3">
              <CustomFieldsSection udf={udf} label={udfTableLabel || ""} />
            </div>
          )}
        </div>
        {footer}
        {/* Popovers stop the click that would close them via the panel handler. */}
        <div onClick={(e) => e.stopPropagation()}>
          {layoutPopover}
          {morePopover}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Toolbar trigger — `Columns · 11`, the count being visible columns. */
export function ColumnsButton({
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
        "group inline-flex h-[34px] items-center gap-2 rounded-lg border bg-surface px-3.5 text-[12.5px] font-medium text-ink-secondary",
        "shadow-[0_1px_1px_rgba(17,20,15,0.03)] transition-all duration-fast ease-out",
        "hover:-translate-y-px hover:border-primary/45 hover:shadow-[0_4px_12px_rgba(22,105,95,0.12)]",
        "active:translate-y-0 disabled:pointer-events-none disabled:opacity-45",
        active ? "border-primary text-primary" : "border-border"
      )}
    >
      <Columns3 size={14} className={cn(active ? "text-primary" : "text-ink-muted")} />
      <span className="hidden sm:inline">Columns</span>
      <span className="text-ink-muted">·</span>
      <span className={cn("font-mono text-[11.5px] font-bold tabular-nums", active && "text-primary")}>
        {visibleCount}
      </span>
    </button>
  );
}
