import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { api } from "../api/client";
import "./mobile.css";
import { PostcodeCascadeField } from "../vendor/scm/components/PostcodeCascadeField";
import { PickListField } from "../vendor/scm/components/PickListField";
import { PAYMENT_TERMS, PAYMENT_TERMS_CUSTOM, listEntryOf } from "../vendor/shared/pick-lists";


export type FormFieldType =
  | "text"
  | "number"
  | "tel"
  | "email"
  | "select"
  | "money"
  | "textarea"
  | "postcode"
  | "pick";

/** The fixed lists a "pick" field offers (vendor/shared/pick-lists), as the desktop forms do. */
export const PICK_LISTS = {
  paymentTerms: { list: PAYMENT_TERMS, other: PAYMENT_TERMS_CUSTOM, typePlaceholder: "Type the term" },
} as const;
export type PickListName = keyof typeof PICK_LISTS;

/** A runtime-loaded option source — used when a select's options are real
 *  records (roles / departments / positions) that can't be a static list. */
export type OptionsSource = {
  base: "scm" | "core";
  path: string;
  listKey?: string;
  value: (row: any) => string | number;
  label: (row: any) => string;
};

export type FormField = {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  optionsSource?: OptionsSource;
  placeholder?: string;
  moneyScale?: number;
  integer?: boolean;
  hint?: string;
  pick?: PickListName;
};

export type FormSchema = {
  title: string;
  eyebrow?: string;
  base: "scm" | "core";
  createPath: string;
  updatePath?: (id: string) => string;
  idKey: string;
  fields: FormField[];
  responseIdKeys?: string[];
};

const num = (s: string) => parseFloat(String(s).replace(/,/g, "")) || 0;

function readId(resp: any, schema: FormSchema): string {
  if (resp == null || typeof resp !== "object") return "";
  const keys = schema.responseIdKeys ?? [schema.idKey, "id"];
  for (const k of keys) {
    const v = resp[k];
    if (v != null && typeof v !== "object") return String(v);
  }
  for (const v of Object.values(resp)) {
    if (v && typeof v === "object") {
      for (const k of keys) {
        const nested = (v as Record<string, unknown>)[k];
        if (nested != null && typeof nested !== "object") return String(nested);
      }
    }
  }
  return "";
}

function pickInitial(row: any, key: string): unknown {
  if (!row || typeof row !== "object") return undefined;
  if (row[key] !== undefined) return row[key];
  const snake = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
  if (row[snake] !== undefined) return row[snake];
  return undefined;
}

function seedValue(field: FormField, row: any): string {
  const raw = pickInitial(row, field.key);
  if (raw == null || raw === "") return "";
  if (field.type === "money") {
    const scale = field.moneyScale ?? 100;
    const n = Number(raw);
    if (!Number.isFinite(n)) return "";
    return (n / scale).toFixed(2);
  }
  const value = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
  if (field.type === "pick") return listEntryOf(field.pick ? PICK_LISTS[field.pick].list : [], value) ?? value;
  // A select shows its blank entry for a value it has no option for, so seeding
  // that value would make Save send what the screen never showed, e.g. an
  // invited member's status, which the save refuses
  // (docs/bugs/0929-a-phone-edit-of-an-invited-member-could-never-be-saved-the-f.md).
  if (field.type === "select" && !field.optionsSource && !field.options?.some((o) => o.value === value)) {
    return "";
  }
  return value;
}

