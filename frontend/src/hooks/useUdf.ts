import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export type UdfFieldType = "text" | "number" | "date" | "select" | "checkbox";

export interface UdfField {
  id: number;
  key: string;
  label: string;
  type: UdfFieldType;
  options: string[] | null;
  position: number;
}

export interface UdfPayload {
  fields: UdfField[];
  /** row_key → field_key → value */
  values: Record<string, Record<string, string | null>>;
}

export interface UseUdfResult {
  fields: UdfField[];
  values: Record<string, Record<string, string | null>>;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Add a new field to this table. */
  addField: (input: {
    key: string;
    label: string;
    type: UdfFieldType;
    options?: string[];
  }) => Promise<void>;
  /** Remove a field and all its stored values. */
  deleteField: (key: string) => Promise<void>;
  /** Save (or clear, if value is null/empty) a single cell value. */
  setValue: (rowKey: string, fieldKey: string, value: string | null) => Promise<void>;
  /** Read a value without triggering re-renders. */
  getValue: (rowKey: string, fieldKey: string) => string | null;
}

/**
 * Per-table user-defined fields hook. One instance per page; pass it to
 * <DataTable udf={...}/> to render dynamic columns and cells.
 *
 * If `table` is undefined the hook returns an empty disabled state — pages
 * that don't opt in to UDFs can still mount safely.
 */
export function useUdf(table: string | undefined): UseUdfResult {
  const [data, setData] = useState<UdfPayload>({ fields: [], values: {} });
  const [loading, setLoading] = useState<boolean>(!!table);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!table) {
      setData({ fields: [], values: {} });
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<UdfPayload>(`/api/udf/${table}`);
      setData(res);
    } catch (e: any) {
      // e.message is already humanized by the API client; the fallback only
      // fires on a non-Error throw and must be a sentence, not String(e).
      setError(e?.message || "We couldn't load the custom fields. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [table]);

  useEffect(() => {
    load();
  }, [load]);

  const addField: UseUdfResult["addField"] = useCallback(
    async (input) => {
      if (!table) throw new Error("No table");
      await api.post(`/api/udf/${table}`, input);
      await load();
    },
    [table, load]
  );

  const deleteField: UseUdfResult["deleteField"] = useCallback(
    async (key) => {
      if (!table) throw new Error("No table");
      await api.del(`/api/udf/${table}/${encodeURIComponent(key)}`);
      await load();
    },
    [table, load]
  );

  const setValue: UseUdfResult["setValue"] = useCallback(
    async (rowKey, fieldKey, value) => {
      if (!table) throw new Error("No table");
      await api.put(`/api/udf/${table}/values/${encodeURIComponent(rowKey)}`, {
        [fieldKey]: value,
      });
      // Optimistic local update so the cell doesn't snap back during reload
      setData((prev) => {
        const next = { ...prev, values: { ...prev.values } };
        const row = { ...(next.values[rowKey] || {}) };
        if (value == null || value === "") {
          delete row[fieldKey];
        } else {
          row[fieldKey] = value;
        }
        if (Object.keys(row).length) {
          next.values[rowKey] = row;
        } else {
          delete next.values[rowKey];
        }
        return next;
      });
    },
    [table]
  );

  const getValue: UseUdfResult["getValue"] = useCallback(
    (rowKey, fieldKey) => {
      const row = data.values[rowKey];
      if (!row) return null;
      const v = row[fieldKey];
      return v == null ? null : v;
    },
    [data]
  );

  return {
    fields: data.fields,
    values: data.values,
    loading,
    error,
    reload: load,
    addField,
    deleteField,
    setValue,
    getValue,
  };
}
