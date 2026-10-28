// Reopen a completed/voided service case for a DIFFERENT complaint (owner
// 2026-09-22). Self-contained: renders its own header button (only on a
// closed case) + a small modal that captures the new complaint and the stage
// to re-assess from, then POSTs /reopen and reloads. Kept out of
// ServiceCases.tsx, which is at its size ceiling.
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../../api/client";
import { REOPEN_STAGE_OPTIONS } from "../../vendor/scm/lib/assr/reopen";

export function ReopenCaseControl({
  caseId,
  stage,
  canWrite,
  onReopened,
  onError,
}: {
  caseId: number;
  stage: string | null | undefined;
  canWrite: boolean;
  onReopened: () => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [complaint, setComplaint] = useState("");
  const [reopenStage, setReopenStage] = useState("under_verification");
  const [busy, setBusy] = useState(false);

  const isClosed = stage === "completed" || stage === "voided";
  if (!canWrite || !isClosed) return null;

  const submit = () => {
    const text = complaint.trim();
    if (!text || busy) return;
    setBusy(true);
    api
      .post(`/api/assr/${caseId}/reopen`, { complaint: text, stage: reopenStage })
      .then(() => {
        setOpen(false);
        setComplaint("");
        onReopened();
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : "Couldn't reopen the case"))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary-soft px-3 py-1.5 text-[12px] font-semibold text-primary hover:opacity-90"
      >
        <RotateCcw size={12} /> Reopen
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setOpen(false)}>
          <div className="w-full max-w-md rounded-lg border border-border bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[14px] font-bold text-ink">Reopen case for a new complaint</h3>
            <p className="mt-1 text-[12px] text-ink-muted">
              The first complaint stays on the timeline. The new complaint below replaces the case's current one, and the case reactivates at the stage you pick.
            </p>
            <label className="mt-3 block text-[11px] font-medium text-ink-muted">New complaint</label>
            <textarea
              className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-ink-secondary outline-none focus:border-primary"
              rows={3}
              autoFocus
              value={complaint}
              placeholder="What is the customer reporting this time?"
              onChange={(e) => setComplaint(e.target.value)}
            />
            <label className="mt-3 block text-[11px] font-medium text-ink-muted">Reopen at stage</label>
            <select
              className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-ink-secondary outline-none focus:border-primary"
              value={reopenStage}
              onChange={(e) => setReopenStage(e.target.value)}
            >
              {REOPEN_STAGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:border-primary/40 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !complaint.trim()}
                className="rounded-md border border-primary bg-primary-soft px-3 py-1.5 text-[12px] font-semibold text-primary hover:opacity-90 disabled:opacity-60"
              >
                {busy ? "Reopening…" : "Reopen case"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
