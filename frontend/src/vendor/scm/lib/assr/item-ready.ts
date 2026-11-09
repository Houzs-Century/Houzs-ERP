// Pending Item Ready (Operation Dept 2026-11-09): the supplier DOs that come back
// with the repaired item, and the route QC sends it on. Shared by the desktop
// stage row and the mobile Stage tab so the labels cannot drift.

export interface ReturnDo {
  id: number;
  do_no: string;
  do_date: string | null;
  received_at: string | null;
  received_by: string | null;
  remarks: string | null;
}

export const ACTION_REQUIRED_OPTIONS: ReadonlyArray<{ value: "pass" | "fail" | "na"; label: string }> = [
  { value: "pass", label: "Approved - to Delivery" },
  { value: "fail", label: "Send back to supplier" },
  { value: "na", label: "Others" },
];

export function actionRequiredLabel(value: string | null | undefined): string {
  return ACTION_REQUIRED_OPTIONS.find((option) => option.value === value)?.label ?? "Not decided";
}

export function returnDoPath(caseId: number, doId: number | null): string {
  return doId === null ? `/api/assr/${caseId}/return-dos` : `/api/assr/${caseId}/return-dos/${doId}`;
}

export interface QcStageChip {
  label: string;
  tone: "ok" | "warn" | "muted";
}

const QC_STAGE_CHIPS: Record<string, QcStageChip> = {
  pass: { label: "QC Passed", tone: "ok" },
  fail: { label: "QC Failed", tone: "warn" },
  na: { label: "QC Other", tone: "muted" },
};

export function qcStageChip(value: string | null | undefined): QcStageChip | null {
  return QC_STAGE_CHIPS[value ?? ""] ?? null;
}

export function itemReadySummary(value: string | null | undefined): string {
  return qcStageChip(value) ? `QC Result: ${actionRequiredLabel(value)}` : "Awaiting supplier return + QC";
}

export function returnDoAttachmentCategory(doId: number): `return_do_${number}` {
  return `return_do_${doId}`;
}

export const RECEIVED_BY_SUGGESTIONS: readonly string[] = ["Warehouse Team", "Logistics Team", "Service Team", "Supplier Driver"];
