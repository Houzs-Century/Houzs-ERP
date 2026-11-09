// 返厂 (owner 2026-09-21) — the mobile presentation of the supplier-return list.
// Every trip to the supplier is a row (added freely, no limit); the latest is
// the current trip and its dates mirror to the case's supplier_pickup_at /
// items_ready_at (server side). Same logic as desktop via
// vendor/scm/lib/assr/returns.ts. Trips are tabs (Operation Dept 2026-11-09):
// the current one opens, older ones stay one tap away. Self-contained (own
// writes via runWrite) so it lives outside MobileServiceCase.tsx, which is at
// its size ceiling.
import { useState, type CSSProperties, type ReactElement } from "react";
import { api } from "../api/client";
import { DateField } from "../vendor/scm/components/DateField";
import {
  type SupplierReturn,
  roundLabel,
  roundCount,
  currentRound,
  shownRound,
  tripTabLabel,
  QC_RESULTS,
  returnNotePath,
} from "../vendor/scm/lib/assr/returns";

const INK = "#11140f";
const MUTED = "#767b6e";
const LINE = "#d6d9d2";
const BLUE = "#1F3A8A";
const SECTION_BG = "#e8efe9";
const SECTION_INK = "#1d5a3a";

const lbl: CSSProperties = { fontSize: 11, color: MUTED, display: "block", margin: "8px 0 3px" };
const inp: CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px", border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 16, fontFamily: "inherit" };
const pair: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 };
const tab = (active: boolean): CSSProperties => ({
  minHeight: 40, padding: "6px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 700, fontFamily: "inherit",
  border: `1px solid ${active ? BLUE : LINE}`, background: active ? "#eef1fb" : "#fff", color: active ? BLUE : INK,
});

export function MobileSectionHead({ title, badge }: { title: string; badge: string | null }): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: SECTION_BG, color: SECTION_INK, borderRadius: 8, padding: "8px 10px", margin: "14px 0 8px", fontSize: 11.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase" }}>
      <span>{title}</span>
      {badge ? <span style={{ background: "#fff", borderRadius: 999, padding: "2px 8px", fontSize: 10.5, textTransform: "none" }}>{badge}</span> : null}
    </div>
  );
}

