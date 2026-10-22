// The remark a defect photo carries — one Model + one Reason, packed into the
// single `project_checklist_attachments.caption` text so no schema change is
// needed. Owner 2026-09-28: every defect photo must carry BOTH a Model (picked
// from the event's stock-out items) and a Reason (free text); upload is blocked
// until both are given, and both must be readable by everyone on mobile.
//
// ONE source for the pack/unpack so the upload prompt and every display agree.
// A caption written before this rule (a plain "Elevation") is not structured —
// parseDefectCaption returns it as `reason` with no model, so old photos still
// read sensibly.

export interface DefectRemark {
  model: string;
  reason: string;
}

const MODEL_RE = /^\s*model\s*:\s*(.*)$/i;
const REASON_RE = /^\s*reason\s*:\s*(.*)$/i;

/** Pack a Model + Reason into the caption stored on the attachment. Both are
 *  trimmed; the format is stable and line-based so parseDefectCaption is exact. */
export function formatDefectCaption(r: DefectRemark): string {
  return `Model: ${r.model.trim()}\nReason: ${r.reason.trim()}`;
}

/** Read a caption back. A structured caption yields {model, reason}; anything
 *  else (a legacy free-text remark, or empty) yields model:null and the whole
 *  text as reason, so the display never hides what was written. */
export function parseDefectCaption(
  caption: string | null | undefined,
): { model: string | null; reason: string | null } {
  const raw = (caption ?? "").trim();
  if (!raw) return { model: null, reason: null };
  let model: string | null = null;
  const reasonLines: string[] = [];
  let sawStructure = false;
  for (const line of raw.split(/\r?\n/)) {
    const m = MODEL_RE.exec(line);
    const rs = REASON_RE.exec(line);
    if (m) { model = m[1].trim() || null; sawStructure = true; }
    else if (rs) { reasonLines.push(rs[1].trim()); sawStructure = true; }
    else if (sawStructure) reasonLines.push(line); // wrapped reason text
  }
  if (!sawStructure) return { model: null, reason: raw };
  const reason = reasonLines.join("\n").trim();
  return { model, reason: reason || null };
}

/** True when both fields are present — the upload gate. */
export function defectRemarkComplete(r: Partial<DefectRemark> | null | undefined): r is DefectRemark {
  return !!r && !!(r.model ?? "").trim() && !!(r.reason ?? "").trim();
}
