// ----------------------------------------------------------------------------
// assr/reopen — the shared "reopen for a new complaint" stage options. NO
// React, no I/O. One place both the desktop ReopenCaseControl and the mobile
// MobileReopenControl read the re-assessment stage choices from, so the list
// and its wording cannot drift between the two surfaces (owner's standing rule:
// one shared logic layer, surfaces differ only in presentation).
//
// Background (owner 2026-09-22 "第一次结束后再有问题倒回来，会有不一样的投诉内容"):
// a completed/voided case that comes back with a NEW complaint keeps its number
// and moves back to one of these assessment stages. The VALUES are the slugs the
// backend validates against REOPEN_STAGES (backend/src/services/assrReopen.ts) —
// the two must name the same three stages; assrReopen.test.ts and
// reopen-controls.test.ts pin each side to this exact set.
// ----------------------------------------------------------------------------

export interface ReopenStageOption {
  /** Stage slug — must be a member of the backend REOPEN_STAGES set. */
  value: string;
  label: string;
}

// Ordered as the operator meets them going backwards from "done": re-inspect,
// re-decide the fix, or start the whole assessment over.
export const REOPEN_STAGE_OPTIONS: readonly ReopenStageOption[] = [
  { value: "under_verification", label: "Verify (inspect the new problem)" },
  { value: "pending_solution", label: "Solution (decide the fix)" },
  { value: "pending_review", label: "Review (start from the top)" },
];
