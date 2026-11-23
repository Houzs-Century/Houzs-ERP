/* Make-up punch (补卡) on the phone (HC-0125). A worker who forgot to clock in
 * or out files the day and the in / out time they actually worked, plus a
 * reason; a supervisor with hr.punch.approve approves, and the approval writes
 * that day's attendance. Mirrors the Overtime tab: report form, my requests,
 * and a To approve list for supervisors. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatDate } from "../lib/utils";
import { minToHhmm } from "../vendor/shared/hr-pay-rules";
import { todayMyt } from "../vendor/scm/lib/dates";
import { DateField } from "../vendor/scm/components/DateField";
import "./mobile.css";

type PcStatus = "PENDING" | "APPROVED" | "REJECTED";
type PcItem = { id: number; workDate: string; reqInMin: number | null; reqOutMin: number | null; reason: string; status: PcStatus; rejectReason: string | null };
type PcPending = PcItem & { employeeName: string; empNo: string };
type PcData = { canApprove: boolean; mine: PcItem[]; pending: PcPending[] };

const timeLabel = (c: { reqInMin: number | null; reqOutMin: number | null }) => {
  const i = c.reqInMin == null ? "?" : minToHhmm(c.reqInMin);
  const o = c.reqOutMin == null ? "?" : `${minToHhmm(c.reqOutMin % 1440)}${c.reqOutMin >= 1440 ? " (+1)" : ""}`;
  return `${i} - ${o}`;
};
const STATUS_TONE: Record<PcStatus, string> = { PENDING: "var(--warn, #9a6b00)", APPROVED: "var(--green)", REJECTED: "var(--red)" };
const STATUS_TEXT: Record<PcStatus, string> = { PENDING: "Waiting for your supervisor", APPROVED: "Approved", REJECTED: "Rejected" };

export function PunchFixBody() {
  const qc = useQueryClient();
  const q = useQuery<PcData>({ queryKey: ["attendance", "punch-fix"], queryFn: () => api.get<PcData>("/api/attendance/punch-fix"), refetchInterval: 60_000 });
  const [workDate, setWorkDate] = useState(todayMyt());
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => void qc.invalidateQueries({ queryKey: ["attendance", "punch-fix"] });
  const input: React.CSSProperties = { width: "100%", minHeight: 38, padding: "6px 10px", fontSize: 14, borderRadius: 8, border: "1px solid var(--border, #d0d0d0)", background: "var(--app-bg)", color: "var(--ink)" };

  async function add() {
    setErr(null);
    setBusy(true);
    try {
      await api.post("/api/attendance/punch-fix", { workDate, clockIn: start, clockOut: end, reason });
      setStart("");
      setEnd("");
      setReason("");
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not send the make-up punch. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: number) {
    setErr(null);
    try {
      await api.del(`/api/attendance/punch-fix/${id}`);
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not delete that request. Please try again.");
    }
  }
  async function review(id: number, decision: "approve" | "reject") {
    setErr(null);
    try {
      await api.post(`/api/attendance/punch-fix/${id}/review`, { decision, reason: "" });
      reload();
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not update that request. Please try again.");
    }
  }

  const data = q.data;
  const canSave = !busy && /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && !!workDate;

  return (
    <>
      {q.isLoading && <div style={{ color: "var(--mut)", fontSize: 13 }}>Loading...</div>}
      {q.isError && <div className="card" style={{ padding: 14, color: "var(--red)", fontSize: 13 }}>Could not load make-up punches. Reopen to retry.</div>}
      {err && <div className="card" style={{ padding: 12, color: "var(--red)", fontSize: 13 }}>{err}</div>}

      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>Fix a missed punch</div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>Forgot to clock in or out? Pick the day and the times you actually worked. Your supervisor approves it, and the day is fixed.</div>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <label style={{ fontSize: 11.5, color: "var(--mut)" }}>
            Day
            <div style={{ marginTop: 3 }}>
              <DateField value={workDate} max={todayMyt()} onChange={(iso) => setWorkDate(iso)} fullWidth aria-label="Make-up punch day" />
            </div>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ flex: 1, fontSize: 11.5, color: "var(--mut)" }}>
              Clock in
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} style={{ ...input, marginTop: 3 }} />
            </label>
            <label style={{ flex: 1, fontSize: 11.5, color: "var(--mut)" }}>
              Clock out
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={{ ...input, marginTop: 3 }} />
            </label>
          </div>
          <label style={{ fontSize: 11.5, color: "var(--mut)" }}>
            Why?
            <input type="text" value={reason} maxLength={200} placeholder="e.g. phone was flat" onChange={(e) => setReason(e.target.value)} style={{ ...input, marginTop: 3 }} />
          </label>
          <button type="button" className="btn" disabled={!canSave} onClick={() => void add()} style={{ minHeight: 44, fontSize: 14 }}>
            {busy ? "Sending..." : "Send make-up punch"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 18, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--mut)", textTransform: "uppercase" }}>My make-up punches</div>
      {data && data.mine.length === 0 && <div style={{ fontSize: 12.5, color: "var(--mut)", marginTop: 6 }}>None sent yet.</div>}
      {(data?.mine ?? []).map((c) => (
        <div key={c.id} className="card" style={{ padding: "10px 12px", marginTop: 8, fontSize: 12.5 }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink)", fontWeight: 600 }}>
            <span>{formatDate(c.workDate)}</span>
            <span>{timeLabel(c)}</span>
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
                <span>{timeLabel(c)}</span>
              </div>
              <div style={{ color: "var(--mut)", marginTop: 2 }}>{formatDate(c.workDate)}{c.reason ? ` · ${c.reason}` : ""}</div>
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
