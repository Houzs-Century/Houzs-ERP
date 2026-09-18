import { useState, useEffect } from "react";
import { useToast } from "../../hooks/useToast";
import { api } from "../../api/client";
import { cn } from "../../lib/utils";
import type { FinanceLine } from "./types";

// Shared className for every editable input in the strip — keeps
// dropdowns + text inputs + date inputs visually identical.
export const SPEC_INPUT_CLASS =
  "w-full appearance-none rounded border border-border bg-surface px-2 py-1 text-[12.5px] font-medium text-ink outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";

// Quick Rental (RM) — writes a single `rental` cost line to the finance
// ledger (the same category the Financial Snapshot's Rental row edits),
// so keying rental here syncs the Rental row, Total Cost, Net Profit, the
// Rental KPI card, and the Project List "Rental (RM)" column. Saves on
// blur / Enter.
export function QuickRentalField({
  projectId,
  financeLines,
  onSaved,
  toast,
}: {
  projectId: number;
  financeLines: FinanceLine[];
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const existing = financeLines.filter(
    (l) => l.kind === "cost" && ((l.category as string | null) ?? "").trim() === "rental" && !l.auto_source,
  );
  const current = existing.reduce((s, l) => s + (l.amount || 0), 0);
  const [val, setVal] = useState(current ? String(current) : "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setVal(current ? String(current) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const save = async () => {
    const trimmed = val.trim();
    const n = trimmed === "" ? 0 : parseFloat(trimmed);
    if (isNaN(n) || n < 0) {
      toast.error("Enter a valid rental amount");
      return;
    }
    if (Math.abs(n - current) < 0.005) return; // unchanged
    setSaving(true);
    try {
      if (n <= 0) {
        for (const l of existing) await api.del(`/api/projects/finance/lines/${l.id}`);
      } else if (existing.length === 1) {
        await api.patch(`/api/projects/finance/lines/${existing[0].id}`, { amount: n });
      } else {
        // 0 existing → create; >1 → consolidate the duplicates into one.
        for (const l of existing) await api.del(`/api/projects/finance/lines/${l.id}`);
        await api.post(`/api/projects/${projectId}/finance/lines`, {
          kind: "cost",
          category: "rental",
          amount: n,
          description: "Rental",
        });
      }
      toast.success("Rental updated");
      onSaved();
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Failed to save rental");
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      className={SPEC_INPUT_CLASS}
      type="number"
      inputMode="decimal"
      value={val}
      placeholder="—"
      disabled={saving}
      onChange={(e) => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

// Text input that flips between read-only display and an editable
// input depending on `editing`. Centralised here so every text field
// in the spec strip looks identical.
export function SpecTextField({
  editing,
  value,
  placeholder,
  type = "text",
  onChange,
}: {
  editing: boolean;
  value: string | number | null | undefined;
  placeholder?: string;
  type?: "text" | "number";
  onChange: (v: string | null) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);
  async function commit() {
    const original = value == null ? "" : String(value);
    if (draft === original) return;
    try {
      await onChange(draft === "" ? null : draft);
    } catch {
      setDraft(original);
    }
  }
  if (!editing) {
    return (
      <SpecValue muted={value == null || value === ""}>
        {value == null || value === "" ? "—" : String(value)}
      </SpecValue>
    );
  }
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value == null ? "" : String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={SPEC_INPUT_CLASS}
    />
  );
}

// ── Spec-strip helpers ────────────────────────────────────────────
// Each cell renders its own label + a children slot for the value
// (text or input). Designed to be visually flat — the dividing
// borders come from the parent `divide-x divide-y` on the grid.

export function SpecCell({
  label,
  span,
  children,
}: {
  label: string;
  span?: 2 | 3;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 px-3.5 py-2.5",
        span === 2 && "md:col-span-2",
        span === 3 && "md:col-span-2 lg:col-span-3"
      )}
    >
      <div className="mb-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
        {label}
      </div>
      <div className="min-w-0 text-[12.5px] font-medium text-ink">
        {children}
      </div>
    </div>
  );
}

export function SpecValue({
  children,
  muted,
  mono,
}: {
  children: React.ReactNode;
  muted?: boolean;
  mono?: boolean;
}) {
  return (
    <div
      className={cn(
        "truncate",
        muted && "text-ink-secondary",
        mono && "font-mono tracking-tight"
      )}
    >
      {children}
    </div>
  );
}
