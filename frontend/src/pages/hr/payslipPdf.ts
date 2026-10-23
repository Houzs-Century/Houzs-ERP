// ----------------------------------------------------------------------------
// payslipPdf — the payslip paper (HC-0125 phase 4), from Hookka's
// generate-payslip-pdf.ts, drawn with Century's own PDF helpers (letterhead,
// info columns, deliverPdf: print / save / preview, never window.print()).
// Earnings, deductions and net, with how each deduction was worked out.
// Two Hookka faults fixed on the way: the penalty deduction is printed, so
// net reconciles on the paper; the rule text comes from the slip's own
// figures, not a hard-coded "10-minute grace". A draft prints a diagonal
// ESTIMATE so it can never pass for a final slip. Phase 5 prints the trip
// month's commission (base x rate) and each trip allowance with its count,
// the monthly allowances, and backpay as a deduction.
// ----------------------------------------------------------------------------
import { DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, drawInfoColumns, ensurePdfCjkFont, fmtDocDate, fmtRm, safeName, type PdfAction } from "../../vendor/scm/lib/pdf-common";
import { pcbHasFigure } from "../../vendor/shared/hr-pcb";
import { tripMonthBounds } from "../../vendor/shared/hr-trip-pay";
import type { Payslip } from "./hrApi";

type JsPdf = import("jspdf").jsPDF;
type AutoTable = (doc: JsPdf, options: Record<string, unknown>) => void;

const monthLabel = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-MY", { month: "long", year: "numeric", timeZone: "UTC" });
};
const hrs = (h: number) => `${Math.round(h * 100) / 100} h`;