export function MobileFactoryTrips({
  returns,
  caseId,
  busy,
  disabled,
  runWrite,
}: {
  returns: SupplierReturn[];
  caseId: number;
  busy: boolean;
  disabled: boolean;
  runWrite: (fn: () => Promise<void>, failTitle: string) => void | Promise<void>;
}): ReactElement {
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState("");
  const [pickedTripId, setPickedTripId] = useState<number | null>(null);
  const rows = returns.filter((r) => !r.archived_at).sort((a, b) => a.round_no - b.round_no);
  const count = roundCount(returns);
  const cur = currentRound(returns);
  const shown = shownRound(rows, pickedTripId);
  const firstTrip = count === 0;
  const off = disabled || busy;

  const patch = (roundId: number, body: Record<string, string | null>) =>
    runWrite(async () => { await api.patch(`/api/assr/${caseId}/supplier-returns/${roundId}`, body); }, "Couldn't save the trip");
  const archive = (roundId: number) => {
    setPickedTripId(null);
    void runWrite(async () => { await api.del(`/api/assr/${caseId}/supplier-returns/${roundId}`); }, "Couldn't remove the trip");
  };
  const add = () => {
    const why = reason.trim() || null;
    setReason(""); setAdding(false); setPickedTripId(null);
    void runWrite(async () => { await api.post(`/api/assr/${caseId}/supplier-returns`, { reason: why }); }, "Couldn't add supplier return");
  };
  const dateInput = (r: SupplierReturn, field: "pickup_at" | "expected_return_at" | "returned_at", label: string) => (
    <div>
      <label style={lbl}>{label}</label>
      <DateField value={r[field] ?? ""} onChange={(iso) => patch(r.id, { [field]: iso || null })} disabled={off} fullWidth aria-label={label} />
    </div>
  );

  return (
    <div>
      <MobileSectionHead title="3. Supplier Service / Return" badge={count > 1 ? `${count} trips` : null} />
      {firstTrip ? <div style={{ fontSize: 12, color: MUTED }}>No supplier return recorded yet.</div> : null}
      {count > 1 ? (
        <div role="tablist" aria-label="Supplier return trips" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
          {rows.map((r) => (
            <button key={r.id} type="button" role="tab" aria-selected={shown?.id === r.id} style={tab(shown?.id === r.id)} onClick={() => setPickedTripId(r.id)}>
              {tripTabLabel(r.round_no)}{cur?.id === r.id ? " · Current" : ""}
            </button>
          ))}
        </div>
      ) : null}
      {shown ? (
        <div key={shown.id}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>
              {roundLabel(shown.round_no)}{cur?.id === shown.id ? " · Current" : ""}
              {shown.ref_no ? <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: MUTED, fontFamily: "monospace" }}>{shown.ref_no}</span> : null}
            </span>
            <span style={{ display: "flex", gap: 6 }}>
              <button className="tinybtn" onClick={() => void runWrite(async () => { await api.openHtml(returnNotePath(caseId, shown.id)); }, "Couldn't open the return note")}>Print</button>
              {!disabled ? <button className="tinybtn" disabled={busy} onClick={() => archive(shown.id)}>Remove</button> : null}
            </span>
          </div>
          <label style={lbl}>Supplier</label>
          <input style={inp} defaultValue={shown.creditor_code ?? ""} placeholder={shown.creditor_name ?? "Supplier code"} disabled={off} key={`cr:${shown.creditor_code ?? ""}`} onBlur={(e) => patch(shown.id, { creditor_code: e.target.value.trim() || null })} />
          <div style={pair}>
            {dateInput(shown, "pickup_at", "Sent to Supplier")}
            {dateInput(shown, "expected_return_at", "Back from Supplier (ETA)")}
          </div>
          <label style={lbl}>{shown.round_no > 1 ? "Why Sent Back Again" : "Reason for Return"}</label>
          <textarea style={inp} rows={2} defaultValue={shown.reason ?? ""} disabled={off} key={`rs:${shown.reason ?? ""}`} onBlur={(e) => patch(shown.id, { reason: e.target.value.trim() || null })} />
          <div style={pair}>
            <div>
              <label style={lbl}>QC Result</label>
              <select style={inp} value={shown.qc_result ?? ""} disabled={off} onChange={(e) => patch(shown.id, { qc_result: e.target.value || null })}>
                <option value="">Pending QC</option>
                {QC_RESULTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {dateInput(shown, "returned_at", "Actual Back Date")}
          </div>
          <label style={lbl}>Remarks</label>
          <textarea style={inp} rows={2} defaultValue={shown.note ?? ""} placeholder="Additional notes…" disabled={off} key={`nt:${shown.note ?? ""}`} onBlur={(e) => patch(shown.id, { note: e.target.value.trim() || null })} />
        </div>
      ) : null}
      {!disabled ? (
        adding && !firstTrip ? (
          <div style={{ marginTop: 10 }}>
            <input style={inp} value={reason} autoFocus placeholder="Why sent back again (QC failed / broke again…)" onChange={(e) => setReason(e.target.value)} />
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button className="tinybtn" disabled={busy} onClick={add}>Add Return</button>
              <button className="tinybtn" onClick={() => { setAdding(false); setReason(""); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="tinybtn" style={{ marginTop: 10 }} disabled={busy} onClick={() => (firstTrip ? add() : setAdding(true))}>
            {firstTrip ? "+ Add Supplier Return" : "+ Send Back Again (New Trip)"}
          </button>
        )
      ) : null}
    </div>
  );
}
