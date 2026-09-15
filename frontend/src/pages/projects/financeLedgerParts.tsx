import { useState } from "react";
import { Plus, Trash2, ExternalLink, Pencil, ChevronDown, ChevronUp } from "lucide-react";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { LEDGER_COST_CATS, LEDGER_INCOME_CATS, ledgerCategoryLabel } from "../../vendor/scm/lib/pms-ledger-categories";
import { api } from "../../api/client";
import { formatDate, formatCurrency, cn } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";
import type { FinanceLine } from "./types";
import { viewableMime } from "./projectHelpers";

// Single Cost Lines section at the bottom of the Financial Snapshot.
// Lists every non-auto, manually-entered cost line (with or without a
// receipt) with open / edit / delete affordances, so each can be edited
// in place and have a receipt attached. "+ Add cost line" opens
// AddFinanceLineForm, whose category dropdown hides already-used
// categories so a category never gets a duplicate line.
export function FinanceAttachmentsSection({
  projectId,
  lines,
  adding,
  onAddOpen,
  onAddClose,
  onChange,
  toast,
}: {
  projectId: number;
  lines: FinanceLine[];
  adding: boolean;
  onAddOpen: () => void;
  onAddClose: () => void;
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const costLines = lines.filter(
    (l) => l.kind === "cost" && !l.auto_source && !l.source,
  );
  // Categories that already have an editable cost line. The add form
  // hides these so a category never gets a duplicate line — the user
  // edits the existing row instead.
  const usedCategories = new Set(costLines.map((l) => ((l.category as string | null) ?? "").trim()));
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">
          Cost lines ({costLines.length})
        </h4>
        {!adding && (
          <button
            onClick={onAddOpen}
            className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-accent hover:underline"
          >
            <Plus size={11} /> Add cost line
          </button>
        )}
      </div>
      {costLines.length === 0 && !adding && (
        <div className="text-[11px] text-ink-muted">
          No cost lines yet. Add one to record a cost and attach a receipt.
        </div>
      )}
      {costLines.length > 0 && (
        <CategoryDetailLines
          lines={costLines}
          onChange={onChange}
          toast={toast}
        />
      )}
      {adding && (
        <div className="mt-2">
          <AddFinanceLineForm
            projectId={projectId}
            kind="cost"
            usedCategories={usedCategories}
            onCancel={onAddClose}
            onSaved={() => {
              onAddClose();
              onChange();
            }}
            toast={toast}
          />
        </div>
      )}
    </div>
  );
}

// EditableSnapshotRow was deleted on 2026-05-08 along with the
// per-row expand UI — boss preferred a single Attachments section
// at the bottom of the snapshot card. SnapshotRow's `editable` prop
// (click-to-edit consolidate) covers the inline edit need; the new
// FinanceAttachmentsSection above covers receipts.