export async function renderPayslipInto(doc: JsPdf, autoTable: AutoTable, s: Payslip): Promise<void> {
  await ensurePdfCjkFont(doc, [s.employeeName]);
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = drawHeader(doc, {
    docTitle: "PAYSLIP",
    rightMeta: [
      { label: "Period", value: monthLabel(s.period) },
      { label: "Status", value: s.status === "DRAFT" || s.id == null ? "Estimate" : s.status === "PAID" ? "Paid" : "Approved" },
    ],
  });
  y = drawInfoColumns(
    doc,
    y,
    {
      title: "EMPLOYEE",
      rows: [
        ["Name", s.employeeName],
        ["Employee No", s.empNo],
        ["Department", s.departmentName],
        ["Pay basis", s.payMode === "DAILY" ? `Per day, ${fmtRm(s.dayRateSen)} a day` : `Monthly, ${fmtRm(s.fullSalarySen)}`],
      ],
    },
    {
      title: "PAYMENT",
      rows: [
        ["Method", s.paymentMethod === "CASH" ? "Cash" : "Bank transfer"],
        ["Bank", s.paymentMethod === "CASH" ? null : s.bankName],
        ["Account", s.paymentMethod === "CASH" ? null : s.bankAccount],
        ["Days worked", String(s.daysWorked)],
      ],
    },
  );

  const minus = (sen: number) => (sen > 0 ? `-${fmtRm(sen)}` : fmtRm(0));
  const earnings: string[][] = [];
  if (s.payMode === "MONTHLY") earnings.push(["Basic salary", fmtRm(s.fullSalarySen)]);
  else earnings.push([`${s.daysWorked} days x ${fmtRm(s.dayRateSen)}`, fmtRm(s.basicEarnedSen + s.shortHourDeductionSen)]);
  if (s.absenceDeductionSen > 0) earnings.push([`Less absence: ${s.absentDays} day(s) x ${fmtRm(s.dayRateSen)}`, minus(s.absenceDeductionSen)]);
  if (s.shortHourDeductionSen > 0) earnings.push([`Less late / short hours: ${hrs(s.shortHours)} x ${fmtRm(s.hourRateSen)}`, minus(s.shortHourDeductionSen)]);
  if (s.otWeekdayPaySen > 0) earnings.push([`Overtime, weekday: ${hrs(s.otWeekdayHours)}`, fmtRm(s.otWeekdayPaySen)]);
  if (s.otSundayPaySen > 0) earnings.push([`Overtime, Sunday: ${hrs(s.otSundayHours)}`, fmtRm(s.otSundayPaySen)]);
  if (s.otHolidayPaySen > 0) earnings.push([`Overtime, public holiday: ${hrs(s.otHolidayHours)}`, fmtRm(s.otHolidayPaySen)]);
  const trip = s.detail.trip;
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  if (trip) {
    for (const l of trip.commission.lines) earnings.push([`Commission: ${fmtRm(l.baseSen)} x ${pct(l.rateBps)}`, fmtRm(l.amountSen)]);
    for (const l of trip.lines) earnings.push([`${l.label} x ${l.count}`, fmtRm(l.amountSen)]);
  } else {
    if (s.commissionSen > 0) earnings.push(["Commission", fmtRm(s.commissionSen)]);
    if (s.tripAllowanceSen > 0) earnings.push(["Trip allowance", fmtRm(s.tripAllowanceSen)]);
  }
  const monthly = (s.detail.allowances ?? []).filter((a) => a.kind !== "BACKPAY");
  if (monthly.length) for (const a of monthly) earnings.push([a.note ? `${a.label} (${a.note})` : a.label, fmtRm(a.amountSen)]);
  else if (s.allowancesSen > 0) earnings.push(["Allowance", fmtRm(s.allowancesSen)]);

  const pcbFigure = pcbHasFigure(s.pcbStatus);
  const deductions: string[][] = [
    ["EPF (employee)", fmtRm(s.epfEmployeeSen)],
    ["SOCSO (employee)", fmtRm(s.socsoEmployeeSen)],
    ["EIS (employee)", fmtRm(s.eisEmployeeSen)],
    ["PCB (income tax)", s.pcbStatus === "DISABLED" ? "Not registered" : pcbFigure ? fmtRm(s.pcbSen) : "--"],
  ];
  if (s.advanceSen > 0) deductions.push([`Salary advance${s.detail.advanceDates.length ? ` (${s.detail.advanceDates.map(fmtDocDate).join(", ")})` : ""}`, fmtRm(s.advanceSen)]);
  if (s.backpaySen > 0) deductions.push(["Backpay (company advance)", fmtRm(s.backpaySen)]);
  if (s.penaltySen > 0) deductions.push(["Penalty", fmtRm(s.penaltySen)]);
  const totalDeductions = s.statutoryEmployeeSen + s.advanceSen + s.backpaySen + s.penaltySen;

  const half = (pageW - margin * 2 - 6) / 2;
  const table = (startX: number, title: string, body: string[][], total: [string, string]) => {
    autoTable(doc, {
      startY: y,
      head: [[title, "Amount"]],
      body,
      foot: [total],
      theme: "plain",
      styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
      headStyles: DOC_TABLE_HEAD_STYLES,
      footStyles: { fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: "auto" }, 1: { cellWidth: 30, halign: "right" } },
      margin: { left: startX, right: pageW - startX - half },
      tableWidth: half,
    });
    return (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
  };
  const leftEnd = table(margin, "EARNINGS", earnings, ["Gross pay", fmtRm(s.grossSen)]);
  const rightEnd = table(margin + half + 6, "DEDUCTIONS", deductions, ["Total deductions", fmtRm(totalDeductions)]);
  let ty = Math.max(leftEnd, rightEnd) + 8;

  doc.setFillColor(240, 240, 240);
  doc.rect(margin, ty - 5, pageW - margin * 2, 10, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("NET PAY", margin + 3, ty + 1.5);
  doc.text(fmtRm(s.netSen), pageW - margin - 3, ty + 1.5, { align: "right" });
  ty += 12;

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text("EMPLOYER CONTRIBUTIONS (not deducted from you)", margin, ty);
  doc.setFont("helvetica", "normal");
  doc.text(`EPF ${fmtRm(s.epfEmployerSen)}   SOCSO ${fmtRm(s.socsoEmployerSen)}   EIS ${fmtRm(s.eisEmployerSen)}`, margin, ty + 4);
  ty += 11;

  const notes: string[] = [];
  if (s.payMode === "MONTHLY") notes.push(`Day rate ${fmtRm(s.dayRateSen)} (salary / working days); hour rate ${fmtRm(s.hourRateSen)} (day rate / the working day including lunch).`);
  if (s.detail.absentDates.length) notes.push(`Absent: ${s.detail.absentDates.map(fmtDocDate).join(", ")}.`);
  if (s.detail.paidLeaveDates?.length) notes.push(`Paid leave: ${s.detail.paidLeaveDates.map(fmtDocDate).join(", ")}.`);
  if (trip) {
    const { first, last } = tripMonthBounds(s.period);
    const cut = trip.commission.cutBps > 0 ? ` Commission rate cut ${pct(trip.commission.cutBps)} for ${trip.commission.missedDays} day(s) with no punch and no leave.` : "";
    notes.push(`Trip pay counts the jobs from ${fmtDocDate(first)} to ${fmtDocDate(last)}.${cut}`);
  }
  if (s.detail.otDays.length) notes.push(`Overtime days: ${s.detail.otDays.map((d) => `${fmtDocDate(d.date)} ${d.hours} h${d.kind === "WEEKDAY" ? "" : d.kind === "SUNDAY" ? " (Sun)" : " (PH)"}`).join(", ")}.`);
  if (!pcbFigure && s.pcbStatus !== "DISABLED") notes.push(s.detail.pcbNote || "PCB not computed: net pay does not include any tax withholding.");
  if (notes.length) {
    doc.setFont("helvetica", "bold");
    doc.text("HOW THE FIGURES WERE WORKED OUT", margin, ty);
    doc.setFont("helvetica", "normal");
    doc.text(notes, margin, ty + 4, { maxWidth: pageW - margin * 2 });
  }

  if (s.status === "DRAFT" || s.id == null) {
    const pageH = doc.internal.pageSize.getHeight();
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0.12 }));
    doc.setFont("helvetica", "bold");
    doc.setFontSize(60);
    doc.setTextColor(150, 100, 0);
    doc.text("ESTIMATE", pageW / 2, pageH / 2, { align: "center", angle: 30 });
    doc.restoreGraphicsState();
    doc.setTextColor(0, 0, 0);
  }
}

export async function generatePayslipPdf(slips: Payslip[], opts?: { action?: PdfAction }): Promise<void> {
  if (!slips.length) return;
  const [{ jsPDF }, autoTableModule] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const autoTable = autoTableModule.default as unknown as AutoTable;
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  for (let i = 0; i < slips.length; i++) {
    if (i > 0) doc.addPage();
    await renderPayslipInto(doc, autoTable, slips[i]);
  }
  const name = slips.length === 1 ? `payslip-${slips[0].period}-${safeName(slips[0].empNo)}.pdf` : `payslips-${slips[0].period}.pdf`;
  deliverPdf(doc, name, opts?.action);
}
