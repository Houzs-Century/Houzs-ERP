// ----------------------------------------------------------------------------
// assr/returns — the shared "factory return" (返厂) round helpers. NO React,
// no I/O. One place both the desktop Supplier panel and the mobile Stage tab
// read the rounds from, so "which trip is current / how many trips / what to
// call round N" cannot drift between the two surfaces.
//
// Background (owner 2026-09-21 "我需要2次返厂 Service 功能"): the supplier leg is
// one factory round-trip whose three dates lived as single columns on the case,
// so a second trip overwrote the first. Each trip is now a row; this module is
// the read side of that list. The backend mirror lives in
// backend/src/services/assr.ts (currentSupplierReturn / nextSupplierReturnRoundNo)
// and MUST agree with these two.
// ----------------------------------------------------------------------------

export interface SupplierReturn {
  id: number;
  round_no: number;
  /** YYYY-MM-DD — sent to the factory/supplier. */
  pickup_at: string | null;
  /** YYYY-MM-DD — back from the factory/supplier. */
  returned_at: string | null;
  /** 'pass' | 'fail' | 'na' — did the returned item pass on receipt. */
  qc_result: string | null;
  creditor_code: string | null;
  creditor_name?: string | null;
  reason: string | null;
  note: string | null;
  created_by_name?: string | null;
  created_at?: string | null;
  archived_at?: string | null;
}

/** How many factory trips this case has (non-archived rows). Drives the
 *  "{n} trips" badge on both surfaces. */
export function roundCount(rows: readonly { archived_at?: string | null }[]): number {
  return rows.filter((r) => !r.archived_at).length;
}

/** The current (latest) trip = highest round_no among non-archived rows. The
 *  case's summary columns mirror this one for the delivery board / HC sheet. */
export function currentRound<
  T extends { round_no: number; archived_at?: string | null },
>(rows: readonly T[]): T | null {
  const live = rows.filter((r) => !r.archived_at);
  if (!live.length) return null;
  return live.reduce((a, b) => (b.round_no > a.round_no ? b : a));
}

/** The number the NEXT trip would take — highest EXISTING number (archived
 *  included, so a number is never reused) + 1. Mirrors the server. */
export function nextRoundNo(rows: readonly { round_no: number }[]): number {
  return rows.reduce((m, r) => Math.max(m, r.round_no), 0) + 1;
}

/** Card / chip title for a trip, e.g. "Return to Supplier #2". */
export function roundLabel(roundNo: number): string {
  return `Return to Supplier #${roundNo}`;
}

/** QC-on-receipt outcomes, shared by both surfaces' selects. */
export const QC_RESULTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "pass", label: "Pass" },
  { value: "fail", label: "Fail" },
  { value: "na", label: "N/A" },
];

export function qcResultLabel(v: string | null | undefined): string {
  return QC_RESULTS.find((o) => o.value === v)?.label ?? (v || "—");
}
