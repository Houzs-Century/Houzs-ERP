import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import type { UdfField } from "../hooks/useUdf";
import { cn } from "../lib/utils";
import { DateField } from "../vendor/scm/components/DateField";

type Status = "idle" | "saving" | "ok" | "error";

interface Props {
  field: UdfField;
  value: string | null;
  onSave: (next: string | null) => Promise<void>;
}

/**
 * In-table editor for a single UDF cell. Picks the right input based on
 * field type and saves on blur / change. The component is intentionally
 * compact so a row stays the same height as the rest of the table.
 */
export function UdfCell({ field, value, onSave }: Props) {
  const [draft, setDraft] = useState<string>(value ?? "");
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  async function commit(next?: string) {
    const candidate = next ?? draft;
    const original = value ?? "";
    if (candidate === original) return;
    setStatus("saving");
    try {
      await onSave(candidate === "" ? null : candidate);
      setStatus("ok");
      setTimeout(() => setStatus("idle"), 1200);
    } catch {
      setStatus("error");
    }
  }

  const baseInput =
    "h-7 w-full min-w-[80px] rounded border border-border bg-surface px-2 text-[12px] text-ink outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/20";

  let editor;
  if (field.type === "select" && field.options) {
    editor = (
      <select
        className={cn(baseInput, "appearance-none pr-6")}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          commit(e.target.value);
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <option value="">—</option>
        {draft && !field.options.includes(draft) && (
          <option value={draft}>{draft}</option>
        )}
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "checkbox") {
    const checked = draft === "1" || draft === "true";
    editor = (
      <input
        type="checkbox"
        className="h-4 w-4 cursor-pointer accent-accent"
        checked={checked}
        onChange={(e) => {
          const v = e.target.checked ? "1" : "";
          setDraft(v);
          commit(v);
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  } else if (field.type === "date") {
    /* DateField, not a native date input: the native one renders in the
       OPERATING SYSTEM's locale, so the same column read DD/MM/YYYY on one
       machine and MM/DD/YYYY on another. "date" is a first-class UdfFieldType,
       so this is reachable by anyone who adds a date column to a table.

       This survived the 2026-08-18 sweep of all 175 native date inputs and the
       gate shipped with it because the type was COMPUTED into a variable —
       `const type = … ? "date" : "text"` and then `type={type}`. That is the one
       spelling check-date-formatting.mjs states it cannot see (the string is
       decided away from the input), which is why it is written out here.

       The span carries the two handlers DateField does not take: the grid row
       must not receive the click, and Enter still commits by blurring. */
    editor = (
      <span
        style={{ display: "contents" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLElement).blur();
        }}
      >
        <DateField
          fullWidth
          className={baseInput}
          value={draft}
          onChange={setDraft}
          onBlur={() => commit()}
        />
      </span>
    );
  } else {
    const type = field.type === "number" ? "number" : "text";
    editor = (
      <input
        type={type}
        className={baseInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1">{editor}</div>
      {status === "saving" && (
        <span className="text-[9px] font-medium uppercase tracking-wider text-accent">…</span>
      )}
      {status === "ok" && <Check size={12} className="text-synced" />}
      {status === "error" && <X size={12} className="text-err" />}
    </div>
  );
}