export function MobileModuleForm({
  schema,
  mode,
  initial,
  onBack,
  onSaved,
}: {
  schema: FormSchema;
  mode: "new" | "edit";
  initial?: any;
  onBack: () => void;
  onSaved?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const isEdit = mode === "edit";

  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of schema.fields) {
      seed[f.key] = isEdit && initial ? seedValue(f, initial) : "";
    }
    return seed;
  });
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [remoteOptions, setRemoteOptions] = useState<
    Record<string, { value: string; label: string }[]>
  >({});

  useEffect(() => {
    let cancelled = false;
    const sources = schema.fields.filter((f) => f.optionsSource);
    if (sources.length === 0) return;
    (async () => {
      for (const f of sources) {
        const src = f.optionsSource!;
        try {
          const data =
            src.base === "core"
              ? await api.get<any>(src.path)
              : await authedFetch<any>(src.path);
          const list = pickList(data, src.listKey);
          if (cancelled) return;
          const opts = list.map((row) => ({
            value: String(src.value(row)),
            label: String(src.label(row)),
          }));
          setRemoteOptions((prev) => ({ ...prev, [f.key]: opts }));
        } catch {
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (key: string, v: string) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const missing = useMemo(
    () =>
      schema.fields.filter(
        (f) => f.required && !String(values[f.key] ?? "").trim(),
      ),
    [schema.fields, values],
  );

  function buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const f of schema.fields) {
      const raw = String(values[f.key] ?? "").trim();
      if (raw === "") {
        if (f.required) continue;
        if (!isEdit) body[f.key] = null;
        continue;
      }
      if (f.type === "money") {
        const scale = f.moneyScale ?? 100;
        body[f.key] = Math.round(num(raw) * scale);
      } else if (f.type === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        body[f.key] = f.integer ? Math.round(n) : n;
      } else if (f.type === "select") {
        if (raw === "true" || raw === "false") body[f.key] = raw === "true";
        else if (/^\d+$/.test(raw)) body[f.key] = Number(raw);
        else body[f.key] = raw;
      } else {
        body[f.key] = raw;
      }
    }
    return body;
  }

  async function save() {
    setTouched(true);
    if (missing.length > 0) {
      setError(
        `Please fill in the required field${missing.length > 1 ? "s" : ""}: ${missing
          .map((f) => f.label)
          .join(", ")}.`,
      );
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const body = buildBody();
      let id = "";
      if (isEdit) {
        if (!schema.updatePath) throw new Error("This record can't be edited.");
        const rowId = String(pickInitial(initial, schema.idKey) ?? initial?.id ?? "");
        if (!rowId) throw new Error("Couldn't identify this record.");
        const path = schema.updatePath(rowId);
        const resp =
          schema.base === "core"
            ? await api.patch<any>(path, body)
            : await authedFetch<any>(path, {
                method: "PATCH",
                body: JSON.stringify(body),
              });
        id = readId(resp, schema) || rowId;
      } else {
        const resp =
          schema.base === "core"
            ? await api.post<any>(schema.createPath, body)
            : await authedFetch<any>(schema.createPath, {
                method: "POST",
                body: JSON.stringify(body),
              });
        id = readId(resp, schema);
      }
      await qc.invalidateQueries({ queryKey: ["mobile-module"] });
      if (onSaved) onSaved(id);
      else onBack();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't save. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const title = `${isEdit ? "Edit" : "New"} ${schema.title}`;

  return (
    <div
      className="hz-m"
      style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}
    >
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span
            onClick={onBack}
            style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "var(--hz-c-primary)", cursor: "pointer" }}
          >
            <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> {schema.title}
          </span>
          <span
            onClick={onBack}
            style={{ fontSize: 13, fontWeight: 600, color: "var(--hz-c-ink-muted)", cursor: "pointer" }}
          >
            Cancel
          </span>
        </div>
        {schema.eyebrow && (
          <div className="ey" style={{ color: "var(--hz-c-accent)", marginTop: 6 }}>{schema.eyebrow}</div>
        )}
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--hz-c-ink)", marginTop: 2 }}>{title}</div>
      </header>

      <div className="scroll" style={{ padding: 12, paddingBottom: 24 }}>
        <div className="so-card">
          <div className="so-hd">
            <h2 className="so-ti">{schema.title}</h2>
          </div>
          <div className="so-bd">
            {schema.fields.map((f) => {
              const err = touched && !!f.required && !String(values[f.key] ?? "").trim();
              const options = f.optionsSource ? remoteOptions[f.key] ?? [] : f.options ?? [];
              if (f.type === "pick" && f.pick) {
                const pick = PICK_LISTS[f.pick];
                return (
                  <PickListField
                    key={f.key}
                    label={f.required ? `${f.label} *` : f.label}
                    options={pick.list}
                    other={pick.other}
                    value={values[f.key] ?? ""}
                    onChange={(v) => set(f.key, v)}
                    pickLabel={f.placeholder ?? "Select…"}
                    typePlaceholder={pick.typePlaceholder}
                    upper={false}
                    classes={{ field: "fld", label: "fld-l", select: "fld-i", input: "fld-i" }}
                  />
                );
              }
              if (f.type === "postcode") {
                const has = (k: string) => schema.fields.some((x) => x.key === k);
                return (
                  <PostcodeCascadeField
                    key={f.key}
                    value={values[f.key] ?? ""}
                    state={values.state || ""}
                    city={values.city || ""}
                    label={f.required ? `${f.label} *` : f.label}
                    onPick={(t) => {
                      set(f.key, t.postcode);
                      if (has("state")) set("state", t.state);
                      if (has("city")) set("city", t.city);
                    }}
                    classes={{ field: "fld", label: "fld-l", select: "fld-i", input: "fld-i" }}
                  />
                );
              }
              return (
                <label key={f.key} className="fld">
                  <span className="fld-l" style={err ? { color: "var(--hz-c-err)" } : undefined}>
                    {f.required ? `${f.label} *` : f.label}
                  </span>
                  {f.type === "select" ? (
                    <select className="fld-i" value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)}>
                      <option value="">{f.placeholder ?? "Select…"}</option>
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : f.type === "textarea" ? (
                    <textarea className="fld-i" rows={3} value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />
                  ) : (
                    <input
                      className={`fld-i${f.type === "money" ? " money" : ""}`}
                      type={f.type === "money" ? "text" : f.type === "number" ? "number" : f.type}
                      inputMode={f.type === "money" || f.type === "number" ? "decimal" : undefined}
                      value={values[f.key] ?? ""}
                      onChange={(e) => set(f.key, e.target.value)}
                      placeholder={f.placeholder}
                    />
                  )}
                  {f.hint && <span className="so-sub" style={{ marginTop: 2 }}>{f.hint}</span>}
                </label>
              );
            })}
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--hz-c-err)", textAlign: "center", padding: "0 4px" }}>{error}</div>
        )}
      </div>

      <footer className="actbar">
        <button className="btn" disabled={submitting} onClick={save} style={{ opacity: submitting ? 0.6 : 1 }}>
          {submitting ? "Saving…" : isEdit ? "Save Changes" : `Create ${schema.title}`}
        </button>
      </footer>
    </div>
  );
}

function pickList(data: unknown, listKey?: string): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (listKey) return Array.isArray(obj[listKey]) ? (obj[listKey] as any[]) : [];
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v as any[];
  return [];
}
