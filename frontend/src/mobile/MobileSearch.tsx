import { useEffect, useMemo, useRef, useState } from "react";
import { HighlightedText } from "../lib/highlight";
import { formatDate } from "../lib/utils";
import {
  GLOBAL_SEARCH_MIN_LENGTH,
  useGlobalSearchResults,
  type SearchHit,
  type SearchHitType,
} from "../lib/globalSearch";
import "./mobile.css";

/**
 * Mobile system-wide search palette.
 *
 * Hits the SAME multi-source endpoint the desktop Cmd+K palette uses
 * (GET /api/search?q=…, backend/src/routes/search.ts). Results are grouped by
 * type, the matched keyword is BOLDED (shared HighlightedText helper), each hit
 * shows its date (numeric DD/MM/YYYY, owner-locked), and a tap routes into the
 * matching mobile screen via the `onNavigate` callback.
 *
 * Navigation is expressed as a typed intent (SearchNav) rather than a raw SPA
 * link so the mobile shell can map each hit onto its own screen stack:
 *   - sales_order → so-detail (by doc_no)
 *   - project     → calendar, jumped to the project's start-date month + the
 *                   project highlighted (falls back to PMS if no date)
 *   - assr_case   → service case list
 *   - product     → products module list
 *   - user        → members module list
 */

/** Typed navigation intent emitted when a hit is tapped. The shell decides
 *  which screen each maps to (see MobileApp). The service-case / product /
 *  people intents carry the hit's `id` so the shell can deep-link to the
 *  specific record instead of dropping the tapper on a bare list. */
export type SearchNav =
  | { kind: "sales_order"; docNo: string }
  | { kind: "project"; projectId: number; date: string | null }
  | { kind: "assr_case"; id: string }
  | { kind: "product"; id: string }
  | { kind: "user"; id: string };

/* Numeric DD/MM/YYYY — the owner-locked mobile date format (never month names),
   matching MobileSalesOrders / MobileCalendar. Delegates to the shared TZ-aware
   helper so date-only strings never drift a day on an off-zone device; keeps this
   surface's empty-string (not em-dash) fallback for a blank/unparseable date. */
const dm = (d: string | null | undefined): string => {
  if (!d) return "";
  const s = formatDate(d);
  return s === "—" ? "" : s;
};

// The phone surface intentionally lists only the record types it has a screen
// for. The procurement/fulfilment documents (purchase_order / grn /
// delivery_order / sales_invoice / purchase_invoice) are desktop Cmd+K sources —
// the mobile shell has no detail screen to route them to yet, so they are left
// out of TYPE_ORDER (and never rendered) rather than shown as dead taps. The
// label/colour maps stay total over SearchHitType so the shared type can grow
// without breaking this file.
const TYPE_ORDER: SearchHitType[] = [
  "sales_order",
  "project",
  "assr_case",
  "product",
  "user",
];
const TYPE_LABEL: Record<SearchHitType, string> = {
  sales_order: "Sales Orders",
  purchase_order: "Purchase Orders",
  grn: "GRNs",
  delivery_order: "Delivery Orders",
  sales_invoice: "Sales Invoices",
  purchase_invoice: "Purchase Invoices",
  project: "Projects",
  assr_case: "Service Cases",
  product: "Products",
  user: "People",
};
const TYPE_COLOR: Record<SearchHitType, string> = {
  sales_order: "#16695f",
  purchase_order: "#b76b00",
  grn: "#2f5d4f",
  delivery_order: "#16695f",
  sales_invoice: "#16695f",
  purchase_invoice: "#b76b00",
  project: "#2f8a5b",
  assr_case: "#a16a2e",
  product: "#4b6b86",
  user: "#7a5c86",
};

function navFor(hit: SearchHit): SearchNav | null {
  switch (hit.type) {
    case "sales_order":
      return { kind: "sales_order", docNo: String(hit.id) };
    case "project":
      return { kind: "project", projectId: Number(hit.id), date: hit.date ?? null };
    // Carry the backend id through so the shell can deep-link the tapped record
    // rather than discard it and open a bare list.
    case "assr_case":
      return { kind: "assr_case", id: String(hit.id) };
    case "product":
      return { kind: "product", id: String(hit.id) };
    case "user":
      return { kind: "user", id: String(hit.id) };
    // SCM documents have no mobile screen yet (and are excluded from TYPE_ORDER,
    // so they never render here) — no navigation intent to emit.
    case "purchase_order":
    case "grn":
    case "delivery_order":
    case "sales_invoice":
    case "purchase_invoice":
      return null;
  }
}