// Compact list of the underlying lines for one category, with the
// existing edit/delete/openFile affordances. Lifted from LedgerGroup
// but stripped of the section chrome so it nests cleanly under a
// snapshot row.
function CategoryDetailLines({
  lines,
  onChange,
  toast,
}: {
  lines: FinanceLine[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [editingId, setEditingId] = useState<number | null>(null);
  async function del(line: FinanceLine) {
    if (!await dialog.confirm("Remove this line? Totals will re-compute.")) return;
    try {
      await api.del(`/api/projects/finance/lines/${line.id}`);
      onChange();
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Something went wrong. Please try again.");
    }
  }
  async function openFile(line: FinanceLine) {
    if (!line.r2_key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${line.r2_key}`, viewableMime(line.r2_key));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Something went wrong. Please try again.");
    }
  }
  return (
    <div className="space-y-1">
      {lines.map((l) =>
        editingId === l.id ? (
          <EditFinanceLineRow
            key={l.id}
            line={l}
            onCancel={() => setEditingId(null)}
            onSaved={() => {
              setEditingId(null);
              onChange();
            }}
            toast={toast}
          />
        ) : (
          <div
            key={l.id}
            className="group flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-[10.5px]"
          >
            <span className="min-w-0 flex-1 truncate" title={l.description || undefined}>
              {l.description || <span className="text-ink-muted">No description</span>}
            </span>
            <span className="font-mono text-[10px] text-ink-muted">
              {l.occurred_at ? formatDate(l.occurred_at) : formatDate(l.created_at)}
            </span>
            <span className="font-mono text-[11px] font-bold text-err">
              −{formatCurrency(l.amount)}
            </span>
            {l.r2_key && (
              <button
                onClick={() => openFile(l)}
                className="rounded p-0.5 text-ink-muted hover:text-accent"
                title="Open receipt"
              >
                <ExternalLink size={11} />
              </button>
            )}
            <button
              onClick={() => setEditingId(l.id)}
              className="rounded p-0.5 text-ink-muted opacity-0 hover:bg-accent/10 hover:text-accent group-hover:opacity-100"
              title="Edit"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={() => del(l)}
              className="rounded p-0.5 text-ink-muted opacity-0 hover:bg-err/10 hover:text-err group-hover:opacity-100"
              title="Remove"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ),
      )}
    </div>
  );
}

// Financial Snapshot tile — large value above a one-line subtitle.
// Mirrors the Exhibition Report layout the boss vibecoded.
export function SnapshotKpi({
  label,
  value,
  subtitle,
  tone,
}: {
  label: string;
  value: string;
  subtitle: string;
  tone?: "synced" | "err";
}) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-display text-[20px] font-extrabold leading-none tracking-tight",
          tone === "synced" && "text-synced",
          tone === "err" && "text-err",
          !tone && "text-ink",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] text-ink-muted">{subtitle}</div>
    </div>
  );
}

// One row of the itemized cost table. `subtotal` flag bolds the row
// and tints the background so it reads as a footer — used for COGS
// Total, Total Cost, and Net Profit rows. `indent` nests the label
// under its parent subtotal (the COGS sub-rows under COGS Total).
// When `editable` is set the value cell becomes click-to-edit and
// calls onSave with the typed amount. `lineCount` + `expanded` +
// `onToggleExpand` add the chevron affordance for drilling into
// per-line detail (descriptions / dates / attachments).
export function SnapshotRow({
  label,
  value,
  annotation,
  subtotal,
  indent,
  tone,
  editable,
  busy,
  lineCount,
  expanded,
  onToggleExpand,
}: {
  label: string;
  value: number;
  annotation?: string;
  subtotal?: boolean;
  indent?: boolean;
  tone?: "synced" | "err";
  editable?: { onSave: (n: number) => Promise<void> };
  busy?: boolean;
  lineCount?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  function startEdit() {
    if (!editable) return;
    setDraft(value > 0 ? String(value) : "");
    setEditing(true);
  }
  async function commit() {
    if (!editable) return;
    const n = parseFloat(draft.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      setEditing(false);
      return;
    }
    setEditing(false);
    if (Math.abs(n - value) < 0.005) return; // unchanged
    await editable.onSave(n);
  }
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border-subtle py-1.5",
        indent ? "pl-8 pr-4" : "px-4",
        subtotal && "bg-bg/50",
        editable && !editing && !busy && "cursor-pointer hover:bg-accent-soft/30",
      )}
      onClick={editable && !editing ? startEdit : undefined}
      title={editable ? "Click to edit" : undefined}
    >
      <span
        className={cn(
          "truncate",
          subtotal ? "font-bold text-ink" : "text-ink-secondary",
        )}
      >
        {label}
        {annotation && (
          <span className="ml-1.5 font-mono text-[10px] font-normal text-ink-muted">
            {annotation}
          </span>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {onToggleExpand && lineCount != null && lineCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] text-ink-muted hover:bg-bg/60 hover:text-accent"
            title={expanded ? "Hide line detail" : `Show ${lineCount} line${lineCount === 1 ? "" : "s"} (descriptions / receipts)`}
          >
            {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            <span>{lineCount}</span>
          </button>
        )}
        {editing ? (
          <input
            type="number"
            step="0.01"
            min="0"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              else if (e.key === "Escape") setEditing(false);
            }}
            className="w-32 rounded border border-accent bg-surface px-2 py-0.5 text-right font-mono tabular-nums outline-none focus:ring-2 focus:ring-primary/20"
          />
        ) : (
          <span
            className={cn(
              "font-mono tabular-nums",
              subtotal && "font-bold",
              tone === "synced" && "text-synced",
              tone === "err" && "text-err",
              !tone && "text-ink",
              busy && "opacity-50",
            )}
          >
            {busy ? "…" : formatCurrency(value)}
          </span>
        )}
      </div>
    </div>
  );
}

function AddFinanceLineForm({
  projectId,
  kind,
  onCancel,
  onSaved,
  toast,
  categoryDefault,
  usedCategories,
}: {
  projectId: number;
  kind: "income" | "cost";
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
  // When set, the category dropdown is pre-selected (and the field
  // hidden) so the row-level "+ Add detailed line" CTA goes straight
  // to amount + description + date + receipt.
  categoryDefault?: string;
  // Categories that already have a line — hidden from the dropdown so
  // the user edits the existing row rather than adding a duplicate.
  usedCategories?: Set<string>;
}) {
  const allCategories = kind === "income" ? LEDGER_INCOME_CATS : LEDGER_COST_CATS;
  const categories = categoryDefault
    ? allCategories
    : allCategories.filter((c) => !usedCategories?.has(c));
  const [category, setCategory] = useState<string>(
    categoryDefault ?? (categories[0] as string | undefined) ?? "",
  );
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    setSubmitting(true);
    try {
      let r2Key: string | undefined;
      let fileName: string | undefined;
      let mimeType: string | undefined;
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          toast.error("File exceeds 10MB");
          setSubmitting(false);
          return;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await file.arrayBuffer();
        const up = await api.putBinary<{ key: string; mime_type: string }>(
          `/api/projects/${projectId}/finance/upload?ext=${ext}`,
          buf,
          file.type
        );
        r2Key = up.key;
        fileName = file.name;
        mimeType = up.mime_type;
      }
      await api.post(`/api/projects/${projectId}/finance/lines`, {
        kind,
        category,
        amount: n,
        description: description.trim() || null,
        occurred_at: occurredAt || null,
        r2_key: r2Key,
        file_name: fileName,
        mime_type: mimeType,
      });
      onSaved();
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!categoryDefault && categories.length === 0) {
    return (
      <div className="mt-3 rounded-md border border-border bg-surface p-3 text-[11px] text-ink-secondary">
        Every category already has a line. Edit the existing row to change its
        amount or attach a receipt instead of adding a duplicate.
        <div className="mt-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">
        New {kind} line
        {categoryDefault && ` · ${ledgerCategoryLabel(categoryDefault)}`}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {!categoryDefault && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {ledgerCategoryLabel(c)}
              </option>
            ))}
          </select>
        )}
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (RM)"
          className={cn(
            "rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-primary",
            categoryDefault && "col-span-2",
          )}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
        <DateField
          fullWidth
          value={occurredAt}
          onChange={(iso) => setOccurredAt(iso)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
          title="Payment date"
        />
        <input
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.pdf,.xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting || !amount}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function EditFinanceLineRow({
  line,
  onCancel,
  onSaved,
  toast,
}: {
  line: FinanceLine;
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const categories = line.kind === "income" ? LEDGER_INCOME_CATS : LEDGER_COST_CATS;
  const initialCategory = categories.includes(line.category)
    ? line.category
    : categories[0];
  const [category, setCategory] = useState<string>(initialCategory);
  const [amount, setAmount] = useState<string>(String((line.amount as number | null) ?? ""));
  const [description, setDescription] = useState<string>(line.description ?? "");
  const [occurredAt, setOccurredAt] = useState<string>(
    line.occurred_at ? line.occurred_at.slice(0, 10) : ""
  );
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    setSubmitting(true);
    try {
      const patch: Record<string, unknown> = {
        category,
        amount: n,
        description: description.trim() || null,
        occurred_at: occurredAt || null,
      };
      // Replacing / attaching a receipt — upload then carry the key on
      // the patch. An existing r2_key is left untouched when no new file
      // is picked.
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          toast.error("File exceeds 10MB");
          setSubmitting(false);
          return;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await file.arrayBuffer();
        const up = await api.putBinary<{ key: string; mime_type: string }>(
          `/api/projects/${line.project_id}/finance/upload?ext=${ext}`,
          buf,
          file.type,
        );
        patch.r2_key = up.key;
        patch.file_name = file.name;
        patch.mime_type = up.mime_type;
      }
      await api.patch(`/api/projects/finance/lines/${line.id}`, patch);
      onSaved();
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft/20 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">
        Edit {line.kind} line
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {ledgerCategoryLabel(c)}
            </option>
          ))}
          {!categories.includes(line.category) && (
            <option value={line.category}>{ledgerCategoryLabel(line.category)}</option>
          )}
        </select>
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (RM)"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-primary"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
        <DateField
          fullWidth
          value={occurredAt}
          onChange={(iso) => setOccurredAt(iso)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
          title="Payment date"
        />
        <div className="col-span-2">
          {line.r2_key && (
            <div className="mb-1 text-[10px] text-ink-muted">
              Current receipt: {line.file_name || "attached"} · pick a file to replace
            </div>
          )}
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.pdf,.xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none"
            title={line.r2_key ? "Replace receipt" : "Attach receipt"}
          />
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting || !amount}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
