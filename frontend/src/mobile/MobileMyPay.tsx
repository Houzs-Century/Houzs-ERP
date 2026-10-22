/* My pay (HC-0125 phase 4), from Hookka's worker pay screen: this month so
 * far (the same sums payroll will use, nothing stored) and the payslips HR
 * has approved, each savable as the PDF. A draft month is not shown: its
 * figures can still change. Hookka's estimate stopped at gross; this one
 * carries statutory and net, and says when tax is not worked out. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatDate } from "../lib/utils";
import { fmtSen } from "../vendor/shared/format";
import { generatePayslipPdf } from "../pages/hr/payslipPdf";
import type { Payslip } from "../pages/hr/hrApi";

type Pay =
  | { linked: false }
  | {
      linked: true;
      employee: { empNo: string; name: string };
      period: string;
      estimate: {
        fullSalarySen: number;
        daysWorked: number;
        absentDays: number;
        absentDates: string[];
        absenceDeductionSen: number;
        shortHours: number;
        shortHourDeductionSen: number;
        otPaySen: number;
        otDays: { date: string; hours: number; kind: string }[];
        grossSen: number;
        statutoryEmployeeSen: number;
        pcbKnown: boolean;
        advanceSen: number;
        penaltySen: number;
        netSen: number;
      } | null;
      payslips: { period: string; status: string; grossSen: number; netSen: number }[];
    };

const monthName = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-MY", { month: "long", year: "numeric", timeZone: "UTC" });
};

function Row({ label, value, tone }: { label: string; value: string; tone?: "neg" | "bold" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 13, fontWeight: tone === "bold" ? 700 : 400, color: tone === "neg" ? "var(--red)" : "var(--ink)" }}>
      <span style={{ color: tone === "bold" ? "var(--ink)" : "var(--mut)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function MyPayBody() {
  const q = useQuery<Pay>({ queryKey: ["attendance", "me", "pay"], queryFn: () => api.get<Pay>("/api/attendance/me/pay") });
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const d = q.data;

  const save = async (period: string) => {
    setSaving(period);
    setErr(null);
    try {
      const r = await api.get<{ slip: Payslip }>(`/api/attendance/me/payslip/${period}`);
      await generatePayslipPdf([r.slip], { action: "save" });
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "Could not open the payslip.");
    } finally {
      setSaving(null);
    }
  };

  if (q.isLoading) return <div style={{ color: "var(--mut)", fontSize: 13 }}>Loading...</div>;
  if (q.isError || !d) return <div className="card" style={{ padding: 14, color: "var(--red)", fontSize: 13 }}>Could not load your pay. Reopen to retry.</div>;
  if (!d.linked) return <div className="card" style={{ padding: 16, fontSize: 13 }}>Your account is not linked to an employee yet. Ask HR to link it.</div>;
  const e = d.estimate;
  return (
    <>
      {e && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: "var(--mut)" }}>{monthName(d.period)} so far · estimate</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--ink)", margin: "4px 0 10px" }}>{fmtSen(e.netSen)}</div>
          {e.fullSalarySen > 0 && <Row label="Basic salary" value={fmtSen(e.fullSalarySen)} />}
          {e.absenceDeductionSen > 0 && <Row label={`Absent ${e.absentDays} day(s)`} value={`-${fmtSen(e.absenceDeductionSen)}`} tone="neg" />}
          {e.shortHourDeductionSen > 0 && <Row label={`Late / short ${e.shortHours} h`} value={`-${fmtSen(e.shortHourDeductionSen)}`} tone="neg" />}
          {e.otPaySen > 0 && <Row label={`Overtime (${e.otDays.length} day(s))`} value={fmtSen(e.otPaySen)} />}
          <Row label="Gross" value={fmtSen(e.grossSen)} tone="bold" />
          <Row label="EPF / SOCSO / EIS / tax" value={`-${fmtSen(e.statutoryEmployeeSen)}`} />
          {e.advanceSen > 0 && <Row label="Advance" value={`-${fmtSen(e.advanceSen)}`} />}
          {e.penaltySen > 0 && <Row label="Penalty" value={`-${fmtSen(e.penaltySen)}`} />}
          <Row label="Net so far" value={fmtSen(e.netSen)} tone="bold" />
          {e.absentDates.length > 0 && <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 6 }}>Absent: {e.absentDates.map(formatDate).join(", ")}</div>}
          {!e.pcbKnown && <div style={{ fontSize: 11.5, color: "var(--warn, #9a6b00)", marginTop: 6 }}>Income tax is not worked out yet; HR is completing your tax details.</div>}
          <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 8 }}>Changes until HR approves the month. A missed day counts as absent only after two working days.</div>
        </div>
      )}
      <div style={{ marginTop: 18, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--mut)", textTransform: "uppercase" }}>Payslips</div>
      {err && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>{err}</div>}
      {d.payslips.length === 0 && <div style={{ fontSize: 12.5, color: "var(--mut)", marginTop: 6 }}>No approved payslip yet.</div>}
      {d.payslips.map((p) => (
        <div key={p.period} className="card" style={{ padding: "10px 12px", marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{monthName(p.period)}</div>
            <div style={{ fontSize: 12, color: "var(--mut)" }}>
              Net {fmtSen(p.netSen)} · {p.status === "PAID" ? "paid" : "approved"}
            </div>
          </div>
          <button type="button" className="btn-ghost" style={{ width: "auto", flex: "none", padding: "0 16px" }} disabled={saving === p.period} onClick={() => void save(p.period)}>
            {saving === p.period ? "Opening..." : "PDF"}
          </button>
        </div>
      ))}
    </>
  );
}
