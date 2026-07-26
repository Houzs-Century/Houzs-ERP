// ----------------------------------------------------------------------------
// Fair Report Fill (Roadshow PMS Agent — Job B). Upload the owner's FAIR REPORT
// (.xlsx, one worksheet per event). We read it in the browser with SheetJS, send
// each sheet's rows to /projects/fair-report/match (the unit-tested parser
// aggregates revenue + product-COGS + salesperson and matches candidate projects
// by brand+venue), then the owner picks the project per event and applies —
// which writes the finance lines (skipping any category already present).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { read, utils } from "../lib/xlsx-runtime";
import { api } from "../api/client";

type FinanceLine = { kind: "income" | "cost"; category: string; amount: number };
type Salesperson = { name: string; sales: number };
type FairEvent = {
  brand: string; venue: string; dateFirst: string | null; dateLast: string | null;
  orders: number; sales: number; cogsMattSofa: number; cogsBedframe: number;
  cogsAccessories: number; salespeople: Salesperson[];
};
type Candidate = { id: number; code: string; name: string; startDate: string; venue: string };
type MatchRow = { event: FairEvent; financeLines: FinanceLine[]; candidates: Candidate[] };
type ApplyResult = { created: number; skipped: string[]; errors: string[] };

const CAT_LABEL: Record<string, string> = {
  sales: "Sales (revenue)",
  cogs_matt_sofa: "COGS · Mattress/Sofa",
  cogs_bedframe: "COGS · Bedframe",
  cogs_accessories: "COGS · Accessories",
};
const rm = (n: number) => `RM ${Math.round(n).toLocaleString()}`;

export function FairReportFill() {
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [projectCount, setProjectCount] = useState(0);
  const [picked, setPicked] = useState<Record<number, number>>({}); // event idx -> project id
  const [results, setResults] = useState<Record<number, ApplyResult>>({});
  const [applying, setApplying] = useState<Record<number, boolean>>({});

  const matched = useMemo(() => rows.filter((r) => r.candidates.length > 0).length, [rows]);

  async function onFile(file: File) {
    setError(""); setRows([]); setResults({}); setPicked({}); setFileName(file.name); setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = read(buf, { type: "array" });
      const sheets = wb.SheetNames.map((name) => ({
        name,
        rows: utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: null }) as unknown[][],
      })).filter((s) => s.rows.length > 1);
      const res = await api.post<{ events: MatchRow[]; projectCount: number }>(
        "/projects/fair-report/match", { sheets },
      );
      setRows(res.events ?? []);
      setProjectCount(res.projectCount ?? 0);
      // Default-pick the first candidate for each matched event.
      const pk: Record<number, number> = {};
      (res.events ?? []).forEach((r, i) => { if (r.candidates[0]) pk[i] = r.candidates[0].id; });
      setPicked(pk);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the file.");
    } finally { setBusy(false); }
  }

  async function apply(idx: number) {
    const row = rows[idx];
    const projectId = picked[idx];
    if (!projectId) return;
    setApplying((s) => ({ ...s, [idx]: true }));
    try {
      const res = await api.post<ApplyResult>(`/projects/${projectId}/fair-report/apply`, { lines: row.financeLines });
      setResults((s) => ({ ...s, [idx]: res }));
    } catch (e) {
      setResults((s) => ({ ...s, [idx]: { created: 0, skipped: [], errors: [e instanceof Error ? e.message : "failed"] } }));
    } finally { setApplying((s) => ({ ...s, [idx]: false })); }
  }

  return (
    <div style={{ padding: 20, maxWidth: 1000 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Fair Report Fill</h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted, #666)", marginBottom: 16 }}>
        Upload a FAIR REPORT (.xlsx). Each event sheet is read for revenue, COGS by category
        (Mattress/Sofa · Bedframe · Accessories) and salesperson sales, then matched to a project.
        Pick the project and apply — a category that already has a line is skipped, never doubled.
      </p>

      <label style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "10px 14px", border: "1px solid var(--border, #ccc)", borderRadius: 8, cursor: "pointer", background: "var(--bg-subtle, #f7f7f7)" }}>
        <input type="file" accept=".xlsx,.xls" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{busy ? "Reading…" : "Choose fair report (.xlsx)"}</span>
      </label>
      {fileName && <span style={{ marginLeft: 12, fontSize: 12, color: "var(--fg-muted,#666)" }}>{fileName}</span>}
      {error && <p style={{ color: "var(--c-error, #c00)", fontSize: 13, marginTop: 10 }}>{error}</p>}

      {rows.length > 0 && (
        <p style={{ fontSize: 13, margin: "16px 0 8px" }}>
          <strong>{rows.length}</strong> events read · <strong>{matched}</strong> matched a project
          {" "}(from {projectCount} live projects). Unmatched events need the project created/renamed first.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {rows.map((r, i) => {
          const ev = r.event;
          const res = results[i];
          return (
            <div key={i} style={{ border: "1px solid var(--border, #ddd)", borderRadius: 10, padding: 14, opacity: r.candidates.length ? 1 : 0.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{ev.brand} @ {ev.venue}</div>
                  <div style={{ fontSize: 12, color: "var(--fg-muted,#666)" }}>
                    {ev.orders} orders{ev.dateFirst ? ` · ${ev.dateFirst}–${ev.dateLast}` : ""}
                  </div>
                </div>
                <div style={{ textAlign: "right", fontSize: 12 }}>
                  <div><strong>{rm(ev.sales)}</strong> sales</div>
                  <div style={{ color: "var(--fg-muted,#666)" }}>
                    COGS {rm(ev.cogsMattSofa + ev.cogsBedframe + ev.cogsAccessories)}
                  </div>
                </div>
              </div>

              {/* Finance lines + salespeople */}
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 8, fontSize: 12 }}>
                <div>
                  {r.financeLines.map((l) => (
                    <div key={l.category} style={{ color: l.kind === "income" ? "var(--c-success,#137)" : "var(--fg,#333)" }}>
                      {CAT_LABEL[l.category] ?? l.category}: {rm(l.amount)}
                    </div>
                  ))}
                </div>
                {ev.salespeople.length > 0 && (
                  <div style={{ color: "var(--fg-muted,#666)" }}>
                    {ev.salespeople.slice(0, 6).map((s) => <div key={s.name}>{s.name}: {rm(s.sales)}</div>)}
                  </div>
                )}
              </div>

              {/* Match + apply */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                {r.candidates.length ? (
                  <>
                    <select value={picked[i] ?? ""} onChange={(e) => setPicked((s) => ({ ...s, [i]: Number(e.target.value) }))}
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border,#ccc)", fontSize: 13 }}>
                      {r.candidates.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name} ({c.startDate})</option>)}
                    </select>
                    <button onClick={() => apply(i)} disabled={applying[i] || !!res}
                      style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: res ? "#9aa" : "var(--c-primary,#146c43)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: res ? "default" : "pointer" }}>
                      {applying[i] ? "Applying…" : res ? "Applied" : "Apply to project"}
                    </button>
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--fg-muted,#999)" }}>No matching project (same brand + venue) — create it first.</span>
                )}
                {res && (
                  <span style={{ fontSize: 12 }}>
                    <span style={{ color: "var(--c-success,#137)" }}>{res.created} added</span>
                    {res.skipped.length > 0 && <span style={{ color: "var(--fg-muted,#666)" }}> · {res.skipped.length} already there</span>}
                    {res.errors.length > 0 && <span style={{ color: "var(--c-error,#c00)" }}> · {res.errors.length} error</span>}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default FairReportFill;
