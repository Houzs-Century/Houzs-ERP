import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { cn } from "../../lib/utils";
import type { Role } from "../../types";

/** Lightweight centered modal shell (portal + scrim + Esc), matching the mock. */
function Modal({
  open,
  onClose,
  maxWidth = 430,
  children,
}: {
  open: boolean;
  onClose: () => void;
  maxWidth?: number;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/[0.34] p-6 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-slab animate-modal-in"
        style={{ maxWidth }}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

const LABEL_CLS =
  "mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-ink-muted";
const FIELD_CLS =
  "h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

export interface NewRoleDraft {
  name: string;
  description: string;
  /** "blank" | "readonly" | `role:{id}` */
  startFrom: string;
}

export function NewRoleModal({
  open,
  roles,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  roles: Role[];
  busy: boolean;
  onClose: () => void;
  onCreate: (draft: NewRoleDraft) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startFrom, setStartFrom] = useState("blank");

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setStartFrom("blank");
    }
  }, [open]);

  // You can only copy from roles you could also express as a custom role —
  // wildcard/system roles would seed a `*` grant, so keep them out of the list.
  const copyable = roles.filter((r) => !r.is_system && !r.permissions.includes("*"));

  return (
    <Modal open={open} onClose={onClose}>
      <div className="border-b border-border-subtle px-[18px] py-4 text-[15px] font-bold text-ink">
        New role
      </div>
      <div className="flex flex-col gap-3.5 px-[18px] py-4">
        <div>
          <label className={LABEL_CLS}>Role name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Regional Dispatcher"
            className={FIELD_CLS}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !busy)
                onCreate({ name, description, startFrom });
            }}
          />
        </div>
        <div>
          <label className={LABEL_CLS}>Description (optional)</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this role is for"
            className={FIELD_CLS}
          />
        </div>
        <div>
          <label className={LABEL_CLS}>Start from</label>
          <select
            value={startFrom}
            onChange={(e) => setStartFrom(e.target.value)}
            className={cn(FIELD_CLS, "cursor-pointer")}
          >
            <option value="blank">Blank — no permissions</option>
            <option value="readonly">Read-only across all modules</option>
            {copyable.length > 0 && (
              <optgroup label="Copy from an existing role">
                {copyable.map((r) => (
                  <option key={r.id} value={`role:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="mt-1.5 text-[11px] text-ink-muted">
            You can change every grant afterwards.
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border-subtle bg-surface-dim px-[18px] py-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || !name.trim()}
          onClick={() => onCreate({ name, description, startFrom })}
        >
          {busy ? "Creating…" : "Create role"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Role picker used two ways:
 *  - mode "apply": choose multiple TARGET roles to copy the current grants INTO.
 *  - mode "copy":  choose one SOURCE role to copy grants FROM.
 * Locked roles (system / wildcard) can't be written, so they're disabled as
 * apply targets.
 */
export function RolePickerModal({
  open,
  mode,
  roles,
  currentName,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  mode: "apply" | "copy" | null;
  roles: Role[];
  currentName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (ids: number[]) => void;
}) {
  const multiple = mode === "apply";
  const [sel, setSel] = useState<number[]>([]);

  useEffect(() => {
    if (open) setSel([]);
  }, [open, mode]);

  if (!mode) return null;

  const toggle = (id: number) => {
    setSel((prev) =>
      multiple
        ? prev.includes(id)
          ? prev.filter((x) => x !== id)
          : [...prev, id]
        : [id]
    );
  };

  const title = mode === "apply" ? "Apply permissions to…" : "Copy permissions from…";
  const blurb =
    mode === "apply"
      ? `Overwrite the grants of the roles you pick with ${currentName}'s current grants.`
      : `Replace the current selection's grants with a copy of another role's grants.`;

  return (
    <Modal open={open} onClose={onClose} maxWidth={460}>
      <div className="border-b border-border-subtle px-[18px] py-4">
        <div className="text-[15px] font-bold text-ink">{title}</div>
        <div className="mt-1 text-[12px] text-ink-muted">{blurb}</div>
      </div>
      <div className="max-h-[52vh] overflow-y-auto px-2.5 py-2.5">
        {roles.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12.5px] text-ink-muted">
            No other roles available.
          </div>
        ) : (
          roles.map((r) => {
            const locked = r.is_system || r.permissions.includes("*");
            const disabled = multiple && locked; // can't write into a system role
            const on = sel.includes(r.id);
            return (
              <button
                key={r.id}
                type="button"
                disabled={disabled}
                onClick={() => toggle(r.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                  disabled
                    ? "cursor-not-allowed opacity-50"
                    : on
                      ? "bg-primary-soft"
                      : "hover:bg-surface-dim"
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center border",
                    multiple ? "rounded" : "rounded-full",
                    on
                      ? "border-primary bg-primary text-white"
                      : "border-border-strong bg-surface"
                  )}
                >
                  {on && <span className="text-[10px] leading-none">✓</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {r.name}
                    </span>
                    {locked && (
                      <Badge tone="accent" size="xs">
                        System
                      </Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-ink-muted">
                    {r.member_count} member{r.member_count === 1 ? "" : "s"} ·{" "}
                    {r.permissions.includes("*") ? "All" : r.permissions.length} permission
                    {r.permissions.length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border-subtle bg-surface-dim px-[18px] py-3">
        <button
          onClick={onClose}
          className="rounded p-1 text-ink-muted hover:text-ink"
          aria-label="Close"
        >
          <X size={16} />
        </button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || sel.length === 0}
            onClick={() => onConfirm(sel)}
          >
            {busy
              ? "Working…"
              : mode === "apply"
                ? `Apply to ${sel.length || ""}`.trim()
                : "Copy grants"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
