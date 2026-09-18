import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { api } from "../api/client";
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileModuleForm — ONE generic, config-driven mobile CREATE / EDIT form that
 * backs the simple SCM + core master modules (Suppliers, Drivers, Fleet,
 * Warehouse, Departments, Positions, Members). It is the write counterpart to
 * MobileModuleList / MobileModuleDetail: the caller passes a `FormSchema`
 * (built from the real backend route's accepted body — see the FORM_SCHEMAS
 * map in MobileModuleList) and a mode, and this renders the design's card/field
 * idiom (1:1 with MobileNewSO's `.mnso-i` look + sticky footer Save button)
 * under the .hz-m scope, wired to the real POST (create) / PATCH (update).
 *
 * A field's value is coerced on save to what the route expects:
 *   • money   → integer minor-units (× `moneyScale`, default 100 = sen/centi;
 *               products use scale 1 because their price columns are whole-RM
 *               integers, not sen).
 *   • number  → Number(value) or omitted when blank.
 *   • select  → the chosen option value (or a runtime-loaded option's value).
 *   • text / tel / email / textarea → trimmed string (blank → null on optional).
 *
 * SCM modules go through `authedFetch` (the /api/scm mount); core modules go
 * through `api` (the /api mount). Errors surface inline; onSaved(id) fires with
 * the created / edited record id on success. English only, no emoji.
 * ------------------------------------------------------------------------- */

export type FormFieldType =
  | "text"
  | "number"
  | "tel"
  | "email"
  | "select"
  | "money"
  | "textarea";

/** A runtime-loaded option source — used when a select's options are real
 *  records (roles / departments / positions) that can't be a static list. */
export type OptionsSource = {
  base: "scm" | "core";
  /** Endpoint returning `{ [listKey]: Array<record> }` (or a bare array). */
  path: string;
  listKey?: string;
  /** Accessor for the option value (usually the id). */
  value: (row: any) => string | number;
  /** Accessor for the human label. */
  label: (row: any) => string;
};

export type FormField = {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Load select options at runtime from a real endpoint (roles / depts …). */
  optionsSource?: OptionsSource;
  placeholder?: string;
  /** For money fields: minor-unit multiplier. 100 = sen/centi (default), 1 =
   *  whole-ringgit integer columns (products). */
  moneyScale?: number;
  /** Numeric fields: send as integer (Math.round) rather than a float. */
  integer?: boolean;
  /** Optional helper line under the field. */
  hint?: string;
};

export type FormSchema = {
  title: string;
  eyebrow?: string;
  base: "scm" | "core";
  /** POST path (relative to the base mount), e.g. "/suppliers". */
  createPath: string;
  /** PATCH path builder, e.g. (id) => `/suppliers/${id}`. Omit when the module
   *  supports create only (e.g. Warehouse racks have no per-row edit route). */
  updatePath?: (id: string) => string;
  /** Key on the created / row object holding the id used for edit + onSaved. */
  idKey: string;
  fields: FormField[];
  /** Optional read of the create-response id (defaults to resp[idKey] or a
   *  nested resp[wrapperKey][idKey]). */
  responseIdKeys?: string[];
};

/* Parse a "RM" money string ("1,450.00") to a float, then to minor units. */
const num = (s: string) => parseFloat(String(s).replace(/,/g, "")) || 0;

/* Pull an id out of a create response that may wrap the record
 * ({ supplier: {...} }, { driver: {...} }) or return it flat ({ id }). */
function readId(resp: any, schema: FormSchema): string {
  if (resp == null || typeof resp !== "object") return "";
  const keys = schema.responseIdKeys ?? [schema.idKey, "id"];
  for (const k of keys) {
    const v = resp[k];
    if (v != null && typeof v !== "object") return String(v);
  }
  // Wrapped record — scan one level of nested objects for the id key.
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

/** Read a value that may arrive camelCase (PostgREST driver) or snake_case. */
function pickInitial(row: any, key: string): unknown {
  if (!row || typeof row !== "object") return undefined;
  if (row[key] !== undefined) return row[key];
  // snake_case fallback for a camelCase field key (leadTimeDays → lead_time_days)
  const snake = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
  if (row[snake] !== undefined) return row[snake];
  return undefined;
}

/** Seed a field's string form-value from an existing row (edit mode). Money
 *  columns arrive as minor units → shown as a plain decimal. */
function seedValue(field: FormField, row: any): string {
  // Money columns store minor units; the form key is the logical name (e.g.
  // creditLimitSen). Read the raw column then divide back to a decimal.
  const raw = pickInitial(row, field.key);
  if (raw == null || raw === "") return "";
  if (field.type === "money") {
    const scale = field.moneyScale ?? 100;
    const n = Number(raw);
    if (!Number.isFinite(n)) return "";
    return (n / scale).toFixed(2);
  }
  const value = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
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

  // Runtime-loaded select options (roles / departments / positions). Keyed by
  // field.key. Loaded once on mount for any field with an optionsSource.
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
          // Leave the select empty on load failure — the operator sees no
          // options and the required-field guard blocks a bad save.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // schema is stable for this screen's lifetime (remounted on navigation).
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
      // On edit, an untouched-empty optional field is left out of the PATCH so
      // we never null a column the operator didn't intend to clear. On create,
      // an empty optional is sent as null (the routes coalesce ?? null).
      if (raw === "") {
        if (f.required) continue; // guarded above; skip defensively
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
        // Boolean selects ("true"/"false") → real booleans so the routes'
        // Boolean(x) / x === false checks behave (a raw "false" string is
        // truthy). Numeric select values (role_id / department_id) → numbers so
        // the core routes' parseInt / typeof-number checks accept them.
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
      // Refresh the list this record belongs to.
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
            style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}
          >
            <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> {schema.title}
          </span>
          <span
            onClick={onBack}
            style={{ fontSize: 13, fontWeight: 600, color: "#767b6e", cursor: "pointer" }}
          >
            Cancel
          </span>
        </div>
        {schema.eyebrow && (
          <div className="ey" style={{ color: "#a16a2e", marginTop: 6 }}>{schema.eyebrow}</div>
        )}
        <div style={{ fontSize: 19, fontWeight: 800, color: "#11140f", marginTop: 2 }}>{title}</div>
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
              return (
                <label key={f.key} className="fld">
                  <span className="fld-l" style={err ? { color: "#b23a3a" } : undefined}>
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
          <div style={{ marginTop: 4, fontSize: 12, color: "#b23a3a", textAlign: "center", padding: "0 4px" }}>{error}</div>
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

/** Pick the array out of a keyed response, or return it if already an array. */
function pickList(data: unknown, listKey?: string): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (listKey) return Array.isArray(obj[listKey]) ? (obj[listKey] as any[]) : [];
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v as any[];
  return [];
}
