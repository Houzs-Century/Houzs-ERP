import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "./Button";
import type { UseUdfResult, UdfFieldType } from "../hooks/useUdf";
import { useDialog } from "../hooks/useDialog";
import { useToast } from "../hooks/useToast";

/**
 * Custom fields (UDF) editor — add and delete the user-defined columns a
 * document type carries. Renaming is deliberately not exposed: the backend
 * `key` is stable by design.
 *
 * Lifted verbatim out of ColumnsPanel when the columns drawer was rebuilt
 * (design handoff 2026-08-01), so the redesign did not also rewrite the one
 * part of that panel that writes to the server.
 */

const FIELD_TYPES: Array<{ value: UdfFieldType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select" },
  { value: "checkbox", label: "Checkbox" },
];

export function CustomFieldsSection({ udf, label }: { udf: UseUdfResult; label: string }) {
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