export function MobileSearch({
  onBack,
  onNavigate,
}: {
  onBack: () => void;
  onNavigate: (nav: SearchNav) => void;
}) {
  const [q, setQ] = useState("");
  const { term, hits, loading, error, degradedNotice } = useGlobalSearchResults(q);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const groups = useMemo(() => {
    const map = new Map<SearchHitType, SearchHit[]>();
    for (const h of hits) {
      const arr = map.get(h.type) ?? [];
      arr.push(h);
      map.set(h.type, arr);
    }
    return TYPE_ORDER.map((t) => ({ type: t, items: map.get(t) ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [hits]);

  return (
    <div
      className="hz-m"
      style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}
    >
      <header className="hdr">
        <div className="hdr-row">
          <button onClick={onBack} className="back" aria-label="Back">‹ Back</button>
          <div className="searchbar" style={{ marginLeft: 4 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--mut)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search orders, projects, cases, products, people…"
              aria-label="Search orders, projects, service cases, products and people"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            {q && (
              <button onClick={() => setQ("")} aria-label="Clear" style={{ background: "none", border: "none", padding: 0, lineHeight: 0, color: "var(--mut)" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="scroll" style={{ padding: 12, paddingBottom: 40 }}>
        {term.length === 0 && (
          <div style={{ padding: "40px 16px", textAlign: "center", color: "var(--mut2)", fontSize: 12.5 }}>
            Start typing to search across sales orders, projects, service cases, products and people.
          </div>
        )}
        {term.length > 0 && term.length < GLOBAL_SEARCH_MIN_LENGTH && (
          <div role="status" aria-live="polite" style={{ padding: "40px 16px", textAlign: "center", color: "var(--mut2)", fontSize: 12.5 }}>
            Type 1 more character to search everywhere.
          </div>
        )}
        {term.length >= GLOBAL_SEARCH_MIN_LENGTH && loading && (
          <div role="status" aria-live="polite" style={{ padding: "30px 0", textAlign: "center", color: "var(--mut2)", fontSize: 12.5 }}>Searching for “{term}”…</div>
        )}
        {error && (
          <div role="alert" style={{ margin: "8px 0", borderRadius: 10, border: "1px solid #e6c3c3", background: "#fbeded", padding: "10px 12px", fontSize: 12, color: "var(--red)" }}>
            Couldn't search right now. Please try again.
          </div>
        )}
        {degradedNotice && !error && (
          <div role="alert" style={{ margin: "8px 0", borderRadius: 10, border: "1px solid #e0cba8", background: "#fdf6e9", padding: "10px 12px", fontSize: 12, color: "var(--ink, #2b2b2b)" }}>
            {degradedNotice}
          </div>
        )}
        {term.length >= GLOBAL_SEARCH_MIN_LENGTH && !loading && !error && hits.length === 0 && (
          <div role="status" aria-live="polite" style={{ padding: "40px 16px", textAlign: "center", color: "var(--mut2)", fontSize: 12.5 }}>
            {/* Must not claim absence when a source went unread — same rule as desktop. */}
            {degradedNotice
              ? `No matches found for "${term}" in what could be searched.`
              : `No matches for "${term}". Try a different keyword.`}
          </div>
        )}

        {groups.map((g) => (
          <div key={g.type} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 2px 7px" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: TYPE_COLOR[g.type] }} />
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--mut)" }}>{TYPE_LABEL[g.type]}</span>
              <span style={{ fontSize: 10, color: "var(--mut2)" }}>· {g.items.length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {g.items.map((hit) => (
                <button
                  key={`${hit.type}-${hit.id}`}
                  className="card"
                  onClick={() => {
                    const nav = navFor(hit);
                    if (nav) onNavigate(nav);
                  }}
                  style={{ textAlign: "left", padding: "11px 13px", borderLeft: `4px solid ${TYPE_COLOR[hit.type]}`, cursor: "pointer", fontFamily: "inherit" }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                      <HighlightedText text={hit.title} query={term} />
                    </span>
                    {hit.date && (
                      <span style={{ fontSize: 10.5, color: "var(--mut2)", flex: "none" }}>{dm(hit.date)}</span>
                    )}
                  </div>
                  {hit.subtitle && (
                    <div style={{ marginTop: 3, fontSize: 11.5, color: "var(--mut)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      <HighlightedText text={hit.subtitle} query={term} />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
