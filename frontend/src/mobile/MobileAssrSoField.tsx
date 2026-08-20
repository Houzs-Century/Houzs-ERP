import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatPhone } from "../vendor/shared/phone";
import { type Any, cellEllipsis, get } from "./assr-case-fields";
import "./mobile.css";

const INK = "#11140f";
const MUTED = "#767b6e";
const GREY = "#9aa093";
const DIM = "#e3e6e0";

/* SO typeahead — mirrors desktop CreatePanel: GET /api/assr/search-so?q=…
   returns { results: [{ doc_no, ref, debtor_name, phone, doc_date,
   sales_agent }] } (min 2 chars server-side). Debounced client-side.

   Lives here rather than in MobileServiceCase because that screen is AT its
   recorded size ceiling; both the create sheet and the detail's SO field
   import it. */
export type SoHit = Any;

export function useSoSearch(q: string): { results: SoHit[]; loading: boolean; error: string | null } {
  const needle = q.trim();
  const { data, isFetching, error } = useQuery({
    queryKey: ["mobile-assr-so-search", needle],
    enabled: needle.length >= 2,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      api.get<{ results?: SoHit[] }>(`/api/assr/search-so?q=${encodeURIComponent(needle)}`, { signal }),
  });
  return {
    results: data?.results ?? [],
    loading: isFetching,
    error: error ? ((error as Error).message || "Could not search sales orders — try again.") : null,
  };
}

/* SO input with the create-sheet's typeahead (Nick 2026-07-14 — editing
   the SO must search like the create form). Picking a hit fills the
   draft; EditableAcc's Save then PATCHes doc_no and the backend
   re-matches customer info. Unknown values (post-disconnect SOs) still
   save as typed. */
export function SoSearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  const { results, loading } = useSoSearch(focused ? value : "");
  const open = focused && value.trim().length >= 2 && (loading || results.length > 0);
  return (
    <div style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="SO #, reference, or customer name…"
        className="fld-i money"
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      {open && (
        <div className="hz-scroll" style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 4, zIndex: 30, border: `1px solid ${DIM}`, borderRadius: 10, background: "#fff", maxHeight: 190, overflowY: "auto", boxShadow: "0 10px 24px -10px rgba(17,24,16,.35)" }}>
          {loading && <div style={{ fontSize: 11, color: GREY, padding: "9px 11px" }}>Searching…</div>}
          {!loading && !results.length && <div style={{ fontSize: 11, color: GREY, padding: "9px 11px" }}>No matching sales orders.</div>}
          {results.map((hit, i) => (
            <button
              key={String(get(hit, "docNo", "doc_no")) + i}
              onMouseDown={(e) => { e.preventDefault(); onChange(String(get(hit, "docNo", "doc_no") ?? "")); setFocused(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderTop: i ? "1px solid #eceee9" : "none", background: "#fff", padding: "9px 11px", cursor: "pointer" }}
            >
              <div className="money" style={{ fontSize: 12, fontWeight: 700, color: INK }}>{String(get(hit, "docNo", "doc_no"))}</div>
              <div style={{ fontSize: 11, color: MUTED, ...cellEllipsis }}>{String(get(hit, "debtorName", "debtor_name") ?? "—")}{get(hit, "phone") ? ` · ${formatPhone(get(hit, "phone"))}` : ""}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
