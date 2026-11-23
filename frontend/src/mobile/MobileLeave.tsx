/* Leave on the phone (HC-0125). A worker applies for leave (annual / medical /
 * unpaid) over a date range; a supervisor with hr.leave.approve approves, and
 * the approved days show as leave on the attendance (payroll already prices
 * them). Mirrors the Overtime tab: apply form, my requests, and a To approve
 * list for supervisors. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatDate } from "../lib/utils";
import { todayMyt } from "../vendor/scm/lib/dates";
import { DateField } from "../vendor/scm/components/DateField";
import "./mobile.css";

type LeaveType = { value: string; label: string; paid: boolean };
type LrStatus = "PENDING" | "APPROVED" | "REJECTED";
type LrItem = { id: number; leaveStatus: string; startDate: string; endDate: string; reason: string; status: LrStatus; rejectReason: string | null };
type LrPending = LrItem & { employeeName: string; empNo: string };
type LrData = { types: LeaveType[]; canApprove: boolean; mine: LrItem[]; pending: LrPending[] };

const rangeLabel = (c: { startDate: string; endDate: string }) => (c.startDate === c.endDate ? formatDate(c.startDate) : `${formatDate(c.startDate)} - ${formatDate(c.endDate)}`);
const STATUS_TONE: Record<LrStatus, string> = { PENDING: "var(--warn, #9a6b00)", APPROVED: "var(--green)", REJECTED: "var(--red)" };
const STATUS_TEXT: Record<LrStatus, string> = { PENDING: "Waiting for your supervisor", APPROVED: "Approved", REJECTED: "Rejected" };

export function LeaveBody() {
  const qc = useQueryClient();
  const q = useQuery<LrData>({ queryKey: ["attendance", "leave"], queryFn: () => api.get<LrData>("/api/attendance/leave"), refetchInterval: 60_000 });
  const [leaveType, setLeaveType] = useState("ANNUAL_LEAVE");
  const [start, setStart] = useState(todayMyt());
  const [end, setEnd] = useState(todayMyt());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => void qc.invalidateQueries({ queryKey: ["attendance", "leave"] });
  const input: React.CSSProperties = { width: "100%", minHeight: 38, padding: "6px 10px", fontSize: 14, borderRadius: 8, border: "1px solid var(--border, #d0d0d0)", background: "var(--app-bg)", color: "var(--ink)" };

  async function add() {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/api/attendance/leave", { leaveType, startDate: start, endDate: end, reason });
      setReason("");
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not send the leave request. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: number) {
    setErr(null);
    try {
      await api.del(`/api/attendance/leave/${id}`);
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not delete that request. Please try again.");
    }
  }
  async function review(id: number, decision: "approve" | "reject") {
    setErr(null);
    try {
      await api.post(`/api/attendance/leave/${id}/review`, { decision, reason: "" });
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not update that request. Please try again.");
    }
  }

  const data = q.data;
  const types = data?.types ?? [];
  const typeLabel = (v: string) => types.find((t) => t.value === v)?.label ?? v;
  const canSave = !busy && !!start && !!end && end >= start;

  return (
    <>
      {q.isLoading && <div style={{ color: "var(--mut)", fontSize: 13 }}>Loading...</div>}
      {q.isError && <div className="card" style={{ padding: 14, color: "var(--red)", fontSize: 13 }}>Could not load leave. Reopen to retry.</div>}
      {err && <div className="card" style={{ padding: 12, color: "var(--red)", fontSize: 13 }}>{err}</div>}

      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>Apply for leave</div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>Pick the kind of leave and the days. Your supervisor approves it.</div>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <label style={{ fontSize: 11.5, color: "var(--mut)" }}>
            Kind
            <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)} style={{ ...input, marginTop: 3 }}>
              {(types.length ? types : [{ value: "ANNUAL_LEAVE", label: "Annual leave", paid: true }]).map((t) => (
                <option key={t.value} value={t.value}>{t.label}{t.paid ? "" : " (unpaid)"}</option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1, fontSize: 11.5, color: "var(--mut)" }}>
              First day
              <div style={{ marginTop: 3 }}>
                <DateField value={start} onChange={(iso) => { setStart(iso); if (end < iso) setEnd(iso); }} fullWidth aria-label="First day of leave" />
              </div>
            </label>
            <label style={{ flex: 1, fontSize: 11.5, color: "var(--mut)" }}>
              Last day
              <div style={{ marginTop: 3 }}>
                <DateField value={end} min={start} onChange={(iso) => setEnd(iso)} fullWidth aria-label="Last day of leave" />
              </div>
            </label>
          </div>
          <label style={{ fontSize: 11.5, color: "var(--mut)" }}>
            Reason
            <input type="text" value={reason} maxLength={200} placeholder="e.g. family matter" onChange={(e) => setReason(e.target.value)} style={{ ...input, marginTop: 3 }} />
          </label>
          <button type="button" className="btn" disabled={!canSave} onClick={() => void add()} style={{ minHeight: 44, fontSize: 14 }}>
            {busy ? "Sending..." : "Send leave request"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 18, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--mut)", textTransform: "uppercase" }}>My leave</div>
      {data && data.mine.length === 0 && <div style={{ fontSize: 12.5, color: "var(--mut)", marginTop: 6 }}>None applied yet.</div>}
      {(data?.mine ?? []).map((c) => (
        <div key={c.id} className="card" style={{ padding: "10px 12px", marginTop: 8, fontSize: 12.5 }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink)", fontWeight: 600 }}>
            <span>{typeLabel(c.leaveStatus)}</span>
            <span>{rangeLabel(c)}</span>
          </div>
          {c.reason && <div style={{ color: "var(--mut)", marginTop: 2 }}>{c.reason}</div>}
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

      {data?.canApprove && (
        <>
          <div style={{ marginTop: 22, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--mut)", textTransform: "uppercase" }}>To approve</div>
          {data.pending.length === 0 && <div style={{ fontSize: 12.5, color: "var(--mut)", marginTop: 6 }}>Nothing waiting.</div>}
          {data.pending.map((c) => (
            <div key={c.id} className="card" style={{ padding: "10px 12px", marginTop: 8, fontSize: 12.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink)", fontWeight: 600 }}>
                <span>{c.empNo} · {c.employeeName}</span>
                <span>{rangeLabel(c)}</span>
              </div>
              <div style={{ color: "var(--mut)", marginTop: 2 }}>{typeLabel(c.leaveStatus)}{c.reason ? ` · ${c.reason}` : ""}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="btn" onClick={() => void review(c.id, "approve")} style={{ flex: 1, minHeight: 36, fontSize: 13 }}>
                  Approve
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
