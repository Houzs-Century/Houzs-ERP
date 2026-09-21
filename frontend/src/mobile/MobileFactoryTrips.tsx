// 返厂 (owner 2026-09-21) — the mobile presentation of the supplier-return list.
// Every trip to the supplier is a row (added freely, no limit); the latest is
// the current trip and its dates mirror to the case's supplier_pickup_at /
// items_ready_at (server side). Same logic as desktop via
// vendor/scm/lib/assr/returns.ts. Self-contained (own writes via runWrite) so it
// lives outside MobileServiceCase.tsx, which is at its size ceiling.
import { useState } from "react";
import { api } from "../api/client";
import { DateField } from "../vendor/scm/components/DateField";
import {
  type SupplierReturn,
  roundLabel,
  roundCount,
  currentRound,
  QC_RESULTS,
} from "../vendor/scm/lib/assr/returns";

const INK = "#11140f";
const MUTED = "#767b6e";
const LINE = "#d6d9d2";
const BLUE = "#1F3A8A";

const lbl: React.CSSProperties = { fontSize: 11, color: MUTED, display: "block", margin: "6px 0 2px" };
const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "8px 10px", border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 13 };

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
}) {
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState("");
  const rows = (returns ?? []).filter((r) => !r.archived_at).sort((a, b) => a.round_no - b.round_no);
  const count = roundCount(returns ?? []);
  const cur = currentRound(returns ?? []);
  const firstTrip = count === 0;

  const patch = (roundId: number, body: Record<string, string | null>) =>
    runWrite(async () => { await api.patch(`/api/assr/${caseId}/supplier-returns/${roundId}`, body); }, "Couldn't save the trip");
  const archive = (roundId: number) =>
    runWrite(async () => { await api.del(`/api/assr/${caseId}/supplier-returns/${roundId}`); }, "Couldn't remove the trip");
  const add = () => {
    const why = reason.trim() || null;
    setReason(""); setAdding(false);
    void runWrite(async () => { await api.post(`/api/assr/${caseId}/supplier-returns`, { reason: why }); }, "Couldn't add supplier return");
  };

  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${LINE}`, paddingTop: 8 }}>
      <div className="fld-l">Supplier Returns{count > 0 ? ` · ${count === 1 ? "1 trip" : `${count} trips`}` : ""}</div>
      {rows.map((r) => (
        <div key={r.id} style={{ border: `1px solid ${cur && cur.id === r.id ? BLUE : LINE}`, borderRadius: 8, padding: "8px 10px", marginTop: 6 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>
              {roundLabel(r.round_no)}{cur && cur.id === r.id ? " · Current" : ""}
            </span>
            {!disabled ? <button className="tinybtn" disabled={busy} onClick={() => archive(r.id)}>Remove</button> : null}
          </div>
          <label style={lbl}>Sent to Supplier</label>
          <DateField value={r.pickup_at ?? ""} onChange={(iso) => patch(r.id, { pickup_at: iso || null })} disabled={disabled || busy} fullWidth />
          <label style={lbl}>Back from Supplier</label>
          <DateField value={r.returned_at ?? ""} onChange={(iso) => patch(r.id, { returned_at: iso || null })} disabled={disabled || busy} fullWidth />
          <label style={lbl}>QC Result</label>
          <select style={inp} value={r.qc_result ?? ""} disabled={disabled || busy} onChange={(e) => patch(r.id, { qc_result: e.target.value || null })}>
            <option value="">—</option>
            {QC_RESULTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <label style={lbl}>Supplier</label>
          <input style={inp} defaultValue={r.creditor_code ?? ""} disabled={disabled || busy} key={`cr:${r.creditor_code ?? ""}`} onBlur={(e) => patch(r.id, { creditor_code: e.target.value.trim() || null })} />
          <label style={lbl}>{r.round_no > 1 ? "Why Sent Back Again" : "Reason"}</label>
          <input style={inp} defaultValue={r.reason ?? ""} disabled={disabled || busy} key={`rs:${r.reason ?? ""}`} onBlur={(e) => patch(r.id, { reason: e.target.value.trim() || null })} />
        </div>
      ))}
      {!disabled ? (
        adding && !firstTrip ? (
          <div style={{ marginTop: 8 }}>
            <input style={inp} value={reason} autoFocus placeholder="Why sent back again (QC failed / broke again…)" onChange={(e) => setReason(e.target.value)} />
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button className="tinybtn" disabled={busy} onClick={add}>Add Return</button>
              <button className="tinybtn" onClick={() => { setAdding(false); setReason(""); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="tinybtn" style={{ marginTop: 8 }} disabled={busy} onClick={() => (firstTrip ? add() : setAdding(true))}>
            + Add Supplier Return
          </button>
        )
      ) : null}
    </div>
  );
}
