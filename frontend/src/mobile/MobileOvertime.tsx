/* Overtime on the phone (HC-0125 hybrid, owner 2026-11-20). Overtime is counted
 * automatically from the day's punch (the time present past a full working day);
 * a worker can still add a window by hand for extra time the single punch cannot
 * show - a split shift, or work before/after being clocked in. Either way a
 * supervisor with hr.ot.confirm confirms it, and only confirmed overtime pays. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatDate } from "../lib/utils";
import { minToHhmm } from "../vendor/shared/hr-pay-rules";
import { todayMyt } from "../vendor/scm/lib/dates";
import { DateField } from "../vendor/scm/components/DateField";
import "./mobile.css";

type OtStatus = "PENDING" | "CONFIRMED" | "REJECTED";
type OtSource = "REPORTED" | "AUTO";
type OtClaim = { id: number; workDate: string; startMin: number; endMin: number; note: string; status: OtStatus; source?: OtSource; rejectReason: string | null };
type PendingClaim = OtClaim & { employeeName: string; empNo: string };
type OtData = { canConfirm: boolean; mine: OtClaim[]; pending: PendingClaim[] };

const windowLabel = (c: { startMin: number; endMin: number }) =>
  `${minToHhmm(c.startMin)}-${minToHhmm(c.endMin % 1440)}${c.endMin >= 1440 ? " (+1)" : ""}`;
const hoursLabel = (c: { startMin: number; endMin: number }) => {
  const m = c.endMin - c.startMin;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
};
const STATUS_TONE: Record<OtStatus, string> = { PENDING: "var(--warn, #9a6b00)", CONFIRMED: "var(--green)", REJECTED: "var(--red)" };
const STATUS_TEXT: Record<OtStatus, string> = { PENDING: "Waiting for your supervisor", CONFIRMED: "Confirmed", REJECTED: "Rejected" };
const SourceTag = ({ source }: { source?: OtSource }) =>
  source === "AUTO" ? (
    <span style={{ fontSize: 10, fontWeight: 600, color: "var(--mut)", border: "1px solid var(--border, #d0d0d0)", borderRadius: 6, padding: "1px 5px" }}>From your punch</span>
  ) : null;

export function OvertimeBody() {
  const qc = useQueryClient();
  const q = useQuery<OtData>({ queryKey: ["attendance", "ot"], queryFn: () => api.get<OtData>("/api/attendance/ot"), refetchInterval: 60_000 });
  const [workDate, setWorkDate] = useState(todayMyt());
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => void qc.invalidateQueries({ queryKey: ["attendance", "ot"] });
  const input: React.CSSProperties = { width: "100%", minHeight: 38, padding: "6px 10px", fontSize: 14, borderRadius: 8, border: "1px solid var(--border, #d0d0d0)", background: "var(--app-bg)", color: "var(--ink)" };

  async function add() {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/api/attendance/ot", { workDate, startHHMM: start, endHHMM: end, note });
      setStart("");
      setEnd("");
      setNote("");
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not save the overtime. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: number) {
    setErr(null);
    try {
      await api.del(`/api/attendance/ot/${id}`);
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not delete that overtime. Please try again.");
    }
  }
  async function review(id: number, decision: "confirm" | "reject") {
    setErr(null);
    try {
      await api.post(`/api/attendance/ot/${id}/review`, { decision, reason: "" });
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not update that overtime. Please try again.");
    }
  }

  const data = q.data;
  const canSave = !busy && /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && !!workDate;

  return (
    <>
      {q.isLoading && <div style={{ color: "var(--mut)", fontSize: 13 }}>Loading...</div>}
      {q.isError && <div className="card" style={{ padding: 14, color: "var(--red)", fontSize: 13 }}>Could not load overtime. Reopen to retry.</div>}
      {err && <div className="card" style={{ padding: 12, color: "var(--red)", fontSize: 13 }}>{err}</div>}

      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>Report overtime</div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>Your overtime is counted from your punch each day. Only add a block here for extra time the punch cannot show - a split shift, or work before or after you clocked in. Your supervisor confirms it.</div>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <label style={{ fontSize: 11.5, color: "var(--mut)" }}>
            Day
            <div style={{ marginTop: 3 }}>
              <DateField value={workDate} max={todayMyt()} onChange={(iso) => setWorkDate(iso)} fullWidth aria-label="Overtime day" />
            </div>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1, fontSize: 11.5, color: "var(--mut)" }}>
              From
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} style={{ ...input, marginTop: 3 }} />
            </label>
            <label style={{ flex: 1, fontSize: 11.5, color: "var(--mut)" }}>
              To
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={{ ...input, marginTop: 3 }} />
            </label>
          </div>
          <label style={{ fontSize: 11.5, color: "var(--mut)" }}>
            What did you do?
            <input type="text" value={note} maxLength={200} placeholder="e.g. rushed an order" onChange={(e) => setNote(e.target.value)} style={{ ...input, marginTop: 3 }} />
          </label>
          <button type="button" className="btn" disabled={!canSave} onClick={() => void add()} style={{ minHeight: 44, fontSize: 14 }}>
            {busy ? "Saving..." : "Add overtime"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 18, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--mut)", textTransform: "uppercase" }}>My overtime</div>
      {data && data.mine.length === 0 && <div style={{ fontSize: 12.5, color: "var(--mut)", marginTop: 6 }}>None reported yet.</div>}
      {(data?.mine ?? []).map((c) => (
        <div key={c.id} className="card" style={{ padding: "10px 12px", marginTop: 8, fontSize: 12.5 }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink)", fontWeight: 600 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{formatDate(c.workDate)} · {windowLabel(c)} <SourceTag source={c.source} /></span>
            <span>{hoursLabel(c)}</span>
          </div>
          {c.note && <div style={{ color: "var(--mut)", marginTop: 2 }}>{c.note}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
            <span style={{ color: STATUS_TONE[c.status], fontWeight: 600 }}>
              {STATUS_TEXT[c.status]}{c.status === "REJECTED" && c.rejectReason ? `: ${c.rejectReason}` : ""}
            </span>
            {c.status === "PENDING" && c.source !== "AUTO" && (
              <button type="button" className="btn-ghost" onClick={() => void remove(c.id)} style={{ minHeight: 28, fontSize: 12, padding: "0 10px" }}>
                Delete
              </button>
            )}
          </div>
        </div>
      ))}

      {data?.canConfirm && (
        <>
          <div style={{ marginTop: 22, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--mut)", textTransform: "uppercase" }}>To confirm</div>
          {data.pending.length === 0 && <div style={{ fontSize: 12.5, color: "var(--mut)", marginTop: 6 }}>Nothing waiting.</div>}
          {data.pending.map((c) => (
            <div key={c.id} className="card" style={{ padding: "10px 12px", marginTop: 8, fontSize: 12.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink)", fontWeight: 600 }}>
                <span>{c.empNo} · {c.employeeName}</span>
                <span>{hoursLabel(c)}</span>
              </div>
              <div style={{ color: "var(--mut)", marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}><span>{formatDate(c.workDate)} · {windowLabel(c)}{c.note ? ` · ${c.note}` : ""}</span> <SourceTag source={c.source} /></div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="btn" onClick={() => void review(c.id, "confirm")} style={{ flex: 1, minHeight: 36, fontSize: 13 }}>
                  Confirm
                </button>
                <button type="button" className="btn-ghost" onClick={() => void review(c.id, "reject")} style={{ flex: 1, minHeight: 36, fontSize: 13 }}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
