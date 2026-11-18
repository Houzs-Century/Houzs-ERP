// The phone's view of the three-layer Financial Snapshot (owner 2026-11-18):
// every line with its figure and its tag — "Forecast" (typed, or the last same event's result), none for
// an actual — and the totals, which say when they include an estimate. A line
// is tapped to set or clear its Forecast (canWrite only). Same figures, tags
// and save as the desktop table (pages/projects/forecastLayers.ts).
import { useState } from "react";
import { formatCurrency } from "../lib/utils";
import { SourceTag } from "../pages/projects/EventPnlTable";
import {
  ESTIMATE_NOTE, FORECAST_LINE_LABELS, FORECAST_LINES, parseForecastInput, saveForecast,
  type DetailForecast, type ForecastLine, type LayeredTotal,
} from "../pages/projects/forecastLayers";

/* The totals sit where the desktop table has them: COGS Total and Gross Profit
   before Rental, Total Cost and Net Profit at the end. */
const MID_TOTALS: Array<[keyof DetailForecast["totals"], string]> = [["cogs_total", "COGS Total"], ["gross_profit", "Gross Profit"]];
const END_TOTALS: Array<[keyof DetailForecast["totals"], string]> = [["total_cost", "Total Cost"], ["net_profit", "Net Profit"]];

export function MobileForecastLines({ projectId, layers, canWrite, reload }: {
  projectId: number;
  layers: DetailForecast;
  canWrite: boolean;
  reload: () => void;
}) {
  const [editing, setEditing] = useState<ForecastLine | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(line: ForecastLine, amount: number | null) {
    setBusy(true);
    setError(null);
    try {
      await saveForecast(projectId, line, amount);
      setEditing(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The forecast was not saved.");
    } finally {
      setBusy(false);
    }
  }
  const totalRow = (key: keyof DetailForecast["totals"], label: string, t: LayeredTotal) => (
    <div key={key} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "8px 12px", borderTop: "1px solid #eceee9", background: "var(--hz-c-surface-2)" }}>
      <span style={{ flex: 1, fontSize: 12, fontWeight: 700, color: "var(--hz-c-ink)" }}>
        {label}
        {t.estimated && <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 600, color: "var(--hz-c-ink-soft)" }}>{ESTIMATE_NOTE}</span>}
      </span>
      <span className="money" style={{ fontSize: 12, fontWeight: 800, color: key === "gross_profit" || key === "net_profit" ? (t.amount >= 0 ? "#2f8a5b" : "#b23a3a") : "var(--hz-c-ink)" }}>{formatCurrency(t.amount)}</span>
    </div>
  );

  return (
    <div style={{ border: "1px solid var(--hz-dk-border-subtle, #eceee9)", borderRadius: 10, overflow: "hidden" }} data-testid="mobile-forecast-lines">
      {FORECAST_LINES.map((k, i) => {
        const l = layers.lines[k];
        const open = editing === k;
        return (
          <div key={k}>
            {k === "rental" && MID_TOTALS.map(([tk, label]) => totalRow(tk, label, layers.totals[tk]))}
            <button
              type="button"
              disabled={!canWrite || busy}
              onClick={() => { setEditing(open ? null : k); setDraft(l.forecast != null ? String(l.forecast) : ""); setError(null); }}
              style={{ display: "flex", width: "100%", alignItems: "baseline", gap: 8, padding: "8px 12px", borderTop: i === 0 ? "none" : "1px solid #eceee9", background: "transparent", textAlign: "left", cursor: canWrite ? "pointer" : "default" }}
              aria-label={`${FORECAST_LINE_LABELS[k]} ${formatCurrency(l.amount)}`}
            >
              <span style={{ flex: 1, fontSize: 12, color: "var(--hz-c-ink-secondary)" }}>{FORECAST_LINE_LABELS[k]}</span>
              <span className="money" style={{ fontSize: 12, fontWeight: 700 }}>{formatCurrency(l.amount)}</span>
              <SourceTag source={l.source} />
            </button>
            {open && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "0 12px 10px" }}>
                <input
                  type="text" inputMode="decimal" autoFocus value={draft} disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Forecast (RM)" aria-label="Forecast amount"
                  style={{ flex: 1, minWidth: 110, padding: "6px 8px", borderRadius: 8, border: "1px solid #ccc", fontSize: 13 }}
                />
                <button type="button" className="tinybtn" disabled={busy} onClick={() => {
                  const p = parseForecastInput(draft);
                  if (!p.ok) { setError(p.error); return; }
                  void run(k, p.amount);
                }}>Save</button>
                {l.forecast != null && <button type="button" className="tinybtn" disabled={busy} onClick={() => void run(k, null)}>Clear</button>}
                {error && <div role="alert" style={{ width: "100%", fontSize: 11, color: "#b23a3a" }}>{error}</div>}
              </div>
            )}
          </div>
        );
      })}
      {END_TOTALS.map(([tk, label]) => totalRow(tk, label, layers.totals[tk]))}
    </div>
  );
}
