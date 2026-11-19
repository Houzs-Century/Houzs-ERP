/* Overtime on the phone (HC-0125). A worker reports overtime as one or more
 * windows on a day ("20:30-21:30 rushed an order"); a supervisor with
 * hr.ot.confirm sees the pending ones and confirms or rejects. Confirmed
 * overtime is what payroll pays - a punch past the shift end no longer does. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatDate } from "../lib/utils";
import { minToHhmm } from "../vendor/shared/hr-pay-rules";
import "./mobile.css";

type OtStatus = "PENDING" | "CONFIRMED" | "REJECTED";
type OtClaim = { id: number; workDate: string; startMin: number; endMin: number; note: string; status: OtStatus; rejectReason: string | null };
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

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function OvertimeBody() {
  const qc = useQueryClient();
  const q = useQuery<OtData>({ queryKey: ["attendance", "ot"], queryFn: () => api.get<OtData>("/api/attendance/ot"), refetchInterval: 60_000 });
  const [workDate, setWorkDate] = useState(localToday());
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
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>Add each block you worked extra - before, after or outside your shift. Your supervisor confirms it.</div>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <label style={{ fontSize: 11.5, color: "var(--mut)" }}>
            Day
            <input type="date" value={workDate} max={localToday()} onChange={(e) => setWorkDate(e.target.value)} style={{ ...input, marginTop: 3 }} />
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
            <span>{formatDate(c.workDate)} · {windowLabel(c)}</span>
            <span>{hoursLabel(c)}</span>
          </div>
          {c.note && <div style={{ color: "var(--mut)", marginTop: 2 }}>{c.note}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
            <span style={{ color: STATUS_TONE[c.status], fontWeight: 600 }}>
              {STATUS_TEXT[c.status]}{c.status === "REJECTED" && c.rejectReason ? `: ${c.rejectReason}` : ""}
            </span>
            {c.status === "PENDING" && (
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
              <div style={{ color: "var(--mut)", marginTop: 2 }}>{formatDate(c.workDate)} · {windowLabel(c)}{c.note ? ` · ${c.note}` : ""}</div>
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
